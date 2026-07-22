import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';

import { CommonModule } from './common/common.module';
import { SecretsModule } from './common/secrets/secrets.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';

// Cross-cutting / platform contexts
import { AuditModule } from './modules/audit/audit.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ConnectionsModule } from './modules/connections/connections.module';
import { ConfigurationsModule } from './modules/configurations/configurations.module';

// Collection + intelligence pipeline
import { CollectorsModule } from './collectors/collectors.module';
import { CorrelationModule } from './correlation/correlation.module';
import { MetricsModule } from './metrics/metrics.module';
import { RulesModule } from './rules/rules.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiAgentsModule } from './ai-agents/ai-agents.module';

// Domain contexts
import { PlanningModule } from './modules/planning/planning.module';
import { CodeModule } from './modules/code/code.module';
import { CiModule } from './modules/ci/ci.module';
import { QualityModule } from './modules/quality/quality.module';
import { DashboardsModule } from './modules/dashboards/dashboards.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

/**
 * Composition root. One module per bounded context (PRODUCT-ARCHITECTURE §3).
 * The same image runs as api | collector | worker via APP_ROLE; all modules are
 * loaded and role-specific behavior is gated within them (scheduler, controllers).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),

    PrismaModule,
    CommonModule,
    SecretsModule,
    AuditModule,
    HealthModule,

    IdentityModule,
    ConnectionsModule,
    ConfigurationsModule,

    CollectorsModule,
    CorrelationModule,
    MetricsModule,
    RulesModule,
    AnalyticsModule,
    AiAgentsModule,

    PlanningModule,
    CodeModule,
    CiModule,
    QualityModule,
    DashboardsModule,
    NotificationsModule,
  ],
})
export class AppModule {}
