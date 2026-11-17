import type {
  ConfigurationCatalogResponse,
  GithubOrganization,
  UpsertConfigurationPayload,
} from '../../lib/api/types';

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
  branchHistoryLookbackDays: string;
  maxHistoryBranches: string;
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
    branchHistoryLookbackDays: '',
    maxHistoryBranches: '',
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
    // An inherited window is shown as a placeholder, never copied into the draft.
    backfillDays: org.inheritedValues?.includes('backfillDays') ? '' : num(org.values.backfillDays),
    syncIntervalMinutes: org.inheritedValues?.includes('syncIntervalMinutes')
      ? ''
      : num(org.values.syncIntervalMinutes),
    branchHistoryLookbackDays: num(org.values.branchHistoryLookbackDays),
    maxHistoryBranches: num(org.values.maxHistoryBranches),
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
  const lookback = Number(draft.branchHistoryLookbackDays);
  if (draft.branchHistoryLookbackDays.trim() && Number.isFinite(lookback) && lookback > 0) {
    values.branchHistoryLookbackDays = lookback;
  }
  const maxBranches = Number(draft.maxHistoryBranches);
  if (draft.maxHistoryBranches.trim() && Number.isFinite(maxBranches) && maxBranches >= 0) {
    values.maxHistoryBranches = maxBranches;
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

/** "blank = 400 from athmahealth" for an inheritable window value; else "blank = <fallback>". */
export function inheritedValuePlaceholder(
  key: 'backfillDays' | 'syncIntervalMinutes',
  defaultOrg: Pick<GithubOrganization, 'organization' | 'values'> | undefined,
  fallback: string,
): string {
  const v = defaultOrg?.values[key];
  return typeof v === 'number' ? `blank = ${v} from ${defaultOrg?.organization}` : `blank = ${fallback}`;
}

export interface RereadResult {
  status: 'scheduled' | 'not_ingest' | 'not_seeded';
  repos: string[];
  readOnNextPushOnly?: boolean;
}

/** What "Read branch history" tells the admin. */
export function rereadMessage(r: RereadResult): string {
  if (r.status === 'not_seeded') return 'Not seeded yet — wait for the first sweep.';
  if (r.status === 'not_ingest') return 'Audit route is not in ingest mode.';
  const n = r.repos.length;
  if (n === 0) return 'No repositories registered for this organisation yet — run Sync org first.';
  const when = r.readOnNextPushOnly
    ? 'when each repository is next pushed to (full sweep is off)'
    : 'at the next full branch sweep (runs hourly)';
  return `Branch history will be read for ${n} ${n === 1 ? 'repo' : 'repos'} ${when}.`;
}

/** Settings that exist only on an added organisation's card; the first organisation's form never shows them. */
export const ORG_ONLY_FIELD_KEYS = ['branchHistoryLookbackDays', 'maxHistoryBranches'];

export function withoutOrgOnlyFields(res: ConfigurationCatalogResponse): ConfigurationCatalogResponse {
  return {
    ...res,
    sections: res.sections.map((section) =>
      section.namespace === 'github'
        ? { ...section, fields: section.fields.filter((f) => !ORG_ONLY_FIELD_KEYS.includes(f.key)) }
        : section,
    ),
  };
}
