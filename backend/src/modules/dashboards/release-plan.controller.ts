import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  NotFoundException,
  Put,
  Query,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * How far a planned release date may drift from the release's own dates
 * (`releaseDate`, falling back to `startAt`, falling back to now) before the
 * write is rejected.
 *
 * Not a data-quality nicety: a plan years away from the release it describes
 * produces a lateness figure in the hundreds of days on a board people make
 * delivery decisions from.
 */
const MAX_PLAN_DRIFT_DAYS = 365;

class SetReleasePlanDto {
  @IsString()
  projectKey!: string;

  @IsString()
  name!: string;

  @IsString()
  plannedReleaseAt!: string;
}

/**
 * The planned release date for an RC — user input, because Jira cannot answer
 * this question.
 *
 * A Jira version carries exactly one date (`releaseDate`, "expected to
 * finish") plus a `released` flag, and Jira overwrites that date with the
 * actual release day the moment the version ships. So at the exact moment
 * you would want to compare planned vs actual, the plan is gone — there is
 * no second field and no history to recover it from. Rather than infer a
 * planned date (a guess presented as a fact, on a board people act on),
 * SprintIQ takes an explicit human statement and records who made it.
 *
 * This is the only write in an otherwise read-only feature (Task 4's version
 * projection deliberately never touches these three columns, so a poll can
 * never overwrite a plan nothing could restore). Admin-only, and audited by
 * the global `AuditInterceptor` like every other mutating route — there is
 * nothing to wire here.
 */
@Controller('dashboards/release-plan')
export class ReleasePlanController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles(Role.ADMIN)
  @Put()
  async set(@CurrentUser() user: AuthUser, @Body() dto: SetReleasePlanDto) {
    const plannedReleaseAt = new Date(dto.plannedReleaseAt);
    if (Number.isNaN(plannedReleaseAt.getTime())) {
      throw new BadRequestException(
        `plannedReleaseAt is not a valid date: "${dto.plannedReleaseAt}".`,
      );
    }

    const release = await this.loadOwnRelease(user, dto.projectKey, dto.name);

    const anchor = release.releaseDate ?? release.startAt ?? new Date();
    const driftDays =
      Math.abs(plannedReleaseAt.getTime() - anchor.getTime()) / 86_400_000;
    if (driftDays > MAX_PLAN_DRIFT_DAYS) {
      throw new BadRequestException(
        `plannedReleaseAt is more than ${MAX_PLAN_DRIFT_DAYS} days from the ` +
          "release's own dates. A plan that far off produces a lateness " +
          'figure in the hundreds of days on a board people act on — double-check the date.',
      );
    }

    await this.prisma.release.update({
      where: { id: release.id },
      data: {
        plannedReleaseAt,
        plannedSetByUserId: user.userId,
        plannedSetAt: new Date(),
      },
    });

    return {
      projectKey: dto.projectKey,
      name: dto.name,
      plannedReleaseAt: plannedReleaseAt.toISOString(),
      plannedSetByUserId: user.userId,
    };
  }

  @Roles(Role.ADMIN)
  @Delete()
  async clear(
    @CurrentUser() user: AuthUser,
    @Query('projectKey') projectKey?: string,
    @Query('name') name?: string,
  ) {
    const release = await this.loadOwnRelease(user, projectKey, name);

    // All three columns together: leaving provenance behind for a date that
    // no longer exists is a record that lies about itself.
    await this.prisma.release.update({
      where: { id: release.id },
      data: {
        plannedReleaseAt: null,
        plannedSetByUserId: null,
        plannedSetAt: null,
      },
    });

    return { ok: true };
  }

  /**
   * The tenant-scoped lookup both handlers share, guarded up front against
   * missing/empty identifiers.
   *
   * The guard matters most on `clear`: `projectKey`/`name` there are bare
   * `@Query()` primitives, which the global `ValidationPipe` does not
   * validate (only class-bodied DTOs get that treatment) — and Prisma drops
   * an `undefined`-valued key from a `where` clause at build time. Without
   * this check, a request missing either param would silently collapse the
   * lookup to `{ tenantId }`, match an arbitrary release for that tenant,
   * and `clear` would then erase that release's plan and report success.
   * Rejecting here, before any query runs, is what closes that hole —
   * Prisma's `undefined` semantics are exactly what must not be relied on.
   *
   * `findFirst` scoped by `tenantId`, not a bare keyed update, is separately
   * what stops a write landing on another tenant's release row.
   */
  private async loadOwnRelease(
    user: AuthUser,
    projectKey: string | undefined,
    name: string | undefined,
  ) {
    if (!projectKey || !name) {
      throw new BadRequestException('projectKey and name are both required.');
    }

    const release = await this.prisma.release.findFirst({
      where: { tenantId: user.tenantId, projectKey, name },
    });
    if (!release) {
      throw new NotFoundException(
        `Release "${name}" not found in project ${projectKey}.`,
      );
    }
    return release;
  }
}
