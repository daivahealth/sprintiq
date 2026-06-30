import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtStrategy } from './auth/jwt.strategy';
import { RolesGuard } from './auth/roles.guard';
import { EventBus } from './events/event-bus';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { AuditInterceptor } from './interceptors/audit.interceptor';
import { TenantContextService } from './tenancy/tenant-context.service';
import { TenantMiddleware } from './tenancy/tenant.middleware';

/**
 * Cross-cutting concerns shared by every context: tenancy, auth/RBAC, audit,
 * the event bus, and the global exception filter. Global so all modules get the
 * same enforcement without re-importing.
 *
 * Guard order: JwtAuthGuard (authenticate, sets tenant) → RolesGuard (authorize).
 */
@Global()
@Module({
  imports: [ConfigModule, PassportModule],
  providers: [
    TenantContextService,
    EventBus,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [TenantContextService, EventBus],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
