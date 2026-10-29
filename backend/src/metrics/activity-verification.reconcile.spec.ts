import type {
  CommitLookup,
  GithubActivitySnapshot,
  VerifiedCommit,
} from '../collectors/sources/github/github-activity-verify.service';
import {
  DbCommit,
  DbPullRequest,
  DbReview,
  ReconcileInput,
  canonicalLogin,
  reconcileActivity,
} from './activity-verification.reconcile';

const REPO = 'acme/api';
const range = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-10-28T00:00:00Z'),
};
const identity = { logins: ['dev'], emails: ['dev@example.com'] };

function dbCommit(sha: string, over: Partial<DbCommit> = {}): DbCommit {
  return {
    repoFullName: REPO,
    sha,
    message: `msg ${sha}`,
    authorLogin: 'dev',
    authorEmail: 'dev@example.com',
    authoredAt: new Date('2026-10-05T10:00:00Z'),
    committedAt: new Date('2026-10-05T10:00:00Z'),
    additions: 10,
    deletions: 2,
    parentCount: 1,
    ...over,
  };
}

function ghCommit(
  sha: string,
  over: Partial<VerifiedCommit> = {},
): VerifiedCommit {
  return {
    repoFullName: REPO,
    sha,
    message: `msg ${sha}`,
    authorLogin: 'dev',
    authorEmail: 'dev@example.com',
    authoredAt: '2026-10-05T10:00:00Z',
    committedAt: '2026-10-05T10:00:00Z',
    additions: 10,
    deletions: 2,
    parentCount: 1,
    branches: ['main'],
    pullRequests: [],
    ...over,
  };
}

function dbPr(n: string, over: Partial<DbPullRequest> = {}): DbPullRequest {
  return {
    repoFullName: REPO,
    externalNumber: n,
    title: `PR ${n}`,
    branch: 'feature',
    state: 'merged',
    authorLogin: 'dev',
    additions: 5,
    deletions: 1,
    openedAt: new Date('2026-10-02T00:00:00Z'),
    mergedAt: new Date('2026-10-03T00:00:00Z'),
    ...over,
  };
}

function dbReview(id: string, over: Partial<DbReview> = {}): DbReview {
  return {
    externalId: id,
    repoFullName: REPO,
    externalNumber: '9',
    reviewerLogin: 'dev',
    isBot: false,
    state: 'approved',
    submittedAt: new Date('2026-10-06T00:00:00Z'),
    ...over,
  };
}

function snapshot(
  over: Partial<GithubActivitySnapshot> = {},
): GithubActivitySnapshot {
  return {
    commits: [],
    pullRequests: [],
    reviews: [],
    unverified: [],
    coverage: {
      scope: 'active',
      collectedRepos: 1,
      reposScanned: [REPO],
      reposNotScanned: 0,
      branchesScanned: 1,
      branchesSkippedInactive: 0,
      pullRequestsOutsideCollectedRepos: 0,
      reviewsOutsideCollectedRepos: 0,
      loginsResolved: ['dev'],
      loginsUnresolved: [],
      collectedThrough: {},
      renamedRepos: [],
      durationMs: 1,
    },
    ...over,
  };
}

function input(over: {
  db?: Partial<ReconcileInput['db']>;
  dbByKey?: Partial<ReconcileInput['dbByKey']>;
  github?: Partial<GithubActivitySnapshot>;
  commitLookups?: CommitLookup[];
}): ReconcileInput {
  return {
    db: { commits: [], pullRequests: [], reviews: [], ...over.db },
    dbByKey: { commits: [], pullRequests: [], reviews: [], ...over.dbByKey },
    github: snapshot(over.github),
    commitLookups: over.commitLookups ?? [],
    identity,
    range,
  };
}

