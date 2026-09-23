import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { newId } from '../../common/id';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { DeveloperIdentityService } from '../../correlation/developer-identity.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: DeveloperIdentityService,
  ) {}

  /**
   * The live roster, alphabetical. Never ordered by any activity figure.
   *
   * Enriches each stored row with `displayName`/`resolved` from
   * `DeveloperIdentityService.attributionIndex`, so an admin can see what the
   * digest already knows: an unresolved entry is indistinguishable from "did
   * nothing" in the raw data, which is exactly the confusion this feature
   * exists to prevent. The resolution check is deliberately the same one
   * `evaluateRoster` (no-commit-detection.service.ts) uses — an entry is
   * unresolved when its `canonicalDeveloperId` is not a key of the
   * attribution index's `displayNames` map. This must not become a second,
   * independently-drifting definition: if this page and the digest ever
   * disagreed about who is unresolved, the page would be actively
   * misleading rather than merely incomplete.
   */
  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const [rows, index] = await Promise.all([
      this.prisma.trackedDeveloper.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { canonicalDeveloperId: 'asc' },
      }),
      this.identities.attributionIndex(user.tenantId),
    ]);
    return {
      items: rows.map((row) => ({
        developer: row.canonicalDeveloperId,
        addedAs: row.addedAs,
        note: row.note,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
        displayName:
          index.displayNames.get(row.canonicalDeveloperId) ??
          row.canonicalDeveloperId,
        resolved: index.displayNames.has(row.canonicalDeveloperId),
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
