import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GithubActivitySnapshot,
  GithubActivityVerifyService,
} from '../collectors/sources/github/github-activity-verify.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { CodeService } from '../modules/code/code.service';
import {
  ReconciliationResult,
  reconcileActivity,
} from './activity-verification.reconcile';

/**
 * Point lookups per run for records SprintIQ counts that the range scan did
 * not return. Each costs a fraction of a GraphQL point; the cap bounds a
 * pathological run, and anything beyond it is reported `not_looked_up`.
 */
const LOOKUP_CAP = 300;

/** Mirrors `listPullRequestsByAuthor`'s `take` — reaching it means the DB side was cut. */
const PR_READ_CAP = 500;

/**
 * How records are matched and counted, sent with every report so the reader
 * never has to guess what a delta means.
 */
export const VERIFICATION_RULES = [
  'Records are matched by identity — repository + commit SHA, repository + PR number, review id — never by totals.',
  'Commits are read from every live branch whose tip is in the range, plus the commit lists of this developer’s PRs; branches whose tip predates the range are skipped because they cannot hold a commit in it.',
  'A commit is this developer’s when GitHub links it to one of their logins, or — only when GitHub links it to no account — its author email is one of theirs. The same rule SprintIQ counts by.',
  'Commits are windowed by committer date; merge commits are excluded from commit and line counts, as on the Developer page.',
  'PRs are those this developer opened in the range; reviews are their non-bot reviews submitted in the range.',
  'Anything GitHub could not fully answer (rate limit, access, time budget) is listed as unverified, and SprintIQ records in that scope are “could not verify”, never “missing”.',
  'Verification is read-only: nothing it finds is written back.',
];

export interface ActivityVerificationReport extends ReconciliationResult {
  developer: string;
  identity: { logins: string[]; emails: string[] };
  range: { from: string; to: string };
  scope: 'active' | 'all';
  coverage: GithubActivitySnapshot['coverage'] & {
    /** The DB read hit its ceiling; the stored figures are a floor. */
    dbCommitsTruncated: boolean;
    dbPullRequestsTruncated: boolean;
    commitLookups: number;
    commitLookupsSkipped: number;
  };
  rules: string[];
  generatedAt: string;
}

/**
 * Developer activity verification (BC-13 read model,
 * docs/features/DASHBOARDS.md §4.4.3): what the Developer page counts for
 * one person and range, reconciled record by record against an independent
 * GitHub read. Read-only end to end — it never inserts, updates or deletes
 * activity, and never feeds a metric.
 */
@Injectable()
export class ActivityVerificationService {
  constructor(
    private readonly identities: DeveloperIdentityService,
    private readonly code: CodeService,
    private readonly github: GithubActivityVerifyService,
  ) {}

  async verify(
    tenantId: string,
    developer: string,
    from: Date,
    to: Date,
    scope: 'active' | 'all',
  ): Promise<ActivityVerificationReport> {
    const aliases = await this.identities.aliasesFor(tenantId, developer);
    if (aliases.logins.length === 0 && aliases.emails.length === 0) {
      throw new NotFoundException(
        `No GitHub login or email is known for developer "${developer}".`,
      );
    }

    // The Developer page's own reads, with its own predicates.
    const [commitPage, pullRequests, reviews] = await Promise.all([
      this.code.listCommitsPage(tenantId, {
        authorLogins: aliases.logins,
        authorEmails: aliases.emails,
        from,
        to,
      }),
      this.code.listPullRequestsByAuthor(tenantId, aliases.logins, from, to),
      this.code.listReviewsByReviewer(tenantId, aliases.logins, from, to),
    ]);
    const db = { commits: commitPage.commits, pullRequests, reviews };

    const hintRepos = [
      ...new Set([
        ...db.commits.map((c) => c.repoFullName),
        ...db.pullRequests.map((p) => p.repoFullName),
      ]),
    ];
    const snapshot = await this.github.verify({
      tenantId,
      logins: aliases.logins,
      emails: aliases.emails,
      from,
      to,
      scope,
      hintRepos,
    });

    const [commitsByKey, pullsByKey, reviewsByKey] = await Promise.all([
      this.code.findCommitsByShas(
        tenantId,
        snapshot.commits.map((c) => c.sha),
      ),
      this.code.findPullRequestsByNumbers(
        tenantId,
        snapshot.pullRequests.map((p) => ({
          repoFullName: p.repoFullName,
          externalNumber: p.number,
        })),
      ),
      this.code.findReviewsByExternalIds(
        tenantId,
        snapshot.reviews.map((r) => r.externalId),
      ),
    ]);

    const returned = new Set(
      snapshot.commits.map((c) => `${c.repoFullName} ${c.sha}`),
    );
    const unreturned = db.commits.filter(
      (c) => !returned.has(`${c.repoFullName} ${c.sha}`),
    );
    const toLookUp = unreturned.slice(0, LOOKUP_CAP);
    const commitLookups =
      toLookUp.length > 0
        ? await this.github.lookupCommits(
            tenantId,
            toLookUp.map((c) => ({ repoFullName: c.repoFullName, sha: c.sha })),
          )
        : [];

    const result = reconcileActivity({
      db,
      dbByKey: {
        commits: commitsByKey,
        pullRequests: pullsByKey,
        reviews: reviewsByKey,
      },
      github: snapshot,
      commitLookups,
      identity: aliases,
      range: { from, to },
    });

    return {
      developer,
      identity: { logins: aliases.logins, emails: aliases.emails },
      range: { from: from.toISOString(), to: to.toISOString() },
      scope,
      ...result,
      coverage: {
        ...snapshot.coverage,
        dbCommitsTruncated: commitPage.truncated,
        dbPullRequestsTruncated: pullRequests.length >= PR_READ_CAP,
        commitLookups: commitLookups.length,
        commitLookupsSkipped: unreturned.length - toLookUp.length,
      },
      rules: VERIFICATION_RULES,
      generatedAt: new Date().toISOString(),
    };
  }
}
