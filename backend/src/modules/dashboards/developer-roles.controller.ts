import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { newId } from '../../common/id';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import {
  DEVELOPER_ROLES,
  isDeveloperRole,
} from '../../metrics/developer-activity.service';

class SetRoleDto {
  @IsIn(DEVELOPER_ROLES as unknown as string[])
  role!: string;
}

/**
 * Admin classification of developers as DEV, QA or OTH (DASHBOARDS.md §4.4.8).
 *
 * SprintIQ cannot observe what kind of work someone does. A QA engineer
 * committing test automation and a backend developer are indistinguishable in
 * the delivery graph, and deriving the difference from file paths or commit
 * messages would be a guess presented as a fact. So this is an explicit human
 * statement, recorded with who made it — the same shape, and for the same
 * reason, as the Watchlist exclusions beside it.
 *
 * Admin-only on the write side and audited by the global `AuditInterceptor`
 * like every other mutating route. The read is open to any dashboard user,
 * because the boards render the role beside each name.
 *
 * There is no expiry, unlike an exclusion: an exclusion is a temporary
 * statement that must lapse so nobody falls off the roster permanently by
 * accident, whereas a role is a standing fact. Removing one is an explicit
 * DELETE, which returns the developer to *unclassified* — which is not `OTH`.
 */
@Controller('dashboards/developer-roles')
export class DeveloperRolesController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every classification the tenant has made, plus the closed set itself so a
   * client renders the options this deployment actually accepts rather than a
   * list hardcoded in the frontend that can drift out of step with it.
   *
   * Readable by any dashboard user: the role is rendered beside each developer
   * on Overview and the Watchlist. Only writing is restricted.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.developerRole.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { canonicalDeveloperId: 'asc' },
    });
    return {
      items: rows
        // A row whose value predates a change to the set would render as a
        // badge nothing can interpret; drop it from the map rather than ship
        // it, and the developer reads as unclassified until someone re-sets it.
        .filter((row) => isDeveloperRole(row.role))
        .map((row) => ({
          developer: row.canonicalDeveloperId,
          role: row.role,
          setByUserId: row.setByUserId,
          updatedAt: row.updatedAt.toISOString(),
        })),
      roles: DEVELOPER_ROLES,
    };
  }

  /**
   * Classify a developer, or change their existing classification.
   *
   * `PUT` rather than `POST`: the unique key is one role per developer, so
   * re-classifying is idempotent by design instead of stacking rows nobody
   * can reason about.
   */
  @Roles(Role.ADMIN)
  @Put(':developer')
  async set(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
    @Body() dto: SetRoleDto,
  ) {
    const data = { role: dto.role, setByUserId: user.userId };
    const row = await this.prisma.developerRole.upsert({
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
    return { developer: row.canonicalDeveloperId, role: row.role };
  }

  /**
   * Clear a classification, returning the developer to **unclassified**.
   *
   * Deleting the row rather than writing `OTH`: those are different statements.
   * `OTH` is someone deciding "none of these"; no row is nobody having decided,
   * and the boards render the difference.
   */
  @Roles(Role.ADMIN)
  @Delete(':developer')
  async clear(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
  ) {
    await this.prisma.developerRole.deleteMany({
      where: { tenantId: user.tenantId, canonicalDeveloperId: developer },
    });
    return { developer, role: null };
  }
}
