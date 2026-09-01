import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  ProvenanceNote,
  StatusDot,
} from '../../../components/ui';
import { timeAgo } from '../../../lib/utils';
import {
  useWatchlist,
  type SignalType,
  type WatchlistBucket,
  type WatchlistDeveloper,
  type WatchlistView,
} from '../useInsights';
import { ErrorCard, LoadingCard } from '../widgets';
import { CurrentLensNote } from './CurrentLensNote';
import { useSectionRange } from './window';

/**
 * Engineering Activity §Watchlist (DASHBOARDS.md §4.4.2).
 *
 * The page in this section that names individuals, so it is the one whose
 * framing has to be exact. Everything here is a prompt to go ask a question.
 * Nothing here is a finding about a person's performance, and the page says so
 * rather than relying on the reader to infer it.
 *
 * Two orthogonal lenses, deliberately not merged: recency (has anything been
 * heard from this person) and assignment (does the plan know what they are
 * working on). They are independent — an *active* developer with nothing
 * assigned is exactly the case worth seeing — so folding assignment into the
 * recency buckets would bury the people it is meant to surface.
 */

const SIGNAL_LABEL: Record<SignalType, string> = {
  commit: 'commit',
  pr_opened: 'PR opened',
  pr_merged: 'PR merged',
  pr_reviewed: 'PR reviewed',
};

const BUCKET_TONE: Record<WatchlistBucket, 'good' | 'warn' | 'neutral'> = {
  active: 'good',
  quiet: 'warn',
  no_signal: 'neutral',
};

const REASON_LABEL: Record<string, string> = {
  leave: 'On approved leave',
  new_joiner: 'Recently joined',
  secondment: 'On secondment',
  other: 'Other',
};

export function WatchlistPage() {
  const { range } = useSectionRange();
  const query = useWatchlist(range);
  const d = query.data;

  if (query.isLoading) return <LoadingCard />;
  if (query.isError) return <ErrorCard error={query.error} />;
  if (!d) return null;

  const byBucket = (bucket: WatchlistBucket) =>
    d.developers.filter((dev) => dev.bucket === bucket);

  return (
    <div className="space-y-6">
      {/* Not decoration. This page names people, and the sentence that stops it
          being read as a performance verdict has to be the first thing on it. */}
      <div className="rounded-md border border-brand-muted bg-brand-fg p-3 text-sm text-brand-muted">
        A prompt to go ask a question — not a conclusion about anyone’s
        performance. Absence of a tracked signal is not absence of work: pairing,
        design, support and review outside GitHub all leave nothing here. Share
        individual cases only with the person’s manager, in conversation.
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <BucketColumn
          bucket="active"
          title="Active"
          count={d.counts.active}
          definition={`A tracked signal in the last ${d.thresholds.activeWithinWorkingDays} working days`}
          developers={byBucket('active')}
        />
        <BucketColumn
          bucket="quiet"
          title="Quiet"
          count={d.counts.quiet}
          definition={`Nothing in ${d.thresholds.activeWithinWorkingDays} working days, but something within ${d.thresholds.quietWithinWorkingDays}`}
          developers={byBucket('quiet')}
        />
        <BucketColumn
          bucket="no_signal"
          title="No tracked activity"
          count={d.counts.no_signal}
          definition={`Nothing in ${d.thresholds.quietWithinWorkingDays} working days`}
          developers={byBucket('no_signal')}
        />
      </div>

      <CurrentLensNote
        range={range}
        lens="Assigned Jira work, the planning gap and exclusions"
      />
      <PlanningGap view={d} />
      <UnlinkedPanel view={d} />
      <InactiveAccountsPanel view={d} />
      <ExclusionPanel view={d} />

      <ProvenanceNote>
        Buckets count working days (Mon–Fri); public holidays are not modelled,
        so a team returning from one reads slightly quieter than it was.
        Alphabetical within each bucket — never ordered by volume. Computed{' '}
        {timeAgo(d.computedAt)}.
      </ProvenanceNote>
    </div>
  );
}

