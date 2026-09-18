import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { newId } from '../../common/id';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';

class UpsertTrackedDeveloperDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Admin management of the daily digest's tracked roster.
 *
 * The roster is data, not a constant in the code, so that a joiner is covered
 * by tomorrow's digest without a deploy — the same reason `DeveloperRole` and
 * the Watchlist exclusions are tables.
 *
 * Note what this is NOT: a statement that someone is or is not working. It
 * only decides who the digest evaluates. Suppressing a specific person on a
 * specific day is what `WatchlistExclusion` is for, and it expires; taking
 * someone off this roster is indefinite and should be rare.
 *
 * Admin-only, and audited by the global `AuditInterceptor` like every other
 * mutating route.
 */
@Controller('dashboards/tracked-developers')
export class TrackedDevelopersController {
  constructor(private readonly prisma: PrismaService) {}

  /** The live roster, alphabetical. Never ordered by any activity figure. */
  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.trackedDeveloper.findMany({
      where: { tenantId: user.tenantId, active: true },
      orderBy: { canonicalDeveloperId: 'asc' },
    });
    return {
      items: rows.map((row) => ({
        developer: row.canonicalDeveloperId,
        addedAs: row.addedAs,
        note: row.note,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      })),
      count: rows.length,
    };
  }

  /**
   * Add a developer to the roster, or reactivate them.
   *
   * `PUT` rather than `POST`: the unique key is one row per developer, so
   * re-adding someone is idempotent instead of stacking rows nobody can
   * reason about.
   */
  @Roles(Role.ADMIN)
  @Put(':developer')
  async upsert(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
    @Body() dto: UpsertTrackedDeveloperDto,
  ) {
    const row = await this.prisma.trackedDeveloper.upsert({
      where: {
        tenantId_canonicalDeveloperId: {
          tenantId: user.tenantId,
          canonicalDeveloperId: developer,
        },
      },
      create: {
        id: newId(),
        tenantId: user.tenantId,
        canonicalDeveloperId: developer,
        // Kept verbatim: if this never resolves to a known identity, the
        // digest reports it as unresolved rather than as someone idle.
        addedAs: developer,
        note: dto.note ?? null,
        createdByUserId: user.userId,
      },
      update: { active: true, note: dto.note ?? null },
    });
    return {
      developer: row.canonicalDeveloperId,
      addedAs: row.addedAs,
      active: row.active,
    };
  }

  /**
   * Take a developer off the roster.
   *
   * Deactivates rather than deletes: a shrinking roster with no record of who
   * was removed, by whom, and when is exactly the unaccountable filtering
   * that makes the digest's own list untrustworthy.
   */
  @Roles(Role.ADMIN)
  @Delete(':developer')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
  ) {
    await this.prisma.trackedDeveloper.updateMany({
      where: { tenantId: user.tenantId, canonicalDeveloperId: developer },
      data: { active: false },
    });
    return { developer, active: false };
  }
}
