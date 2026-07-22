import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../modules/connections/connections.module';
import { CollectorRegistry } from './framework/collector.registry';
import { IngestionService } from './ingestion/ingestion.service';
import { CollectorSchedulerService } from './scheduler/collector-scheduler.service';
import { GithubOrgSyncService } from './sources/github/github-org-sync.service';
import { GithubClient } from './sources/github/github.client';
import { GithubCollector } from './sources/github/github.collector';
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
    GithubClient,
    GithubCollector,
    GithubOrgSyncService,
    JiraClient,
    JiraCollector,
    CollectorSchedulerService,
  ],
  exports: [IngestionService, GithubOrgSyncService],
})
export class CollectorsModule {}