describe('reconcileActivity — commits', () => {
  it('reports a full match when every record agrees', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('aaa')] },
        github: { commits: [ghCommit('aaa')] },
      }),
    );
    expect(r.status).toBe('match');
    expect(r.counts.commits).toEqual({
      matched: 1,
      missingInDb: 0,
      mismatched: 0,
      onlyInDb: 0,
      unverifiable: 0,
      pendingSync: 0,
    });
    expect(r.items).toEqual([]);
  });

  it('flags a commit GitHub has and SprintIQ never collected as missing_in_db', () => {
    const r = reconcileActivity(
      input({
        github: { commits: [ghCommit('bbb', { branches: ['feature/x'] })] },
      }),
    );
    expect(r.items).toEqual([
      expect.objectContaining({
        kind: 'commit',
        category: 'missing_in_db',
        code: 'not_collected',
        ref: 'bbb',
      }),
    ]);
    expect(r.items[0].reason).toContain('feature/x');
    expect(r.status).toBe('discrepancies');
  });

  it('calls out a commit stored with no line changes', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('aaa', { additions: 0, deletions: 0 })] },
        github: { commits: [ghCommit('aaa')] },
      }),
    );
    expect(r.items[0]).toMatchObject({
      category: 'mismatched',
      code: 'lines_not_recorded',
    });
    expect(r.items[0].diffs).toEqual([
      { field: 'additions', db: 0, github: 10 },
      { field: 'deletions', db: 0, github: 2 },
    ]);
  });

  it('separates a mis-attributed commit from a missing one', () => {
    const stored = dbCommit('aaa', { authorLogin: 'someone-else' });
    const r = reconcileActivity(
      input({
        dbByKey: { commits: [stored] },
        github: { commits: [ghCommit('aaa')] },
      }),
    );
    expect(r.items[0]).toMatchObject({
      category: 'mismatched',
      code: 'not_counted_for_developer',
    });
    expect(r.items[0].diffs.map((d) => d.field)).toEqual([
      'attribution',
      'authorLogin',
    ]);
    expect(r.counts.commits.missingInDb).toBe(0);
  });

  it('notices a commit stored under a different repository', () => {
    const r = reconcileActivity(
      input({
        dbByKey: { commits: [dbCommit('aaa', { repoFullName: 'acme/fork' })] },
        github: { commits: [ghCommit('aaa')] },
      }),
    );
    expect(r.items[0]).toMatchObject({
      category: 'mismatched',
      code: 'stored_under_other_repo',
    });
  });

  it('ignores an unknown merge flag rather than reporting it as wrong', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('aaa', { parentCount: null })] },
        github: { commits: [ghCommit('aaa')] },
      }),
    );
    expect(r.status).toBe('match');
  });

  describe('records only SprintIQ holds', () => {
    it('is only_in_db / not_on_github when GitHub has no such commit', () => {
      const r = reconcileActivity(
        input({
          db: { commits: [dbCommit('gone')] },
          commitLookups: [
            { repoFullName: REPO, sha: 'gone', status: 'not_found' },
          ],
        }),
      );
      expect(r.items[0]).toMatchObject({
        category: 'only_in_db',
        code: 'not_on_github',
      });
    });

    it('is only_in_db / not_on_live_branch when it exists but no live branch reaches it', () => {
      const r = reconcileActivity(
        input({
          db: { commits: [dbCommit('sq')] },
          commitLookups: [
            {
              repoFullName: REPO,
              sha: 'sq',
              status: 'found',
              commit: ghCommit('sq', { branches: [] }),
            },
          ],
        }),
      );
      expect(r.items[0]).toMatchObject({
        category: 'only_in_db',
        code: 'not_on_live_branch',
      });
    });

    it('pairs a rebased commit with its replacement instead of calling the branch deleted', () => {
      const old = dbCommit('old1', {
        message: 'Add cardio view\n\nbody',
        authoredAt: new Date('2026-10-26T16:53:51Z'),
        committedAt: new Date('2026-10-26T16:53:51Z'),
      });
      const replacement = ghCommit('new1', {
        message: 'Add cardio view',
        authoredAt: '2026-10-26T16:53:51Z',
        committedAt: '2026-10-28T11:44:47Z',
        branches: ['feature/cardio-3d'],
      });
      const r = reconcileActivity(
        input({
          db: { commits: [old] },
          // The replacement is also stored: the same work, counted twice.
          dbByKey: { commits: [dbCommit('new1')] },
          github: { commits: [replacement] },
          commitLookups: [
            {
              repoFullName: REPO,
              sha: 'old1',
              status: 'found',
              commit: ghCommit('old1', { branches: [] }),
            },
          ],
        }),
      );
      const item = r.items.find((i) => i.ref === 'old1');
      expect(item).toMatchObject({
        category: 'only_in_db',
        code: 'rewritten_on_github',
      });
      expect(item?.reason).toMatch(
        /replaced by new1 \(branch feature\/cardio-3d\)/,
      );
      expect(item?.reason).toMatch(/counted twice/);
    });

    it('pairs a rewrite whose message was also edited when exactly one commit fits', () => {
      const old = dbCommit('old2', {
        message: 'Cardio 3D: anga 683667f — selected part',
        authoredAt: new Date('2026-10-26T17:36:31Z'),
      });
      const r = reconcileActivity(
        input({
          db: { commits: [old] },
          github: {
            commits: [
              ghCommit('new2', {
                message: 'Cardio 3D: anga 9792137 — selected part',
                authoredAt: '2026-10-26T17:36:31Z',
                committedAt: '2026-10-28T11:44:48Z',
              }),
            ],
          },
          commitLookups: [
            {
              repoFullName: REPO,
              sha: 'old2',
              status: 'found',
              commit: ghCommit('old2', { branches: [] }),
            },
          ],
        }),
      );
      const item = r.items.find((i) => i.ref === 'old2');
      expect(item?.code).toBe('rewritten_on_github');
      expect(item?.reason).toMatch(/message edited/);
    });

    it('does not pair when two GitHub commits could be the replacement', () => {
      const old = dbCommit('old1', { message: 'wip' });
      const twin = (sha: string) =>
        ghCommit(sha, {
          message: 'wip',
          authoredAt: old.authoredAt.toISOString(),
        });
      const r = reconcileActivity(
        input({
          db: { commits: [old] },
          github: { commits: [twin('n1'), twin('n2')] },
          commitLookups: [
            {
              repoFullName: REPO,
              sha: 'old1',
              status: 'found',
              commit: ghCommit('old1', { branches: [] }),
            },
          ],
        }),
      );
      expect(r.items.find((i) => i.ref === 'old1')?.code).toBe(
        'not_on_live_branch',
      );
    });

    it('is only_in_db / github_disagrees when GitHub names a different author', () => {
      const r = reconcileActivity(
        input({
          db: { commits: [dbCommit('x')] },
          commitLookups: [
            {
              repoFullName: REPO,
              sha: 'x',
              status: 'found',
              commit: ghCommit('x', { authorLogin: 'other' }),
            },
          ],
        }),
      );
      expect(r.items[0]).toMatchObject({
        category: 'only_in_db',
        code: 'github_disagrees',
      });
    });

    it('is unverifiable — never missing — when the repository was not fully read', () => {
      const r = reconcileActivity(
        input({
          db: {
            commits: [
              dbCommit('a1'),
              dbCommit('b1', { repoFullName: 'acme/web' }),
            ],
          },
          github: {
            unverified: [
              {
                kind: 'commits',
                repoFullName: REPO,
                reason: 'rate_limited',
                detail: '',
              },
            ],
          },
        }),
      );
      expect(r.items.map((i) => [i.ref, i.category, i.code])).toEqual([
        ['a1', 'unverifiable', 'scope_not_read'],
        ['b1', 'unverifiable', 'scope_not_read'],
      ]);
      expect(r.counts.commits.onlyInDb).toBe(0);
      expect(r.status).toBe('incomplete');
    });

    it('is unverifiable when the lookup cap left it unchecked', () => {
      const r = reconcileActivity(
        input({ db: { commits: [dbCommit('zzz')] } }),
      );
      expect(r.items[0]).toMatchObject({
        category: 'unverifiable',
        code: 'not_looked_up',
      });
    });
  });

  it('summarises both sides by the page’s rules: one row per SHA, merges out', () => {
    const r = reconcileActivity(
      input({
        db: {
          commits: [
            dbCommit('a'),
            dbCommit('a', { repoFullName: 'acme/copy' }),
            dbCommit('m', { parentCount: 2, additions: 999 }),
          ],
        },
        github: {
          commits: [
            ghCommit('a'),
            ghCommit('b', { additions: 3, deletions: 0 }),
            ghCommit('m', { parentCount: 2 }),
          ],
          unverified: [{ kind: 'reviews', reason: 'failed', detail: '' }],
        },
      }),
    );
    const byMetric = Object.fromEntries(r.summary.map((s) => [s.metric, s]));
    expect(byMetric.commits).toMatchObject({
      db: 1,
      github: 2,
      delta: 1,
      complete: true,
    });
    expect(byMetric.additions).toMatchObject({ db: 10, github: 13, delta: 3 });
    expect(byMetric.reviewsGiven.complete).toBe(false);
  });
});

