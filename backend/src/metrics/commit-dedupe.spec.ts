import { distinctCommitsBySha } from './commit-dedupe';

const c = (sha: string, repoFullName: string, n = 0) => ({
  sha,
  repoFullName,
  n,
});

describe('distinctCommitsBySha', () => {
  it('counts a SHA held by several repositories once, keeping the alphabetically first repo', () => {
    const { commits, sharedCommitsCollapsed } = distinctCommitsBySha([
      c('aaa', 'acme/pe_platform_kiosk', 1),
      c('aaa', 'acme/caritas_kiosk_app', 2),
      c('aaa', 'acme/nhcare-kiosk-app', 3),
      c('bbb', 'acme/ehr', 4),
    ]);
    expect(commits.map((x) => [x.sha, x.repoFullName])).toEqual([
      ['aaa', 'acme/caritas_kiosk_app'],
      ['bbb', 'acme/ehr'],
    ]);
    expect(sharedCommitsCollapsed).toBe(2);
  });

  it('keeps the input order (newest first) of the commits it keeps', () => {
    const { commits } = distinctCommitsBySha([
      c('new', 'acme/b'),
      c('old', 'acme/a'),
      c('new', 'acme/a'),
    ]);
    expect(commits.map((x) => x.sha)).toEqual(['old', 'new']);
  });

  it('returns the input untouched when nothing is shared', () => {
    const input = [c('a', 'acme/x'), c('b', 'acme/x')];
    const out = distinctCommitsBySha(input);
    expect(out.commits).toBe(input);
    expect(out.sharedCommitsCollapsed).toBe(0);
  });

  it('never collapses different SHAs, even with identical content (cherry-picks count on each branch)', () => {
    expect(
      distinctCommitsBySha([c('pick1', 'acme/lis'), c('pick2', 'acme/lis')])
        .sharedCommitsCollapsed,
    ).toBe(0);
  });
});
