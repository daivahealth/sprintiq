import { MultiDirectedGraph } from 'graphology';
import {
  isAnonymizedAccount,
  isBotDeveloper,
} from '../../correlation/developer-identity.util';
import {
  CommitRecord,
  DeveloperRef,
  developerKey,
  EdgeType,
  edgeKey,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  IssueRecord,
  nodeKey,
  NodeType,
  PullRequestRecord,
  repositoryId,
  repositoryKey,
  ReviewRecord,
} from './knowledge-graph.types';

export type KnowledgeGraph = MultiDirectedGraph<GraphNode, GraphEdge>;

/** Edges a node owns: replaced wholesale whenever that node is re-read. */
interface OwnedEdges {
  in?: EdgeType[];
  out?: EdgeType[];
}

interface NewEdge {
  type: EdgeType;
  source: string;
  target: string;
  attributes?: Omit<GraphEdge, 'type'>;
}

const PAIR = '\u0000';

/** Node types that exist only while something connects to them. */
const DEPENDENT_TYPES: ReadonlySet<string> = new Set([
  NodeType.DEVELOPER,
  NodeType.REPOSITORY,
  NodeType.JIRA_ISSUE,
]);

/**
 * One tenant's knowledge graph plus the natural-key index the source events
 * address it by.
 *
 * Every mutation is idempotent: a record is applied by replacing the edges its
 * node owns, so applying the same row twice — or a corrected row after a stale
 * one — converges on the same state. The loader and the incremental updater go
 * through these same methods, which is what makes a rebuild and a stream of
 * updates agree.
 *
 * The derived edges (CONTRIBUTED_TO, REVIEWED) are recomputed from the nodes
 * underneath them rather than counted up and down, so they cannot drift.
 */
export class TenantGraph {
  readonly graph: KnowledgeGraph = new MultiDirectedGraph<
    GraphNode,
    GraphEdge
  >();

  /** natural key (`commit|repo@sha`, `pr|repo#n`, `issue|KEY`) → node key */
  private readonly refs = new Map<string, string>();

  /** Derived-edge pairs (`developer\0target`) awaiting recomputation. */
  private readonly dirtyContributions = new Set<string>();
  private readonly dirtyReviewed = new Set<string>();
  /** Nodes that lost an edge and may now be isolated. */
  private readonly touched = new Set<string>();

  /** Bulk load defers derived edges to one pass at the end. */
  private deferDerived = false;

  constructor(readonly tenantId: string) {}

  /** Builds the whole graph from a snapshot, deriving edges once at the end. */
  load(snapshot: GraphSnapshot): void {
    this.deferDerived = true;
    try {
      snapshot.commits.forEach((c) => this.upsertCommit(c));
      snapshot.pullRequests.forEach((pr) => this.upsertPullRequest(pr));
      snapshot.issues.forEach((issue) => this.upsertIssue(issue));
    } finally {
      this.deferDerived = false;
    }
    this.flushDerived();
  }

  upsertCommit(record: CommitRecord): void {
    const key = nodeKey(NodeType.COMMIT, record.id);
    this.markDerived(key);
    this.refs.set(commitRef(record.repoFullName, record.sha), key);
    this.setNode(key, {
      type: NodeType.COMMIT,
      id: record.id,
      repoFullName: record.repoFullName,
      sha: record.sha,
      authoredAt: record.authoredAt.toISOString(),
      isMerge: record.parentCount === null ? null : record.parentCount > 1,
    });
    this.replaceOwnedEdges(
      key,
      { in: [EdgeType.CREATED], out: [EdgeType.BELONGS_TO] },
      [
        {
          type: EdgeType.BELONGS_TO,
          source: key,
          target: this.ensureRepository(record.repoFullName),
        },
        ...this.createdBy(record.author, key),
      ],
    );
    this.markDerived(key);
    this.flushDerived();
  }

