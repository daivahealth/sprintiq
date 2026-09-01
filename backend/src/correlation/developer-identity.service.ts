import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import {
  IdentityMatch,
  JiraAssigneeIdentity,
  SourceIdentity,
  indexLoginsByNormalizedKey,
  isAnonymizedAccount,
  isBotDeveloper,
  isMachineEmail,
  buildDeveloperEmailIndex,
  DisplayNameSources,
  MatchSuggestion,
  jiraSourceKeyOf,
  loginToDisplayName,
  resolveDisplayName,
  suggestMatches,
  normalizeIdentityKey,
  resolveIdentity,
  resolveJiraIdentity,
  sourceKeyOf,
} from './developer-identity.util';

const SOURCE_SYSTEM = 'github';
const JIRA_SOURCE_SYSTEM = 'jira';

/**
 * Every read below that answers "whose commit is this" filters on this.
 *
 * `correlation_developer_identity` holds one row per observed SOURCE identity,
 * and since the Jira arm landed those sources are no longer all GitHub. The
 * distinction is not cosmetic: an unfiltered read would put Jira account
 * references into `AttributionIndex.byLogin` — the map commit attribution is
 * looked up in — and would widen `aliasesFor` with them, so a developer's
 * commit query could match on a Jira accountId that means nothing to git.
 */
const GITHUB_SOURCED = { sourceSystem: SOURCE_SYSTEM } as const;

export interface IdentityResolveResult {
  /** Distinct source identities observed on commits and pull requests. */
  observed: number;
  /** Identities that resolved to a GitHub account. */
  resolved: number;
  /** Identities carrying no login that a name/email match recovered. */
  recovered: number;
  /** Identities left deliberately unmerged: no evidence, or evidence for several people. */
  unresolved: number;
  ambiguous: number;
}

/** Outcome of one Jira-assignee resolution pass. */
export interface JiraIdentityResult {
  /** Distinct assignees observed on collected stories. */
  observed: number;
  /** Assignees bridged to a canonical developer. */
  matched: number;
  /** Assignees no developer could be matched to — a known, countable gap. */
  unmatched: number;
  /** Assignees whose name points at several colleagues; left unmerged. */
  ambiguous: number;
}

/** The Jira account references one canonical developer is assigned work under. */
export interface JiraAssigneeRefs {
  logins: string[];
  names: string[];
}

/**
 * How well the Jira↔GitHub bridge holds. Published beside any figure derived
 * from it, for the same reason `AttributionCoverage` is: an unmatched person
 * and a developer with no assigned work are the same absence on screen and
 * opposite findings in fact.
 *
 * **`coveragePct` is measured over DEVELOPERS, not over Jira assignees**, and
 * the distinction was worth a metric bug to learn (api/README.md §12 #47). The
 * assignee-side ratio was published first and read as "how well the bridge
 * works". It is not that. On the reference tenant it said **41%** while the
 * bridge was actually linking **90%** of active committers, because 127 of the
 * 128 unmatched assignees were QA, BA and support staff who hold tickets and
 * never commit — people with no GitHub entity to link *to*. That figure is a
 * fact about org composition, and reading it as a matching failure pointed
 * remediation at the wrong problem entirely.
 *
 * `assignees*` are retained as exactly that org context, never as the headline.
 */
export interface JiraAssigneeCoverage {
  /** Developers with a commit in the window, automation excluded. */
  developersInWindow: number;
  /** Of those, the ones a Jira assignee identity resolves to. */
  developersLinked: number;
  /** developersLinked / developersInWindow — the trust signal boards show. */
  coveragePct: number | null;
  /** Active committers with no Jira account matched — the actionable list. */
  unlinkedDevelopers: string[];
  /** Org context: how many Jira assignees are developers at all. */
  assigneesObserved: number;
  assigneesMatched: number;
  assigneesUnmatched: number;
}

export interface JiraAssigneeIndex {
  byDeveloper: Map<string, JiraAssigneeRefs>;
  /** Org context only — see `JiraAssigneeCoverage`. Not a matching score. */
  assignees: { observed: number; matched: number; unmatched: number };
}