describe('reconcileActivity — pull requests', () => {
  const gh = {
    repoFullName: REPO,
    number: '7',
    title: 'PR 7',
    state: 'merged' as const,
    authorLogin: 'dev',
    openedAt: '2026-10-02T00:00:00Z',
    mergedAt: '2026-10-03T00:00:00Z',
    additions: 5,
    deletions: 1,
  };

  it('matches, flags missing, flags mismatched state and reports unreturned ones', () => {
    const r = reconcileActivity(
      input({
        db: {
          pullRequests: [
            dbPr('7'),
            dbPr('8', { state: 'open', mergedAt: null }),
            dbPr('99'),
          ],
        },
        github: {
          pullRequests: [
            gh,
            { ...gh, number: '8' },
            { ...gh, number: '10', title: 'new' },
          ],
        },
      }),
    );
    expect(r.counts.pullRequests).toEqual({
      matched: 1,
      missingInDb: 1,
      mismatched: 1,
      onlyInDb: 1,
      unverifiable: 0,
      pendingSync: 0,
    });
    const pr8 = r.items.find((i) => i.ref === '#8');
    expect(pr8?.diffs.map((d) => d.field)).toEqual(['state', 'mergedAt']);
    expect(r.items.find((i) => i.ref === '#99')).toMatchObject({
      category: 'only_in_db',
      code: 'not_returned',
    });
    const merged = r.summary.find((s) => s.metric === 'prsMerged');
    expect(merged).toMatchObject({ db: 2, github: 3 });
  });

  it('treats unreturned PRs as unverifiable when the search did not complete', () => {
    const r = reconcileActivity(
      input({
        db: { pullRequests: [dbPr('99')] },
        github: {
          unverified: [
            { kind: 'pull_requests', reason: 'rate_limited', detail: '' },
          ],
        },
      }),
    );
    expect(r.items[0]).toMatchObject({
      category: 'unverifiable',
      code: 'scope_not_read',
    });
  });
});

