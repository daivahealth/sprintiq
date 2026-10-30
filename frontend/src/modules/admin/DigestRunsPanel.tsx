import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { DigestRunSummary, TenantConfiguration } from '../../lib/api/types';
import { Badge, Card, Spinner } from '../../components/ui';
import {
  automaticSendEnabled,
  automaticSendLine,
  outcomeLabel,
  triggerLabel,
} from './notification-test-panel-logic';

export const DIGEST_RUNS_QUERY_KEY = ['admin', 'digest-runs'] as const;

export interface DigestRunsPanelViewProps {
  automaticEnabled: boolean | null;
  runs: DigestRunSummary[] | null;
  loading: boolean;
  errorMessage: string | null;
}

/**
 * Pure view, rendered in tests via `react-dom/server` like
 * `NotificationTestPanelView`. Shows whether the 09:30 IST weekday send is
 * armed and the recent runs — never names: who a run named stays on the
 * Watchlist, whose every view is audited.
 */
export function DigestRunsPanelView({
  automaticEnabled,
  runs,
  loading,
  errorMessage,
}: DigestRunsPanelViewProps) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg">Recent digest runs</p>
        {loading ? <Spinner /> : null}
      </div>
      <p className="text-xs text-fg-subtle">{automaticSendLine(automaticEnabled)}</p>

      {errorMessage ? <p className="text-sm text-danger-fg">{errorMessage}</p> : null}

      {runs && runs.length === 0 ? (
        <p className="text-sm text-fg-subtle">No digest has run yet.</p>
      ) : null}

      {runs && runs.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {runs.map((run) => (
            <li
              key={`${run.reportedDay}-${run.createdAt}`}
              className="space-y-0.5 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
                <span className="font-medium">{run.reportedDay}</span>
                <Badge tone={run.trigger === 'cron' ? 'good' : 'neutral'}>
                  {triggerLabel(run.trigger)}
                </Badge>
                <span className="text-fg-secondary">{outcomeLabel(run.outcome)}</span>
              </div>
              <p className="text-xs text-fg-subtle">
                {run.flaggedCount} of {run.rosterCount} named · ran{' '}
                {new Date(run.createdAt).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                })}{' '}
                IST
              </p>
              {run.detail ? (
                <p className="text-xs text-warning-fg">{run.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * The runs list plus the armed/disarmed line. Reuses the configurations
 * page's query key, so both views share one cached read.
 */
export function DigestRunsPanel() {
  const runs = useQuery({
    queryKey: DIGEST_RUNS_QUERY_KEY,
    queryFn: () =>
      api.get<{ runs: DigestRunSummary[] }>(
        '/api/admin/notifications/no-commit-digest/runs?limit=10',
      ),
  });
  const configurations = useQuery({
    queryKey: ['admin', 'configurations'],
    queryFn: () =>
      api.get<{ configurations: TenantConfiguration[] }>('/api/admin/configurations'),
  });

  return (
    <DigestRunsPanelView
      automaticEnabled={automaticSendEnabled(configurations.data?.configurations)}
      runs={runs.data?.runs ?? null}
      loading={runs.isLoading}
      errorMessage={runs.isError ? 'The digest runs could not be loaded.' : null}
    />
  );
}
