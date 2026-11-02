import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppRole, roleServesHttp } from '../../config/app-role';
import { PrismaService } from '../../database/prisma.service';
import { KnowledgeGraphLoader } from './graph-loader.service';
import {
  KnowledgeGraphConfig,
  readKnowledgeGraphConfig,
} from './knowledge-graph.config';
import { GraphChange } from './knowledge-graph.types';
import { TenantGraph } from './tenant-graph';

const DAY_MS = 24 * 60 * 60 * 1000;

export type GraphStatus = 'disabled' | 'initializing' | 'ready' | 'failed';

interface TenantEntry {
  graph?: TenantGraph;
  /** The window the live graph was built for; incremental reads use the same. */
  windowStart?: Date;
  builtAt?: Date;
  lastIncrementalAt?: Date;
  /** An incremental update failed; the next rebuild corrects the graph. */
  stale: boolean;
  error?: string;
  building: boolean;
  /** Changes that arrived while a rebuild was reading, replayed after the swap. */
  pending: GraphChange[];
}

/** How current a response is — shipped beside every graph read. */
export interface GraphFreshness {
  builtAt: string;
  windowStart: string;
  windowDays: number;
  lastIncrementalAt: string | null;
  stale: boolean;
  rebuildMinutes: number;
}

type ReplayHandler = (
  tenantId: string,
  changes: GraphChange[],
) => Promise<void>;

/**
 * Owns every tenant's in-memory graph: initial load, periodic rebuild, and the
 * readiness the read API reports.
 *
 * Graphs are per tenant and never shared, so no read can cross tenants. Each
 * process builds its own — nothing here is coordinated across instances, and
 * a restart simply rebuilds from Postgres, which stays the source of truth.
 *
 * Initialisation runs after HTTP startup and does not block it: until a
 * tenant's graph is built its reads answer 503, and `status` says why.
 */