describe('reconcileActivity — reviews', () => {
  const gh = {
    externalId: '101',
    repoFullName: REPO,
    number: '9',
    reviewerLogin: 'dev',
    isBot: false,
    state: 'approved',
    submittedAt: '2026-10-06T00:00:00Z',
  };

  it('matches by review id and reports the rest', () => {
    const r = reconcileActivity(
      input({
        db: {
          reviews: [
            dbReview('101'),
            dbReview('102', { state: 'commented' }),
            dbReview('500'),
          ],
        },
        github: {
          reviews: [
            gh,
            { ...gh, externalId: '102', state: 'dismissed' },
            { ...gh, externalId: '103' },
            { ...gh, externalId: '104', isBot: true },
          ],
        },
      }),
    );
    expect(r.counts.reviews).toEqual({
      matched: 1,
      missingInDb: 1,
      mismatched: 1,
      onlyInDb: 1,
      unverifiable: 0,
      pendingSync: 0,
    });
    expect(r.summary.find((s) => s.metric === 'reviewsGiven')).toMatchObject({
      db: 3,
      github: 3,
    });
  });
});

describe('reconcileActivity — REST vs GraphQL differences are not discrepancies', () => {
  it('ignores line-stat differences on merge commits', () => {
    const r = reconcileActivity(
      input({
        db: {
          commits: [
            dbCommit('m', { parentCount: 2, additions: 999, deletions: 5 }),
          ],
        },
        github: { commits: [ghCommit('m', { parentCount: 2 })] },
      }),
    );
    expect(r.status).toBe('match');
  });

  it('still compares lines on ordinary commits', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('a', { additions: 11 })] },
        github: { commits: [ghCommit('a')] },
      }),
    );
    expect(r.items[0].diffs).toEqual([
      { field: 'additions', db: 11, github: 10 },
    ]);
  });

  it('treats one account’s REST and GraphQL logins as the same', () => {
    expect(canonicalLogin('Copilot')).toBe(canonicalLogin('copilot-swe-agent'));
    expect(canonicalLogin('Copilot')).toBe(
      canonicalLogin('copilot-pull-request-reviewer'),
    );
    expect(canonicalLogin('dependabot[bot]')).toBe(
      canonicalLogin('dependabot'),
    );
    expect(canonicalLogin('Dev')).toBe('dev');
    expect(canonicalLogin(null)).toBeNull();
    const gh = {
      repoFullName: REPO,
      number: '7',
      title: 'PR 7',
      state: 'merged' as const,
      authorLogin: 'dev',
      openedAt: '2026-10-02T00:00:00Z',
      mergedAt: '2026-10-03T00:00:00Z',
      additions: 5,
      deletions: 1,
    };
    const r = reconcileActivity(
      input({
        db: { pullRequests: [dbPr('7', { authorLogin: 'Dev' })] },
        github: { pullRequests: [gh] },
      }),
    );
    expect(r.status).toBe('match');
  });

  it('labels a login GitHub added after collection as stale attribution, not an error', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('a', { authorLogin: null })] },
        github: { commits: [ghCommit('a')] },
      }),
    );
    expect(r.items[0]).toMatchObject({
      category: 'mismatched',
      code: 'attribution_updated_on_github',
    });
    expect(r.items[0].reason).toMatch(/now links this commit to dev/);
  });

  it('calls it stale attribution only when the login is the sole difference', () => {
    const r = reconcileActivity(
      input({
        db: { commits: [dbCommit('a', { authorLogin: null })] },
        github: {
          commits: [ghCommit('a', { authorLogin: 'dev', additions: 3 })],
        },
      }),
    );
    expect(r.items[0].code).not.toBe('attribution_updated_on_github');
  });
});

