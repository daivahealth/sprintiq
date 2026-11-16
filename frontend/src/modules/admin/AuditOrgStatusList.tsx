import { Badge } from '../../components/ui';
import { useGithubOrganizations } from './GithubOrganizationsPanel';

/**
 * One compact audit-route row per additional GitHub organisation (ADR-0013).
 * The panel above stays the first organisation's; with one organisation this
 * renders nothing.
 */
export function AuditOrgStatusList() {
  const orgs = useGithubOrganizations();
  const others = (orgs.data?.organizations ?? []).filter((o) => !o.isDefault);
  if (others.length === 0) return null;
  return (
    <div className="space-y-2">
      {others.map((o) => (
        <div key={o.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-xs text-fg-secondary">
          <strong className="text-sm text-fg">{o.organization}</strong>
          <Badge tone={o.audit.enabled ? 'neutral' : 'warn'}>
            {o.audit.enabled ? `audit route ${o.audit.mode}` : 'audit route off'}
          </Badge>
          <Badge tone={o.digest === 'included' ? 'good' : 'neutral'}>{o.digest}</Badge>
          {o.audit.lagMinutes !== null ? <span>{o.audit.lagMinutes} min behind{o.audit.behind ? ' — lagging' : ''}</span> : null}
          {o.audit.lastStatus ? <span>last run: {o.audit.lastStatus}</span> : null}
          {o.audit.pendingRanges + o.audit.failedRanges > 0 ? (
            <span>{o.audit.pendingRanges} pending · {o.audit.failedRanges} failed</span>
          ) : null}
          {o.audit.lastError ? <span className="basis-full text-danger-fg">{o.audit.lastError}</span> : null}
        </div>
      ))}
    </div>
  );
}
