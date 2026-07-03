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

  /**
   * Repos linked to the given projects via the delivery graph — the scope
   * system's cross-filter (DASHBOARDS.md §3.2). A repo qualifies when at least
   * one of its PRs has a `pr_implements_story` edge into a story of one of the
   * projects. Edge fromId is "<repoFullName>#<prNumber>" (see correlatePullRequest).
   */
  async reposLinkedToProjects(
    tenantId: string,
    projectKeys: string[],
  ): Promise<string[]> {
    const storyIds = await this.planning.listStoryIdsForProjects(
      tenantId,
      projectKeys,
    );
    if (storyIds.length === 0) {
      return [];
    }
    const links = await this.prisma.correlationLink.findMany({
      where: {
        tenantId,
        edgeType: 'pr_implements_story',
        toType: 'story',
        toId: { in: storyIds },
      },
      select: { fromId: true },
    });
    const repos = new Set<string>();
    for (const link of links) {
      const repo = link.fromId.split('#')[0];
      if (repo) {
        repos.add(repo);
      }
    }
    return [...repos].sort();
  }

  /**
   * PR refs grouped by project through `pr_implements_story` links. This is the
   * project rollup bridge for dashboard metrics without hard-coded mappings.
   */
  async pullRequestRefsByProject(
    tenantId: string,
    projectKeys: string[],
  ): Promise<Map<string, string[]>> {
    const stories = await this.planning.listStoryRefsForProjects(
      tenantId,
      projectKeys,
    );
    const storyProject = new Map(stories.map((s) => [s.id, s.projectKey]));
    if (storyProject.size === 0) {
      return new Map(projectKeys.map((key) => [key, []]));
    }
    const links = await this.prisma.correlationLink.findMany({
      where: {
        tenantId,
        edgeType: 'pr_implements_story',
        fromType: 'pull_request',
        toType: 'story',
        toId: { in: [...storyProject.keys()] },
      },
      select: { fromId: true, toId: true },
    });
    const byProject = new Map(projectKeys.map((key) => [key, [] as string[]]));
    for (const link of links) {
      const project = storyProject.get(link.toId);
      if (!project) {
        continue;
      }
      byProject.set(project, [...(byProject.get(project) ?? []), link.fromId]);
    }
    return byProject;
  }

  /** PR refs ("repo#num") linked to each story — the Jira→GitHub direction. */
  async prRefsByStoryId(
    tenantId: string,
    storyIds: string[],
  ): Promise<Map<string, string[]>> {
    if (storyIds.length === 0) {
      return new Map();
    }
    const links = await this.prisma.correlationLink.findMany({
      where: {
        tenantId,
        edgeType: 'pr_implements_story',
        fromType: 'pull_request',
        toType: 'story',
        toId: { in: storyIds },
      },
      select: { fromId: true, toId: true },
    });
    const byStory = new Map<string, string[]>();
    for (const link of links) {
      byStory.set(link.toId, [...(byStory.get(link.toId) ?? []), link.fromId]);
    }
    return byStory;
  }

  /** Bug story ids linked to each repository through PR→story edges. */
  async bugStoryIdsByRepo(
    tenantId: string,
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<Map<string, Set<string>>> {
    if (repos.length === 0) {
      return new Map();
    }
    const links = await this.prisma.correlationLink.findMany({
      where: {
        tenantId,
        edgeType: 'pr_implements_story',
        fromType: 'pull_request',
        toType: 'story',
      },
      select: { fromId: true, toId: true },
    });
    const candidateStoryIds = [...new Set(links.map((link) => link.toId))];
    if (candidateStoryIds.length === 0) {
      return new Map(repos.map((repo) => [repo, new Set<string>()]));
    }
    const bugIds = new Set(
      await this.planning.listBugStoryIds(
        tenantId,
        candidateStoryIds,
        from,
        to,
      ),
    );
    const byRepo = new Map(repos.map((repo) => [repo, new Set<string>()]));
    const repoSet = new Set(repos);
    for (const link of links) {
      if (!bugIds.has(link.toId)) {
        continue;
      }
      const repo = link.fromId.split('#')[0];
      if (repoSet.has(repo)) {
        byRepo.get(repo)?.add(link.toId);
      }
    }
    return byRepo;
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
