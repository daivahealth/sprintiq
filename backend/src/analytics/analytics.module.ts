import { Module } from '@nestjs/common';
import { CorrelationModule } from '../correlation/correlation.module';
import { AnalyticsService } from './analytics.service';
import { KnowledgeGraphLoader } from './knowledge-graph/graph-loader.service';
import { KnowledgeGraphManager } from './knowledge-graph/graph-manager.service';
import { GraphSourceReader } from './knowledge-graph/graph-source.reader';
import { KnowledgeGraphUpdater } from './knowledge-graph/graph-updater.service';
import { KnowledgeGraphController } from './knowledge-graph/knowledge-graph.controller';

/** BC-10 Analytics & Insight. */
@Module({
  // DeveloperIdentityService: BC-5 identity resolution, reused, not copied.
  imports: [CorrelationModule],
  controllers: [KnowledgeGraphController],
  providers: [
    AnalyticsService,
    GraphSourceReader,
    KnowledgeGraphLoader,
    KnowledgeGraphManager,
    KnowledgeGraphUpdater,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
