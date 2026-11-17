import type { GithubOrganization, UpsertConfigurationPayload } from '../../lib/api/types';

/** Mirrors the backend's GITHUB_LOGIN_PATTERN (github-orgs.ts). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const ORG_REF_FIELDS = [
  { key: 'tokenRef', label: 'Token secret ref' },
  { key: 'auditLogTokenRef', label: 'Audit-log token secret ref' },
  { key: 'copilotMetricsTokenRef', label: 'Copilot metrics token secret ref' },
] as const;

export interface OrgDraft {
  organization: string;
  tokenRef: string;
  auditLogTokenRef: string;
  copilotMetricsTokenRef: string;
  backfillDays: string;
  syncIntervalMinutes: string;
  enabled: boolean;
}

export function emptyOrgDraft(): OrgDraft {
  return {
    organization: '',
    tokenRef: '',
    auditLogTokenRef: '',
    copilotMetricsTokenRef: '',
    backfillDays: '',
    syncIntervalMinutes: '',
    enabled: true,
  };
}

/** A saved organisation as an editable draft: its OWN refs only, so inherited ones stay blank. */
export function draftOf(org: GithubOrganization): OrgDraft {
  const own = (k: string) =>
    org.inheritedRefs.includes(k) ? '' : (org.secretRefs[k] ?? '');
  const num = (v: unknown) => (typeof v === 'number' ? String(v) : '');
  return {
    organization: org.organization,
    tokenRef: own('tokenRef'),
    auditLogTokenRef: own('auditLogTokenRef'),
    copilotMetricsTokenRef: own('copilotMetricsTokenRef'),
    backfillDays: num(org.values.backfillDays),
    syncIntervalMinutes: num(org.values.syncIntervalMinutes),
    enabled: org.status === 'active',
  };
}

export function validateOrgLogin(login: string, existing: readonly string[]): string | null {
  const trimmed = login.trim();
  if (!LOGIN.test(trimmed)) return 'Enter the GitHub login of the organisation (letters, digits, hyphens).';
  if (existing.some((o) => o.toLowerCase() === trimmed.toLowerCase())) {
    return `GitHub organisation "${trimmed}" is already configured.`;
  }
  return null;
}

export function orgPayload(draft: OrgDraft): UpsertConfigurationPayload {
  const organization = draft.organization.trim();
  const values: Record<string, unknown> = { organization };
  for (const k of ['backfillDays', 'syncIntervalMinutes'] as const) {
    const n = Number(draft[k]);
    if (draft[k].trim() && Number.isFinite(n) && n > 0) values[k] = n;
  }
  const secretRefs: Record<string, string> = {};
  for (const { key } of ORG_REF_FIELDS) {
    const v = draft[key].trim();
    if (v) secretRefs[key] = v;
  }
  return {
    namespace: 'github',
    key: organization.toLowerCase(),
    values,
    secretRefs,
    status: draft.enabled ? 'active' : 'disabled',
  };
}

export function inheritedPlaceholder(ref: string, defaultOrg: GithubOrganization | undefined): string {
  const name = defaultOrg?.secretRefs[ref];
  return name ? `blank = ${name} from ${defaultOrg.organization}` : 'blank = not set';
}
