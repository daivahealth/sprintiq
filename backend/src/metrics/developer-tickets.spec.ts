import { developerTickets, ticketKeysByCommit } from './developer-tickets';

const commit = (
  sha: string,
  at: string,
  message = 'msg',
  repo = 'acme/ehr',
) => ({
  repoFullName: repo,
  sha,
  message,
  additions: 0,
  deletions: 0,
  committedAt: new Date(at),
  authoredAt: new Date(at),
});
/** `seen` is when the commit was first seen on the branch; same instant by default. */
const link = (
  sha: string,
  branch: string,
  seen = '2026-10-14T06:00:00Z',
  repoFullName = 'acme/ehr',
) => ({
  repoFullName,
  branch,
  sha,
  firstSeenAt: new Date(seen),
});
const story = (externalKey: string) => ({
  externalKey,
  projectKey: externalKey.split('-')[0],
  type: 'Story',
  status: 'In Progress',
  title: `${externalKey} title`,
});

describe('ticketKeysByCommit', () => {
  it('reads keys from the commit message and from the branch it was first seen on', () => {
    const keys = ticketKeysByCommit(
      [commit('a', '2026-10-14T05:00:00Z', 'ACT-1 fix login')],
      [link('a', 'feature/AS2-7-export'), link('a', 'develop')],
    );
    const forA = keys.get('acme/ehr@a');
    expect([...(forA?.credited.get('ACT-1') ?? [])]).toEqual(['message']);
    expect([...(forA?.credited.get('AS2-7') ?? [])]).toEqual(['branch']);
    expect(forA?.inherited.size).toBe(0);
  });

  it('credits only the earliest-seen branch; branches it reached later are inherited', () => {
    // Made on ACT-1's branch, then carried onto the release branch and every
    // ticket branch cut from it.
    const keys = ticketKeysByCommit(
      [commit('a', '2026-10-14T05:00:00Z', 'Build error fix')],
      [
        link('a', '4.61.x-ACT-2-consent', '2026-10-16T00:00:00Z'),
        link('a', 'ACT-1-build-fix', '2026-10-14T06:00:00Z'),
        link('a', '4.61.x', '2026-10-15T00:00:00Z'),
        link('a', 'ACT-3-popup-4.61.x', '2026-10-17T00:00:00Z'),
      ],
    );
    const forA = keys.get('acme/ehr@a')!;
    expect([...forA.credited.keys()]).toEqual(['ACT-1']);
    expect([...forA.inherited].sort()).toEqual(['ACT-2', 'ACT-3']);
  });

  it('credits no branch key when the earliest branch names no ticket', () => {
    const keys = ticketKeysByCommit(
      [commit('a', '2026-10-14T05:00:00Z', 'hotfix')],
      [
        link('a', '4.61.x', '2026-10-14T06:00:00Z'),
        link('a', '4.61.x-ACT-2-consent', '2026-10-16T00:00:00Z'),
      ],
    );
    const forA = keys.get('acme/ehr@a')!;
    expect(forA.credited.size).toBe(0);
    expect([...forA.inherited]).toEqual(['ACT-2']);
  });

  it('credits every branch tied for earliest, since nothing tells them apart', () => {
    const keys = ticketKeysByCommit(
      [commit('a', '2026-10-14T05:00:00Z')],
      [link('a', 'ACT-1-x'), link('a', 'ACT-2-y')],
    );
    expect([...keys.get('acme/ehr@a')!.credited.keys()].sort()).toEqual([
      'ACT-1',
      'ACT-2',
    ]);
  });

  it('reads lowercase and underscore-suffixed keys only when asked to', () => {
    const commits = [
      commit('a', '2026-10-14T05:00:00Z', 'act-92982 stages TAT'),
      commit('b', '2026-10-14T05:00:00Z', 'ACT-97104_avoid_sending'),
      commit('c', '2026-10-14T05:00:00Z', 'bump cms-1.0'),
    ];
    const links = [link('c', 'fix-cihl-1189')];
    const strict = ticketKeysByCommit(commits, links);
    expect(strict.get('acme/ehr@a')!.credited.size).toBe(0);
    expect(strict.get('acme/ehr@b')!.credited.size).toBe(0);
    const loose = ticketKeysByCommit(commits, links, { loose: true });
    expect([...loose.get('acme/ehr@a')!.credited.keys()]).toEqual([
      'ACT-92982',
    ]);
    expect([...loose.get('acme/ehr@b')!.credited.keys()]).toEqual([
      'ACT-97104',
    ]);
    // A version is not a key; the branch's key still is.
    expect([...loose.get('acme/ehr@c')!.credited.keys()]).toEqual([
      'CIHL-1189',
    ]);
  });

  it('ignores branch links for commits that are not this developer’s', () => {
    const keys = ticketKeysByCommit(
      [commit('a', '2026-10-14T05:00:00Z')],
      [link('zzz', 'feature/ACT-9')],
    );
    expect(keys.get('acme/ehr@zzz')).toBeUndefined();
    expect(keys.get('acme/ehr@a')?.credited.size ?? 0).toBe(0);
  });
});

