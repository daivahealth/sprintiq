import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { GithubOrgSyncService } from '../../collectors/sources/github/github-org-sync.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { SecretsService } from '../../common/secrets/secrets.service';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_NAMESPACES,
  SECRET_REF_HINT,
  SECRET_REF_PATTERN,
} from './configuration-catalog';
import {
  ConfigurationsService,
  TenantConfigurationView,
} from './configurations.service';

class UpsertConfigurationDto {
  @IsIn(CONFIGURATION_NAMESPACES)
  namespace!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secretRefs?: Record<string, unknown>;

  /** Actual secret values to store (encrypted). Never echoed back by any response. */
  @IsOptional()
  @IsObject()
  secretValues?: Record<string, unknown>;

  /** Field keys whose stored secret value should be deleted (reverts to any env-var fallback). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  clearSecrets?: string[];

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;

  /** Optimistic-concurrency token: the updatedAt the client last saw. */
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}

class SyncGithubOrgDto {
  /** Overrides the github namespace's own backfillDays for this sync only. */
  @IsOptional()
  @IsNumber()
  backfillDays?: number;
}

@Controller('admin/configurations')
export class ConfigurationsController {
  constructor(
    private readonly configurations: ConfigurationsService,
    private readonly secrets: SecretsService,
    private readonly githubOrgSync: GithubOrgSyncService,
  ) {}

  @Roles(Role.ADMIN)
  @Get('catalog')
  catalog() {
    // RegExp objects don't survive JSON.stringify (serialize to `{}`) — send
    // the pattern source as a string; the frontend reconstructs it for
    // client-side validation that mirrors the server-side check exactly.
    return {
      secretRefHint: SECRET_REF_HINT,
      secretRefPattern: SECRET_REF_PATTERN.source,
      // Whether pasting a secret value will actually work server-side
      // (SECRETS_ENCRYPTION_KEY configured) — lets the UI explain itself
      // instead of failing opaquely on save.
      secretsStoreEnabled: this.secrets.isEnabled(),
      sections: CONFIGURATION_CATALOG.map((section) => ({
        ...section,
        fields: section.fields.map((field) => ({
          ...field,
          pattern: field.pattern?.source,
        })),
      })),
    };
  }

  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const configs = await this.configurations.listTenantConfigurations(
      user.tenantId,
    );
    return { configurations: configs.map((config) => this.toView(config)) };
  }

  @Roles(Role.ADMIN)
  @Put()
  async upsert(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertConfigurationDto,
  ) {
    const config = await this.configurations.upsertTenantConfiguration(
      user.tenantId,
      dto,
      { actorId: user.userId },
    );
    return this.toView(config);
  }

  /**
   * Discovers every repo in the tenant's configured GitHub org and registers
   * a Connection per repo (skipping ones already registered, and archived/
   * disabled repos) so the regular scheduler picks each one up. Complements
   * the single-default-repo bridge above — this is "sync the whole org."
   * The token is resolved server-side and never appears in the response.
   */
  @Roles(Role.ADMIN)
  @Post('github/sync-org')
  async syncGithubOrg(
    @CurrentUser() user: AuthUser,
    @Body() dto: SyncGithubOrgDto,
  ) {
    const configs = await this.configurations.listTenantConfigurations(
      user.tenantId,
    );
    const github = configs.find(
      (c) => c.namespace === 'github' && c.key === 'default',
    );
    const values = (github?.values ?? {}) as Record<string, unknown>;
    const secretRefs = (github?.secretRefs ?? {}) as Record<string, unknown>;
    const organization =
      typeof values.organization === 'string' ? values.organization : undefined;
    const tokenRef =
      typeof secretRefs.tokenRef === 'string' ? secretRefs.tokenRef : undefined;

    if (!github || github.status !== 'active' || !organization || !tokenRef) {
      throw new BadRequestException(
        'Configure GitHub (organization + token secret ref, saved as active) before syncing the whole org.',
      );
    }

    const token = await this.secrets.resolve(user.tenantId, tokenRef);
    if (!token) {
      throw new BadRequestException(
        `No value is stored (or set via env var) for secret ref "${tokenRef}" yet — paste the token in the Configuration screen, or set the env var, first.`,
      );
    }

    const backfillDays =
      dto.backfillDays ??
      (typeof values.backfillDays === 'number' ? values.backfillDays : 90);

    return this.githubOrgSync.syncOrgRepos(
      user.tenantId,
      organization,
      tokenRef,
      token,
      backfillDays,
    );
  }

  private toView(config: TenantConfigurationView) {
    return {
      id: config.id,
      namespace: config.namespace,
      key: config.key,
      values: config.values,
      secretRefs: config.secretRefs,
      status: config.status,
      updatedAt: config.updatedAt,
      // Whether this namespace is actually collecting data, not just saved —
      // null for config-only namespaces (llm/notifications/metrics/security).
      connection: config.connection,
      // Per secret-ref field: whether a value is stored in the encrypted DB
      // store. Never the value itself — write-only from the admin's side.
      secretsConfigured: config.secretsConfigured,
    };
  }
}
