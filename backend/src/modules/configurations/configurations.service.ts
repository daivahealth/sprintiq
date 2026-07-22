import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Prisma, TenantConfiguration } from '@prisma/client';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { newId } from '../../common/id';
import { SecretsService } from '../../common/secrets/secrets.service';
import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from '../connections/connections.service';
import {
  ConfigurationNamespace,
  getConfigurationSection,
  isConfigurationNamespace,
  validateConfigurationValues,
} from './configuration-catalog';

export interface UpsertTenantConfigurationInput {
  namespace: string;
  key?: string;
  values?: Record<string, unknown>;
  secretRefs?: Record<string, unknown>;
  /**
   * Actual secret values, keyed by field key (e.g. `{ tokenRef: 'ghp_...' }').
   * Encrypted and stored server-side (SecretsService) — never echoed back.
   * Omit a field to leave its stored value (if any) untouched.
   */
  secretValues?: Record<string, unknown>;
  /** Field keys whose stored secret value should be deleted, reverting to any env-var fallback. */
  clearSecrets?: string[];
  status?: string;
  /** Optimistic-concurrency token: the updatedAt the client last saw. */
  expectedUpdatedAt?: string;
}

export interface UpsertContext {
  actorId?: string;
}

/** Surfaced to the admin UI so "saved as active" doesn't silently mean "not actually collecting". */
export interface ConfigurationConnectionSummary {
  linked: boolean;
  status?: string;
  lastSyncAt?: Date | null;
  syncLagSeconds?: number;
}

export interface TenantConfigurationView extends TenantConfiguration {
  connection: ConfigurationConnectionSummary | null;
  /** Per secret-ref field key: whether a value is stored in the encrypted DB store (vs. relying on an env var, or unset). */
  secretsConfigured: Record<string, boolean>;
}

/** Namespaces backed by a real BC-0 Connection (github/jira); others are config-only. */
type BridgedNamespace = 'github' | 'jira';

function isBridgedNamespace(
  namespace: ConfigurationNamespace,
): namespace is BridgedNamespace {
  return namespace === 'github' || namespace === 'jira';
}

/** Deterministic, collision-safe name for the connection this screen owns (BC-0 has no unique constraint on sourceSystem alone — other connections for the same source may already exist, e.g. from seed data or direct /admin/connections use). */
function bridgeConnectionName(namespace: BridgedNamespace): string {
  return `Managed by tenant configuration (${namespace})`;
}

interface DerivedConnectionInput {
  config: Record<string, unknown>;
  secretRef?: string;
  webhookSecretRef?: string;
}

/** Non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Positive finite number, or undefined (falls back to the collector's own default). */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Maps validated config values/secretRefs onto what the collector actually
 * needs. Returns null when required identifying fields aren't filled in yet
 * (e.g. no default repo) — saving is still allowed (see catalog validation),
 * it just doesn't produce a connection collection can run against.
 *
 * `config.backfillDays` is carried as-is (not yet resolved to an absolute
 * `backfillSince` date) — the caller resolves that, since whether to actually
 * recompute it depends on comparing against what the connection already has.
 */
function deriveConnectionInput(
  namespace: BridgedNamespace,
  values: Record<string, unknown>,
  secretRefs: Record<string, unknown>,
): DerivedConnectionInput | null {
  const backfillDays = positiveNumber(values.backfillDays);

  if (namespace === 'github') {
    const organization = str(values.organization);
    const defaultRepo = str(values.defaultRepo);
    if (!organization || !defaultRepo) {
      return null; // org-wide config only — no single repo to collect yet
    }
    return {
      config: { repoFullName: `${organization}/${defaultRepo}`, backfillDays },
      secretRef: str(secretRefs.tokenRef),
      webhookSecretRef: str(secretRefs.webhookSecretRef),
    };
  }

  const siteUrl = str(values.siteUrl);
  const email = str(values.email);
  if (!siteUrl || !email) {
    return null; // email isn't catalog-required but Basic auth needs it
  }
  return {
    config: {
      siteUrl,
      email,
      projectKey: str(values.projectKey),
      backfillDays,
    },
    secretRef: str(secretRefs.apiTokenRef),
    webhookSecretRef: str(secretRefs.webhookSecretRef),
  };
}

