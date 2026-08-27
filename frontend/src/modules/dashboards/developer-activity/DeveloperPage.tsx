import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge,
  Card,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { SearchSelect } from '../../../components/search-select';
import { timeAgo } from '../../../lib/utils';
import { CommitChart } from '../CommitChart';
import { useDeveloperActivity, useDeveloperCatalog } from '../useInsights';
import { BarList, ErrorCard, LoadingCard, Stat } from '../widgets';
import { rangeDays, rangeEndKey, useSectionRange } from './window';

/**
 * Developer Activity §Developer (DASHBOARDS.md §4.4.3).
 *
 * One person's context, evidence-first. Two things the original design carried
 * are deliberately absent:
 *
 *  - **A second table of "commits without a linked ticket."** That was the same
 *    commit list split in two by one attribute. It is one table with a
 *    provenance column instead.
 *  - **Per-person "average time to first review."** Review latency is a
 *    property of the team's review capacity, not of the person waiting on it;
 *    attaching it to an individual turns a queue signal into a personal score.
 *    The team figure lives on Efficiency.
 *
 * The selected developer lives in the URL so a link from the Watchlist or the
 * commit timeline lands on the right person (§3).
 */
export function DeveloperPage() {
  const { range } = useSectionRange();
  const [params, setParams] = useSearchParams();
  const developer = params.get('developer');
  const search = params.get('q') ?? '';

  const catalog = useDeveloperCatalog(search);
  const developers = catalog.data?.items ?? [];
  const query = useDeveloperActivity(developer, range);
  const d = query.data;

  const setDeveloper = (login: string | null) => {
    const next = new URLSearchParams(params);
    if (login) {
      next.set('developer', login);
    } else {
      next.delete('developer');
    }
    setParams(next, { replace: true });
  };

  // Open on whoever committed most recently, not whoever sorts first.
  //
  // The list itself stays alphabetical — that is what you want when searching
  // for a name — but landing on the alphabetically-first developer meant
  // opening on someone with no recent work far more often than not (on a real
  // tenant, only 36 of 83 developers committed in the last week). An empty
  // page on arrival reads as the page being broken rather than as that person
  // having been busy elsewhere.
  useEffect(() => {
    if (developer || developers.length === 0) {
      return;
    }
    const mostRecent = developers.reduce((best, dev) =>
      (dev.lastActiveAt ?? '') > (best.lastActiveAt ?? '') ? dev : best,
    );
    setDeveloper(mostRecent.login);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [developer, developers]);

  const options = developers.map((dev) => ({
    value: dev.login,
    label: dev.displayName ?? dev.login,
    // Marked in the list rather than hidden: these are the people whose commits
    // GitHub attributed to no account, and silently omitting them is what made
    // their work look like nobody's. `attributed` absent means the API can't
    // distinguish, so nothing is claimed either way.
    hint: dev.attributed === false ? '· no linked account' : undefined,
  }));

  return (
    <div className="space-y-6">
      <SearchSelect
        label="Developer"
        value={developer}
        options={options}
        onSearch={(q) => {
          const next = new URLSearchParams(params);
          if (q) next.set('q', q);
          else next.delete('q');
          setParams(next, { replace: true });
        }}
        onSelect={setDeveloper}
        loading={catalog.isFetching}
        placeholder="Search developers…"
      />

      {query.isLoading && developer && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}

      {d && (
        <>
          <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-fg">{d.developer}</h3>
              <span className="space-x-1">
                {d.activeProjects.map((p) => (
                  <Badge key={p} tone="good">
                    {p}
                  </Badge>
                ))}
                {d.activeProjects.length === 0 && (
                  <Badge tone="warn">No linked projects</Badge>
                )}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Commits" value={d.totals.commits} />
              <Stat
                label="Lines committed"
                value={d.totals.locChanged}
                hint={`+${d.totals.additions} / −${d.totals.deletions}`}
              />
              <Stat
                label="PRs opened"
                value={d.totals.prsAuthored}
                // Delivery counts merged PRs by merge date; this page counts
                // every PR opened in the window. Stating both stops the two
                // boards reading as a contradiction about the same person.
                hint={
                  d.totals.prsMerged === undefined
                    ? undefined
                    : `${d.totals.prsMerged} merged`
                }
              />
              <Stat
                label="Reviews given"
                value={d.prsReviewed ?? '—'}
                hint="bot reviews excluded"
              />
            </div>

            {/* Whose identities these figures were gathered under. A person
                whose git email isn't verified on their GitHub account commits
                under a login-less identity; until it's matched, this page reads
                "0 commits" for someone who has been committing all month.
                Every branch is guarded: this build can be serving against an
                API that predates identity resolution, and an unguarded
                dereference here took the entire board down rather than
                degrading to the older, less informative rendering. */}
            {d.identity?.inferred && (
              <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
                Includes commits authored as{' '}
                <span className="font-medium text-fg">
                  {d.identity.recoveredEmails.join(', ')}
                </span>
                , matched to this developer by name because GitHub attributed
                those commits to no account.
              </p>
            )}
            {d.totals.commits === 0 && d.identity && !d.identity.inferred && (
              <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
                No commits matched{' '}
                <span className="font-medium text-fg">
                  {d.identity.logins.join(', ')}
                </span>{' '}
                in this window. If this developer has been committing, their git
                email is likely not verified on their GitHub account — check the
                attribution figure on Overview.
              </p>
            )}

            <div>
              <h4 className="mb-2 text-sm font-medium text-fg-muted">
                Commits per day
              </h4>
              <CommitChart
                series={d.dailySeries}
                windowDays={rangeDays(range)}
                endKey={rangeEndKey(range)}
              />
            </div>
          </Card>

          <AssignedWork view={d} />

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-fg-muted">
              Repositories committed to
            </h4>
            <BarList
              rows={d.byRepo.map((r) => ({
                label: r.repo,
                value: r.commits,
                secondary: `${r.locChanged} LOC`,
              }))}
            />
          </Card>

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-fg-muted">Recent commits</h4>
            <ul className="divide-y divide-border-subtle">
              {d.recentCommits.map((c) => (
                <li
                  key={`${c.repo}@${c.sha}`}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-subtle">
                    {c.sha}
                  </code>
                  <span className="w-40 shrink-0 truncate text-fg-subtle">
                    {c.repo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">
                    {c.message}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs">
                    <span className="text-success-fg">+{c.additions}</span>{' '}
                    <span className="text-danger-fg">−{c.deletions}</span>
                  </span>
                  <span
                    className="w-20 shrink-0 text-right text-xs text-fg-faint"
                    title={`Authored ${timeAgo(c.authoredAt)}`}
                  >
                    {timeAgo(c.committedAt)}
                  </span>
                </li>
              ))}
              {d.recentCommits.length === 0 && (
                <li className="py-4 text-center text-sm text-fg-faint">
                  No commits in this window.
                </li>
              )}
            </ul>
            <ProvenanceNote>
              Activity context, never a ranking. Computed{' '}
              {timeAgo(d.computedAt)}.
            </ProvenanceNote>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * The Jira work assigned to this person — the other half of the planning gap.
 *
 * `assignment === null` is a distinct rendering from an empty list, and the
 * distinction is the whole point: null means the assignee bridge never matched
 * this developer, so we cannot see their tickets. Drawing that as "no assigned
 * work" would assert a finding out of a data gap.
 */
function AssignedWork({
  view,
}: {
  view: {
    assignment?: {
      openItems: {
        key: string;
        projectKey: string;
        type: string;
        status: string;
        title: string;
        inSprint: boolean;
      }[];
      jiraRefs: string[];
    } | null;
  };
}) {
  // `undefined` = this API predates the section; render nothing rather than
  // claim anything (frontend/backend skew, §4.2).
  if (view.assignment === undefined) {
    return null;
  }

  if (view.assignment === null) {
    return (
      <Card className="space-y-2">
        <h4 className="text-sm font-medium text-fg-muted">Assigned work</h4>
        <p className="rounded-md border border-border bg-subtle p-2.5 text-sm text-fg-muted">
          No Jira assignee could be matched to this developer, so their assigned
          work cannot be shown. This is a gap in identity matching — not a
          statement that they have nothing assigned.
        </p>
      </Card>
    );
  }

  const { openItems } = view.assignment;
  return (
    <Card className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-fg-muted">
          Assigned work · {openItems.length} open
        </h4>
        <p className="text-xs text-fg-subtle">
          Open Jira items assigned to this developer right now — not windowed,
          because an old ticket still assigned is still their work
        </p>
      </div>

      {openItems.length === 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-bg p-2.5 text-sm text-warning-fg">
          No open Jira item is assigned to this developer. If they have been
          committing, that work is not represented in the plan.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Title</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {openItems.map((item) => (
                <TableBodyRow key={item.key}>
                  <td className="py-2.5 pr-4 font-medium text-fg-secondary">
                    {item.key}
                    {!item.inSprint && (
                      <span
                        className="ml-1.5 text-xs text-fg-faint"
                        title="Assigned but not committed to a sprint"
                      >
                        backlog
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-fg-muted">{item.type}</td>
                  <td className="py-2.5 pr-4 text-fg-muted">{item.status}</td>
                  <td className="max-w-md truncate py-2.5 text-fg-secondary" title={item.title}>
                    {item.title}
                  </td>
                </TableBodyRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
