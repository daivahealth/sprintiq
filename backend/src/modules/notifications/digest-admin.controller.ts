import { Body, Controller, Post } from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  Matches,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { NotificationsService } from './notifications.service';

/**
 * Whether a `YYYY-MM-DD` string names a real calendar date, not merely a
 * value that matches the shape.
 *
 * `2026-02-30` matches `\d{4}-\d{2}-\d{2}` and silently rolls forward to 2
 * March under `new Date(...)`/`Date.UTC(...)` arithmetic — the window queried
 * would then disagree with the `reportedDay` recorded on the run row.
 * `9999-99-99` matches the same shape and produces an Invalid Date, against
 * which `no-commit-detection.service.ts`'s freshness gate (`!collectedThroughAt
 * || collectedThroughAt < to`) is false on both sides — the gate fails OPEN
 * instead of withholding. Round-tripping the parsed parts back to the same
 * `YYYY-MM-DD` string catches both: a real date is the only input for which
 * the round trip is lossless.
 */
function isRealCalendarDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const roundTrip = `${date.getUTCFullYear().toString().padStart(4, '0')}-${(
    date.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
  return roundTrip === value;
}

/** class-validator decorator wrapping `isRealCalendarDateKey`. */
function IsRealCalendarDateKey(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRealCalendarDateKey',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isRealCalendarDateKey(value);
        },
      },
    });
  };
}

export class RunDigestDto {
  /** IST day key. Defaults to the previous working day. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'day must be an IST date key, YYYY-MM-DD',
  })
  @IsRealCalendarDateKey({
    message: 'day must be a real calendar date, YYYY-MM-DD',
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