describe('reconcileActivity — timing is not a collection fault', () => {
  const coverage = (collectedThrough: Record<string, string | null>) => ({
    ...snapshot().coverage,
    collectedThrough,
  });

  it('reports records newer than the last completed sync as pending, not missing', () => {
    const r = reconcileActivity(
      input({
        github: {
          coverage: coverage({ [REPO]: '2026-10-05T06:00:00Z' }),
          commits: [
            ghCommit('new', { committedAt: '2026-10-05T10:00:00Z' }),
            ghCommit('old', { committedAt: '2026-10-04T10:00:00Z' }),
          ],
        },
      }),
    );
    expect(r.items.map((i) => [i.ref, i.category, i.code])).toEqual([
      ['new', 'pending_sync', 'not_collected_yet'],
      ['old', 'missing_in_db', 'not_collected'],
    ]);
    expect(r.counts.commits.pendingSync).toBe(1);
  });

  it('holds branch commits to the audit-log route’s checkpoint too, but not PRs', () => {
    const r = reconcileActivity(
      input({
        github: {
          coverage: {
            ...coverage({ [REPO]: '2026-10-28T13:00:00Z' }),
            branchCommitsCollectedThrough: '2026-10-27T09:35:00Z',
          },
          commits: [
            ghCommit('branch', { committedAt: '2026-10-28T11:44:00Z' }),
            ghCommit('older', { committedAt: '2026-10-27T08:00:00Z' }),
          ],
          pullRequests: [
            {
              repoFullName: REPO,
              number: '7',
              title: 'PR 7',
              state: 'open',
              authorLogin: 'dev',
              openedAt: '2026-10-28T11:00:00Z',
              additions: 1,
              deletions: 0,
            },
          ],
        },
      }),
    );
    expect(r.items.map((i) => [i.ref, i.category])).toEqual([
      ['branch', 'pending_sync'],
      ['older', 'missing_in_db'],
      ['#7', 'missing_in_db'],
    ]);
    expect(r.items[0].reason).toMatch(/audit-log route’s checkpoint/);
  });

  it('treats a PR merged after the last sync as pending, but not other field changes', () => {
    const gh = {
      repoFullName: REPO,
      number: '3',
      title: 'PR 3',
      state: 'merged' as const,
      authorLogin: 'dev',
      openedAt: '2026-10-26T16:48:38Z',
      mergedAt: '2026-10-28T13:05:12Z',
      additions: 2131,
      deletions: 333,
    };
    const stale = dbPr('3', {
      state: 'open',
      mergedAt: null,
      additions: 446,
      deletions: 236,
      openedAt: new Date('2026-10-26T16:48:38Z'),
    });
    const cov = coverage({ [REPO]: '2026-10-28T08:00:29Z' });
    const pending = reconcileActivity(
      input({
        db: { pullRequests: [stale] },
        github: { coverage: cov, pullRequests: [gh] },
      }),
    );
    expect(pending.items[0]).toMatchObject({
      category: 'pending_sync',
      code: 'changed_since_sync',
    });
    expect(pending.status).toBe('match');

    const wrongAuthor = reconcileActivity(
      input({
        db: { pullRequests: [{ ...stale, authorLogin: 'someone' }] },
        dbByKey: { pullRequests: [{ ...stale, authorLogin: 'someone' }] },
        github: { coverage: cov, pullRequests: [gh] },
      }),
    );
    expect(wrongAuthor.items[0].category).toBe('mismatched');
  });

  it('treats a still-backfilling repository’s records as pending, and pending alone as a match', () => {
    const r = reconcileActivity(
      input({
        github: {
          coverage: coverage({ [REPO]: null }),
          commits: [ghCommit('a')],
          pullRequests: [
            {
              repoFullName: REPO,
              number: '7',
              title: 'PR 7',
              state: 'open',
              authorLogin: 'dev',
              openedAt: '2026-10-02T00:00:00Z',
              additions: 1,
              deletions: 0,
            },
          ],
        },
      }),
    );
    expect(r.items.every((i) => i.category === 'pending_sync')).toBe(true);
    expect(r.status).toBe('match');
  });

  it('treats a just-opened PR or review search did not return as unverifiable', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    const fresh = new Date(now.getTime() - 5 * 60 * 1000);
    const r = reconcileActivity({
      ...input({
        db: {
          pullRequests: [
            dbPr('50', { openedAt: fresh, mergedAt: null, state: 'open' }),
          ],
          reviews: [dbReview('900', { submittedAt: fresh })],
        },
      }),
      now,
    });
    expect(r.items.map((i) => [i.kind, i.category, i.code])).toEqual([
      ['pull_request', 'unverifiable', 'search_index_lag'],
      ['review', 'unverifiable', 'search_index_lag'],
    ]);
    expect(r.status).toBe('incomplete');
  });

  it('marks a run with unchecked records incomplete even without an unverified scope', () => {
    const r = reconcileActivity(input({ db: { commits: [dbCommit('zzz')] } }));
    expect(r.status).toBe('incomplete');
  });
});

describe('reconcileActivity — unverified scopes', () => {
  it('collapses repeated scopes from a halted run', () => {
    const scope = {
      kind: 'pull_requests' as const,
      reason: 'rate_limited' as const,
      detail: 'x',
    };
    const r = reconcileActivity(
      input({ github: { unverified: [scope, scope, scope] } }),
    );
    expect(r.unverified).toHaveLength(1);
  });
});
