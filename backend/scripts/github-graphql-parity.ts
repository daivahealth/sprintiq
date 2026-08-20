/**
 * GraphQL/REST parity harness — the pre-cutover check ADR-0008 requires.
 *
 * Not a unit test: it needs a live token and a real repository, because the
 * whole question is whether GraphQL's field *semantics* match REST's on actual
 * data. Mocks cannot answer that — they would only re-assert what this code
 * already assumes.
 *
 * The field that matters most is `author.user.login`. REST populates
 * `commit.author.login` only when the commit's email is verified on a GitHub
 * account, and §12 #22's identity resolution is built on exactly that
 * behaviour — it recovered 15 of 19 identities and closed a 19.2%-of-commits
 * discrepancy on the reference tenant. A silent semantic difference here
 * regresses it invisibly, which is why `authorLogin` is reported as CRITICAL
 * below and everything else merely as a difference.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... npx ts-node scripts/github-graphql-parity.ts owner/repo [more/repos...]
 *
 * Exit code is 1 when any critical difference is found, so it can gate a
 * cutover in CI.
 */
import { GithubGraphqlClient } from '../src/collectors/sources/github/github-graphql.client';
import { GithubClient } from '../src/collectors/sources/github/github.client';

/** How many PRs / commits to compare per repo. Kept small — this is a spot check, not a re-collection. */
const SAMPLE = 25;

interface Diff {
  entity: string;
  key: string;
  field: string;
  rest: unknown;
  graphql: unknown;
  critical: boolean;
}

/**
 * What this run actually managed to compare.
 *
 * Load-bearing, and for the same reason the collectors distinguish `failed`
 * from empty: a comparison that never ran produces zero differences, which is
 * byte-identical to a comparison that ran and found none. Reporting the first
 * as "safe to cut over" is the worst version of that mistake, because it is
 * the check standing between a silent metric regression and production.
 */
interface Coverage {
  /** Sections that completed: "<repo> pulls" / "<repo> commits". */
  compared: string[];
  /** Sections that could not run, with why. */
  skipped: { section: string; reason: string }[];
}

function record(
  diffs: Diff[],
  entity: string,
  key: string,
  field: string,
  rest: unknown,
  graphql: unknown,
  critical = false,
): void {
  // Normalise the shapes that are legitimately different rather than wrong:
  // undefined and null both mean "absent" across the two transports.
  const a = rest ?? null;
  const b = graphql ?? null;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs.push({ entity, key, field, rest: a, graphql: b, critical });
  }
}

