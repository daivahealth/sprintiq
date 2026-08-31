import { Logger, Module } from '@nestjs/common';
import { ConnectionsModule } from '../modules/connections/connections.module';
import { CollectorRegistry } from './framework/collector.registry';
import { IngestionService } from './ingestion/ingestion.service';
import { CollectionProgressService } from './scheduler/collection-progress.service';
import { BackfillSchedulerService } from './scheduler/backfill-scheduler.service';
import { CollectorSchedulerService } from './scheduler/collector-scheduler.service';
import { GithubCommitMessageReconcilerService } from './sources/github/github-commit-message-reconciler.service';
import { GithubCommitReconcilerService } from './sources/github/github-commit-reconciler.service';
import { GithubOrgSyncService } from './sources/github/github-org-sync.service';
import { GithubPrReconcilerService } from './sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from './sources/github/github-review-reconciler.service';
import { GithubGraphqlClient } from './sources/github/github-graphql.client';
import {
  GITHUB_SOURCE_CLIENT,
  collectionMode,
} from './sources/github/github-source-client';
import { GithubClient } from './sources/github/github.client';
import { GithubCollector } from './sources/github/github.collector';
import { JiraAssigneeEmailReconcilerService } from './sources/jira/jira-assignee-email-reconciler.service';
import { JiraStoryDateReconcilerService } from './sources/jira/jira-story-date-reconciler.service';
import { JiraClient } from './sources/jira/jira.client';
import { JiraCollector } from './sources/jira/jira.collector';
import { SignatureVerifierRegistry } from './webhooks/signature-verifier.registry';
import { WebhooksController } from './webhooks/webhooks.controller';

/**
 * BC-1 Collectors & Ingestion — the only door to the outside world. Hosts the
 * public webhook receivers, per-provider signature verification, the native
 * per-source collectors (client + webhook normalizer + poller), the scheduled
 * sync sweep (backfill + reconciliation), and the single ingestion pipeline +
 * raw-event store.
 */
@Module({
  imports: [ConnectionsModule],
  controllers: [WebhooksController],
  providers: [
    IngestionService,
    SignatureVerifierRegistry,
    CollectorRegistry,
    // Both transports are constructed; only one is bound to the token the
    // collector, reconcilers and org sync inject. REST stays registered while
    // GraphQL is on so the parity harness (ADR-0008) can drive them
    // side-by-side against the same repos.
    GithubClient,
    GithubGraphqlClient,
    {
      provide: GITHUB_SOURCE_CLIENT,
      inject: [GithubClient, GithubGraphqlClient],
      useFactory: (rest: GithubClient, graphql: GithubGraphqlClient) => {
        const mode = collectionMode();
        Logger.log(
          `GitHub collection transport: ${mode}${mode === 'rest' ? ' (set GITHUB_COLLECTION_MODE=graphql to switch)' : ''}`,
          'CollectorsModule',
        );
        return mode === 'graphql' ? graphql : rest;
      },
    },
    GithubCollector,
    GithubOrgSyncService,
    GithubCommitMessageReconcilerService,
    GithubCommitReconcilerService,
    GithubPrReconcilerService,
    GithubReviewReconcilerService,
    JiraClient,
    JiraCollector,
    JiraStoryDateReconcilerService,
    JiraAssigneeEmailReconcilerService,
    CollectorSchedulerService,
    BackfillSchedulerService,
    CollectionProgressService,
  ],
  exports: [
    IngestionService,
    GithubOrgSyncService,
    GithubCommitMessageReconcilerService,
    GithubCommitReconcilerService,
    GithubPrReconcilerService,
    GithubReviewReconcilerService,
    JiraStoryDateReconcilerService,
    JiraAssigneeEmailReconcilerService,
    CollectionProgressService,
  ],
})
export class CollectorsModule {}
