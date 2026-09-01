import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { newId } from '../../common/id';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * Why an exclusion exists. A closed set, and never blank: the Watchlist prints
 * this reason beside the person, and "excluded, no reason given" is exactly the
 * unaccountable filtering that would make a shortened roster untrustworthy.
 */
const EXCLUSION_REASONS = [
  'leave',
  'new_joiner',
  'secondment',
  'other',
] as const;

/**
 * The longest an exclusion may run before someone has to renew it.
 *
 * A cap, not a default. An exclusion with no end date — or a five-year one — is
 * how a person quietly drops off the roster permanently without anyone
 * deciding to, which is the failure this whole mechanism exists to prevent.
 * Renewal is cheap; a silent permanent omission is not.
 */
const MAX_EXCLUSION_DAYS = 180;

class UpsertExclusionDto {
  @IsIn(EXCLUSION_REASONS as unknown as string[])
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsDateString()
  expiresAt!: string;
}

/**
 * Admin management of Watchlist exclusions (DASHBOARDS.md §4.4.2).
 *
 * SprintIQ has no HR feed. Leave, a start date, a secondment — the ordinary
 * reasons a developer shows no commits — are invisible to it, and every one of
 * them renders identically to disengagement. Rather than infer them (which
 * would be a guess presented as a fact) the platform takes an explicit human
 * statement, records who made it, and makes it expire.
 *
 * Admin-only, and audited by the global `AuditInterceptor` like every other
 * mutating route. Note what this does NOT do: an excluded developer keeps
 * counting in every commit, PR and metric figure. It suppresses one thing —
 * being listed as someone to go ask about — and the board still publishes the
 * count and the reasons, because a silently shortened list is how a roster
 * review loses the person it should have surfaced.
 */
@Controller('dashboards/watchlist-exclusions')
export class WatchlistExclusionsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Live exclusions, with who entered each. Admin-visible detail. */
  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.watchlistExclusion.findMany({
      where: { tenantId: user.tenantId, expiresAt: { gt: new Date() } },
      orderBy: { canonicalDeveloperId: 'asc' },
    });
    return {
      items: rows.map((row) => ({
        developer: row.canonicalDeveloperId,
        reason: row.reason,
        note: row.note,
        expiresAt: row.expiresAt.toISOString(),
        createdByUserId: row.createdByUserId,
      })),
      reasons: EXCLUSION_REASONS,
      maxDays: MAX_EXCLUSION_DAYS,
    };
  }

  /**
   * Exclude a developer, or replace their existing exclusion.
   *
   * `PUT` rather than `POST`: the unique key is one live exclusion per
   * developer, so re-excluding someone is idempotent by design instead of
   * stacking overlapping rows nobody can reason about.
   */
  @Roles(Role.ADMIN)
  @Put(':developer')
  async upsert(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
    @Body() dto: UpsertExclusionDto,
  ) {
    const expiresAt = new Date(dto.expiresAt);
    const ceiling = new Date(Date.now() + MAX_EXCLUSION_DAYS * 86_400_000);
    if (expiresAt <= new Date()) {
      throw new BadRequestException(
        'expiresAt must be in the future — an already-lapsed exclusion hides nobody and only obscures the record.',
      );
    }
    if (expiresAt > ceiling) {
      throw new BadRequestException(
        `expiresAt may be at most ${MAX_EXCLUSION_DAYS} days out. Longer exclusions drop someone off the roster without anyone deciding to; renew instead.`,
      );
    }

    const data = {
      reason: dto.reason,
      note: dto.note ?? null,
      expiresAt,
      createdByUserId: user.userId,
    };
    const row = await this.prisma.watchlistExclusion.upsert({
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
        ...data,
      },
      update: data,
    });
    return {
      developer: row.canonicalDeveloperId,
      reason: row.reason,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** Lift an exclusion early; the developer returns to the buckets at once. */
  @Roles(Role.ADMIN)
  @Delete(':developer')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
  ) {
    await this.prisma.watchlistExclusion.deleteMany({
      where: { tenantId: user.tenantId, canonicalDeveloperId: developer },
    });
    return { developer, excluded: false };
  }
}
