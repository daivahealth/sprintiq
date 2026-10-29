import { NotFoundException } from '@nestjs/common';
import { ActivityVerificationService } from './activity-verification.service';

describe('ActivityVerificationService', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-10-28T00:00:00Z');

  function commitRow(sha: string, repoFullName = 'acme/api') {
    return {
      repoFullName,
      sha,
      message: sha,
      authorLogin: 'dev',
      authorEmail: null,
      authoredAt: from,
      committedAt: from,
      additions: 1,
      deletions: 0,
      parentCount: 1,
    };
  }

  function setup(aliases = { logins: ['dev'], emails: ['dev@example.com'] }) {
    const identities = { aliasesFor: jest.fn().mockResolvedValue(aliases) };
    const code = {
      listCommitsPage: jest.fn().mockResolvedValue({
        commits: [commitRow('aaa'), commitRow('bbb', 'acme/web')],
        truncated: false,
      }),
      listPullRequestsByAuthor: jest.fn().mockResolvedValue([]),
      listReviewsByReviewer: jest.fn().mockResolvedValue([]),
      findCommitsByShas: jest.fn().mockResolvedValue([commitRow('aaa')]),
      findPullRequestsByNumbers: jest.fn().mockResolvedValue([]),
      findReviewsByExternalIds: jest.fn().mockResolvedValue([]),
    };
    const github = {
      verify: jest.fn().mockResolvedValue({
        commits: [
          {
            ...commitRow('aaa'),
            authorEmail: undefined,
            authoredAt: from.toISOString(),
            committedAt: from.toISOString(),
            branches: ['main'],
            pullRequests: [],
          },
        ],
        pullRequests: [],
        reviews: [],
        unverified: [],
        coverage: { reposScanned: ['acme/api', 'acme/web'], durationMs: 1 },
      }),
      lookupCommits: jest
        .fn()
        .mockResolvedValue([
          { repoFullName: 'acme/web', sha: 'bbb', status: 'not_found' },
        ]),
    };
    const service = new ActivityVerificationService(
      identities as never,
      code as never,
      github as never,
    );
    return { service, identities, code, github };
  }

  it('reads the page’s own DB figures, hints the stored repos, and looks up only unreturned commits', async () => {
    const { service, code, github } = setup();
    const report = await service.verify('t1', 'dev', from, to, 'active');

    expect(code.listCommitsPage).toHaveBeenCalledWith('t1', {
      authorLogins: ['dev'],
      authorEmails: ['dev@example.com'],
      from,
      to,
    });
    expect(github.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        scope: 'active',
        hintRepos: ['acme/api', 'acme/web'],
      }),
    );
    expect(code.findCommitsByShas).toHaveBeenCalledWith('t1', ['aaa']);
    expect(github.lookupCommits).toHaveBeenCalledWith('t1', [
      { repoFullName: 'acme/web', sha: 'bbb' },
    ]);
    expect(report.counts.commits).toMatchObject({ matched: 1, onlyInDb: 1 });
    expect(report.status).toBe('discrepancies');
    expect(report.rules.length).toBeGreaterThan(0);
    expect(report.coverage).toMatchObject({
      commitLookups: 1,
      dbCommitsTruncated: false,
    });
  });

  it('refuses a developer with no GitHub identity rather than reporting zeros', async () => {
    const { service, github } = setup({ logins: [], emails: [] });
    await expect(
      service.verify('t1', 'ghost', from, to, 'active'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(github.verify).not.toHaveBeenCalled();
  });
});
