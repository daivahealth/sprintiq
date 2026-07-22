export const CONFIGURATION_NAMESPACES = [
  'github',
  'jira',
  'llm',
  'notifications',
  'metrics',
  'security',
] as const;

export type ConfigurationNamespace = (typeof CONFIGURATION_NAMESPACES)[number];

/**
 * Secret-ref convention used throughout the codebase (see Connection.secretRef,
 * resolved via `process.env[ref]` in the webhook controller): an environment
 * variable NAME, never a raw token/URL. Enforcing this pattern is what actually
 * stops an admin from pasting a real secret into a "secret ref" field.
 */
export const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const SECRET_REF_HINT =
  'Environment variable name only (e.g. GITHUB_TOKEN) — never a raw token or URL.';

const URL_PATTERN = /^https?:\/\/.+/;
const URL_HINT = 'Must start with http:// or https://';

export interface ConfigurationField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'secret-ref';
  required?: boolean;
  helper?: string;
  /** Optional format constraint for 'text' fields (e.g. URL shape). */
  pattern?: RegExp;
  patternHint?: string;
}

export interface ConfigurationSection {
  namespace: ConfigurationNamespace;
  label: string;
  description: string;
  fields: ConfigurationField[];
}

export const CONFIGURATION_CATALOG: ConfigurationSection[] = [
  {
    namespace: 'github',
    label: 'GitHub',
    description:
      'Repository collection defaults and webhook secret references.',
    fields: [
      {
        key: 'organization',
        label: 'Organization',
        kind: 'text',
        required: true,
      },
      { key: 'defaultRepo', label: 'Default repository', kind: 'text' },
      {
        key: 'apiBaseUrl',
        label: 'API base URL',
        kind: 'text',
        pattern: URL_PATTERN,
        patternHint: URL_HINT,
      },
      {
        key: 'tokenRef',
        label: 'Token secret ref',
        kind: 'secret-ref',
        required: true,
      },
      {
        key: 'webhookSecretRef',
        label: 'Webhook secret ref',
        kind: 'secret-ref',
      },
      {
        key: 'backfillDays',
        label: 'Backfill window (days)',
        kind: 'number',
        helper:
          'How far back to import history on first sync (default 90 days). Changing this after collection has started re-runs the backfill to the new window.',
      },
    ],
  },
  {
    namespace: 'jira',
    label: 'Jira',
    description: 'Planning collection defaults and issue-key parsing settings.',
    fields: [
      {
        key: 'siteUrl',
        label: 'Site URL',
        kind: 'text',
        required: true,
        pattern: URL_PATTERN,
        patternHint: URL_HINT,
      },
      { key: 'projectKey', label: 'Default project key', kind: 'text' },
      { key: 'email', label: 'Integration email', kind: 'text' },
      {
        key: 'apiTokenRef',
        label: 'API token secret ref',
        kind: 'secret-ref',
        required: true,
      },
      {
        key: 'webhookSecretRef',
        label: 'Webhook secret ref',
        kind: 'secret-ref',
      },
      {
        key: 'backfillDays',
        label: 'Backfill window (days)',
        kind: 'number',
        helper:
          'How far back to import history on first sync (default 90 days). Changing this after collection has started re-runs the backfill to the new window.',
      },
    ],
  },
  {
    namespace: 'llm',
    label: 'LLM',
    description: 'Per-tenant AI model, provider, and spend controls.',
    fields: [
      { key: 'provider', label: 'Provider', kind: 'text', required: true },
      {
        key: 'defaultModel',
        label: 'Default model',
        kind: 'text',
        required: true,
      },
      {
        key: 'monthlyTokenBudget',
        label: 'Monthly token budget',
        kind: 'number',
      },
      {
        key: 'apiKeyRef',
        label: 'API key secret ref',
        kind: 'secret-ref',
        required: true,
      },
    ],
  },
  {
    namespace: 'notifications',
    label: 'Notifications',
    description: 'Outbound delivery configuration for approved notifications.',
    fields: [
      {
        key: 'slackWebhookRef',
        label: 'Slack webhook ref',
        kind: 'secret-ref',
      },
      {
        key: 'teamsWebhookRef',
        label: 'Teams webhook ref',
        kind: 'secret-ref',
      },
      { key: 'emailFrom', label: 'Email from address', kind: 'text' },
    ],
  },
  {
    namespace: 'metrics',
    label: 'Metrics',
    description: 'Tenant-level metric windows, thresholds, and exclusions.',
    fields: [
      {
        key: 'defaultWindowDays',
        label: 'Default window days',
        kind: 'number',
      },
      { key: 'excludeBots', label: 'Exclude bot accounts', kind: 'boolean' },
      {
        key: 'cycleTimeTargetHours',
        label: 'PR cycle target hours',
        kind: 'number',
      },
    ],
  },
  {
    namespace: 'security',
    label: 'Security',
    description: 'Tenant-level security and authentication policy knobs.',
    fields: [
      { key: 'ssoEnabled', label: 'SSO enabled', kind: 'boolean' },
      {
        key: 'sessionTtlMinutes',
        label: 'Session TTL minutes',
        kind: 'number',
      },
      { key: 'allowedDomains', label: 'Allowed email domains', kind: 'text' },
    ],
  },
];

