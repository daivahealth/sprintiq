export const CONFIGURATION_NAMESPACES = [
  'github',
  'jira',
  'llm',
  'notifications',
  'metrics',
  'security',
] as const;

export type ConfigurationNamespace = (typeof CONFIGURATION_NAMESPACES)[number];

export interface ConfigurationField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'secret-ref';
  required?: boolean;
  helper?: string;
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
      { key: 'organization', label: 'Organization', kind: 'text' },
      { key: 'defaultRepo', label: 'Default repository', kind: 'text' },
      { key: 'apiBaseUrl', label: 'API base URL', kind: 'text' },
      { key: 'tokenRef', label: 'Token secret ref', kind: 'secret-ref' },
      {
        key: 'webhookSecretRef',
        label: 'Webhook secret ref',
        kind: 'secret-ref',
      },
    ],
  },
  {
    namespace: 'jira',
    label: 'Jira',
    description: 'Planning collection defaults and issue-key parsing settings.',
    fields: [
      { key: 'siteUrl', label: 'Site URL', kind: 'text' },
      { key: 'projectKey', label: 'Default project key', kind: 'text' },
      { key: 'email', label: 'Integration email', kind: 'text' },
      { key: 'apiTokenRef', label: 'API token secret ref', kind: 'secret-ref' },
      {
        key: 'webhookSecretRef',
        label: 'Webhook secret ref',
        kind: 'secret-ref',
      },
    ],
  },
  {
    namespace: 'llm',
    label: 'LLM',
    description: 'Per-tenant AI model, provider, and spend controls.',
    fields: [
      { key: 'provider', label: 'Provider', kind: 'text' },
      { key: 'defaultModel', label: 'Default model', kind: 'text' },
      {
        key: 'monthlyTokenBudget',
        label: 'Monthly token budget',
        kind: 'number',
      },
      { key: 'apiKeyRef', label: 'API key secret ref', kind: 'secret-ref' },
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
  return CONFIGURATION_NAMESPACES.includes(value as ConfigurationNamespace);
}
