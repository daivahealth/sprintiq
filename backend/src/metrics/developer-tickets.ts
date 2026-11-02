import { extractJiraKeys } from '../correlation/jira-key.util';

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

const commitId = (repoFullName: string, sha: string) =>
  `${repoFullName}@${sha}`;

/**
 * The Jira keys each commit names, and where it names them.
 *
 * A key counts when it is in the commit's message, or in the name of a branch
 * the commit was seen on (`code_commit_branch`, which holds only what a branch
 * adds over its base). Nothing else — not the repo, and not the PR — so a
 * ticket only appears for someone whose own commit points at it. Keys are
 * candidates here; `developerTickets` keeps the ones Jira knows.
 */
export function ticketKeysByCommit(
  commits: { repoFullName: string; sha: string; message: string }[],
  links: { repoFullName: string; branch: string; sha: string }[],
): Map<string, KeySources> {
  const out = new Map<string, KeySources>();
  const add = (id: string, key: string, source: TicketLinkSource) => {
    const keys = out.get(id);
    if (!keys) return;
    keys.set(key, (keys.get(key) ?? new Set()).add(source));
  };
  for (const c of commits) {
    const id = commitId(c.repoFullName, c.sha);
    out.set(id, new Map());
    for (const m of extractJiraKeys({ message: c.message })) {
      add(id, m.key, 'message');
    }
  }
  for (const l of links) {
    for (const m of extractJiraKeys({ branch: l.branch })) {
      add(commitId(l.repoFullName, l.sha), m.key, 'branch');
    }
  }
  return out;
}

/**
 * Groups one developer's commits by the known Jira items they reference.
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
  keysByCommit: ReadonlyMap<string, KeySources>,
  stories: TicketStory[],
  cap: number = DEVELOPER_TICKETS_CAP,
  commitsCap: number = DEVELOPER_TICKET_COMMITS_CAP,
): {
  tickets: DeveloperTicket[];
  ticketsTotal: number;
  commitsWithoutTicket: number;
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
  for (const c of commits) {
    const at = c.committedAt ?? c.authoredAt;
    let linked = false;
    for (const [key, sources] of keysByCommit.get(
      commitId(c.repoFullName, c.sha),
    ) ?? []) {
      const story = storyByKey.get(key);
      if (!story) continue;
      linked = true;
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
        },
      });
      acc.set(key, a);
    }
    if (!linked) commitsWithoutTicket += 1;
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
    projects: [...new Set(all.map((t) => t.projectKey))].sort(),
  };
}

/** Every distinct key across `ticketKeysByCommit`'s result, for one lookup. */
export function candidateTicketKeys(
  keysByCommit: ReadonlyMap<string, KeySources>,
): string[] {
  const keys = new Set<string>();
  for (const sources of keysByCommit.values()) {
    for (const key of sources.keys()) keys.add(key);
  }
  return [...keys].sort();
}
