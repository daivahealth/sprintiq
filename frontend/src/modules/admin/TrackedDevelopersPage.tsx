import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import type { TrackedDeveloper } from '../../lib/api/types';
import { SearchSelect } from '../../components/search-select';
import { Badge, Button, Card, Spinner } from '../../components/ui';
import { useDeveloperCatalog } from '../dashboards/useInsights';
import { NotificationTestPanel } from './NotificationTestPanel';
import { resolutionBadge, sortByDisplayName } from './tracked-developers-logic';

function useTrackedDevelopers() {
  return useQuery({
    queryKey: ['admin', 'tracked-developers'],
    queryFn: () =>
      api.get<{ items: TrackedDeveloper[]; count: number }>(
        '/api/dashboards/tracked-developers',
      ),
  });
}

/**
 * Admin roster for the weekday no-activity digest (10:30 IST → Teams).
 *
 * Adding is deliberately search-then-select only — there is no free-text
 * entry field. A typed login that matches nobody would create an entry that
 * silently never resolves, which is exactly the failure mode the resolution
 * badge below exists to surface, so the add control must not be able to
 * create one on its own.
 */
export function TrackedDevelopersPage() {
  const queryClient = useQueryClient();
  const roster = useTrackedDevelopers();
  const [search, setSearch] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  const catalog = useDeveloperCatalog(search);

  const invalidateRoster = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'tracked-developers'] });

  const add = useMutation({
    mutationFn: (login: string) =>
      api.put<{ developer: string; addedAs: string; active: boolean }>(
        `/api/dashboards/tracked-developers/${encodeURIComponent(login)}`,
        {},
      ),
    onSuccess: () => void invalidateRoster(),
  });

  const remove = useMutation({
    mutationFn: (developer: string) =>
      api.delete<{ developer: string; active: boolean }>(
        `/api/dashboards/tracked-developers/${encodeURIComponent(developer)}`,
      ),
    onSuccess: () => void invalidateRoster(),
    onSettled: () => setPendingRemoval(null),
  });

  const rows = sortByDisplayName(roster.data?.items ?? []);
  const addOptions = (catalog.data?.items ?? []).map((d) => ({
    value: d.login,
    label: d.displayName ?? d.login,
    hint: (d.displayName ?? d.login) !== d.login ? `· ${d.login}` : undefined,
  }));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.035em] text-fg">
            Tracked Developers
          </h2>
          <p className="mt-1 text-sm text-fg-subtle">
            Who the daily no-activity digest reports on. Every weekday at
            10:30 IST, a Teams card names anyone below with no delivery
            activity the previous working day.
          </p>
        </div>
        {roster.isLoading && <Spinner />}
      </div>

      {roster.isError ? (
        <Card>
          <p className="text-sm text-danger-fg">
            The roster could not be loaded.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-2">
        <p className="text-xs font-medium text-fg-subtle">Add a developer</p>
        <SearchSelect
          label=""
          value={null}
          options={addOptions}
          onSearch={setSearch}
          onSelect={(login) => add.mutate(login)}
          loading={catalog.isFetching || add.isPending}
          placeholder="Search developers…"
          emptyText="No matching developers"
        />
        <p className="text-xs text-fg-faint">
          Only developers the system already knows can be added. There is no
          free-text entry — a typed login that matches nobody would create an
          entry that silently never resolves.
        </p>
        {add.isError ? (
          <p className="text-xs text-danger-fg">
            {add.error instanceof ApiError
              ? add.error.message
              : 'Could not add this developer.'}
          </p>
        ) : null}
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[minmax(200px,1.2fr)_minmax(160px,0.8fr)_minmax(220px,1fr)_minmax(180px,0.7fr)] border-b-2 border-rule bg-subtle px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
            <span>Developer</span>
            <span>Tracked as</span>
            <span>Resolution</span>
            <span />
          </div>

          {rows.map((row) => {
            const badge = resolutionBadge(row.resolved);
            const confirming = pendingRemoval === row.developer;
            return (
              <div
                key={row.developer}
                className="grid grid-cols-[minmax(200px,1.2fr)_minmax(160px,0.8fr)_minmax(220px,1fr)_minmax(180px,0.7fr)] items-center gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {row.displayName}
                  </p>
                  {row.note ? (
                    <p className="truncate text-xs text-fg-subtle">
                      {row.note}
                    </p>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-fg-subtle">
                    {row.developer}
                  </p>
                </div>
                <div className="min-w-0">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  {!row.resolved ? (
                    <p className="mt-1 max-w-xs text-xs text-warning-fg">
                      {badge.explanation}
                    </p>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  {confirming ? (
                    <div className="space-y-1.5 text-right">
                      <p className="text-xs text-fg-subtle">
                        Stop tracking {row.displayName}? They will no longer
                        be named in the daily digest.
                      </p>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setPendingRemoval(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => remove.mutate(row.developer)}
                          disabled={remove.isPending}
                        >
                          {remove.isPending ? 'Removing…' : 'Confirm'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setPendingRemoval(row.developer)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          {!roster.isLoading && rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-subtle">
              No developers are tracked. The daily no-activity digest will
              report on nobody until someone is added above.
            </p>
          ) : null}
        </div>
      </div>

      {remove.isError ? (
        <p className="text-sm text-danger-fg">
          {remove.error instanceof ApiError
            ? remove.error.message
            : 'Could not remove this developer.'}
        </p>
      ) : null}

      <NotificationTestPanel />
    </section>
  );
}
