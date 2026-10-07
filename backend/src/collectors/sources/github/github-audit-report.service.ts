import { Injectable } from '@nestjs/common';
import { istDayEnd, istDayStart } from '../../../common/time';
import { PrismaService } from '../../../database/prisma.service';
import {
  AuditRunCounters,
  CommitOutcome,
  emptyCounters,
} from './github-audit-sync.service';

export interface AuditDayReport {
  day: string;
  runs: number;
  failedRuns: number;
  totals: AuditRunCounters;
  ranges: {
    pending: number;
    shadowed: number;
    done: number;
    failed: number;
    truncated: number;
  };
  repositoriesAffected: number;
  branchesAffected: number;
  /**
   * Every range created that IST day with the SHAs it processed and each
   * one's outcome — in shadow mode this is the list to compare against
   * ground truth (spec §9 step 3), since nothing is ingested.
   */
  rangeDetails: Array<{
    repoFullName: string;
    ref: string;
    kind: string;
    baseSha: string | null;
    baseRef: string | null;
    headSha: string | null;
    status: string;
    truncated: boolean;
    commitOutcomes: CommitOutcome[];
  }>;
  auditCommits: Array<{
    repoFullName: string;
    sha: string;
    authorLogin?: string;
    authorEmail?: string;
    ref?: string;
  }>;
  checkpoint: {
    checkpointAt: Date | null;
    seededAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
  } | null;
}

/**
 * "Did the audit route find the commits the other routes missed?" for one IST
 * day (spec §7). Reads only BC-1's own tables; identity attribution is added
 * by the admin controller, which owns that cross-context read.
 */
@Injectable()
export class GithubAuditReportService {
  constructor(private readonly prisma: PrismaService) {}

  async dayReport(tenantId: string, day: string): Promise<AuditDayReport> {
    const from = istDayStart(day);
    const to = istDayEnd(day);
    const [runs, ranges, raw, checkpoint] = await Promise.all([
      this.prisma.githubAuditRun.findMany({
        where: { tenantId, startedAt: { gte: from, lte: to } },
      }),
      this.prisma.githubPushRange.findMany({
        where: { tenantId, createdAt: { gte: from, lte: to } },
      }),
      this.prisma.rawEvent.findMany({
        where: {
          tenantId,
          eventType: 'code.commit.pushed',
          occurredAt: { gte: from, lte: to },
          envelope: {
            path: ['externalRefs', 'discoveredBy'],
            equals: 'github-audit-compare',
          },
        },
        select: { envelope: true },
      }),
      this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } }),
    ]);

    const totals = emptyCounters();
    for (const run of runs) {
      const c = (run.counters ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(totals) as (keyof AuditRunCounters)[]) {
        if (typeof c[key] === 'number' && !key.endsWith('RateRemaining')) {
          (totals[key] as number) += c[key] as number;
        }
      }
    }
    const count = (status: string) =>
      ranges.filter((r) => r.status === status).length;

    return {
      day,
      runs: runs.length,
      failedRuns: runs.filter((r) => r.status === 'failed').length,
      totals,
      ranges: {
        pending: count('pending'),
        shadowed: count('shadowed'),
        done: count('done'),
        failed: count('failed'),
        truncated: ranges.filter((r) => r.truncated).length,
      },
      repositoriesAffected: new Set(ranges.map((r) => r.repoFullName)).size,
      branchesAffected: new Set(ranges.map((r) => `${r.repoFullName}:${r.ref}`))
        .size,
      rangeDetails: ranges.map((r) => ({
        repoFullName: r.repoFullName,
        ref: r.ref,
        kind: r.kind,
        baseSha: r.baseSha,
        baseRef: r.baseRef,
        headSha: r.headSha,
        status: r.status,
        truncated: r.truncated,
        commitOutcomes: Array.isArray(r.commitOutcomes)
          ? (r.commitOutcomes as unknown as CommitOutcome[])
          : [],
      })),
      auditCommits: raw.map((r) => {
        const env = r.envelope as {
          externalRefs?: Record<string, string>;
          data?: Record<string, string | undefined>;
        };
        return {
          repoFullName: env.externalRefs?.repo ?? '',
          sha: env.externalRefs?.sha ?? '',
          ref: env.externalRefs?.ref,
          authorLogin: env.data?.authorLogin,
          authorEmail: env.data?.authorEmail,
        };
      }),
      checkpoint: checkpoint
        ? {
            checkpointAt: checkpoint.checkpointAt,
            seededAt: checkpoint.seededAt,
            lastStatus: checkpoint.lastStatus,
            lastError: checkpoint.lastError,
          }
        : null,
    };
  }
}