export function isConfigurationNamespace(
  value: string,
): value is ConfigurationNamespace {
  return (CONFIGURATION_NAMESPACES as readonly string[]).includes(value);
}

export function getConfigurationSection(
  namespace: ConfigurationNamespace,
): ConfigurationSection {
  const section = CONFIGURATION_CATALOG.find((s) => s.namespace === namespace);
  if (!section) {
    throw new Error(`No catalog section for namespace "${namespace}".`);
  }
  return section;
}

/**
 * Validate values/secretRefs against the catalog for one namespace:
 * unknown keys rejected, types checked per field kind, secret-ref values must
 * match the env-var-name convention (the actual enforcement behind "store
 * references only, never raw tokens"), required fields enforced when the
 * config is being saved as active. Returns field-level error messages.
 */
export function validateConfigurationValues(
  namespace: ConfigurationNamespace,
  values: Record<string, unknown>,
  secretRefs: Record<string, unknown>,
  status: string,
): string[] {
  const section = getConfigurationSection(namespace);
  const errors: string[] = [];
  const knownKeys = new Set(section.fields.map((f) => f.key));

  for (const key of Object.keys(values)) {
    if (
      !knownKeys.has(key) ||
      section.fields.find((f) => f.key === key)?.kind === 'secret-ref'
    ) {
      errors.push(`Unknown or misplaced field "${key}" in values.`);
    }
  }
  for (const key of Object.keys(secretRefs)) {
    const field = section.fields.find((f) => f.key === key);
    if (!field || field.kind !== 'secret-ref') {
      errors.push(`Unknown or misplaced field "${key}" in secretRefs.`);
    }
  }

  for (const field of section.fields) {
    const bucket = field.kind === 'secret-ref' ? secretRefs : values;
    const raw = bucket[field.key];
    const present = raw !== undefined && raw !== null && raw !== '';

    if (status === 'active' && field.required && !present) {
      errors.push(`"${field.label}" is required.`);
      continue;
    }
    if (!present) {
      continue;
    }

    switch (field.kind) {
      case 'secret-ref':
        if (typeof raw !== 'string' || !SECRET_REF_PATTERN.test(raw)) {
          errors.push(`"${field.label}": ${SECRET_REF_HINT}`);
        }
        break;
      case 'number':
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          errors.push(`"${field.label}" must be a number.`);
        }
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') {
          errors.push(`"${field.label}" must be true or false.`);
        }
        break;
      case 'text':
        if (typeof raw !== 'string') {
          errors.push(`"${field.label}" must be text.`);
        } else if (field.pattern && !field.pattern.test(raw)) {
          errors.push(
            `"${field.label}": ${field.patternHint ?? 'invalid format.'}`,
          );
        }
        break;
    }
  }

  return errors;
}
