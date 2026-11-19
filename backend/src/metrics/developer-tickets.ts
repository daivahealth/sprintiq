import {
  extractJiraKeyCandidates,
  extractJiraKeys,
} from '../correlation/jira-key.util';

/** Where a commit named the ticket: its own message, or a branch it was on. */
export type TicketLinkSource = 'branch' | 'message';

/** One Jira item a developer committed against in the window. */
export interface DeveloperTicket {
  key: string;
  projectKey: string;
  type: string;
  /** As Jira states it now — the range windows the commits, not the status. */
  status: string;
  title: string;
  /** This developer's commits that reference it, each counted once. */
  commits: number;
  lastCommitAt: string;
  linkedVia: TicketLinkSource[];
  /**
   * Those commits, newest first, for the row's drill-down — capped at
   * `DEVELOPER_TICKET_COMMITS_CAP`; `commits` is the full count.
   */
  commitList: TicketCommit[];
}

/** One of a developer's commits on a ticket, as the drill-down lists it. */
export interface TicketCommit {
  /** The full SHA, so the page can link to the commit on GitHub. */
  sha: string;
  repo: string;
  /** The subject line only. */
  message: string;
  committedAt: string;
  additions: number;
  deletions: number;
  /** How this commit named the ticket. */
  linkedVia: TicketLinkSource[];
  /**
   * Known tickets this commit also points at but is not credited to (see
   * `developerTickets`) — disclosed so the row shows the evidence that was
   * set aside, not just the conclusion.
   */
  notCreditedTo: string[];
}

/** The story fields a ticket row needs, as the planning context returns them. */
export interface TicketStory {
  externalKey: string;
  projectKey: string;
  type: string;
  status: string;
  title: string;
}

/** Rows returned; `ticketsTotal` carries the full count beyond it. */
export const DEVELOPER_TICKETS_CAP = 50;

/** Commits listed under one ticket; `commits` carries the full count. */
export const DEVELOPER_TICKET_COMMITS_CAP = 50;

type KeySources = Map<string, Set<TicketLinkSource>>;

/** The Jira keys one commit names, split by whether it is credited to them. */
export interface CommitTicketKeys {
  /** Keys the commit counts toward, and how it named each. */
  credited: KeySources;
  /**
   * Keys named only by branches the commit reached after the one it was first
   * seen on — a release branch, or a branch cut from one. Never credited.
   */
  inherited: Set<string>;
}

/** A branch a commit was seen on, and when the audit route first saw it there. */
export interface CommitBranchLink {
  repoFullName: string;
  branch: string;
  sha: string;
  firstSeenAt: Date;
}

const commitId = (repoFullName: string, sha: string) =>
  `${repoFullName}@${sha}`;

/**
 * The Jira keys each commit names, and where it names them.
 *
 * A key counts when it is in the commit's message, or in the name of the
 * branch the commit was **first seen on** (2026-11-19). `code_commit_branch`
 * records every branch a commit has been on: a new branch is compared against
 * the default branch, not the branch it was cut from, so a commit made on
 * `ACT-1-fix` is also recorded on `4.61.x` and on every ticket branch later
 * cut from `4.61.x`. Reading every one of those names credited the commit's
 * author with tickets they never touched — on the reference data, about four
 * in ten developer→ticket links. The earliest-seen branch is where the commit
 * was pushed first; keys only its later branches name go to `inherited`, kept
 * for disclosure. A tie for earliest (one run saw several) credits every tied
 * branch, since nothing tells them apart. The earliest branch may name no
 * ticket (a commit pushed straight to a release branch): then no branch key
 * is credited.
 *
 * Nothing else counts — not the repo, and not the PR — so a ticket only
 * appears for someone whose own commit points at it. Keys are candidates
 * here; callers keep the ones Jira knows. `loose` adds lowercase and
 * underscore-suffixed keys (`extractJiraKeyCandidates`), which only a caller
 * that resolves every key to a known story may ask for.
 */
export function ticketKeysByCommit(
  commits: { repoFullName: string; sha: string; message: string }[],
  links: CommitBranchLink[],
  { loose = false }: { loose?: boolean } = {},
): Map<string, CommitTicketKeys> {
  const keysOf = (text: string) =>
    loose
      ? extractJiraKeyCandidates(text)
      : extractJiraKeys({ text }).map((m) => m.key);
  const out = new Map<string, CommitTicketKeys>();
  for (const c of commits) {
    const credited: KeySources = new Map();
    for (const key of keysOf(c.message)) {
      credited.set(key, new Set<TicketLinkSource>(['message']));
    }
    out.set(commitId(c.repoFullName, c.sha), {
      credited,
      inherited: new Set(),
    });
  }
  const linksById = new Map<string, CommitBranchLink[]>();
  for (const l of links) {
    const id = commitId(l.repoFullName, l.sha);
    if (!out.has(id)) continue;
    const seen = linksById.get(id) ?? [];
    seen.push(l);
    linksById.set(id, seen);
  }
  for (const [id, seen] of linksById) {
    const keys = out.get(id)!;
    const first = Math.min(...seen.map((l) => l.firstSeenAt.getTime()));
    const later = new Set<string>();
    for (const l of seen) {
      const isOrigin = l.firstSeenAt.getTime() === first;
      for (const key of keysOf(l.branch)) {
        if (isOrigin) {
          keys.credited.set(
            key,
            (keys.credited.get(key) ?? new Set<TicketLinkSource>()).add(
              'branch',
            ),
          );
        } else {
          later.add(key);
        }
      }
    }
    for (const key of later) {
      if (!keys.credited.has(key)) keys.inherited.add(key);
    }
  }
  return out;
}

