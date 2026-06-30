import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/auth/public.decorator';
import { AppRole } from '../config/app-role';

/**
 * Liveness/readiness. Public (no JWT) and served by every role, so the platform
 * can health-check api, collector, and worker pods uniformly.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  check() {
    return {
      status: 'ok',
      role: this.config.get<AppRole>('appRole'),
      env: this.config.get<string>('env'),
      timestamp: new Date().toISOString(),
    };
  }
}