function BucketColumn({
  bucket,
  title,
  count,
  definition,
  developers,
}: {
  bucket: WatchlistBucket;
  title: string;
  count: number;
  definition: string;
  developers: WatchlistDeveloper[];
}) {
  return (
    <Card className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold text-fg">
            <StatusDot tone={BUCKET_TONE[bucket]} />
            {title}
          </h3>
          <span className="text-sm tabular-nums text-fg-subtle">{count}</span>
        </div>
        {/* The threshold is stated, not implied. A bucket whose rule the reader
            has to guess at is a label they will fill in with their own. */}
        <p className="mt-0.5 text-xs text-fg-subtle">{definition}</p>
      </div>

      <div className="space-y-2">
        {developers.map((dev) => (
          <DeveloperCard key={dev.developer} dev={dev} />
        ))}
        {developers.length === 0 && (
          <p className="py-3 text-center text-xs text-fg-faint">
            Nobody in this bucket.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * Recency only — no commit counts.
 *
 * Counts belong on Overview and the developer page. Here they would invite
 * exactly the comparison between two named people that this page must not
 * support, and they answer a question the buckets aren't asking: what matters
 * is when we last heard anything, not how much of it there was.
 */
function DeveloperCard({ dev }: { dev: WatchlistDeveloper }) {
  return (
    <Link
      to={`../developer?developer=${encodeURIComponent(dev.developer)}`}
      className="block rounded-md border border-border p-2.5 transition hover:bg-subtle"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg-secondary">
          {dev.displayName}
        </span>
        {dev.hasAssignedWork === false && (
          <Badge tone="warn">nothing assigned</Badge>
        )}
      </div>
      <p className="mt-0.5 text-xs text-fg-subtle">
        {dev.lastSignal ? (
          <>
            Last signal:{' '}
            <span className="font-medium text-fg-muted">
              {SIGNAL_LABEL[dev.lastSignal.type]}
            </span>
            , {timeAgo(dev.lastSignal.at)}
          </>
        ) : (
          'No commit, PR or review collected in this range'
        )}
      </p>
    </Link>
  );
}

/**
 * Committing, with nothing assigned in Jira — the planning gap.
 *
 * Gated on the assignee bridge twice over: the list only ever contains people
 * the bridge matched, and the caveat below states the match rate whether or not
 * the list is empty. Without that, an unmatched assignee is indistinguishable
 * from a developer working off-plan, and the page would be accusing people of
 * the platform's own data gap.
 */
function PlanningGap({ view }: { view: WatchlistView }) {
  const { committingWithoutAssignedWork: rows, assigneeCoverage } = view;
  const bridgeUnusable = assigneeCoverage.assigneesMatched === 0;
  const unlinked = assigneeCoverage.unlinkedDevelopers ?? [];

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold text-fg">
          Committing without assigned work
        </h3>
        <p className="text-xs text-fg-subtle">
          Landed commits in this window, but no open Jira item assigned to them
          — work the plan cannot see
        </p>
      </div>

      {bridgeUnusable ? (
        <p className="rounded-md border border-border bg-subtle p-3 text-sm text-fg-muted">
          No Jira assignee could be matched to a developer yet, so this cannot
          be reported. Until the bridge matches someone, an empty list here
          would mean “we cannot tell”, not “nobody”.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {rows.map((dev) => (
              <Link
                key={dev.developer}
                to={`../developer?developer=${encodeURIComponent(dev.developer)}`}
                className="rounded-md border border-warning-border bg-warning-bg px-2 py-1 text-xs text-warning-fg hover:opacity-80"
              >
                {dev.displayName}
              </Link>
            ))}
            {rows.length === 0 && (
              <p className="text-sm text-fg-muted">
                Everyone who committed in this window has assigned work.
              </p>
            )}
          </div>

          {unlinked.length > 0 && (
            <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
              {/* Names the specific people, not a percentage. A ratio tells a
                  reader to distrust the list; a list of names tells them which
                  rows to distrust — and is short enough to act on. */}
              <span className="font-medium text-fg">{unlinked.length}</span> of{' '}
              {assigneeCoverage.developersInWindow} developers who committed
              have no Jira account matched ({assigneeCoverage.coveragePct}%
              linked):{' '}
              <span className="text-fg-secondary">
                {unlinked.slice(0, 6).join(', ')}
                {unlinked.length > 6 && ` +${unlinked.length - 6} more`}
              </span>
              . Their assigned work is invisible here, so they are excluded from
              the list above rather than named in it.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Committers the bridge couldn't link, each with the names that might be them.
 *
 * A suggestion is not a match, and the wording keeps that distinction load-
 * bearing rather than decorative: these are shown so a person can recognise
 * their colleague, which is a judgement the matcher deliberately refuses to
 * make. `Junaid Haneef` → `Mohammed Junaid Haneef` is obvious to a human and
 * unprovable from the data, and no threshold would make it safe to apply
 * automatically — the same shaped comparison would fuse `Vijay Kumar Yadav`
 * with `Sanjay Kumar Yadav`.
 *
 * Nothing here writes. Confirming a suggestion is a separate, deliberate
 * action that does not exist yet.
 */
function UnlinkedPanel({ view }: { view: WatchlistView }) {
  // Absent (not empty) means an API that predates this — say nothing at all
  // rather than render "everyone is linked" on a payload that never claimed it.
  const rows = view.unlinked;
  if (!rows) {
    return null;
  }

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold text-fg">Unlinked developers</h3>
        <p className="text-xs text-fg-subtle">
          Committed in this window, but no Jira account matched — so their
          assigned work is invisible and they are left out of the planning gap
          above rather than named in it
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Every developer who committed in this window is linked to a Jira
          account.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <li
              key={row.developer}
              className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className="shrink-0 text-sm font-medium text-fg-secondary">
                {row.displayName}
              </span>
              {row.suggestions.length === 0 ? (
                <span className="text-xs text-fg-faint">
                  No similar name found — needs a manual link
                </span>
              ) : (
                <span className="flex flex-wrap items-baseline gap-1.5 text-xs">
                  <span className="text-fg-subtle">possibly</span>
                  {row.suggestions.map((s) => (
                    <span
                      key={s.candidate}
                      className="rounded border border-border bg-subtle px-1.5 py-0.5 text-fg-secondary"
                      // The basis is the reader's cue for how much to trust it:
                      // whole words matching is stronger than characters.
                      title={
                        s.basis === 'token_subset'
                          ? 'Every word of one name appears in the other'
                          : 'One name appears inside the other once punctuation is removed'
                      }
                    >
                      {s.candidateName}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-fg-faint">
        Suggestions, not matches — shown for you to recognise, never applied
        automatically.
      </p>
    </Card>
  );
}

/**
 * Accounts GitHub anonymized when their owner was deprovisioned.
 *
 * These reached the buckets as `1a824967e10493200d5a7ee2d91b87_athma` — 83
 * pull requests, no name, no signal — and sorted to the very top of "no
 * tracked activity", where the page was inviting someone to go check on a
 * person who had already left.
 *
 * Reported rather than filtered, on the same principle as the exclusion list:
 * a roster that quietly drops a category of account is one nobody can audit,
 * and the PR count is the fact that says whether the account's history still
 * matters to someone.
 */
function InactiveAccountsPanel({ view }: { view: WatchlistView }) {
  const rows = view.inactiveAccounts;
  // Absent means an API predating this — say nothing rather than imply none.
  if (!rows || rows.length === 0) {
    return null;
  }

  return (
    <Card className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-fg-muted">
          Inactive / deprovisioned accounts · {rows.length}
        </h3>
        <p className="text-xs text-fg-subtle">
          GitHub replaced the login with an identifier when the account was
          deprovisioned, so there is no person here to check on — kept out of
          the buckets above, listed so the roster stays auditable
        </p>
      </div>

      <ul className="divide-y divide-border-subtle text-sm">
        {rows.map((row) => (
          <li
            key={row.developer}
            className="flex flex-wrap items-baseline justify-between gap-2 py-2"
          >
            <code
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-subtle"
              title={row.developer}
            >
              {row.developer.slice(0, 12)}…
            </code>
            <span className="text-xs text-fg-subtle">
              {row.prsAuthored > 0 ? (
                <>
                  <span className="font-medium text-fg-muted">
                    {row.prsAuthored}
                  </span>{' '}
                  pull request{row.prsAuthored === 1 ? '' : 's'} authored
                </>
              ) : (
                'no pull requests'
              )}
              {' · '}
              {row.lastSignal
                ? `last signal ${timeAgo(row.lastSignal.at)}`
                : 'no signal in range'}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-fg-faint">
        Their commits and pull requests still count in every total — this
        removes them from head-counts of people, not from the work.
      </p>
    </Card>
  );
}

/**
 * Who is deliberately kept off the buckets, and why.
 *
 * Shown rather than silently applied. A filtered roster whose filter is
 * invisible is how a review loses the person it should have surfaced — and
 * when nothing is configured this says exactly that, rather than implying
 * leave and start dates were checked. SprintIQ has no HR feed; it only knows
 * what an admin told it.
 */
function ExclusionPanel({ view }: { view: WatchlistView }) {
  return (
    <Card className="space-y-2">
      <h3 className="text-sm font-medium text-fg-muted">Excluded from the buckets</h3>
      {view.excluded.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No exclusions configured. SprintIQ has no leave or joining-date feed,
          so nobody is filtered out — someone on approved leave or in their
          first week will appear as quiet here. An admin can record an exclusion
          under Configuration.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle text-sm">
          {view.excluded.map((row) => (
            <li
              key={row.developer}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <span className="font-medium text-fg-secondary">
                {row.displayName}
              </span>
              <span className="text-xs text-fg-subtle">
                {REASON_LABEL[row.reason] ?? row.reason} · until{' '}
                {new Date(row.expiresAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
