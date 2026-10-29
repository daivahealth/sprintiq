import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  ProvenanceNote,
  SegmentedControl,
  Spinner,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { api } from '../../../lib/api/client';
import { timeAgo } from '../../../lib/utils';
import type { ActivityRange } from '../activity-range';
import { ErrorCard } from '../widgets';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  KIND_LABELS,
  METRIC_LABELS,
  defaultVerifyRange,
  formatDelta,
  groupItems,
  isActionable,
  reasonLabel,
  scopeLabel,
  verificationHeadline,
  verifyRangeProblem,
  type ActivityVerificationReport,
  type DiscrepancyItem,
  type VerifyRequest,
} from './activity-verification';

function useVerifyActivity() {
  return useMutation({
    mutationFn: (body: VerifyRequest) =>
      api.post<ActivityVerificationReport>(
        '/api/dashboards/developer-activity/verify',
        body,
      ),
  });
}

const STATUS_TONE = {
  match: 'good',
  discrepancies: 'bad',
  incomplete: 'warn',
} as const;

const STATUS_LABEL = {
  match: 'Matches GitHub',
  discrepancies: 'Discrepancies',
  incomplete: 'Incomplete',
} as const;

/**
 * "Verify against GitHub" — reconciles what this page counts for one
 * developer against an independent read of GitHub, record by record
 * (docs/features/DASHBOARDS.md §4.4.3).
 *
 * Mounted only for admins; the API refuses everyone else as well. Each run
 * spends the tenant's GitHub quota, so it is an explicit button, never a
 * query that refetches on focus. Read-only: nothing it finds is written back.
 */
export function VerifyActivityCard({
  developer,
  range,
}: {
  developer: string;
  range: ActivityRange;
}) {
  const initial = defaultVerifyRange(range);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const verify = useVerifyActivity();
  const problem = verifyRangeProblem(from, to);
  const r = verify.data;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-fg">Verify against GitHub</h4>
          <p className="text-xs text-fg-subtle">
            Admins only · checks every stored commit, PR and review for this
            developer against GitHub · read-only
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-fg-subtle">
          From
          <input
            type="date"
            className="rounded border border-border bg-surface px-2 py-1 text-xs text-fg"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-subtle">
          To
          <input
            type="date"
            className="rounded border border-border bg-surface px-2 py-1 text-xs text-fg"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <SegmentedControl
          label="Repositories"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'active', label: 'Where they worked' },
            { value: 'all', label: 'All repositories' },
          ]}
        />
        <Button
          size="sm"
          disabled={Boolean(problem) || verify.isPending}
          onClick={() => verify.mutate({ developer, from, to, scope })}
        >
          {verify.isPending ? 'Verifying…' : 'Run verification'}
        </Button>
      </div>
      {problem && <p className="text-xs text-warning-fg">{problem}</p>}
      <p className="text-xs text-fg-faint">
        “Where they worked” reads repositories with this developer’s stored
        activity, their PRs, or their GitHub contributions. “All repositories”
        reads every collected repository — slower, and uses more of the GitHub
        rate limit.
      </p>

      {verify.isPending && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Reading branches, PRs and reviews from GitHub — this can
          take a minute or two.
        </div>
      )}
      {verify.isError && <ErrorCard error={verify.error} />}

      {r && !verify.isPending && <Report report={r} />}
    </Card>
  );
}

