import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type {
  ConfigurationField,
  ConfigurationSection,
  TenantConfiguration,
} from '../../lib/api/types';
import { Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';

type Draft = Record<string, string | boolean>;

function useConfigurationCatalog() {
  return useQuery({
    queryKey: ['admin', 'configurations', 'catalog'],
    queryFn: () =>
      api.get<{ sections: ConfigurationSection[] }>(
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

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
    const next: Record<string, Draft> = {};
    for (const section of catalog.data.sections) {
      const config = byNamespace.get(section.namespace);
      next[section.namespace] = buildDraft(section.fields, config);
    }
    setDrafts(next);
  }, [byNamespace, catalog.data, configs.data]);

  const save = useMutation({
    mutationFn: (section: ConfigurationSection) => {
      const draft = drafts[section.namespace] ?? {};
      const values: Record<string, unknown> = {};
      const secretRefs: Record<string, unknown> = {};
      for (const field of section.fields) {
        const raw = draft[field.key];
        const target = field.kind === 'secret-ref' ? secretRefs : values;
        target[field.key] = normalizeValue(field, raw);
      }
      return api.put<TenantConfiguration>('/api/admin/configurations', {
        namespace: section.namespace,
        key: 'default',
        values,
        secretRefs,
        status: 'active',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'configurations'],
      });
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
                <span>{section.label}</span>
                {stored ? <Badge tone="good">{stored.status}</Badge> : null}
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
              {byNamespace.get(selected.namespace) ? (
                <Badge tone="good">Configured</Badge>
              ) : (
                <Badge>Not configured</Badge>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {selected.fields.map((field) => {
                const value = drafts[selected.namespace]?.[field.key];
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
                return (
                  <Field key={field.key} label={field.label}>
                    <Input
                      type={field.kind === 'number' ? 'number' : 'text'}
                      value={String(value ?? '')}
                      onChange={(event) =>
                        updateDraft(selected, field, event.target.value)
                      }
                    />
                  </Field>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-4">
              <p className="text-xs text-slate-500">
                Store secret manager references only, never raw tokens.
              </p>
              <Button
                type="button"
                onClick={() => save.mutate(selected)}
                disabled={save.isPending}
              >
                {save.isPending ? 'Saving…' : 'Save configuration'}
              </Button>
            </div>

            {save.isError ? (
              <p className="text-sm text-rose-700">
                {save.error instanceof Error
                  ? save.error.message
                  : 'Configuration could not be saved.'}
              </p>
            ) : null}
          </Card>
        ) : null}
      </div>
    </section>
  );
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
  if (field.kind === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return typeof value === 'string' ? value.trim() : '';
}
