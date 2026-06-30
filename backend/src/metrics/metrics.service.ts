import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';

export interface PrCycleTimeResult {
  metric: 'pr_cycle_time';
  repo: string;
  sampleSize: number;
  p50Hours: number | null;
  p85Hours: number | null;
  computedAt: string;
}

/**
 * BC-8 Metrics & Aggregation Engine. Scaffold computes one real metric end to
 * end — PR cycle time (open → merge, p50/p85) — over correlated PR facts, and
 * persists a lineage-tagged metric_value. Tenant-scoped via TenantContextService.
 * See docs/features/METRICS.md.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly code: CodeService,
  ) {}

  async computePrCycleTime(repoFullName: string): Promise<PrCycleTimeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const prs = await this.code.listMergedPullRequests(tenantId, repoFullName);

    const durationsHours = prs
      .filter((pr) => pr.mergedAt && pr.openedAt)
      .map(
        (pr) =>
          (pr.mergedAt!.getTime() - pr.openedAt!.getTime()) / (1000 * 60 * 60),
      )
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);

    const p50 = percentile(durationsHours, 50);
    const p85 = percentile(durationsHours, 85);
    const computedAt = new Date();

    if (durationsHours.length > 0) {
      const now = computedAt;
      await this.prisma.metricValue.create({
        data: {
          id: newId(),
          tenantId,
          metricKey: 'pr_cycle_time',
          scopeType: 'repo',
          scopeId: repoFullName,
          periodStart: prs.reduce(
            (min, pr) => (pr.openedAt! < min ? pr.openedAt! : min),
            now,
          ),
          periodEnd: now,
          value: p50 ?? 0,
          sampleSize: durationsHours.length,
          lineage: { prIds: prs.map((pr) => pr.id) },
        },
      });
    }

    return {
      metric: 'pr_cycle_time',
      repo: repoFullName,
      sampleSize: durationsHours.length,
      p50Hours: round2(p50),
      p85Hours: round2(p85),
      computedAt: computedAt.toISOString(),
    };
  }
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}

function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}
