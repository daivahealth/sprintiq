import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CodePullRequestPayload } from '../common/events/contracts';
import { CODE_PR_EVENT_TYPES } from '../common/events/event-types';
import { DomainEvent } from '../common/events/domain-event';
import { EventBus } from '../common/events/event-bus';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import { PlanningService } from '../modules/planning/planning.service';
import { extractJiraKeys } from './jira-key.util';

/**
 * BC-5 Correlation & Delivery Graph — the moat. On each PR event it extracts
 * Jira keys (title/branch/commits), resolves the story, and writes a
 * confidence-scored `pr_implements_story` edge — or flags an orphan when no
 * key is present or the story is unknown. It never guesses silently.
 */
@Injectable()
export class CorrelationService implements OnModuleInit {
  private readonly logger = new Logger(CorrelationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    private readonly planning: PlanningService,
  ) {}

  onModuleInit(): void {
    for (const type of CODE_PR_EVENT_TYPES) {
      this.eventBus.subscribe<CodePullRequestPayload>(type, (e) =>
        this.correlatePullRequest(e),
      );
    }
  }

  private async correlatePullRequest(
    event: DomainEvent<CodePullRequestPayload>,
  ): Promise<void> {
    const p = event.payload;
    const prRef = `${p.repoFullName}#${p.externalNumber}`;

    const matches = extractJiraKeys({
      title: p.title,
      branch: p.branch,
      commit: (p.commitMessages ?? []).join('\n'),
    });

    if (matches.length === 0) {
      await this.upsertOrphan(event.tenantId, 'pull_request', prRef, 'no_key');
      return;
    }

    for (const match of matches) {
      const story = await this.planning.findByKey(event.tenantId, match.key);
      if (!story) {
        await this.upsertOrphan(
          event.tenantId,
          'pull_request',
          prRef,
          'unknown_project',
        );
        continue;
      }

      const confidence = this.scoreConfidence(match.foundIn, matches.length);
      await this.upsertLink(event.tenantId, {
        edgeType: 'pr_implements_story',
        fromType: 'pull_request',
        fromId: prRef,
        toType: 'story',
        toId: story.id,
        confidence,
        method: 'regex',
        evidence: { key: match.key, foundIn: match.foundIn },
        sourceEventId: event.sourceEventIds?.[0],
      });
      this.logger.debug(
        `linked ${prRef} → ${match.key} (confidence=${confidence})`,
      );
    }
  }

  /**
   * Confidence heuristic: a single key found in the title is strongest; presence
   * in multiple inputs raises it; multiple distinct keys on one PR lowers it
   * (ambiguous). Bounded to [0.5, 0.95].
   */
  private scoreConfidence(foundIn: string[], totalKeys: number): number {
    let score = 0.6;
    if (foundIn.includes('title')) score += 0.2;
    if (foundIn.length > 1) score += 0.15;
    if (totalKeys > 1) score -= 0.25;
    return Math.max(0.5, Math.min(0.95, Number(score.toFixed(2))));
  }

  private async upsertLink(
    tenantId: string,
    link: {
      edgeType: string;
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      confidence: number;
      method: string;
      evidence: Prisma.InputJsonValue;
      sourceEventId?: string;
    },
  ): Promise<void> {
    const existing = await this.prisma.correlationLink.findFirst({
      where: {
        tenantId,
        edgeType: link.edgeType,
        fromId: link.fromId,
        toId: link.toId,
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.correlationLink.update({
        where: { id: existing.id },
        data: { confidence: link.confidence, evidence: link.evidence },
      });
      return;
    }
    await this.prisma.correlationLink.create({
      data: { id: newId(), tenantId, ...link },
    });
  }

  private async upsertOrphan(
    tenantId: string,
    nodeType: string,
    nodeRef: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.prisma.orphan.findFirst({
      where: { tenantId, nodeType, nodeRef, resolvedAt: null },
      select: { id: true },
    });
    if (existing) {
      return;
    }
    await this.prisma.orphan.create({
      data: { id: newId(), tenantId, nodeType, nodeRef, reason },
    });
    this.logger.debug(`orphan ${nodeRef} (${reason})`);
  }
}
