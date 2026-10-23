import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card } from '../../components/ui';
import { api } from '../../lib/api/client';
import { timeAgo } from '../../lib/utils';
import { suggestedPrimary, type DuplicateGroup } from './identity-duplicates';

interface IdentityOverride {
  sourceSystem: string;
  sourceKey: string;
  action: 'merge' | 'exclude';
  canonicalDeveloperId: string | null;
  reason: string;
  setByUserId: string;
  updatedAt: string;
}

const BASE = '/api/admin/configurations/identity-overrides';

/**
 * "One person, two rows" — fixed by an admin, not a script (2026-10-19).
 *
 * Possible duplicates are developers whose names normalise to the same letters
 * (a personal account beside the corporate one, a name in capitals). Nothing
 * merges until an admin clicks, and every merge carries a reason, takes effect
 * at once, and is audited. Current overrides are listed with who set them and
 * why, and can be removed.
 */
export function DeveloperIdentitiesPanel() {
  const queryClient = useQueryClient();
  const groups = useQuery({
    queryKey: ['admin', 'identity-duplicates'],
    queryFn: () => api.get<{ groups: DuplicateGroup[] }>(`${BASE}/possible-duplicates`),
  });
  const overrides = useQuery({
    queryKey: ['admin', 'identity-overrides'],
    queryFn: () => api.get<{ overrides: IdentityOverride[] }>(BASE),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'identity-duplicates'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'identity-overrides'] }),
    ]);

  const [merging, setMerging] = useState<{ from: string; into: string } | null>(null);
  const [reason, setReason] = useState('');
  const merge = useMutation({
    mutationFn: (p: { from: string; into: string; reason: string }) =>
      api.post(`${BASE}/merge-developer`, p),
    onSuccess: () => {
      setMerging(null);
      setReason('');
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (o: IdentityOverride) =>
      api.delete(`${BASE}/${encodeURIComponent(o.sourceSystem)}/${encodeURIComponent(o.sourceKey)}`),
    onSuccess: refresh,
  });

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-fg">Developer identities</h3>
        <p className="text-sm text-fg-subtle">
          When one person shows up as two developers — a personal GitHub
          account, or the same name spelt differently — merge them here. Each
          merge needs a reason, applies immediately, and is recorded.
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-fg-muted">Possible duplicates</h4>
        {groups.isLoading && <p className="text-sm text-fg-faint">Loading…</p>}
        {groups.data && groups.data.groups.length === 0 && (
          <p className="text-sm text-fg-faint">No developers share a name.</p>
        )}
        {groups.data?.groups.map((g) => {
          const primary = suggestedPrimary(g);
          return (
            <div key={g.name} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {g.members.map((m) => (
                  <span key={m.canonicalDeveloperId} className="flex items-center gap-1">
                    <span className="text-fg-secondary">{m.displayName}</span>
                    <code className="rounded bg-muted px-1 text-xs text-fg-subtle">
                      {m.canonicalDeveloperId}
                    </code>
                    {m.canonicalDeveloperId === primary && <Badge tone="good">suggested target</Badge>}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {g.members
                  .filter((m) => m.canonicalDeveloperId !== primary)
                  .map((m) =>
                    merging?.from === m.canonicalDeveloperId ? (
                      <form
                        key={m.canonicalDeveloperId}
                        className="flex flex-wrap items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          merge.mutate({ ...merging, reason });
                        }}
                      >
                        <span className="text-xs text-fg-subtle">
                          Merge {m.canonicalDeveloperId} into {merging.into}:
                        </span>
                        <input
                          className="w-56 rounded border border-border bg-surface px-2 py-1 text-xs"
                          placeholder="Why are these the same person?"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          autoFocus
                        />
                        <Button size="sm" disabled={reason.trim().length < 3 || merge.isPending}>
                          Merge
                        </Button>
                        <Button size="sm" variant="ghost" type="button" onClick={() => setMerging(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <Button
                        key={m.canonicalDeveloperId}
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setMerging({ from: m.canonicalDeveloperId, into: primary })
                        }
                      >
                        Merge {m.displayName} into {primary}…
                      </Button>
                    ),
                  )}
              </div>
            </div>
          );
        })}
        {merge.isError && (
          <p className="text-sm text-danger-fg">{(merge.error as Error).message}</p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-fg-muted">Current overrides</h4>
        {overrides.data && overrides.data.overrides.length === 0 && (
          <p className="text-sm text-fg-faint">None.</p>
        )}
        <ul className="divide-y divide-border-subtle text-sm">
          {overrides.data?.overrides.map((o) => (
            <li key={`${o.sourceSystem}:${o.sourceKey}`} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={o.action === 'merge' ? 'neutral' : 'warn'}>{o.action}</Badge>
              <code className="text-xs text-fg-subtle">{o.sourceKey}</code>
              {o.canonicalDeveloperId && (
                <span className="text-xs text-fg-subtle">→ {o.canonicalDeveloperId}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-fg-faint" title={o.reason}>
                {o.reason} · {timeAgo(o.updatedAt)}
              </span>
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(o)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