/** `now - days` as an ISO floor, or undefined to fall back to the collector's own default. */
function resolveBackfillSince(days: number | undefined): string | undefined {
  return days === undefined
    ? undefined
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Whether the scope of what/how-far-back to collect changed — repo, site,
 * project, or the backfill window. If so, the sync must re-walk from the new
 * starting point, so stale cursors (page numbers, watermarks from the OLD
 * scope) have to be cleared; otherwise a connection that already finished
 * backfilling would silently keep ignoring the new window/target forever.
 */
function scopeChanged(
  namespace: BridgedNamespace,
  existingConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): boolean {
  const keys: string[] =
    namespace === 'github'
      ? ['repoFullName', 'backfillDays']
      : ['siteUrl', 'projectKey', 'backfillDays'];
  return keys.some((key) => existingConfig[key] !== nextConfig[key]);
}

@Injectable()
export class ConfigurationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly secrets: SecretsService,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  async listTenantConfigurations(
    tenantId: string,
  ): Promise<TenantConfigurationView[]> {
    const configs = await this.prisma.tenantConfiguration.findMany({
      where: { tenantId },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });
    return Promise.all(
      configs.map((config) => this.buildView(tenantId, config)),
    );
  }

  async upsertTenantConfiguration(
    tenantId: string,
    input: UpsertTenantConfigurationInput,
    ctx: UpsertContext = {},
  ): Promise<TenantConfigurationView> {
    const namespace = this.validateNamespace(input.namespace);
    const key = input.key?.trim() || 'default';
    const values = input.values ?? {};
    const secretRefs = input.secretRefs ?? {};
    const secretValues = input.secretValues ?? {};
    const clearSecrets = input.clearSecrets ?? [];
    const status = input.status ?? 'active';

    const errors = validateConfigurationValues(
      namespace,
      values,
      secretRefs,
      status,
    );
    errors.push(
      ...this.validateSecretValueInputs(
        namespace,
        secretRefs,
        secretValues,
        clearSecrets,
      ),
    );
    if (errors.length > 0) {
      throw new BadRequestException({
        message: errors,
        error: 'Bad Request',
        statusCode: 400,
      });
    }

    const existing = await this.prisma.tenantConfiguration.findUnique({
      where: { tenantId_namespace_key: { tenantId, namespace, key } },
    });

    // Optimistic concurrency: only enforced when the client sends a baseline
    // (i.e. it believes a row already exists) — first-time creates skip it.
    if (
      existing &&
      input.expectedUpdatedAt &&
      existing.updatedAt.toISOString() !== input.expectedUpdatedAt
    ) {
      throw new ConflictException(
        'This configuration was changed by someone else. Reload and try again.',
      );
    }

    const saved = await this.prisma.tenantConfiguration.upsert({
      where: { tenantId_namespace_key: { tenantId, namespace, key } },
      create: {
        id: newId(),
        tenantId,
        namespace,
        key,
        values: values as Prisma.InputJsonValue,
        secretRefs: secretRefs as Prisma.InputJsonValue,
        status,
      },
      update: {
        values: values as Prisma.InputJsonValue,
        secretRefs: secretRefs as Prisma.InputJsonValue,
        status,
      },
    });

    const secretChanges = await this.applySecretValues(
      tenantId,
      secretRefs,
      secretValues,
      clearSecrets,
    );

    // Meaningful audit entry: namespace/key/status + WHICH fields changed —
    // never the values themselves (secrets are refs, but values may still hold
    // sensitive-ish integration details like site URLs; log keys only).
    await this.audit?.record({
      tenantId,
      actorType: 'user',
      actorId: ctx.actorId,
      action: existing ? 'configuration.updated' : 'configuration.created',
      targetType: 'tenant_configuration',
      targetId: saved.id,
      metadata: {
        namespace,
        key,
        status,
        changedValueKeys: diffKeys(
          existing?.values as Record<string, unknown> | undefined,
          values,
        ),
        changedSecretRefKeys: diffKeys(
          existing?.secretRefs as Record<string, unknown> | undefined,
          secretRefs,
        ),
        secretValuesSet: secretChanges.setKeys,
        secretValuesCleared: secretChanges.clearedKeys,
      },
    });

    if (isBridgedNamespace(namespace)) {
      await this.syncConnection(
        tenantId,
        namespace,
        values,
        secretRefs,
        status,
      );
    }

    return this.buildView(tenantId, saved);
  }

  private validateNamespace(namespace: string): ConfigurationNamespace {
    if (!isConfigurationNamespace(namespace)) {
      throw new BadRequestException('Unsupported configuration namespace.');
    }
    return namespace;
  }

  /**
   * Creates/updates/disables the BC-0 Connection this config namespace owns,
   * so saving "active" here is what actually makes collection (webhooks +
   * the scheduled backfill/sync sweep) run — not just a config-only save.
   */
  private async syncConnection(
    tenantId: string,
    namespace: BridgedNamespace,
    values: Record<string, unknown>,
    secretRefs: Record<string, unknown>,
    status: string,
  ): Promise<void> {
    const name = bridgeConnectionName(namespace);
    const existing = await this.connections.findByTenantSourceAndName(
      tenantId,
      namespace,
      name,
    );
    const derived = deriveConnectionInput(namespace, values, secretRefs);

    if (!derived) {
      // Required identifying fields (e.g. default repo) aren't filled in yet.
      // Saving is still allowed — just disable any prior connection rather
      // than leaving it running against config that's now incomplete.
      if (existing) {
        await this.connections.setStatus(existing.id, 'disabled');
      }
      return;
    }

    const connectionStatus = status === 'active' ? 'active' : 'disabled';

    if (existing) {
      const existingConfig = (existing.config ?? {}) as Record<string, unknown>;
      // Only recompute the absolute floor when the window actually changed —
      // otherwise "now - N days" would drift forward on every unrelated save.
      const rescoped = scopeChanged(namespace, existingConfig, derived.config);
      const backfillSince = rescoped
        ? resolveBackfillSince(
            derived.config.backfillDays as number | undefined,
          )
        : existingConfig.backfillSince;

      await this.connections.updateConfig(existing.id, {
        config: { ...derived.config, backfillSince },
        secretRef: derived.secretRef,
        webhookSecretRef: derived.webhookSecretRef,
        status: connectionStatus,
      });
      if (rescoped) {
        await this.connections.setSyncCursors(existing.id, {});
      }
    } else if (status === 'active') {
      const backfillSince = resolveBackfillSince(
        derived.config.backfillDays as number | undefined,
      );
      await this.connections.create(tenantId, {
        sourceSystem: namespace,
        name,
        config: { ...derived.config, backfillSince },
        secretRef: derived.secretRef,
        webhookSecretRef: derived.webhookSecretRef,
      });
    }
  }

  /**
   * Rejects secret values with no ref name to key them by, and values/clears
   * for fields that aren't secret-ref fields in this namespace's catalog —
   * the same "fail the whole save with a clear message" pattern as catalog
   * validation, rather than silently dropping something the admin submitted.
   */
  private validateSecretValueInputs(
    namespace: ConfigurationNamespace,
    secretRefs: Record<string, unknown>,
    secretValues: Record<string, unknown>,
    clearSecrets: string[],
  ): string[] {
    const section = getConfigurationSection(namespace);
    const secretFieldKeys = new Set(
      section.fields.filter((f) => f.kind === 'secret-ref').map((f) => f.key),
    );
    const errors: string[] = [];

    for (const fieldKey of Object.keys(secretValues)) {
      if (!secretFieldKeys.has(fieldKey)) {
        errors.push(`Unknown secret value field "${fieldKey}".`);
        continue;
      }
      const value = str(secretValues[fieldKey]);
      if (value && !str(secretRefs[fieldKey])) {
        const label =
          section.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
        errors.push(
          `Set a secret ref name for "${label}" before providing a value.`,
        );
      }
    }
    for (const fieldKey of clearSecrets) {
      if (!secretFieldKeys.has(fieldKey)) {
        errors.push(
          `Unknown secret value field "${fieldKey}" in clearSecrets.`,
        );
      }
    }
    return errors;
  }

  /** Writes/deletes actual secret values via SecretsService, keyed by the admin-chosen ref name. */
  private async applySecretValues(
    tenantId: string,
    secretRefs: Record<string, unknown>,
    secretValues: Record<string, unknown>,
    clearSecrets: string[],
  ): Promise<{ setKeys: string[]; clearedKeys: string[] }> {
    const setKeys: string[] = [];
    const clearedKeys: string[] = [];

    for (const [fieldKey, rawValue] of Object.entries(secretValues)) {
      const value = str(rawValue);
      const ref = str(secretRefs[fieldKey]);
      if (value && ref) {
        await this.secrets.setSecret(tenantId, ref, value);
        setKeys.push(fieldKey);
      }
    }
    for (const fieldKey of clearSecrets) {
      const ref = str(secretRefs[fieldKey]);
      if (ref) {
        await this.secrets.deleteSecret(tenantId, ref);
        clearedKeys.push(fieldKey);
      }
    }
    return { setKeys, clearedKeys };
  }

  private async secretsConfiguredFor(
    tenantId: string,
    config: TenantConfiguration,
  ): Promise<Record<string, boolean>> {
    const section = getConfigurationSection(
      config.namespace as ConfigurationNamespace,
    );
    const secretRefs = (config.secretRefs ?? {}) as Record<string, unknown>;
    const result: Record<string, boolean> = {};
    for (const field of section.fields) {
      if (field.kind !== 'secret-ref') {
        continue;
      }
      const ref = str(secretRefs[field.key]);
      result[field.key] = ref
        ? await this.secrets.hasSecret(tenantId, ref)
        : false;
    }
    return result;
  }

  private async buildView(
    tenantId: string,
    config: TenantConfiguration,
  ): Promise<TenantConfigurationView> {
    const secretsConfigured = await this.secretsConfiguredFor(tenantId, config);

    if (!isBridgedNamespace(config.namespace as ConfigurationNamespace)) {
      return { ...config, connection: null, secretsConfigured };
    }
    const connection = await this.connections.findByTenantSourceAndName(
      tenantId,
      config.namespace,
      bridgeConnectionName(config.namespace as BridgedNamespace),
    );
    return {
      ...config,
      connection: connection
        ? {
            linked: true,
            status: connection.status,
            lastSyncAt: connection.lastSyncAt,
            syncLagSeconds: connection.syncLagSeconds,
          }
        : { linked: false },
      secretsConfigured,
    };
  }
}

/** Keys whose value differs between the previous and next object (shallow). */
function diffKeys(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): string[] {
  const prev = previous ?? {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      changed.push(key);
    }
  }
  return changed;
}
