import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PullRequest } from '@prisma/client';
import { CodePullRequestPayload } from '../../common/events/contracts';
import { CODE_PR_EVENT_TYPES } from '../../common/events/event-types';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';

/**
 * BC-4 Source Control (Git domain). Consumes code.pull_request.* events and
 * upserts PR facts; exposes reads for metrics. PR timestamps drive PR/review
 * metrics (docs/features/METRICS.md).
 */
@Injectable()
export class CodeService implements OnModuleInit {
  private readonly logger = new Logger(CodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit(): void {
    for (const type of CODE_PR_EVENT_TYPES) {
      this.eventBus.subscribe<CodePullRequestPayload>(type, (e) =>
        this.handlePullRequest(e),
      );
    }
  }

  private async handlePullRequest(
    event: DomainEvent<CodePullRequestPayload>,
  ): Promise<void> {
    const p = event.payload;
    const fields = {
      connectionId: event.connectionId ?? '',
      title: p.title,
      branch: p.branch,
      baseBranch: p.baseBranch ?? null,
      state: p.state,
      authorLogin: p.authorLogin ?? null,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      changedFiles: p.changedFiles ?? 0,
      commitMessages: p.commitMessages ?? [],
      openedAt: toDate(p.openedAt),
      firstReviewAt: toDate(p.firstReviewAt),
      approvedAt: toDate(p.approvedAt),
      mergedAt: toDate(p.mergedAt),
    };

    await this.prisma.pullRequest.upsert({
      where: {
        tenantId_repoFullName_externalNumber: {
          tenantId: event.tenantId,
          repoFullName: p.repoFullName,
          externalNumber: p.externalNumber,
        },
      },
      create: {
        id: newId(),
        tenantId: event.tenantId,
        repoFullName: p.repoFullName,
        externalNumber: p.externalNumber,
        ...fields,
      },
      update: fields,
    });

    this.logger.debug(
      `upserted PR ${p.repoFullName}#${p.externalNumber} (${p.state})`,
    );
  }

  /** Merged PRs with both open + merge timestamps — input for PR cycle time. */
  listMergedPullRequests(
    tenantId: string,
    repoFullName: string,
  ): Promise<PullRequest[]> {
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        repoFullName,
        state: 'merged',
        mergedAt: { not: null },
        openedAt: { not: null },
      },
    });
  }
}

function toDate(value?: string): Date | null {
  return value ? new Date(value) : null;
}