async function comparePulls(
  repo: string,
  token: string,
  rest: GithubClient,
  graphql: GithubGraphqlClient,
  diffs: Diff[],
  coverage: Coverage,
): Promise<void> {
  const restPage = await rest.listPullRequestsPage(repo, token, { page: 1 });
  const gqlPage = await graphql.listPullRequestsPage(repo, token, { page: 1 });

  if (restPage.failed || gqlPage.failed) {
    const reason = `PR page failed (rest=${!!restPage.failed} graphql=${!!gqlPage.failed})`;
    console.error(`  ! ${repo}: ${reason} — cannot compare`);
    coverage.skipped.push({ section: `${repo} pulls`, reason });
    return;
  }

  const gqlByNumber = new Map(gqlPage.items.map((p) => [p.number, p]));
  const sample = restPage.items.slice(0, SAMPLE);
  console.log(`  PRs: comparing ${sample.length}`);
  coverage.compared.push(`${repo} pulls (${sample.length})`);

  for (const restPr of sample) {
    const gqlPr = gqlByNumber.get(restPr.number);
    const key = `${repo}#${restPr.number}`;
    if (!gqlPr) {
      diffs.push({
        entity: 'pull',
        key,
        field: '(missing)',
        rest: 'present',
        graphql: 'absent',
        critical: true,
      });
      continue;
    }

    record(diffs, 'pull', key, 'state', restPr.state, gqlPr.state);
    record(diffs, 'pull', key, 'merged_at', restPr.merged_at, gqlPr.merged_at);
    record(
      diffs,
      'pull',
      key,
      'updated_at',
      restPr.updated_at,
      gqlPr.updated_at,
    );
    // additions/deletions/changed_files are deliberately NOT compared here:
    // REST's PR *list* endpoint never carries them (api/README.md §3, which is
    // the whole reason a per-PR detail call exists), while GraphQL returns them
    // inline. null -> 31 is that documented difference, not a defect — the
    // meaningful comparison is against REST's detail response, below.
    record(diffs, 'pull', key, 'baseRef', restPr.base?.ref, gqlPr.base?.ref);
    // The PR author drives every people metric; a mismatch mis-attributes work.
    record(
      diffs,
      'pull',
      key,
      'authorLogin',
      restPr.user?.login,
      gqlPr.user?.login,
      true,
    );

    // Enrichment: REST spends 4 calls here, GraphQL already has it cached.
    const [restDetail, gqlDetail] = await Promise.all([
      rest.getPullRequestDetail(repo, token, restPr.number),
      graphql.getPullRequestDetail(repo, token, restPr.number),
    ]);
    record(
      diffs,
      'pull',
      key,
      'changedFiles',
      restDetail.changedFiles,
      gqlDetail.changedFiles,
    );
    // Against the DETAIL response, where REST does carry them.
    record(
      diffs,
      'pull',
      key,
      'additions',
      restDetail.additions,
      gqlDetail.additions,
    );
    record(
      diffs,
      'pull',
      key,
      'deletions',
      restDetail.deletions,
      gqlDetail.deletions,
    );
    // `merged_by` drives self_merge_rate — a governance metric.
    record(
      diffs,
      'pull',
      key,
      'mergedBy',
      restDetail.mergedBy,
      gqlDetail.mergedBy,
      true,
    );

    const [restReviews, gqlReviews] = await Promise.all([
      rest.listPullRequestReviews(repo, token, restPr.number),
      graphql.listPullRequestReviews(repo, token, restPr.number),
    ]);
    if (!restReviews.failed && !gqlReviews.failed) {
      record(
        diffs,
        'pull',
        key,
        'reviewCount',
        restReviews.reviews.length,
        gqlReviews.reviews.length,
        true,
      );
      const restIds = restReviews.reviews.map((r) => r.externalId).sort();
      const gqlIds = gqlReviews.reviews.map((r) => r.externalId).sort();
      // The review id keys code_pr_review; if it differs, a re-walk inflates
      // reviewer_load instead of converging on the same rows.
      record(diffs, 'pull', key, 'reviewIds', restIds, gqlIds, true);
      record(
        diffs,
        'pull',
        key,
        'botFlags',
        restReviews.reviews.map((r) => r.isBot).sort(),
        gqlReviews.reviews.map((r) => r.isBot).sort(),
        true,
      );
    }

    const [restComments, gqlComments] = await Promise.all([
      rest.listPullRequestReviewComments(repo, token, restPr.number),
      graphql.listPullRequestReviewComments(repo, token, restPr.number),
    ]);
    if (!restComments.failed && !gqlComments.failed) {
      // REST pages comments and can undercount (`truncated`); GraphQL's
      // totalCount is exact. Compare only where REST claims to be complete.
      if (!restComments.truncated) {
        for (const [reviewId, count] of restComments.countByReviewId) {
          record(
            diffs,
            'pull',
            `${key}/review:${reviewId}`,
            'commentCount',
            count,
            gqlComments.countByReviewId.get(reviewId) ?? 0,
          );
        }
      }
    }
  }
}