  /**
   * Applies a PR together with its full review set and issue links, as they
   * stand in Postgres. Reviews and links the graph held that the row no
   * longer carries are removed — that is how corrections land.
   */
  upsertPullRequest(record: PullRequestRecord): void {
    const key = nodeKey(NodeType.PULL_REQUEST, record.id);
    this.markDerived(key);
    this.refs.set(prRef(record.repoFullName, record.number), key);
    this.setNode(key, {
      type: NodeType.PULL_REQUEST,
      id: record.id,
      repoFullName: record.repoFullName,
      number: record.number,
      title: record.title,
      state: record.state,
      openedAt: record.openedAt?.toISOString() ?? null,
      mergedAt: record.mergedAt?.toISOString() ?? null,
    });
    this.replaceOwnedEdges(
      key,
      {
        in: [EdgeType.CREATED],
        out: [EdgeType.BELONGS_TO, EdgeType.REFERENCES],
      },
      [
        {
          type: EdgeType.BELONGS_TO,
          source: key,
          target: this.ensureRepository(record.repoFullName),
        },
        ...this.createdBy(record.author, key),
        ...record.issueLinks.map((link) => ({
          type: EdgeType.REFERENCES,
          source: key,
          target: this.upsertIssueNode(link.issue),
          attributes: { confidence: link.confidence, method: link.method },
        })),
      ],
    );

    const keep = new Set(
      record.reviews.map((r) => nodeKey(NodeType.REVIEW, r.id)),
    );
    for (const reviewKey of this.reviewsOf(key)) {
      if (!keep.has(reviewKey)) {
        this.dropNode(reviewKey);
      }
    }
    record.reviews.forEach((review) => this.applyReview(review, key));

    this.markDerived(key);
    this.flushDerived();
  }

  /** An issue reached by assignment, or re-read after a Jira update. */
  upsertIssue(record: IssueRecord): void {
    // Kept only while a PR references it or it has a resolved assignee.
    this.touched.add(this.upsertIssueNode(record));
    this.flushDerived();
  }

  /** Whether a loaded PR currently references the issue. */
  isIssueReferenced(externalKey: string): boolean {
    const key = this.resolveRef('issue', externalKey);
    if (!key) {
      return false;
    }
    let referenced = false;
    this.graph.forEachInEdge(key, (_edge, attrs) => {
      referenced ||= attrs.type === EdgeType.REFERENCES;
    });
    return referenced;
  }

  /** Removes a commit that no longer exists or has left the loaded window. */
  removeCommit(repoFullName: string, sha: string): void {
    this.removeByRef(commitRef(repoFullName, sha));
  }

  /** Removes a PR along with the reviews that hang off it. */
  removePullRequest(repoFullName: string, number: string): void {
    const key = this.resolveRef('pull_request', repoFullName, number);
    if (key) {
      this.reviewsOf(key).forEach((reviewKey) => this.dropNode(reviewKey));
    }
    this.removeByRef(prRef(repoFullName, number));
  }

  removeIssue(externalKey: string): void {
    this.removeByRef(issueRef(externalKey));
  }

  /** The node key a natural key currently maps to, if loaded. */
  resolveRef(
    kind: 'commit' | 'pull_request' | 'issue',
    ...parts: string[]
  ): string | undefined {
    const ref =
      kind === 'commit'
        ? commitRef(parts[0], parts[1])
        : kind === 'pull_request'
          ? prRef(parts[0], parts[1])
          : issueRef(parts[0]);
    const key = this.refs.get(ref);
    return key && this.graph.hasNode(key) ? key : undefined;
  }

