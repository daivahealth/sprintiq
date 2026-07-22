import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import type {
  ConfigurationCatalogResponse,
  ConfigurationField,
  ConfigurationNamespace,
  ConfigurationSection,
  TenantConfiguration,
  UpsertConfigurationPayload,
} from '../../lib/api/types';
import { Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { timeAgo } from '../../lib/utils';

type Draft = Record<string, string | boolean>;
type ConfigStatus = 'active' | 'disabled';

interface SavedState {
  draft: Draft;
  status: ConfigStatus;
  updatedAt?: string;
}

function useConfigurationCatalog() {
  return useQuery({
    queryKey: ['admin', 'configurations', 'catalog'],
    queryFn: () =>
      api.get<ConfigurationCatalogResponse>(
        '/api/admin/configurations/catalog',
      ),
    staleTime: 10 * 60_000,
  });
}

function useTenantConfigurations() {
  return useQuery({
    queryKey: ['admin', 'configurations'],
    queryFn: () =>
      api.get<{ configurations: TenantConfiguration[] }>(
        '/api/admin/configurations',
      ),
  });
}

export function AdminConfigurationsPage() {
  const queryClient = useQueryClient();
  const catalog = useConfigurationCatalog();
  const configs = useTenantConfigurations();
  const [active, setActive] = useState<string>('github');

  // `drafts`/`statusDrafts` are user-owned once seeded: only Reset or an
  // explicit reload overwrites them. Never rebuild them wholesale from a
  // refetch — that was the root cause of unsaved edits in one section being
  // wiped out by saving a different section.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [statusDrafts, setStatusDrafts] = useState<Record<string, ConfigStatus>>({});
  const [savedSnapshots, setSavedSnapshots] = useState<Record<string, SavedState>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, Record<string, string>>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, ApiError | undefined>>({});
  // Secret VALUES (as opposed to ref names, which live in `drafts`) — never
  // seeded from the server, since it never echoes them back. Cleared after a
  // successful save, since the value is now stored server-side.
  const [secretValueDrafts, setSecretValueDrafts] = useState<Record<string, Record<string, string>>>({});
  // Field keys marked to have their stored value deleted on next save.
  const [secretsToClear, setSecretsToClear] = useState<Record<string, Set<string>>>({});

  const sections = catalog.data?.sections ?? [];
  const byNamespace = useMemo(() => {
    const map = new Map<string, TenantConfiguration>();
    for (const config of configs.data?.configurations ?? []) {
      if (config.key === 'default') {
        map.set(config.namespace, config);
      }
    }
    return map;
  }, [configs.data?.configurations]);

  useEffect(() => {
    if (!catalog.data || !configs.data) {
      return;
    }
    setSavedSnapshots(() => {
      const next: Record<string, SavedState> = {};
      for (const section of catalog.data.sections) {
        const stored = byNamespace.get(section.namespace);
        next[section.namespace] = {
          draft: buildDraft(section.fields, stored),
          status: (stored?.status as ConfigStatus) ?? 'active',
          updatedAt: stored?.updatedAt,
        };
      }
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      for (const section of catalog.data.sections) {
        if (next[section.namespace] === undefined) {
          const stored = byNamespace.get(section.namespace);
          next[section.namespace] = buildDraft(section.fields, stored);
        }
      }
      return next;
    });
    setStatusDrafts((current) => {
      const next = { ...current };
      for (const section of catalog.data.sections) {
        if (next[section.namespace] === undefined) {
          const stored = byNamespace.get(section.namespace);
          next[section.namespace] = (stored?.status as ConfigStatus) ?? 'active';
        }
      }
      return next;
    });
  }, [byNamespace, catalog.data, configs.data]);

  const isDirty = (namespace: string) => {
    const draft = drafts[namespace];
    const saved = savedSnapshots[namespace];
    const status = statusDrafts[namespace];
    if (!draft || !saved || !status) {
      return false;
    }
    const hasPendingSecretValue = Object.values(secretValueDrafts[namespace] ?? {}).some(
      (v) => v.trim() !== '',
    );
    const hasPendingClear = (secretsToClear[namespace]?.size ?? 0) > 0;
    return (
      status !== saved.status ||
      JSON.stringify(draft) !== JSON.stringify(saved.draft) ||
      hasPendingSecretValue ||
      hasPendingClear
    );
  };

  const anyDirty = sections.some((section) => isDirty(section.namespace));

  useEffect(() => {
    if (!anyDirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);

  const save = useMutation({
    mutationFn: (namespace: string) => {
      const section = sections.find((s) => s.namespace === namespace);
      if (!section) {
        throw new Error(`Unknown configuration section "${namespace}".`);
      }
      const payload = buildPayload(
        section,
        drafts[namespace] ?? {},
        statusDrafts[namespace] ?? 'active',
        savedSnapshots[namespace]?.updatedAt,
        secretValueDrafts[namespace] ?? {},
        Array.from(secretsToClear[namespace] ?? []),
      );
      return api.put<TenantConfiguration>('/api/admin/configurations', payload);
    },
    onSuccess: (saved, namespace) => {
      const section = sections.find((s) => s.namespace === namespace);
      queryClient.setQueryData<{ configurations: TenantConfiguration[] }>(
        ['admin', 'configurations'],
        (old) => {
          const list = old?.configurations ?? [];
          const idx = list.findIndex(
            (c) => c.namespace === saved.namespace && c.key === saved.key,
          );
          const nextList =
            idx >= 0
              ? [...list.slice(0, idx), saved, ...list.slice(idx + 1)]
              : [...list, saved];
          return { configurations: nextList };
        },
      );
      if (section) {
        setSavedSnapshots((current) => ({
          ...current,
          [namespace]: {
            draft: buildDraft(section.fields, saved),
            status: saved.status,
            updatedAt: saved.updatedAt,
          },
        }));
      }
      // Values are now stored server-side — never keep them in browser memory.
      setSecretValueDrafts((current) => ({ ...current, [namespace]: {} }));
      setSecretsToClear((current) => ({ ...current, [namespace]: new Set() }));
      setFieldErrors((current) => ({ ...current, [namespace]: {} }));
      setSaveErrors((current) => ({ ...current, [namespace]: undefined }));
    },
    onError: (error, namespace) => {
      setSaveErrors((current) => ({
        ...current,
        [namespace]: error instanceof ApiError ? error : undefined,
      }));
    },
  });

  const selected = sections.find((section) => section.namespace === active);
  const loading = catalog.isLoading || configs.isLoading;

  const updateDraft = (
    section: ConfigurationSection,
    field: ConfigurationField,
    value: string | boolean,
  ) => {
    setDrafts((current) => ({
      ...current,
      [section.namespace]: {
        ...(current[section.namespace] ?? {}),
        [field.key]: value,
      },
    }));
  };

  const handleSave = (section: ConfigurationSection) => {
    if (!catalog.data) {
      return;
    }
    const errors = computeFieldErrors(
      section,
      drafts[section.namespace] ?? {},
      statusDrafts[section.namespace] ?? 'active',
      new RegExp(catalog.data.secretRefPattern),
      secretValueDrafts[section.namespace] ?? {},
    );
    setFieldErrors((current) => ({ ...current, [section.namespace]: errors }));
    if (Object.keys(errors).length > 0) {
      return;
    }
    save.mutate(section.namespace);
  };

  const updateSecretValueDraft = (
    section: ConfigurationSection,
    field: ConfigurationField,
    value: string,
  ) => {
    setSecretValueDrafts((current) => ({
      ...current,
      [section.namespace]: { ...(current[section.namespace] ?? {}), [field.key]: value },
    }));
    // Typing a new value supersedes any pending "clear" for the same field.
    setSecretsToClear((current) => {
      const next = new Set(current[section.namespace] ?? []);
      next.delete(field.key);
      return { ...current, [section.namespace]: next };
    });
  };

  const markSecretForClear = (section: ConfigurationSection, field: ConfigurationField) => {
    setSecretsToClear((current) => {
      const next = new Set(current[section.namespace] ?? []);
      next.add(field.key);
      return { ...current, [section.namespace]: next };
    });
    setSecretValueDrafts((current) => {
      const next = { ...(current[section.namespace] ?? {}) };
      delete next[field.key];
      return { ...current, [section.namespace]: next };
    });
  };

  const handleReset = (section: ConfigurationSection) => {
    const saved = savedSnapshots[section.namespace];
    if (!saved) {
      return;
    }
    setDrafts((current) => ({ ...current, [section.namespace]: { ...saved.draft } }));
    setStatusDrafts((current) => ({ ...current, [section.namespace]: saved.status }));
    setSecretValueDrafts((current) => ({ ...current, [section.namespace]: {} }));
    setSecretsToClear((current) => ({ ...current, [section.namespace]: new Set() }));
    setFieldErrors((current) => ({ ...current, [section.namespace]: {} }));
    setSaveErrors((current) => ({ ...current, [section.namespace]: undefined }));
  };

  const handleReloadLatest = async (section: ConfigurationSection) => {
    const result = await configs.refetch();
    const fresh = (result.data?.configurations ?? []).find(
      (c) => c.namespace === section.namespace && c.key === 'default',
    );
    const newDraft = buildDraft(section.fields, fresh);
    const status: ConfigStatus = (fresh?.status as ConfigStatus) ?? 'active';
    setDrafts((current) => ({ ...current, [section.namespace]: newDraft }));
    setStatusDrafts((current) => ({ ...current, [section.namespace]: status }));
    setSavedSnapshots((current) => ({
      ...current,
      [section.namespace]: { draft: newDraft, status, updatedAt: fresh?.updatedAt },
    }));
    setSecretValueDrafts((current) => ({ ...current, [section.namespace]: {} }));
    setSecretsToClear((current) => ({ ...current, [section.namespace]: new Set() }));
    setFieldErrors((current) => ({ ...current, [section.namespace]: {} }));
    setSaveErrors((current) => ({ ...current, [section.namespace]: undefined }));
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">
            Configuration
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Tenant-scoped integration, AI, metric, and policy settings
          </p>
        </div>
        {loading && <Spinner />}
      </div>

      {catalog.isError || configs.isError ? (
        <Card>
          <p className="text-sm text-rose-700">
            Configuration data could not be loaded.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-1">
          {sections.map((section) => {
            const stored = byNamespace.get(section.namespace);
            const selectedSection = section.namespace === active;
            const dirty = isDirty(section.namespace);
            return (
              <button
                key={section.namespace}
                type="button"
                onClick={() => setActive(section.namespace)}
                className={
                  selectedSection
                    ? 'flex w-full items-center justify-between rounded-md bg-brand-fg px-3 py-2 text-left text-sm font-medium text-brand'
                    : 'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100'
                }
              >
                <span className="flex items-center gap-2">
                  {section.label}
                  {dirty ? (
                    <span
                      title="Unsaved changes"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  ) : null}
                </span>
                {stored ? (
                  <Badge tone={stored.status === 'active' ? 'good' : 'neutral'}>
                    {stored.status}
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>

        {selected ? (
          <Card className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  {selected.label}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  {selected.description}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {byNamespace.get(selected.namespace) ? (
                  <Badge tone="good">Configured</Badge>
                ) : (
                  <Badge>Not configured</Badge>
                )}
                <label className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={(statusDrafts[selected.namespace] ?? 'active') === 'active'}
                    onChange={(event) =>
                      setStatusDrafts((current) => ({
                        ...current,
                        [selected.namespace]: event.target.checked ? 'active' : 'disabled',
                      }))
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Enabled
                </label>
              </div>
            </div>

            <ConnectionLinkageNotice
              namespace={selected.namespace}
              connection={byNamespace.get(selected.namespace)?.connection ?? null}
            />

            <div className="grid gap-4 md:grid-cols-2">
              {selected.fields.map((field) => {
                const value = drafts[selected.namespace]?.[field.key];
                const error = fieldErrors[selected.namespace]?.[field.key];
                if (field.kind === 'boolean') {
                  return (
                    <label
                      key={field.key}
                      className="flex min-h-[42px] items-center gap-3 rounded-md border border-slate-200 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(value)}
                        onChange={(event) =>
                          updateDraft(selected, field, event.target.checked)
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      <span className="text-sm font-medium text-slate-700">
                        {field.label}
                      </span>
                    </label>
                  );
                }
                const isSecretRef = field.kind === 'secret-ref';
                const secretValueDraft = secretValueDrafts[selected.namespace]?.[field.key] ?? '';
                const isMarkedForClear =
                  secretsToClear[selected.namespace]?.has(field.key) ?? false;
                const isStoredSecurely =
                  byNamespace.get(selected.namespace)?.secretsConfigured?.[field.key] ?? false;
                return (
                  <Fragment key={field.key}>
                    <Field label={field.required ? `${field.label} *` : field.label}>
                      <div className="flex items-center gap-2">
                        <Input
                          type={field.kind === 'number' ? 'number' : 'text'}
                          value={String(value ?? '')}
                          placeholder={isSecretRef ? 'e.g. GITHUB_TOKEN' : undefined}
                          onChange={(event) =>
                            updateDraft(selected, field, event.target.value)
                          }
                          className={
                            isSecretRef
                              ? `font-mono ${error ? 'border-rose-400' : ''}`
                              : error
                                ? 'border-rose-400'
                                : ''
                          }
                        />
                        {isSecretRef ? <Badge>ENV VAR</Badge> : null}
                      </div>
                      {error ? (
                        <p className="text-xs text-rose-600">{error}</p>
                      ) : isSecretRef ? (
                        <p className="text-xs text-slate-400">
                          {catalog.data?.secretRefHint}
                        </p>
                      ) : field.patternHint ? (
                        <p className="text-xs text-slate-400">{field.patternHint}</p>
                      ) : field.helper ? (
                        <p className="text-xs text-slate-400">{field.helper}</p>
                      ) : null}
                    </Field>

                    {isSecretRef ? (
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 md:col-span-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-500">
                            Secret value for {field.label}
                          </span>
                          {isStoredSecurely ? (
                            <Badge tone="good">Stored securely</Badge>
                          ) : (
                            <Badge>Not stored — falls back to server env var if set</Badge>
                          )}
                        </div>
                        {catalog.data?.secretsStoreEnabled === false ? (
                          <p className="mt-2 text-xs text-amber-600">
                            Ask an operator to set SECRETS_ENCRYPTION_KEY on the server to
                            paste secrets here — for now, use an environment variable
                            matching the ref name above.
                          </p>
                        ) : (
                          <div className="mt-2 flex items-center gap-2">
                            <Input
                              type="password"
                              autoComplete="new-password"
                              value={isMarkedForClear ? '' : secretValueDraft}
                              disabled={isMarkedForClear}
                              placeholder={
                                isMarkedForClear
                                  ? 'Will be cleared on save'
                                  : isStoredSecurely
                                    ? 'Paste a new value to replace the stored one'
                                    : 'Paste the real token to store it securely'
                              }
                              onChange={(event) =>
                                updateSecretValueDraft(selected, field, event.target.value)
                              }
                            />
                            {isStoredSecurely ? (
                              <Button
                                type="button"
                                onClick={() => markSecretForClear(selected, field)}
                                disabled={isMarkedForClear}
                                className="whitespace-nowrap bg-slate-100 text-slate-700 hover:bg-slate-200"
                              >
                                {isMarkedForClear ? 'Will clear' : 'Clear'}
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <p className="text-xs text-slate-500">
                Store secret manager references only, never raw tokens.
              </p>
              <div className="flex items-center gap-2">
                {isDirty(selected.namespace) ? (
                  <Button
                    type="button"
                    onClick={() => handleReset(selected)}
                    className="bg-slate-100 text-slate-700 hover:bg-slate-200"
                  >
                    Reset
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={() => handleSave(selected)}
                  disabled={save.isPending || !isDirty(selected.namespace)}
                >
                  {save.isPending ? 'Saving…' : 'Save configuration'}
                </Button>
              </div>
            </div>

            {saveErrors[selected.namespace] ? (
              <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3">
                {saveErrors[selected.namespace]?.details?.length ? (
                  <ul className="list-disc space-y-1 pl-4 text-sm text-rose-700">
                    {saveErrors[selected.namespace]?.details?.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-rose-700">
                    {saveErrors[selected.namespace]?.message ??
                      'Configuration could not be saved.'}
                  </p>
                )}
                {saveErrors[selected.namespace]?.status === 409 ? (
                  <Button
                    type="button"
                    onClick={() => handleReloadLatest(selected)}
                    className="bg-rose-600 hover:bg-rose-700"
                  >
                    Reload latest and discard local edits
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Whether "saved as active" is actually collecting data — github/jira are
 * backed by a real Connection (BC-0) that a scheduled sync runs against;
 * without this, an admin could save the screen and reasonably assume data is
 * flowing when it isn't (e.g. no default repo yet to collect from).
 */
function ConnectionLinkageNotice({
  namespace,
  connection,
}: {
  namespace: ConfigurationNamespace;
  connection: TenantConfiguration['connection'];
}) {
  if (!connection) {
    return null; // config-only namespace (llm/notifications/metrics/security)
  }

  if (!connection.linked) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <span className="font-medium">Not collecting yet.</span>{' '}
        {linkingHint(namespace)}
      </div>
    );
  }

  if (connection.status !== 'active') {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <span className="font-medium">Linked, but disabled.</span> Enable this
        section and save to resume collection.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      <span className="font-medium">Collecting.</span>{' '}
      {connection.lastSyncAt
        ? `Last synced ${timeAgo(connection.lastSyncAt)}.`
        : "Backfill hasn't run yet — the first sync happens within 5 minutes."}
    </div>
  );
}

function linkingHint(namespace: ConfigurationNamespace): string {
  if (namespace === 'github') {
    return 'Add a default repository above to start collecting PRs and commits.';
  }
  if (namespace === 'jira') {
    return 'Add an integration email above (needed for API auth) to start collecting issues.';
  }
  return '';
}

function buildDraft(
  fields: ConfigurationField[],
  config?: TenantConfiguration,
): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const source = field.kind === 'secret-ref' ? config?.secretRefs : config?.values;
    const value = source?.[field.key];
    if (field.kind === 'boolean') {
      draft[field.key] = Boolean(value);
    } else {
      draft[field.key] = value === undefined || value === null ? '' : String(value);
    }
  }
  return draft;
}

function normalizeValue(
  field: ConfigurationField,
  value: string | boolean | undefined,
): unknown {
  if (field.kind === 'boolean') {
    return Boolean(value);
  }
  if (value === undefined || value === '') {
    return null;
  }
  if (field.kind === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return typeof value === 'string' ? value.trim() : '';
}

function buildPayload(
  section: ConfigurationSection,
  draft: Draft,
  status: ConfigStatus,
  expectedUpdatedAt: string | undefined,
  secretValueDraft: Record<string, string>,
  clearSecrets: string[],
): UpsertConfigurationPayload {
  const values: Record<string, unknown> = {};
  const secretRefs: Record<string, unknown> = {};
  for (const field of section.fields) {
    const raw = draft[field.key];
    const target = field.kind === 'secret-ref' ? secretRefs : values;
    const normalized = normalizeValue(field, raw);
    if (normalized === null && field.kind !== 'boolean') {
      continue;
    }
    target[field.key] = normalized;
  }
  const secretValues: Record<string, unknown> = {};
  for (const [fieldKey, raw] of Object.entries(secretValueDraft)) {
    if (raw.trim() !== '') {
      secretValues[fieldKey] = raw.trim();
    }
  }
  return {
    namespace: section.namespace as ConfigurationNamespace,
    key: 'default',
    values,
    secretRefs,
    secretValues: Object.keys(secretValues).length > 0 ? secretValues : undefined,
    clearSecrets: clearSecrets.length > 0 ? clearSecrets : undefined,
    status,
    expectedUpdatedAt,
  };
}

/** Mirrors the backend's validateConfigurationValues so bad input is caught before a round trip. */
function computeFieldErrors(
  section: ConfigurationSection,
  draft: Draft,
  status: ConfigStatus,
  secretRefPattern: RegExp,
  secretValueDraft: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of section.fields) {
    const raw = draft[field.key];
    const present = field.kind === 'boolean' ? true : raw !== undefined && raw !== '';

    if (status === 'active' && field.required && !present) {
      errors[field.key] = 'Required.';
      continue;
    }

    if (
      field.kind === 'secret-ref' &&
      (secretValueDraft[field.key] ?? '').trim() !== '' &&
      !present
    ) {
      errors[field.key] = 'Set a secret ref name before providing a value.';
      continue;
    }

    if (!present) {
      continue;
    }

    if (field.kind === 'secret-ref') {
      if (typeof raw !== 'string' || !secretRefPattern.test(raw)) {
        errors[field.key] = 'Must be an environment variable name (e.g. GITHUB_TOKEN), not a raw secret or URL.';
      }
    } else if (field.kind === 'number') {
      if (Number.isNaN(Number(raw))) {
        errors[field.key] = 'Must be a number.';
      }
    } else if (field.kind === 'text' && field.pattern) {
      const re = new RegExp(field.pattern);
      if (typeof raw === 'string' && raw !== '' && !re.test(raw)) {
        errors[field.key] = field.patternHint ?? 'Invalid format.';
      }
    }
  }
  return errors;
}
