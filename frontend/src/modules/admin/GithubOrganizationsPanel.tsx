import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import type { GithubOrganization } from '../../lib/api/types';
import { Badge, Button, Field, Input } from '../../components/ui';
import {
  draftOf,
  emptyOrgDraft,
  inheritedPlaceholder,
  ORG_REF_FIELDS,
  orgPayload,
  validateOrgLogin,
  type OrgDraft,
} from './github-organizations-logic';

const ORGS_KEY = ['admin', 'configurations', 'github-organizations'];

export function useGithubOrganizations() {
  return useQuery({
    queryKey: ORGS_KEY,
    queryFn: () =>
      api.get<{ organizations: GithubOrganization[] }>(
        '/api/admin/configurations/github/organizations',
      ),
  });
}

const DIGEST_LABEL: Record<GithubOrganization['digest'], string> = {
  included: 'In the daily digest',
  collecting: 'Collecting — joins the digest after its first full sweep',
  disabled: 'Disabled',
};

/**
 * Organisations beyond the first (ADR-0013). The first organisation keeps
 * its own form above; each one here is a separate configuration row, so
 * saving or syncing it never changes the first one.
 */
export function GithubOrganizationsPanel() {
  const orgs = useGithubOrganizations();
  const [adding, setAdding] = useState(false);
  const all = orgs.data?.organizations ?? [];
  const defaultOrg = all.find((o) => o.isDefault);
  const others = all.filter((o) => !o.isDefault);

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">
          <strong className="text-fg-secondary">Additional organisations.</strong>{' '}
          Each is collected on its own; adding one never changes{' '}
          {defaultOrg?.organization ?? 'the first organisation'}. Blank token refs use the first
          organisation&apos;s.
        </p>
        {!adding ? (
          <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
            Add organisation
          </Button>
        ) : null}
      </div>
      {others.map((org) => (
        <OrgEditor
          key={org.key}
          initial={draftOf(org)}
          saved={org}
          defaultOrg={defaultOrg}
          existing={all.map((o) => o.organization)}
        />
      ))}
      {adding ? (
        <OrgEditor
          initial={emptyOrgDraft()}
          defaultOrg={defaultOrg}
          existing={all.map((o) => o.organization)}
          onDone={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function OrgEditor({
  initial,
  saved,
  defaultOrg,
  existing,
  onDone,
}: {
  initial: OrgDraft;
  saved?: GithubOrganization;
  defaultOrg: GithubOrganization | undefined;
  existing: string[];
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OrgDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof OrgDraft, v: string | boolean) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.put('/api/admin/configurations', orgPayload(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'configurations'] });
      onDone?.();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed.'),
  });
  const sync = useMutation({
    mutationFn: () =>
      api.post<{ reposFound: number; created: number; updated: number; skipped: number; rateLimited: boolean }>(
        '/api/admin/configurations/github/sync-org',
        { organization: saved?.organization },
      ),
  });

  const onSave = () => {
    const problem = saved ? null : validateOrgLogin(draft.organization, existing);
    setError(problem);
    if (!problem) save.mutate();
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-fg">{saved?.organization ?? 'New organisation'}</strong>
        {saved ? <Badge tone={saved.digest === 'included' ? 'good' : 'neutral'}>{DIGEST_LABEL[saved.digest]}</Badge> : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Organization">
          <Input
            value={draft.organization}
            readOnly={!!saved}
            disabled={!!saved}
            placeholder="GitHub login, e.g. NHWebsite"
            onChange={(e) => set('organization', e.target.value)}
          />
        </Field>
        {ORG_REF_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input
              value={draft[f.key]}
              placeholder={inheritedPlaceholder(f.key, defaultOrg)}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </Field>
        ))}
        <Field label="Backfill window (days)">
          <Input value={draft.backfillDays} inputMode="numeric" placeholder="90" onChange={(e) => set('backfillDays', e.target.value)} />
        </Field>
        <Field label="Sync interval (minutes)">
          <Input value={draft.syncIntervalMinutes} inputMode="numeric" onChange={(e) => set('syncIntervalMinutes', e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-fg-secondary">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} className="h-3.5 w-3.5 rounded border-border-strong" />
        Enabled
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save organisation'}
        </Button>
        {saved ? (
          <Button type="button" variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending || saved.status !== 'active'}>
            {sync.isPending ? 'Syncing…' : 'Sync org'}
          </Button>
        ) : null}
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        ) : null}
        {sync.data ? (
          <p className="text-xs text-fg-subtle">
            Found {sync.data.reposFound} · created {sync.data.created} · already registered {sync.data.updated} · skipped {sync.data.skipped}
            {sync.data.rateLimited ? ' — stopped early on the GitHub rate limit; run again to continue.' : ''}
          </p>
        ) : null}
        {sync.isError ? (
          <p className="text-xs text-danger-fg">{sync.error instanceof ApiError ? sync.error.message : 'Organisation sync failed.'}</p>
        ) : null}
        {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
      </div>
    </div>
  );
}
