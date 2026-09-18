import { Body, Controller, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, Matches } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { NotificationsService } from './notifications.service';

class RunDigestDto {
  /** IST day key. Defaults to the previous working day. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'day must be an IST date key, YYYY-MM-DD',
  })
  day?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * Manual control over the daily digest.
 *
 * `dryRun` is the important one: it returns the full computation — who would
 * be named, which roster entries did not resolve, whose data is incomplete,
 * and the collection freshness — and posts nothing. It is how the rule is
 * validated against real data before a single name reaches a channel, and how
 * a failed morning is inspected afterwards.
 */
@Controller('admin/notifications/no-commit-digest')
export class DigestAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  @Roles(Role.ADMIN)
  @Post('run')
  async run(@CurrentUser() user: AuthUser, @Body() dto: RunDigestDto) {
    return this.notifications.runNoCommitDigest(user.tenantId, {
      ...(dto.day ? { day: dto.day } : {}),
      ...(dto.dryRun === undefined ? {} : { dryRun: dto.dryRun }),
      ...(dto.force === undefined ? {} : { force: dto.force }),
    });
  }
}