/** One selectable developer in the picker. */
export interface DeveloperCatalogEntry {
  canonicalDeveloperId: string;
  displayName: string;
  /** False when no GitHub account could be matched — their work is still counted. */
  attributed: boolean;
  /**
   * Newest commit across every identity this person commits under. Lets a board
   * open on someone with recent work instead of whoever sorts first
   * alphabetically — on this tenant only 36 of 83 developers committed in the
   * last week, so an alphabetical default lands on an empty board more often
   * than not, which reads as the board being broken.
   */
  lastActiveAt: string | null;
}

/** Every source identity one canonical developer commits or opens PRs under. */
export interface DeveloperAliases {
  canonicalDeveloperId: string;
  logins: string[];
  emails: string[];
}

/**
 * Bulk alias→person lookup for reads that bucket EVERY commit in a window —
 * the counterpart of `aliasesFor`, which widens one developer's query.
 * Attribution order mirrors collection reality: a commit's `authorLogin` is
 * authoritative when present; otherwise its email (lowercased) is the match.
 */
export interface AttributionIndex {
  /** sourceLogin → canonicalDeveloperId */
  byLogin: Map<string, string>;
  /** lowercased email → canonicalDeveloperId */
  byEmail: Map<string, string>;
  /** canonicalDeveloperId → what the UI should call this person */
  displayNames: Map<string, string>;
}

/** How much of a window's commit volume can be attributed to a person at all. */
export interface AttributionCoverage {
  commitsInScope: number;
  commitsAttributed: number;
  /** Commits whose author matches no known developer — counted, never hidden. */
  commitsUnattributed: number;
  coveragePct: number | null;
  /** Distinct git identities behind `commitsUnattributed`. */
  unattributedIdentities: number;
}

/**
 * BC-5 developer identity resolution (PRODUCT-ARCHITECTURE.md BC-5,
 * DATA-MODEL.md §3).
 *
 * A git identity is not a GitHub account. GitHub sets `commit.author.login`
 * only when the commit's email is verified on some account; otherwise the
 * commit arrives with a name and an email and no login, while the same
 * person's pull requests always carry `user.login`. Read models that query
 * commits by raw login therefore return nothing for those people and render
 * "0 commits" as though it were a fact about them.
 *
 * This service builds the mapping that makes those two halves one person, and
 * it is deliberately conservative: it merges only on evidence, records what
 * that evidence was, and queues ambiguity as an orphan instead of guessing
 * (CLAUDE.md — "surface orphans/ambiguities rather than guessing silently").
 *
 * Pure in-database work over facts already collected — no external API calls,
 * so the collector boundary is untouched, and it is safe to re-run.
 */