function Report({ report: r }: { report: ActivityVerificationReport }) {
  const c = r.coverage;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
        <p className="text-sm text-fg-secondary">{verificationHeadline(r)}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <TableHeadRow>
              <th className="py-2 pr-4 font-medium">Metric</th>
              <th className="py-2 pr-4 text-right font-medium">SprintIQ</th>
              <th className="py-2 pr-4 text-right font-medium">GitHub</th>
              <th className="py-2 pr-4 text-right font-medium">Difference</th>
              <th className="py-2 font-medium" />
            </TableHeadRow>
          </thead>
          <tbody>
            {r.summary.map((s) => (
              <TableBodyRow key={s.metric}>
                <td className="py-2 pr-4 text-fg-secondary">
                  {METRIC_LABELS[s.metric]}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.db}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.github}</td>
                <td
                  className={`py-2 pr-4 text-right tabular-nums ${s.delta === 0 ? 'text-fg-faint' : 'font-medium text-danger-fg'}`}
                >
                  {formatDelta(s.delta)}
                </td>
                <td className="py-2 text-xs">
                  {!s.complete && (
                    <span
                      className="text-warning-fg"
                      title="Part of GitHub feeding this figure could not be read"
                    >
                      partial
                    </span>
                  )}
                </td>
              </TableBodyRow>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-faint">
        Difference is GitHub minus SprintIQ. Totals are a summary; the records
        below are matched one by one, so equal totals can still hide a missing
        record offset by an extra one.
      </p>

      {CATEGORY_ORDER.map((category) => {
        const groups = groupItems(r.items, category);
        if (groups.length === 0) return null;
        const count = groups.reduce((n, g) => n + g.items.length, 0);
        return (
          <details
            key={category}
            className="rounded-md border border-border"
            open={isActionable({ category })}
          >
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-fg">
              {CATEGORY_LABELS[category]} · {count}
            </summary>
            <div className="space-y-3 px-3 pb-3">
              {groups.map((g) => (
                <ItemTable key={g.kind} kind={g.kind} items={g.items} />
              ))}
            </div>
          </details>
        );
      })}

      {r.unverified.length > 0 && (
        <details className="rounded-md border border-warning-border bg-warning-bg">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-warning-fg">
            Not fully read from GitHub · {r.unverified.length}
          </summary>
          <ul className="space-y-1 px-3 pb-3 text-xs text-fg-secondary">
            {r.unverified.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{scopeLabel(s)}</span> —{' '}
                {reasonLabel(s.reason)}. {s.detail}
              </li>
            ))}
          </ul>
        </details>
      )}

      <ProvenanceNote>
        Read {c.reposScanned.length} of {c.collectedRepos} collected
        repositories ({c.branchesScanned} branches;{' '}
        {c.branchesSkippedInactive} skipped as inactive before the range)
        {c.reposNotScanned > 0 &&
          ` — ${c.reposNotScanned} showed no sign of this developer and were not read`}
        .{' '}
        {c.loginsUnresolved.length > 0 &&
          `GitHub has no user for ${c.loginsUnresolved.join(', ')}, so their commits match by email only. `}
        {c.pullRequestsOutsideCollectedRepos + c.reviewsOutsideCollectedRepos >
          0 &&
          `${c.pullRequestsOutsideCollectedRepos} PR(s) and ${c.reviewsOutsideCollectedRepos} review(s) are in repositories SprintIQ does not collect and are not compared. `}
        {(c.renamedRepos?.length ?? 0) > 0 &&
          `Renamed on GitHub and matched under their collected names: ${c.renamedRepos
            ?.map((r) => `${r.collected} → ${r.current}`)
            .join(', ')}. `}
        {(c.dbCommitsTruncated || c.dbPullRequestsTruncated) &&
          'The SprintIQ side hit its read ceiling, so its figures are a floor. '}
        {c.commitLookupsSkipped > 0 &&
          `${c.commitLookupsSkipped} stored commit(s) were past the lookup cap and are listed as unverifiable. `}
        Identities checked: {[...r.identity.logins, ...r.identity.emails].join(', ')}.
        Took {Math.round(c.durationMs / 1000)}s
        {c.rateLimitRemaining !== undefined &&
          `, ${c.rateLimitRemaining} GitHub GraphQL points left`}
        . Run {timeAgo(r.generatedAt)}.
      </ProvenanceNote>
      <details className="text-xs text-fg-subtle">
        <summary className="cursor-pointer">How records are matched</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {r.rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function ItemTable({
  kind,
  items,
}: {
  kind: DiscrepancyItem['kind'];
  items: DiscrepancyItem[];
}) {
  return (
    <div className="overflow-x-auto">
      <p className="pt-2 text-xs font-medium text-fg-muted">
        {KIND_LABELS[kind]}s · {items.length}
      </p>
      <table className="w-full text-sm">
        <thead>
          <TableHeadRow>
            <th className="py-2 pr-4 font-medium">Record</th>
            <th className="py-2 pr-4 font-medium">Repository</th>
            <th className="py-2 pr-4 font-medium">When</th>
            <th className="py-2 font-medium">Why</th>
          </TableHeadRow>
        </thead>
        <tbody>
          {items.map((i) => (
            <TableBodyRow key={`${i.repoFullName} ${i.ref}`}>
              <td className="py-2 pr-4 align-top">
                <a
                  href={i.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-brand hover:underline"
                >
                  {i.ref}
                </a>
                <div
                  className="max-w-[16rem] truncate text-xs text-fg-subtle"
                  title={i.title}
                >
                  {i.title}
                </div>
              </td>
              <td className="py-2 pr-4 align-top text-xs text-fg-subtle">
                {i.repoFullName}
              </td>
              <td className="py-2 pr-4 align-top text-xs text-fg-faint">
                {i.at ? i.at.slice(0, 10) : '—'}
              </td>
              <td className="py-2 align-top text-xs text-fg-secondary">
                {i.reason}
                {i.diffs.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {i.diffs
                      .filter((d) => d.field !== 'attribution')
                      .map((d) => (
                        <li key={d.field} className="font-mono text-[11px]">
                          {d.field}: SprintIQ{' '}
                          <span className="text-danger-fg">
                            {String(d.db ?? '—')}
                          </span>{' '}
                          · GitHub{' '}
                          <span className="text-success-fg">
                            {String(d.github ?? '—')}
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </td>
            </TableBodyRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}