describe('developerTickets', () => {
  it('keeps only keys that resolve to a known story, and derives projects from them alone', () => {
    const commits = [
      commit('a', '2026-10-14T05:00:00Z', 'ACT-1 fix; bump UTF-8 handling'),
      commit('b', '2026-10-15T05:00:00Z', 'OTHER-5 mentioned in passing'),
    ];
    const keys = ticketKeysByCommit(commits, []);
    const out = developerTickets(commits, keys, [story('ACT-1')]);
    expect(out.tickets.map((t) => t.key)).toEqual(['ACT-1']);
    expect(out.projects).toEqual(['ACT']);
    // `b` names only a key Jira doesn't know, so it is linked to nothing.
    expect(out.commitsWithoutTicket).toBe(1);
  });

  it('counts each commit once per ticket and records every way it was linked', () => {
    const commits = [
      commit('a', '2026-10-14T05:00:00Z', 'ACT-1 start'),
      commit('b', '2026-10-15T05:00:00Z', 'more work'),
    ];
    const keys = ticketKeysByCommit(commits, [
      link('a', 'feature/ACT-1'),
      link('a', 'bugfix/ACT-1-retry'),
      link('b', 'feature/ACT-1'),
    ]);
    const [ticket] = developerTickets(commits, keys, [story('ACT-1')]).tickets;
    expect(ticket).toMatchObject({
      key: 'ACT-1',
      projectKey: 'ACT',
      commits: 2,
      lastCommitAt: '2026-10-15T05:00:00.000Z',
      linkedVia: ['branch', 'message'],
    });
  });

  it('credits the message’s ticket over a branch naming another, and discloses the one set aside', () => {
    const commits = [commit('a', '2026-10-14T05:00:00Z', 'ACT-1 fix login')];
    const keys = ticketKeysByCommit(commits, [
      link('a', 'ACT-2-other-work', '2026-10-14T06:00:00Z'),
      link('a', 'ACT-3-later', '2026-10-20T00:00:00Z'),
    ]);
    const out = developerTickets(commits, keys, [
      story('ACT-1'),
      story('ACT-2'),
      story('ACT-3'),
    ]);
    expect(out.tickets.map((t) => t.key)).toEqual(['ACT-1']);
    expect(out.tickets[0].commitList[0].notCreditedTo).toEqual([
      'ACT-2',
      'ACT-3',
    ]);
    expect(out.commitsWithTicketsNotCredited).toBe(1);
    expect(out.projects).toEqual(['ACT']);
  });

  it('falls back to the first-seen branch when the message names no known ticket', () => {
    const commits = [commit('a', '2026-10-14T05:00:00Z', 'fix UTF-8 bug')];
    const keys = ticketKeysByCommit(commits, [
      link('a', 'ACT-1-fix', '2026-10-14T06:00:00Z'),
      link('a', '4.61.x-ACT-2', '2026-10-20T00:00:00Z'),
    ]);
    const out = developerTickets(commits, keys, [
      story('ACT-1'),
      story('ACT-2'),
    ]);
    expect(out.tickets.map((t) => [t.key, t.linkedVia])).toEqual([
      ['ACT-1', ['branch']],
    ]);
    expect(out.tickets[0].commitList[0].notCreditedTo).toEqual(['ACT-2']);
    expect(out.commitsWithoutTicket).toBe(0);
  });

  it('counts a commit only on inherited tickets as linked to nothing', () => {
    const commits = [commit('a', '2026-10-14T05:00:00Z', 'hotfix')];
    const keys = ticketKeysByCommit(commits, [
      link('a', '4.61.x', '2026-10-14T06:00:00Z'),
      link('a', '4.61.x-ACT-2', '2026-10-20T00:00:00Z'),
    ]);
    const out = developerTickets(commits, keys, [story('ACT-2')]);
    expect(out.tickets).toEqual([]);
    expect(out.commitsWithoutTicket).toBe(1);
    expect(out.commitsWithTicketsNotCredited).toBe(1);
  });

  it('orders by most recent commit, never by commit count, and caps with the total stated', () => {
    const commits = [
      commit('a', '2026-10-10T05:00:00Z', 'ACT-1'),
      commit('b', '2026-10-11T05:00:00Z', 'ACT-1'),
      commit('c', '2026-10-12T05:00:00Z', 'ACT-1'),
      commit('d', '2026-10-20T05:00:00Z', 'AS2-2'),
      commit('e', '2026-10-15T05:00:00Z', 'AS2-3'),
    ];
    const out = developerTickets(
      commits,
      ticketKeysByCommit(commits, []),
      [story('ACT-1'), story('AS2-2'), story('AS2-3')],
      2,
    );
    expect(out.tickets.map((t) => t.key)).toEqual(['AS2-2', 'AS2-3']);
    expect(out.ticketsTotal).toBe(3);
    // Projects come from every ticket, not just the rows that fit the cap.
    expect(out.projects).toEqual(['ACT', 'AS2']);
  });

  it('lists each ticket’s commits newest first, with how each one named it', () => {
    const commits = [
      {
        ...commit('aaa111', '2026-10-14T05:00:00Z', 'ACT-1 start\n\nbody'),
        additions: 5,
        deletions: 1,
      },
      {
        ...commit('bbb222', '2026-10-16T05:00:00Z', 'tidy'),
        additions: 2,
        deletions: 0,
      },
    ];
    const keys = ticketKeysByCommit(commits, [link('bbb222', 'feature/ACT-1')]);
    const [ticket] = developerTickets(commits, keys, [story('ACT-1')]).tickets;
    expect(ticket.commitList).toEqual([
      {
        sha: 'bbb222',
        repo: 'acme/ehr',
        message: 'tidy',
        committedAt: '2026-10-16T05:00:00.000Z',
        additions: 2,
        deletions: 0,
        linkedVia: ['branch'],
        notCreditedTo: [],
      },
      {
        sha: 'aaa111',
        repo: 'acme/ehr',
        message: 'ACT-1 start',
        committedAt: '2026-10-14T05:00:00.000Z',
        additions: 5,
        deletions: 1,
        linkedVia: ['message'],
        notCreditedTo: [],
      },
    ]);
  });

  it('caps each ticket’s commit list while `commits` keeps the full count', () => {
    const commits = Array.from({ length: 4 }, (_, i) =>
      commit(`s${i}`, `2026-10-1${i}T05:00:00Z`, 'ACT-1'),
    );
    const [ticket] = developerTickets(
      commits,
      ticketKeysByCommit(commits, []),
      [story('ACT-1')],
      50,
      2,
    ).tickets;
    expect(ticket.commits).toBe(4);
    expect(ticket.commitList.map((c) => c.sha)).toEqual(['s3', 's2']);
  });

  it('falls back to the authored date when the committer date is missing', () => {
    const c = {
      ...commit('a', '2026-10-14T05:00:00Z', 'ACT-1'),
      committedAt: null,
    };
    const [ticket] = developerTickets([c], ticketKeysByCommit([c], []), [
      story('ACT-1'),
    ]).tickets;
    expect(ticket.lastCommitAt).toBe('2026-10-14T05:00:00.000Z');
  });
});