async function compareCommits(
  repo: string,
  token: string,
  rest: GithubClient,
  graphql: GithubGraphqlClient,
  diffs: Diff[],
  coverage: Coverage,
): Promise<void> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const restPage = await rest.listCommitsPage(repo, token, { page: 1 }, since);
  const gqlPage = await graphql.listCommitsPage(
    repo,
    token,
    { page: 1 },
    since,
  );

  if (restPage.failed || gqlPage.failed) {
    const reason = `commit page failed (rest=${!!restPage.failed} graphql=${!!gqlPage.failed})`;
    console.error(`  ! ${repo}: ${reason} — cannot compare`);
    coverage.skipped.push({ section: `${repo} commits`, reason });
    return;
  }

  const gqlBySha = new Map(gqlPage.items.map((c) => [c.sha, c]));
  const sample = restPage.items.slice(0, SAMPLE);
  console.log(`  commits: comparing ${sample.length}`);
  coverage.compared.push(`${repo} commits (${sample.length})`);

  for (const restCommit of sample) {
    const gqlCommit = gqlBySha.get(restCommit.sha);
    const key = `${repo}@${restCommit.sha.slice(0, 8)}`;
    if (!gqlCommit) {
      // REST lists all branches; GraphQL walks defaultBranchRef. A commit on
      // a side branch is an expected, non-critical absence — but a real one
      // on the default branch is not, so it is still reported.
      diffs.push({
        entity: 'commit',
        key,
        field: '(missing — check whether it is off the default branch)',
        rest: 'present',
        graphql: 'absent',
        critical: false,
      });
      continue;
    }

    // THE field this harness exists for. REST sets `author.login` only on a
    // verified commit email; GraphQL's `author.user.login` must agree exactly,
    // including where both are null.
    record(
      diffs,
      'commit',
      key,
      'authorLogin',
      restCommit.author?.login ?? null,
      gqlCommit.author?.login ?? null,
      true,
    );
    record(
      diffs,
      'commit',
      key,
      'authorEmail',
      restCommit.commit.author?.email,
      gqlCommit.commit.author?.email,
      true,
    );
    record(
      diffs,
      'commit',
      key,
      'authoredAt',
      restCommit.commit.author?.date,
      gqlCommit.commit.author?.date,
    );
    record(
      diffs,
      'commit',
      key,
      'committedAt',
      restCommit.commit.committer?.date,
      gqlCommit.commit.committer?.date,
    );
    record(
      diffs,
      'commit',
      key,
      'message',
      restCommit.commit.message,
      gqlCommit.commit.message,
    );

    const [restDetail, gqlDetail] = await Promise.all([
      rest.getCommitDetail(repo, token, restCommit.sha),
      graphql.getCommitDetail(repo, token, restCommit.sha),
    ]);
    record(
      diffs,
      'commit',
      key,
      'additions',
      restDetail.additions,
      gqlDetail.additions,
    );
    record(
      diffs,
      'commit',
      key,
      'deletions',
      restDetail.deletions,
      gqlDetail.deletions,
    );
  }
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? '';
  const repos = process.argv.slice(2);

  if (!token || repos.length === 0) {
    console.error(
      'Usage: GITHUB_TOKEN=... npx ts-node scripts/github-graphql-parity.ts owner/repo [owner/repo ...]',
    );
    process.exit(2);
  }

  const rest = new GithubClient();
  const graphql = new GithubGraphqlClient();
  const diffs: Diff[] = [];
  const coverage: Coverage = { compared: [], skipped: [] };

  for (const repo of repos) {
    console.log(`\n== ${repo}`);
    await comparePulls(repo, token, rest, graphql, diffs, coverage);
    await compareCommits(repo, token, rest, graphql, diffs, coverage);
  }

  const critical = diffs.filter((d) => d.critical);
  const expected = repos.length * 2; // pulls + commits per repo
  console.log(`\n${'='.repeat(70)}`);
  console.log(
    `Compared ${coverage.compared.length}/${expected} sections across ${repos.length} repo(s).`,
  );
  for (const section of coverage.compared) {
    console.log(`  ok      ${section}`);
  }
  for (const s of coverage.skipped) {
    console.log(`  SKIPPED ${s.section} — ${s.reason}`);
  }
  console.log(`${diffs.length} difference(s), ${critical.length} critical.`);

  if (diffs.length > 0) {
    console.log('\nDifferences (REST -> GraphQL):');
    for (const d of diffs) {
      console.log(
        `  ${d.critical ? 'CRITICAL' : '        '} ${d.entity} ${d.key} ${d.field}: ${JSON.stringify(d.rest)} -> ${JSON.stringify(d.graphql)}`,
      );
    }
  }

  if (critical.length > 0) {
    console.error(
      '\nDO NOT CUT OVER. Critical differences change what the metrics report.',
    );
    process.exit(1);
  }

  // Zero differences from a comparison that never ran looks exactly like zero
  // differences from one that did. Only the second is evidence, so an
  // incomplete run is never allowed to read as a pass.
  if (coverage.skipped.length > 0 || coverage.compared.length === 0) {
    console.error(
      `\nNOT VERIFIED. ${coverage.skipped.length} section(s) could not be compared, so "no differences" here is absence of evidence, not evidence of parity. Re-run until every section reports ok.`,
    );
    process.exit(1);
  }

  console.log(
    '\nEvery section compared, no critical differences — safe to enable GITHUB_COLLECTION_MODE=graphql.',
  );
}

void main();
