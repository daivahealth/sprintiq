import { branchKey } from '../modules/code/code.service';
import { developerBranches } from './developer-branches';

const commit = (sha: string, at: string, additions = 10, deletions = 0) => ({
  repoFullName: 'acme/ehr',
  sha,
  additions,
  deletions,
  committedAt: new Date(at),
  authoredAt: new Date(at),
});
const link = (sha: string, branch: string, repoFullName = 'acme/ehr') => ({
  repoFullName,
  branch,
  sha,
});

describe('developerBranches', () => {
  it('counts a commit on two branches on both, with lines and last commit', () => {
    const { branches } = developerBranches(
      [
        commit('a', '2026-10-14T05:00:00Z', 30, 5),
        commit('b', '2026-10-15T05:00:00Z'),
      ],
      [link('a', 'feat-x'), link('a', 'release-1'), link('b', 'feat-x')],
      new Map(),
    );
    const feat = branches.find((b) => b.branch === 'feat-x');
    const rel = branches.find((b) => b.branch === 'release-1');
    expect(feat).toMatchObject({
      commits: 2,
      locChanged: 45,
      lastCommitAt: '2026-10-15T05:00:00.000Z',
    });
    expect(rel).toMatchObject({
      commits: 1,
      locChanged: 35,
      lastCommitAt: '2026-10-14T05:00:00.000Z',
    });
  });

  it('labels each branch with its PR status and "none" when there is no PR', () => {
    const { branches } = developerBranches(
      [
        commit('a', '2026-10-14T05:00:00Z'),
        commit('b', '2026-10-15T05:00:00Z'),
      ],
      [link('a', 'merged-one'), link('b', 'no-pr')],
      new Map([[branchKey('acme/ehr', 'merged-one'), 'merged' as const]]),
    );
    expect(
      Object.fromEntries(branches.map((b) => [b.branch, b.prStatus])),
    ).toEqual({
      'merged-one': 'merged',
      'no-pr': 'none',
    });
  });

  it('orders by last activity, never by volume, caps the rows and reports the total', () => {
    const commits = Array.from({ length: 5 }, (_, i) =>
      commit(`c${i}`, `2026-10-1${i}T05:00:00Z`, i === 0 ? 10_000 : 1),
    );
    const { branches, branchesTotal } = developerBranches(
      commits,
      commits.map((c, i) => link(c.sha, `b${i}`)),
      new Map(),
      3,
    );
    expect(branches.map((b) => b.branch)).toEqual(['b4', 'b3', 'b2']);
    expect(branchesTotal).toBe(5);
  });

  it("ignores links to commits that are not this developer's", () => {
    const { branches, branchesTotal } = developerBranches(
      [commit('mine', '2026-10-14T05:00:00Z')],
      [
        link('mine', 'feat'),
        link('someone-else', 'feat'),
        link('mine', 'feat', 'acme/other'),
      ],
      new Map(),
    );
    expect(branchesTotal).toBe(1);
    expect(branches[0]).toMatchObject({ repoFullName: 'acme/ehr', commits: 1 });
  });
});