  stats(): {
    nodes: number;
    edges: number;
    nodesByType: Record<NodeType, number>;
    edgesByType: Record<EdgeType, number>;
  } {
    const nodesByType = zeroed(Object.values(NodeType));
    const edgesByType = zeroed(Object.values(EdgeType));
    this.graph.forEachNode((_key, attrs) => {
      nodesByType[attrs.type]++;
    });
    this.graph.forEachEdge((_key, attrs) => {
      edgesByType[attrs.type]++;
    });
    return {
      nodes: this.graph.order,
      edges: this.graph.size,
      nodesByType,
      edgesByType,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private applyReview(record: ReviewRecord, prKey: string): void {
    const key = nodeKey(NodeType.REVIEW, record.id);
    this.markDerived(key);
    this.setNode(key, {
      type: NodeType.REVIEW,
      id: record.id,
      repoFullName: record.repoFullName,
      prNumber: record.prNumber,
      state: record.state,
      submittedAt: record.submittedAt.toISOString(),
      isBot: record.isBot,
    });
    this.replaceOwnedEdges(
      key,
      { in: [EdgeType.CREATED], out: [EdgeType.BELONGS_TO] },
      [
        { type: EdgeType.BELONGS_TO, source: key, target: prKey },
        ...this.createdBy(record.reviewer, key),
      ],
    );
    this.markDerived(key);
  }

  private upsertIssueNode(record: IssueRecord): string {
    const key = nodeKey(NodeType.JIRA_ISSUE, record.id);
    this.refs.set(issueRef(record.key), key);
    this.setNode(key, {
      type: NodeType.JIRA_ISSUE,
      id: record.id,
      key: record.key,
      title: record.title,
      status: record.status,
      issueType: record.type,
    });
    this.replaceOwnedEdges(
      key,
      { out: [EdgeType.ASSIGNED_TO] },
      record.assignee
        ? [
            {
              type: EdgeType.ASSIGNED_TO,
              source: key,
              target: this.ensureDeveloper(record.assignee),
            },
          ]
        : [],
    );
    return key;
  }

  private createdBy(author: DeveloperRef | undefined, key: string): NewEdge[] {
    if (!author) {
      return [];
    }
    return [
      {
        type: EdgeType.CREATED,
        source: this.ensureDeveloper(author),
        target: key,
      },
    ];
  }

  private removeByRef(ref: string): void {
    const key = this.refs.get(ref);
    this.refs.delete(ref);
    if (key && this.graph.hasNode(key)) {
      this.dropNode(key);
    }
    this.flushDerived();
  }

  /** Drops a node, remembering what its derived edges and neighbours were. */
  private dropNode(key: string): void {
    this.markDerived(key);
    this.graph.forEachNeighbor(key, (neighbour) => this.touched.add(neighbour));
    this.graph.dropNode(key);
  }

  private ensureRepository(fullName: string): string {
    const key = repositoryKey(fullName);
    if (!this.graph.hasNode(key)) {
      this.graph.addNode(key, {
        type: NodeType.REPOSITORY,
        fullName,
        url: `https://github.com/${fullName}`,
      });
    }
    return key;
  }

  private ensureDeveloper(ref: DeveloperRef): string {
    const key = developerKey(ref.developerId);
    // Latest read wins: a rename or an admin exclusion reaches the node on the
    // next record that mentions the developer.
    this.setNode(key, {
      type: NodeType.DEVELOPER,
      developerId: ref.developerId,
      displayName: ref.displayName,
      isBot: isBotDeveloper(ref.developerId),
      isAnonymized: isAnonymizedAccount(ref.developerId),
      excluded: ref.excluded,
    });
    return key;
  }

  private setNode(key: string, attrs: GraphNode): void {
    if (this.graph.hasNode(key)) {
      this.graph.replaceNodeAttributes(key, attrs);
    } else {
      this.graph.addNode(key, attrs);
    }
  }

  private replaceOwnedEdges(
    key: string,
    owned: OwnedEdges,
    edges: NewEdge[],
  ): void {
    const wanted = new Map(
      edges.map((e) => [edgeKey(e.type, e.source, e.target), e]),
    );
    const stale: string[] = [];
    this.graph.forEachInEdge(key, (edge, attrs, source) => {
      if (owned.in?.includes(attrs.type) && !wanted.has(edge)) {
        stale.push(edge);
        this.touched.add(source);
      }
    });
    this.graph.forEachOutEdge(key, (edge, attrs, _source, target) => {
      if (owned.out?.includes(attrs.type) && !wanted.has(edge)) {
        stale.push(edge);
        this.touched.add(target);
      }
    });
    stale.forEach((edge) => this.graph.dropEdge(edge));
    for (const [edge, e] of wanted) {
      this.graph.mergeEdgeWithKey(edge, e.source, e.target, {
        type: e.type,
        ...e.attributes,
      });
    }
  }

  /** REVIEW nodes hanging off a PR. */
  private reviewsOf(prKey: string): string[] {
    const out: string[] = [];
    if (!this.graph.hasNode(prKey)) {
      return out;
    }
    this.graph.forEachInEdge(prKey, (_edge, attrs, source, _t, sourceAttrs) => {
      if (
        attrs.type === EdgeType.BELONGS_TO &&
        sourceAttrs.type === NodeType.REVIEW
      ) {
        out.push(source);
      }
    });
    return out;
  }

  /**
   * Records the derived-edge pairs a COMMIT/PR/REVIEW node participates in.
   * Called before and after a change, so both the old and new pairs are
   * recomputed.
   */
  private markDerived(key: string): void {
    if (!this.graph.hasNode(key)) {
      return;
    }
    const attrs = this.graph.getNodeAttributes(key);
    if (attrs.type === NodeType.PULL_REQUEST) {
      // A moved PR moves its reviewers' contributions with it.
      this.reviewsOf(key).forEach((review) => this.markDerived(review));
    }
    const repo = this.repositoryOf(key);
    if (repo) {
      this.touched.add(repo);
    }
    const pr =
      attrs.type === NodeType.REVIEW ? this.prOfReview(key) : undefined;
    this.graph.forEachInEdge(key, (_edge, edgeAttrs, developer) => {
      if (edgeAttrs.type !== EdgeType.CREATED) {
        return;
      }
      this.touched.add(developer);
      if (repo) {
        this.dirtyContributions.add(developer + PAIR + repo);
      }
      if (pr) {
        this.dirtyReviewed.add(developer + PAIR + pr);
      }
    });
  }

  /** COMMIT/PR/REVIEW → the repository it happened in. */
  private repositoryOf(key: string): string | undefined {
    const attrs = this.graph.getNodeAttributes(key);
    return attrs.type === NodeType.COMMIT ||
      attrs.type === NodeType.PULL_REQUEST ||
      attrs.type === NodeType.REVIEW
      ? repositoryKey(attrs.repoFullName)
      : undefined;
  }

  private prOfReview(reviewKey: string): string | undefined {
    let pr: string | undefined;
    this.graph.forEachOutEdge(reviewKey, (_edge, attrs, _s, target) => {
      if (attrs.type === EdgeType.BELONGS_TO) {
        pr = target;
      }
    });
    return pr;
  }

  private flushDerived(): void {
    if (this.deferDerived) {
      return;
    }
    for (const pair of this.dirtyReviewed) {
      const [developer, pr] = pair.split(PAIR);
      this.refreshReviewed(developer, pr);
    }
    for (const pair of this.dirtyContributions) {
      const [developer, repo] = pair.split(PAIR);
      this.refreshContribution(developer, repo);
    }
    for (const key of this.touched) {
      this.dropIfIsolated(key);
    }
    this.dirtyReviewed.clear();
    this.dirtyContributions.clear();
    this.touched.clear();
  }

  /** DEVELOPER –REVIEWED→ PR exists iff they submitted ≥1 review on it. */
  private refreshReviewed(developer: string, pr: string): void {
    const key = edgeKey(EdgeType.REVIEWED, developer, pr);
    let count = 0;
    let lastAt: string | undefined;
    if (this.graph.hasNode(developer)) {
      for (const review of this.reviewsOf(pr)) {
        if (!this.graph.hasEdge(edgeKey(EdgeType.CREATED, developer, review))) {
          continue;
        }
        count++;
        lastAt = latest(
          lastAt,
          activityAt(this.graph.getNodeAttributes(review)),
        );
      }
    }
    if (count === 0) {
      this.dropEdgeIfPresent(key);
      return;
    }
    this.graph.mergeEdgeWithKey(key, developer, pr, {
      type: EdgeType.REVIEWED,
      count,
      lastAt,
    });
  }

  /** DEVELOPER –CONTRIBUTED_TO→ REPO exists iff they created ≥1 commit/PR/review in it. */
  private refreshContribution(developer: string, repo: string): void {
    const key = edgeKey(EdgeType.CONTRIBUTED_TO, developer, repo);
    let lastAt: string | undefined;
    let any = false;
    if (this.graph.hasNode(developer) && this.graph.hasNode(repo)) {
      this.graph.forEachOutEdge(
        developer,
        (_edge, attrs, _source, target, _sourceAttrs, targetAttrs) => {
          if (
            attrs.type === EdgeType.CREATED &&
            this.repositoryOf(target) === repo
          ) {
            any = true;
            lastAt = latest(lastAt, activityAt(targetAttrs));
          }
        },
      );
    }
    if (!any) {
      this.dropEdgeIfPresent(key);
      return;
    }
    this.graph.mergeEdgeWithKey(key, developer, repo, {
      type: EdgeType.CONTRIBUTED_TO,
      lastAt,
    });
  }

  private dropEdgeIfPresent(key: string): void {
    if (this.graph.hasEdge(key)) {
      this.graph.dropEdge(key);
    }
  }

  /** Developers, repos and issues exist only while something connects to them. */
  private dropIfIsolated(key: string): void {
    if (
      this.graph.hasNode(key) &&
      DEPENDENT_TYPES.has(this.graph.getNodeAttribute(key, 'type')) &&
      this.graph.degree(key) === 0
    ) {
      this.graph.dropNode(key);
    }
  }
}

/** When a contribution happened, for "last contribution". */
export function activityAt(node: GraphNode): string | undefined {
  switch (node.type) {
    case NodeType.COMMIT:
      return node.authoredAt;
    case NodeType.PULL_REQUEST:
      return node.mergedAt ?? node.openedAt ?? undefined;
    case NodeType.REVIEW:
      return node.submittedAt;
    default:
      return undefined;
  }
}

function latest(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) {
    return b;
  }
  return b && b > a ? b : a;
}

function zeroed<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
}

function commitRef(repoFullName: string, sha: string): string {
  return `commit|${repositoryId(repoFullName)}@${sha}`;
}

function prRef(repoFullName: string, number: string): string {
  return `pr|${repositoryId(repoFullName)}#${number}`;
}

function issueRef(externalKey: string): string {
  return `issue|${externalKey}`;
}
