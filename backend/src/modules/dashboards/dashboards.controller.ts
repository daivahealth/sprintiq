import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/role.enum';
import { MetricsService } from '../../metrics/metrics.service';

/**
 * BC-13 Dashboards & Reporting (read BFF). JWT-guarded globally; tenant resolved
 * from the token. This slice exposes PR cycle time for a repo; widgets/personas
 * are built out per docs/features/DASHBOARDS.md.
 */
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly metrics: MetricsService) {}

  @Roles(
    Role.DEVELOPER,
    Role.TEAM_LEAD,
    Role.SCRUM_MASTER,
    Role.ENG_MANAGER,
    Role.CTO,
  )
  @Get('pr-cycle-time')
  getPrCycleTime(@Query('repo') repo?: string) {
    if (!repo) {
      throw new BadRequestException(
        'Query param "repo" is required (owner/name).',
      );
    }
    return this.metrics.computePrCycleTime(repo);
  }
}