@Injectable()
export class DeveloperIdentityService {
  private readonly logger = new Logger(DeveloperIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rebuilds the tenant's identity map from collected commits and PRs.
   *
   * Idempotent: re-running re-derives every row from the same facts, so an
   * identity that later gains a login (the person verified their email, and a
   * newer commit carried it) is upgraded on the next pass rather than being
   * stuck at whatever the first pass concluded.
   */
  async resolveTenant(tenantId: string): Promise<IdentityResolveResult> {
    const [commitIdentities, prLogins] = await Promise.all([
      this.prisma.commit.groupBy({
        by: ['authorLogin', 'authorEmail', 'authorName'],
        where: { tenantId },
      }),
      this.prisma.pullRequest.groupBy({
        by: ['authorLogin'],
        where: { tenantId, authorLogin: { not: null } },
      }),
    ]);

    const knownLogins = new Set<string>();
    for (const row of commitIdentities) {
      if (row.authorLogin) {
        knownLogins.add(row.authorLogin);
      }
    }
    for (const row of prLogins) {
      if (row.authorLogin) {
        knownLogins.add(row.authorLogin);
      }
    }

    const loginByEmail = buildEmailIndex(commitIdentities);
    const loginsByNameKey = indexLoginsByNormalizedKey(knownLogins);

    const observed: { identity: SourceIdentity; key: string }[] = [];
    for (const row of commitIdentities) {
      const identity: SourceIdentity = {
        login: row.authorLogin,
        email: row.authorEmail,
        name: row.authorName,
      };
      const key = sourceKeyOf(identity);
      if (key) {
        observed.push({ identity, key });
      }
    }
    for (const row of prLogins) {
      if (row.authorLogin) {
        observed.push({
          identity: { login: row.authorLogin },
          key: `login:${row.authorLogin}`,
        });
      }
    }

    const result: IdentityResolveResult = {
      observed: 0,
      resolved: 0,
      recovered: 0,
      unresolved: 0,
      ambiguous: 0,
    };
    const seen = new Set<string>();
    // Names already claimed by an unresolved identity, so a second unrelated
    // person with the same git name can't quietly inherit the first one's id.
    const claimedNames = new Set<string>();

    for (const { identity, key } of observed) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.observed++;

      const match = resolveIdentity(identity, loginByEmail, loginsByNameKey);
      if (!match) {
        // Several colleagues normalize to the same key. Recorded for review;
        // their commits stay unattributed rather than credited to a coin flip.
        result.ambiguous++;
        await this.upsertOrphan(tenantId, key, 'ambiguous_identity');
        continue;
      }

      const resolvedMatch =
        match.method === 'unresolved'
          ? this.withReadableId(match, identity, claimedNames)
          : match;

      if (resolvedMatch.method === 'github_login') {
        result.resolved++;
      } else if (resolvedMatch.method === 'unresolved') {
        result.unresolved++;
        await this.upsertOrphan(tenantId, key, 'unresolved_identity');
      } else {
        result.recovered++;
      }

      await this.upsertIdentity(tenantId, key, identity, resolvedMatch);
    }

    this.logger.log(
      `Identity resolution (tenant ${tenantId}): ${result.observed} identities — ${result.resolved} from source, ${result.recovered} recovered, ${result.unresolved} unresolved, ${result.ambiguous} ambiguous.`,
    );
    return result;
  }

  /**
   * Maps Jira assignees onto the canonical developers resolved from GitHub.
   *
   * Run AFTER `resolveTenant`, which is what mints the canonical ids this pass
   * matches into. Same conservatism, weaker evidence: Jira stories carry no
   * author email, so the only bridge is the display name (see
   * `resolveJiraIdentity`). Ambiguity becomes an orphan; a miss stays an
   * honestly unmatched `jira:` identity rather than a guess.
   *
   * `matched` versus `unmatched` is not incidental bookkeeping — it is the
   * denominator the Watchlist has to publish. An unmatched assignee looks
   * exactly like a developer with no assigned work, and those mean opposite
   * things: one is a data gap, the other is the finding. A board that shows the
   * second without the first is asserting something it cannot support.
   */
  async resolveJiraAssignees(tenantId: string): Promise<JiraIdentityResult> {
    const [assignees, githubIdentities] = await Promise.all([
      this.prisma.story.groupBy({
        by: ['assigneeLogin', 'assigneeName', 'assigneeEmail'],
        where: {
          tenantId,
          OR: [
            { assigneeLogin: { not: null } },
            { assigneeName: { not: null } },
          ],
        },
      }),
      this.prisma.developerIdentity.findMany({
        where: { tenantId, ...GITHUB_SOURCED },
        select: { canonicalDeveloperId: true, email: true },
      }),
    ]);

    // Match against canonical developer ids, not raw source logins. An EMU
    // login and the git name it was recovered from are already one person by
    // this point; re-deriving from source rows would reintroduce the split.
    const loginsByNameKey = indexLoginsByNormalizedKey(
      new Set(githubIdentities.map((row) => row.canonicalDeveloperId)),
    );
    // The strong rung: every address a resolved developer is known to commit
    // under, so an Atlassian email that equals one of them is a match rather
    // than an inference.
    const developerByEmail = buildDeveloperEmailIndex(githubIdentities);

    const result: JiraIdentityResult = {
      observed: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
    };
    const seen = new Set<string>();

    // Newest disclosure first: `groupBy` returns one row per distinct
    // (login, name, email) triple, so an assignee whose email was collected
    // only after visibility was opened appears twice — once with a null email.
    // Sorting the disclosed rows first means the `seen` guard keeps the
    // informative one and discards the blank, rather than whichever Postgres
    // happened to return first.
    const ordered = [...assignees].sort(
      (a, b) => (b.assigneeEmail ? 1 : 0) - (a.assigneeEmail ? 1 : 0),
    );

    for (const row of ordered) {
      const identity: JiraAssigneeIdentity = {
        login: row.assigneeLogin,
        name: row.assigneeName,
        email: row.assigneeEmail,
      };
      const key = jiraSourceKeyOf(identity);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.observed++;

      const match = resolveJiraIdentity(
        identity,
        loginsByNameKey,
        developerByEmail,
      );
      if (!match) {
        result.ambiguous++;
        await this.upsertOrphan(tenantId, `jira:${key}`, 'ambiguous_identity');
        continue;
      }
      if (match.method === 'unresolved') {
        result.unmatched++;
        await this.upsertOrphan(tenantId, `jira:${key}`, 'unresolved_identity');
      } else {
        result.matched++;
      }

      await this.upsertIdentity(
        tenantId,
        key,
        { login: identity.login, name: identity.name, email: identity.email },
        match,
        JIRA_SOURCE_SYSTEM,
      );
    }

    this.logger.log(
      `Jira assignee resolution (tenant ${tenantId}): ${result.observed} assignees — ${result.matched} matched to a developer, ${result.unmatched} unmatched, ${result.ambiguous} ambiguous.`,
    );
    return result;
  }

