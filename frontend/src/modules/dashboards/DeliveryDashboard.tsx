import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Input, Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import type { PrCycleTime } from '../../lib/api/types';
import { formatHours, timeAgo } from '../../lib/utils';
import { usePrCycleTime } from './usePrCycleTime';

export function DeliveryDashboard() {
  const [repoInput, setRepoInput] = useState('acme/payments');
  const [repo, setRepo] = useState('acme/payments');
  const query = usePrCycleTime(repo);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setRepo(repoInput.trim());
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Delivery</h2>
        <p className="text-sm text-slate-500">
          Flow metrics derived from the correlated delivery graph.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-3">
        <div className="w-72">
          <label className="mb-1 block text-sm font-medium text-slate-600">
            Repository
          </label>
          <Input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/name"
          />
        </div>
        <Button type="submit">Load</Button>
      </form>

      {query.isLoading && (
        <Card className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading metric…
        </Card>
      )}

      {query.isError && (
        <Card className="text-sm text-rose-600">
          {(query.error as ApiError)?.status === 400
            ? 'Enter a repository as owner/name.'
            : ((query.error as ApiError)?.message ?? 'Failed to load metric.')}
        </Card>
      )}

      {query.data && <PrCycleTimeCard data={query.data} />}
    </div>
  );
}

function PrCycleTimeCard({ data }: { data: PrCycleTime }) {
  // Metric-health transparency: small samples are low-confidence (see the
  // frontend rules — always show how trustworthy a number is).
  const health =
    data.sampleSize === 0
      ? { tone: 'bad' as const, label: 'No data' }
      : data.sampleSize < 5
        ? { tone: 'warn' as const, label: 'Low confidence' }
        : { tone: 'good' as const, label: 'Healthy' };

  return (
    <Card className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-slate-800">PR Cycle Time</h3>
          <p className="text-sm text-slate-500">
            {data.repo} · open → merge
          </p>
        </div>
        <Badge tone={health.tone}>{health.label}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="p50 (median)" value={formatHours(data.p50Hours)} />
        <Stat label="p85" value={formatHours(data.p85Hours)} />
        <Stat label="Merged PRs" value={String(data.sampleSize)} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-400">
        <span>Sample size: {data.sampleSize}</span>
        <span>Computed {timeAgo(data.computedAt)}</span>
        <span>Source: correlated merged PRs (lineage-traced)</span>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <div className="text-2xl font-semibold text-slate-800">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