/**
 * Groups one developer's commits by the known Jira items they reference.
 *
 * A commit whose message names a known ticket counts toward the message's
 * tickets only (2026-11-19): the developer said what the commit was for, and
 * a first-seen branch naming something else is where it sat, not what it
 * did. A commit whose message names no known ticket falls back to its
 * first-seen branch (`ticketKeysByCommit`). Known tickets set aside either way
 * are listed on the commit (`notCreditedTo`), and such commits are counted in
 * `commitsWithTicketsNotCredited`.
 *
 * A key with no matching story (`UTF-8`, another tenant's prefix, a typo) is
 * dropped rather than guessed at, and a commit left with no ticket is counted
 * in `commitsWithoutTicket` so the page can say how much of the work the list
 * covers. `projects` comes from every ticket, not just the capped rows. Ordered
 * by last commit, never by volume (CLAUDE.md "Metrics are ethics-first").
 */
export function developerTickets(
  commits: {
    repoFullName: string;
    sha: string;
    message: string;
    additions: number;
    deletions: number;
    committedAt: Date | null;
    authoredAt: Date;
  }[],
  keysByCommit: ReadonlyMap<string, CommitTicketKeys>,
  stories: TicketStory[],
  cap: number = DEVELOPER_TICKETS_CAP,
  commitsCap: number = DEVELOPER_TICKET_COMMITS_CAP,
): {
  tickets: DeveloperTicket[];
  ticketsTotal: number;
  commitsWithoutTicket: number;
  commitsWithTicketsNotCredited: number;
  projects: string[];
} {
  const storyByKey = new Map(stories.map((s) => [s.externalKey, s]));
  const acc = new Map<
    string,
    {
      story: TicketStory;
      commits: number;
      last: Date;
      via: Set<TicketLinkSource>;
      list: { at: Date; commit: TicketCommit }[];
    }
  >();
  let commitsWithoutTicket = 0;
  let commitsWithTicketsNotCredited = 0;
  for (const c of commits) {
    const at = c.committedAt ?? c.authoredAt;
    const keys = keysByCommit.get(commitId(c.repoFullName, c.sha));
    const known = [...(keys?.credited ?? [])].filter(([key]) =>
      storyByKey.has(key),
    );
    const byMessage = known.filter(([, sources]) => sources.has('message'));
    const credit = byMessage.length > 0 ? byMessage : known;
    const creditedKeys = new Set(credit.map(([key]) => key));
    const notCreditedTo = [
      ...known.map(([key]) => key),
      ...[...(keys?.inherited ?? [])].filter((key) => storyByKey.has(key)),
    ]
      .filter((key) => !creditedKeys.has(key))
      .sort();
    if (notCreditedTo.length > 0) commitsWithTicketsNotCredited += 1;
    if (credit.length === 0) commitsWithoutTicket += 1;
    for (const [key, sources] of credit) {
      const story = storyByKey.get(key)!;
      const a = acc.get(key) ?? {
        story,
        commits: 0,
        last: at,
        via: new Set<TicketLinkSource>(),
        list: [],
      };
      a.commits += 1;
      if (at > a.last) a.last = at;
      for (const s of sources) a.via.add(s);
      a.list.push({
        at,
        commit: {
          sha: c.sha,
          repo: c.repoFullName,
          message: c.message.split('\n')[0],
          committedAt: at.toISOString(),
          additions: c.additions,
          deletions: c.deletions,
          linkedVia: [...sources].sort(),
          notCreditedTo,
        },
      });
      acc.set(key, a);
    }
  }
  const all = [...acc.values()]
    .map((a) => ({
      key: a.story.externalKey,
      projectKey: a.story.projectKey,
      type: a.story.type,
      status: a.story.status,
      title: a.story.title,
      commits: a.commits,
      lastCommitAt: a.last.toISOString(),
      linkedVia: [...a.via].sort(),
      commitList: a.list
        .sort(
          (x, y) =>
            y.at.getTime() - x.at.getTime() ||
            x.commit.sha.localeCompare(y.commit.sha),
        )
        .slice(0, commitsCap)
        .map((e) => e.commit),
    }))
    .sort(
      (x, y) =>
        y.lastCommitAt.localeCompare(x.lastCommitAt) ||
        x.key.localeCompare(y.key),
    );
  return {
    tickets: all.slice(0, cap),
    ticketsTotal: all.length,
    commitsWithoutTicket,
    commitsWithTicketsNotCredited,
    projects: [...new Set(all.map((t) => t.projectKey))].sort(),
  };
}

/**
 * Every distinct key across `ticketKeysByCommit`'s result, for one lookup —
 * the inherited ones too, so a commit can say which known tickets it was not
 * credited to.
 */
export function candidateTicketKeys(
  keysByCommit: ReadonlyMap<string, CommitTicketKeys>,
): string[] {
  const keys = new Set<string>();
  for (const { credited, inherited } of keysByCommit.values()) {
    for (const key of credited.keys()) keys.add(key);
    for (const key of inherited) keys.add(key);
  }
  return [...keys].sort();
}