  /**
   * canonicalDeveloperId → the Jira assignee references that person is known
   * by, plus how well the bridge holds tenant-wide.
   *
   * One read for the whole tenant: the Watchlist asks this of every developer
   * at once, so a per-person lookup would be N+1 over a table that is small
   * enough to hold entirely.
   */
  async jiraAssigneeIndex(tenantId: string): Promise<JiraAssigneeIndex> {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId, sourceSystem: JIRA_SOURCE_SYSTEM },
      select: {
        canonicalDeveloperId: true,
        sourceLogin: true,
        name: true,
        method: true,
      },
    });

    const byDeveloper = new Map<string, JiraAssigneeRefs>();
    let matched = 0;
    let unmatched = 0;
    for (const row of rows) {
      if (row.method === 'unresolved') {
        unmatched++;
        continue;
      }
      matched++;
      const refs = byDeveloper.get(row.canonicalDeveloperId) ?? {
        logins: [],
        names: [],
      };
      if (row.sourceLogin) {
        refs.logins.push(row.sourceLogin);
      }
      if (row.name) {
        refs.names.push(row.name);
      }
      byDeveloper.set(row.canonicalDeveloperId, refs);
    }

    return {
      byDeveloper,
      // Developer-side figures are completed by `bridgeCoverage`, which is the
      // only layer that knows the window and who committed in it. Not computed
      // table-wide here: "linked" only means anything against the people the
      // board is actually reporting on (§12 #47).
      assignees: {
        observed: matched + unmatched,
        matched,
        unmatched,
      },
    };
  }

  /**
   * Completes a `JiraAssigneeCoverage` for one window's committers.
   *
   * Separate from `jiraAssigneeIndex` because coverage is a property of the
   * QUESTION — "of the people who committed in these 7 days, how many can we
   * see assigned work for" — not of the identity table. Computing it over the
   * table instead produced the misleading 41% that sent remediation after the
   * wrong problem (§12 #47).
   */
  bridgeCoverage(
    committers: Iterable<string>,
    index: JiraAssigneeIndex,
  ): JiraAssigneeCoverage {
    // Neither automation nor a deprovisioned account is a developer missing a
    // Jira account — nobody will ever fix either, so counting them only drags
    // the trust signal down. Both stay in the commit and LOC totals and stay
    // out of every head-count.
    const people = [...committers].filter(
      (dev) => !isBotDeveloper(dev) && !isAnonymizedAccount(dev),
    );
    const unlinked = people.filter((dev) => !index.byDeveloper.has(dev));
    const linked = people.length - unlinked.length;
    return {
      developersInWindow: people.length,
      developersLinked: linked,
      coveragePct:
        people.length > 0
          ? Number(((linked / people.length) * 100).toFixed(1))
          : null,
      unlinkedDevelopers: unlinked.sort(),
      assigneesObserved: index.assignees.observed,
      assigneesMatched: index.assignees.matched,
      assigneesUnmatched: index.assignees.unmatched,
    };
  }

  /**
   * Every login and email that rolls up to one canonical developer.
   *
   * Read models widen their queries with this instead of filtering on a single
   * login — that is what makes a commit GitHub could not attribute reachable
   * from the person's page.
   */
  async aliasesFor(
    tenantId: string,
    canonicalDeveloperId: string,
  ): Promise<DeveloperAliases> {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId, canonicalDeveloperId, ...GITHUB_SOURCED },
      select: { sourceLogin: true, email: true },
    });

    const logins = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      if (row.sourceLogin) {
        logins.add(row.sourceLogin);
      }
      if (row.email) {
        emails.add(row.email.toLowerCase());
      }
    }
    // Never return an empty alias set for a real request: before the first
    // resolution pass the table is empty, and an empty set would silently widen
    // "this developer's commits" into "every commit". Falling back to the
    // requested id reproduces exactly today's behaviour instead.
    if (logins.size === 0 && emails.size === 0) {
      logins.add(canonicalDeveloperId);
    }
    return {
      canonicalDeveloperId,
      logins: [...logins],
      emails: [...emails],
    };
  }

  /**
   * Every known alias mapped to its canonical developer, in one read — for
   * reads that bucket a whole window of commits by person (e.g. the daily
   * activity grid), where calling `aliasesFor` per developer would be N+1
   * and filtering per person would re-scan the window N times.
   */
  async attributionIndex(tenantId: string): Promise<AttributionIndex> {
    // Jira names are read alongside because they win the display-name ladder:
    // they are the only human-curated source, and complete for every linked
    // developer on the reference tenant (DASHBOARDS.md §4.4.6).
    const [rows, jiraRows] = await Promise.all([
      this.prisma.developerIdentity.findMany({
        where: { tenantId, ...GITHUB_SOURCED },
        select: {
          canonicalDeveloperId: true,
          sourceLogin: true,
          email: true,
          name: true,
        },
      }),
      this.prisma.developerIdentity.findMany({
        where: {
          tenantId,
          sourceSystem: JIRA_SOURCE_SYSTEM,
          NOT: { method: 'unresolved' },
        },
        select: { canonicalDeveloperId: true, name: true },
      }),
    ]);

    const jiraNames = new Map<string, string>();
    for (const row of jiraRows) {
      if (row.name && !jiraNames.has(row.canonicalDeveloperId)) {
        jiraNames.set(row.canonicalDeveloperId, row.name);
      }
    }

    const byLogin = new Map<string, string>();
    const byEmail = new Map<string, string>();
    // Best source seen per developer, resolved into a name once at the end —
    // the ladder has to compare across ALL of a person's identity rows, and
    // deciding row-by-row would let whichever row arrived first win.
    const sources = new Map<string, DisplayNameSources>();
    for (const row of rows) {
      if (row.sourceLogin) {
        byLogin.set(row.sourceLogin, row.canonicalDeveloperId);
      }
      if (row.email) {
        byEmail.set(row.email.toLowerCase(), row.canonicalDeveloperId);
      }
      const current = sources.get(row.canonicalDeveloperId) ?? {
        canonicalDeveloperId: row.canonicalDeveloperId,
        jiraDisplayName: jiraNames.get(row.canonicalDeveloperId),
      };
      current.githubLogin ??= row.sourceLogin;
      current.gitName ??= row.name;
      sources.set(row.canonicalDeveloperId, current);
    }

    const displayNames = new Map<string, string>();
    for (const [developer, source] of sources) {
      displayNames.set(developer, resolveDisplayName(source));
    }
    return { byLogin, byEmail, displayNames };
  }

  /**
   * Possible identity matches for a developer nothing linked automatically.
   *
   * Two candidate pools, because the reference tenant has both failure modes:
   * a genuinely unlinked person whose Jira name differs (`nithin` →
   * `Nithin N`), and a stray GitHub fragment that belongs to an already-linked
   * developer (`Junaid Haneef`, committing from a personal Gmail, belongs to
   * `Mohammed-Junaid-Haneef_athma`).
   *
   * Suggestions only. Nothing here merges anything — the matcher that IS
   * allowed to merge lives in `resolveJiraIdentity` and requires evidence
   * rather than resemblance.
   */
  async suggestionsFor(
    tenantId: string,
    developers: { developer: string; displayName: string }[],
  ): Promise<Map<string, MatchSuggestion[]>> {
    if (developers.length === 0) {
      return new Map();
    }
    const [jiraRows, ghRows] = await Promise.all([
      this.prisma.developerIdentity.findMany({
        where: { tenantId, sourceSystem: JIRA_SOURCE_SYSTEM },
        select: { canonicalDeveloperId: true, name: true, method: true },
      }),
      this.prisma.developerIdentity.findMany({
        where: { tenantId, ...GITHUB_SOURCED },
        select: { canonicalDeveloperId: true, sourceLogin: true, name: true },
      }),
    ]);

    const unlinkedIds = new Set(developers.map((d) => d.developer));
    const jiraPool = jiraRows
      .filter((r) => r.name)
      .map((r) => ({ id: r.canonicalDeveloperId, name: r.name! }));
    // Other developers, as merge candidates for stray fragments. Excludes the
    // unlinked set itself so two fragments don't suggest each other.
    const developerPool = [
      ...new Map(
        ghRows
          .filter((r) => !unlinkedIds.has(r.canonicalDeveloperId))
          .map((r) => [
            r.canonicalDeveloperId,
            {
              id: r.canonicalDeveloperId,
              name: r.sourceLogin
                ? loginToDisplayName(r.sourceLogin)
                : (r.name ?? r.canonicalDeveloperId),
            },
          ]),
      ).values(),
    ];

    const out = new Map<string, MatchSuggestion[]>();
    for (const dev of developers) {
      // Deduped by candidate id, keeping the first (stronger) basis. Both pools
      // key on `canonicalDeveloperId`, so a linked developer who is ALSO a Jira
      // assignee — which is most of them — matched twice and rendered as
      // "Mohammed Junaid Haneef | Mohammed Junaid Haneef", reading as two
      // separate pieces of evidence when it is one.
      const found = new Map<string, MatchSuggestion>();
      for (const suggestion of [
        ...suggestMatches(dev.displayName, jiraPool),
        ...suggestMatches(dev.displayName, developerPool),
      ]) {
        if (!found.has(suggestion.candidate)) {
          found.set(suggestion.candidate, suggestion);
        }
      }
      if (found.size > 0) {
        out.set(dev.developer, [...found.values()].slice(0, 3));
      }
    }
    return out;
  }

  /**
   * Canonical developers for the picker: everyone with collected work,
   * including the people no GitHub account could be found for — they are the
   * ones the old login-only catalog made invisible.
   */
  async listDevelopers(
    tenantId: string,
    search?: string,
  ): Promise<DeveloperCatalogEntry[]> {
    const [rows, lastCommitByKey, jiraRows] = await Promise.all([
      this.prisma.developerIdentity.findMany({
        // GitHub-sourced only: this is the picker for boards that count
        // commits, and a Jira-only assignee has none. Listing them would offer
        // a person whose every figure is structurally zero.
        where: { tenantId, ...GITHUB_SOURCED },
        select: {
          canonicalDeveloperId: true,
          sourceKey: true,
          sourceLogin: true,
          name: true,
          method: true,
        },
      }),
      this.lastCommitBySourceKey(tenantId),
      // Jira names win the display ladder, so the picker needs them too.
      this.prisma.developerIdentity.findMany({
        where: {
          tenantId,
          sourceSystem: JIRA_SOURCE_SYSTEM,
          NOT: { method: 'unresolved' },
        },
        select: { canonicalDeveloperId: true, name: true },
      }),
    ]);

    const jiraNames = new Map<string, string>();
    for (const row of jiraRows) {
      if (row.name && !jiraNames.has(row.canonicalDeveloperId)) {
        jiraNames.set(row.canonicalDeveloperId, row.name);
      }
    }

    const byCanonical = new Map<
      string,
      { displayName: string; attributed: boolean; lastActiveAt: Date | null }
    >();
    for (const row of rows) {
      const attributed = row.method !== 'unresolved';
      const existing = byCanonical.get(row.canonicalDeveloperId);
      const seen = lastCommitByKey.get(row.sourceKey) ?? null;
      byCanonical.set(row.canonicalDeveloperId, {
        // Same ladder the boards render (`attributionIndex`), so the picker
        // and the page you land on agree about what the person is called.
        displayName:
          existing?.displayName ??
          resolveDisplayName({
            canonicalDeveloperId: row.canonicalDeveloperId,
            jiraDisplayName: jiraNames.get(row.canonicalDeveloperId),
            githubLogin: row.sourceLogin,
            gitName: row.name,
          }),
        attributed: existing ? existing.attributed || attributed : attributed,
        // Newest across all of this person's identities — the whole point of
        // resolving them is that their activity is one timeline, not several.
        lastActiveAt: newest(existing?.lastActiveAt ?? null, seen),
      });
    }

    const needle = search?.toLowerCase();
    return (
      [...byCanonical.entries()]
        .map(([canonicalDeveloperId, v]) => ({
          canonicalDeveloperId,
          displayName: v.displayName,
          attributed: v.attributed,
          lastActiveAt: v.lastActiveAt ? v.lastActiveAt.toISOString() : null,
        }))
        .filter(
          (d) =>
            !needle ||
            d.canonicalDeveloperId.toLowerCase().includes(needle) ||
            d.displayName.toLowerCase().includes(needle),
        )
        // Alphabetical: this is a searchable picker, and someone looking for a
        // name scans for it. Recency rides along as a field so the board can
        // OPEN on someone who has actually committed lately without reordering
        // the list out from under the reader.
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    );
  }

  /** Newest commit per source identity, keyed the same way as `sourceKey`. */
  private async lastCommitBySourceKey(
    tenantId: string,
  ): Promise<Map<string, Date>> {
    const rows = await this.prisma.commit.groupBy({
      by: ['authorLogin', 'authorEmail'],
      where: { tenantId },
      _max: { committedAt: true },
    });
    const out = new Map<string, Date>();
    for (const row of rows) {
      const at = row._max.committedAt;
      if (!at) {
        continue;
      }
      const key = row.authorLogin
        ? `login:${row.authorLogin}`
        : row.authorEmail
          ? `email:${row.authorEmail.toLowerCase()}`
          : null;
      if (!key) {
        continue;
      }
      const existing = out.get(key);
      if (!existing || at > existing) {
        out.set(key, at);
      }
    }
    return out;
  }

  /**
   * Share of a window's commits that can be attributed to any developer.
   *
   * Surfaced on every board that counts commits, because "0 commits" and
   * "commits we cannot attribute" look identical on screen and mean opposite
   * things (CLAUDE.md — always surface linkage coverage).
   */
  async attributionCoverage(
    tenantId: string,
    from: Date,
    to: Date,
    repos?: string[],
  ): Promise<AttributionCoverage> {
    const recoveredEmails = await this.prisma.developerIdentity.findMany({
      where: {
        tenantId,
        ...GITHUB_SOURCED,
        method: { in: ['email_exact', 'name_normalized'] },
        email: { not: null },
      },
      select: { email: true },
    });
    const attributableEmails = recoveredEmails
      .map((r) => r.email)
      .filter((e): e is string => Boolean(e));

    const window = {
      tenantId,
      ...(repos && repos.length > 0 ? { repoFullName: { in: repos } } : {}),
      committedAt: { gte: from, lte: to },
    };

    const [commitsInScope, unattributed, identities] = await Promise.all([
      this.prisma.commit.count({ where: window }),
      this.prisma.commit.count({
        where: {
          ...window,
          authorLogin: null,
          ...(attributableEmails.length > 0
            ? { NOT: { authorEmail: { in: attributableEmails } } }
            : {}),
        },
      }),
      this.prisma.commit.groupBy({
        by: ['authorEmail'],
        where: {
          ...window,
          authorLogin: null,
          ...(attributableEmails.length > 0
            ? { NOT: { authorEmail: { in: attributableEmails } } }
            : {}),
        },
      }),
    ]);

    return {
      commitsInScope,
      commitsAttributed: commitsInScope - unattributed,
      commitsUnattributed: unattributed,
      coveragePct:
        commitsInScope > 0
          ? Number(
              (
                ((commitsInScope - unattributed) / commitsInScope) *
                100
              ).toFixed(1),
            )
          : null,
      unattributedIdentities: identities.length,
    };
  }

  /**
   * Gives an unresolved identity a human-readable canonical id (its git name)
   * when that name is free, so the picker shows "saravanakumar_athma" rather
   * than "email:357486@example.org".
   *
   * Safe by construction: a name that matched any known login would have been
   * resolved a rung earlier, so it cannot collide with a real developer here.
   * The `claimedNames` guard covers the remaining case — two different people
   * committing under the same git name from different emails — by leaving the
   * second on its email key rather than merging them.
   */
  private withReadableId(
    match: IdentityMatch,
    identity: SourceIdentity,
    claimedNames: Set<string>,
  ): IdentityMatch {
    const nameKey = normalizeIdentityKey(identity.name);
    if (!identity.name || !nameKey || claimedNames.has(nameKey)) {
      return match;
    }
    claimedNames.add(nameKey);
    return { ...match, canonicalDeveloperId: identity.name };
  }

  private async upsertIdentity(
    tenantId: string,
    sourceKey: string,
    identity: SourceIdentity,
    match: IdentityMatch,
    sourceSystem: string = SOURCE_SYSTEM,
  ): Promise<void> {
    const data = {
      sourceLogin: identity.login ?? null,
      email:
        identity.email && !isMachineEmail(identity.email)
          ? identity.email
          : null,
      name: identity.name ?? null,
      canonicalDeveloperId: match.canonicalDeveloperId,
      confidence: match.confidence,
      method: match.method,
      evidence: match.evidence,
    };
    await this.prisma.developerIdentity.upsert({
      where: {
        tenantId_sourceSystem_sourceKey: {
          tenantId,
          sourceSystem,
          sourceKey,
        },
      },
      create: {
        id: newId(),
        tenantId,
        sourceSystem,
        sourceKey,
        ...data,
      },
      update: data,
    });
  }

  private async upsertOrphan(
    tenantId: string,
    nodeRef: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.prisma.orphan.findFirst({
      where: {
        tenantId,
        nodeType: 'developer_identity',
        nodeRef,
        resolvedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      return;
    }
    await this.prisma.orphan.create({
      data: {
        id: newId(),
        tenantId,
        nodeType: 'developer_identity',
        nodeRef,
        reason,
      },
    });
  }
}

function newest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * email → login, from commits GitHub DID attribute. Only unambiguous mappings
 * survive: a shared or machine address seen under several logins identifies no
 * one, and keeping it would merge those people together.
 */
function buildEmailIndex(
  rows: {
    authorLogin: string | null;
    authorEmail: string | null;
  }[],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      !row.authorLogin ||
      !row.authorEmail ||
      isMachineEmail(row.authorEmail)
    ) {
      continue;
    }
    const email = row.authorEmail.toLowerCase();
    const set = candidates.get(email) ?? new Set<string>();
    set.add(row.authorLogin);
    candidates.set(email, set);
  }
  const index = new Map<string, string>();
  for (const [email, logins] of candidates) {
    if (logins.size === 1) {
      index.set(email, [...logins][0]);
    }
  }
  return index;
}