@Injectable()
export class KnowledgeGraphManager
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeGraphManager.name);
  private readonly tenants = new Map<string, TenantEntry>();
  private state: GraphStatus = 'initializing';
  private config: KnowledgeGraphConfig = readKnowledgeGraphConfig();
  private timer?: NodeJS.Timeout;
  private replay?: ReplayHandler;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: KnowledgeGraphLoader,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.config = readKnowledgeGraphConfig();
    const role = this.configService.get<AppRole>('appRole') ?? AppRole.API;
    if (!this.config.enabled || !roleServesHttp(role)) {
      this.state = 'disabled';
      this.logger.log(
        `knowledge graph disabled (enabled=${this.config.enabled}, role=${role})`,
      );
      return;
    }
    void this.initialize();
    this.timer = setInterval(
      () => void this.rebuildAll().catch((err) => this.logFailure(err)),
      this.config.rebuildMinutes * 60_000,
    );
    // Never the reason the process stays alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Builds every tenant's graph. Per-tenant failures do not stop the rest. */
  async initialize(): Promise<void> {
    this.state = 'initializing';
    try {
      await this.rebuildAll();
      this.state = 'ready';
    } catch (err) {
      this.state = 'failed';
      this.logFailure(err);
    }
  }

  async rebuildAll(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const { id } of tenants) {
      await this.rebuildTenant(id);
    }
  }

  /**
   * Rebuilds one tenant off to the side and swaps it in atomically: readers
   * see the old graph until the new one is complete, never a half-built one.
   */
  async rebuildTenant(tenantId: string): Promise<void> {
    const entry = this.entry(tenantId);
    if (entry.building) {
      return;
    }
    entry.building = true;
    entry.pending = [];
    const windowStart = new Date(Date.now() - this.config.windowDays * DAY_MS);
    try {
      const graph = await this.loader.build(tenantId, windowStart);
      entry.graph = graph;
      entry.windowStart = windowStart;
      entry.builtAt = new Date();
      entry.stale = false;
      entry.error = undefined;
    } catch (err) {
      entry.error = (err as Error).message;
      entry.stale = Boolean(entry.graph);
      this.logger.error(
        `tenant=${tenantId} graph build failed: ${(err as Error).message}`,
      );
    } finally {
      entry.building = false;
    }
    const pending = entry.pending;
    entry.pending = [];
    if (pending.length && entry.graph && this.replay) {
      await this.replay(tenantId, pending);
    }
  }

  // ── for the updater ──────────────────────────────────────────────────────

  isActive(): boolean {
    return this.state !== 'disabled';
  }

  onRebuilt(handler: ReplayHandler): void {
    this.replay = handler;
  }

  /**
   * Holds changes back while a rebuild is reading Postgres: the old graph is
   * about to be replaced, and applying them to it would lose them.
   */
  deferIfRebuilding(tenantId: string, changes: GraphChange[]): boolean {
    const entry = this.tenants.get(tenantId);
    if (!entry?.building) {
      return false;
    }
    entry.pending.push(...changes);
    return true;
  }

  /** The live graph to update, or undefined when none is loaded yet. */
  liveGraph(
    tenantId: string,
  ): { graph: TenantGraph; windowStart: Date } | undefined {
    const entry = this.tenants.get(tenantId);
    return entry?.graph && entry.windowStart
      ? { graph: entry.graph, windowStart: entry.windowStart }
      : undefined;
  }

  markIncremental(tenantId: string): void {
    const entry = this.tenants.get(tenantId);
    if (entry) {
      entry.lastIncrementalAt = new Date();
    }
  }

  markStale(tenantId: string, error: Error): void {
    const entry = this.tenants.get(tenantId);
    if (entry) {
      entry.stale = true;
      entry.error = error.message;
    }
  }

  // ── for the read API ─────────────────────────────────────────────────────

  /** The tenant's graph and how fresh it is, or 503 until there is one. */
  readyGraph(tenantId: string): {
    graph: TenantGraph;
    freshness: GraphFreshness;
  } {
    // Plain messages: the global exception filter keeps only the message, so
    // the state is spelled out in it; `status` has the detail.
    const entry = this.tenants.get(tenantId);
    if (this.state === 'disabled') {
      throw new ServiceUnavailableException(
        'Knowledge graph disabled: not enabled on this instance.',
      );
    }
    if (!entry?.graph || !entry.builtAt || !entry.windowStart) {
      // A tenant provisioned after startup is picked up on first request.
      if (this.state === 'ready' && !entry?.building) {
        void this.rebuildTenant(tenantId);
      }
      throw new ServiceUnavailableException(
        entry?.error && !entry.building
          ? 'Knowledge graph failed: the build for this tenant failed; see /api/knowledge-graph/status.'
          : 'Knowledge graph initializing: this tenant is not built yet; retry shortly.',
      );
    }
    return {
      graph: entry.graph,
      freshness: {
        builtAt: entry.builtAt.toISOString(),
        windowStart: entry.windowStart.toISOString(),
        windowDays: this.config.windowDays,
        lastIncrementalAt: entry.lastIncrementalAt?.toISOString() ?? null,
        stale: entry.stale,
        rebuildMinutes: this.config.rebuildMinutes,
      },
    };
  }

  /** Readiness for one tenant — counts only, never names. */
  status(tenantId: string) {
    const entry = this.tenants.get(tenantId);
    const stats = entry?.graph?.stats();
    return {
      status: this.state,
      enabled: this.state !== 'disabled',
      windowDays: this.config.windowDays,
      rebuildMinutes: this.config.rebuildMinutes,
      tenant: {
        state: entry?.building
          ? 'building'
          : entry?.graph
            ? 'ready'
            : entry?.error
              ? 'failed'
              : 'not_loaded',
        builtAt: entry?.builtAt?.toISOString() ?? null,
        windowStart: entry?.windowStart?.toISOString() ?? null,
        lastIncrementalAt: entry?.lastIncrementalAt?.toISOString() ?? null,
        stale: entry?.stale ?? false,
        error: entry?.error ?? null,
        totalNodes: stats?.nodes ?? 0,
        totalEdges: stats?.edges ?? 0,
        nodesByType: stats?.nodesByType ?? null,
        edgesByType: stats?.edgesByType ?? null,
      },
    };
  }

  private entry(tenantId: string): TenantEntry {
    let entry = this.tenants.get(tenantId);
    if (!entry) {
      entry = { stale: false, building: false, pending: [] };
      this.tenants.set(tenantId, entry);
    }
    return entry;
  }

  private logFailure(err: unknown): void {
    this.logger.error(
      `knowledge graph rebuild failed: ${(err as Error).message}`,
    );
  }
}
