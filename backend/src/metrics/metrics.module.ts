import { Module } from '@nestjs/common';
import { CollectorsModule } from '../collectors/collectors.module';
import { CorrelationModule } from '../correlation/correlation.module';
import { CodeModule } from '../modules/code/code.module';
import { ConnectionsModule } from '../modules/connections/connections.module';
import { PlanningModule } from '../modules/planning/planning.module';
import { ActivityVerificationService } from './activity-verification.service';
import { DeveloperActivityService } from './developer-activity.service';
import { InsightsService } from './insights.service';
import { MetricsService } from './metrics.service';
import { NoCommitDetectionService } from './no-commit-detection.service';
import { SprintHealthDetailService } from './sprint-health-detail.service';

/** BC-8 Metrics & Aggregation Engine + dashboard insight read models. */
@Module({
  // ConnectionsModule: the velocity read needs the collection horizon, which
  // is a property of the connections, to know which sprints predate the data.
  // CollectorsModule: the digest's audit-coverage gate reads
  // `GithubAuditSyncService.coverageForDay` — a read-only, tenant-scoped
  // method; no GitHub call leaves the collector context through it. Activity
  // verification asks `GithubActivityVerifyService` (BC-1) for its GitHub
  // read the same way: the call to GitHub is the collector's, not ours.
  imports: [
    CodeModule,
    CollectorsModule,
    ConnectionsModule,
    CorrelationModule,
    PlanningModule,
  ],
  providers: [
    MetricsService,
    InsightsService,
    DeveloperActivityService,
    SprintHealthDetailService,
    NoCommitDetectionService,
    ActivityVerificationService,
  ],
  exports: [
    MetricsService,
    InsightsService,
    DeveloperActivityService,
    SprintHealthDetailService,
    NoCommitDetectionService,
    ActivityVerificationService,
  ],
})
export class MetricsModule {}
