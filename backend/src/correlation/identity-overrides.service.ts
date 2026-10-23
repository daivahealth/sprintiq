import { BadRequestException, Injectable } from '@nestjs/common';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import { DeveloperIdentityService } from './developer-identity.service';
import { loginToDisplayName } from './developer-identity.util';

export type OverrideAction = 'merge' | 'exclude';

export interface IdentityOverrideInput {
  sourceSystem: 'github' | 'jira';
  sourceKey: string;
  action: OverrideAction;
  canonicalDeveloperId?: string | null;
  reason: string;
}

/** Two or more developers whose names normalise to the same letters. */
export interface PossibleDuplicate {
  /** The normalised name the members share. */
  name: string;
  members: {
    canonicalDeveloperId: string;
    displayName: string;
    /** The identity rows under this developer — what a merge would move. */
    sourceKeys: string[];
    /** Whether a GitHub login (not just an email) backs this developer. */
    hasLogin: boolean;
  }[];
}

/** Letters only, lower-cased: "Shubham Jain" and "SHUBHAM_JAIN" both → "shubhamjain". */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Admin-managed identity overrides (2026-10-19). Until now overrides were
 * written only by `scripts/apply-identity-overrides.ts`, with the merges
 * hardcoded — there was no way for an admin to fix "one person, two rows".
 *
 * Every write is an explicit human statement, re-derived into the identity map
 * at once (`resolveTenant`). Nothing here merges on its own: possible
 * duplicates are suggestions an admin acts on.
 */
@Injectable()
export class IdentityOverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: DeveloperIdentityService,
  ) {}

  list(tenantId: string) {
    return this.prisma.identityOverride.findMany({
      where: { tenantId },
      orderBy: [{ action: 'asc' }, { sourceKey: 'asc' }],
      select: {
        sourceSystem: true,
        sourceKey: true,
        action: true,
        canonicalDeveloperId: true,
        reason: true,
        setByUserId: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Records one override and re-resolves the tenant. A merge must name an
   * existing developer that is not itself excluded; the identity it moves must
   * exist. Restating an override updates it.
   */
  async set(tenantId: string, userId: string, input: IdentityOverrideInput) {
    if (!['github', 'jira'].includes(input.sourceSystem)) {
      throw new BadRequestException('sourceSystem must be github or jira.');
    }
    if (!['merge', 'exclude'].includes(input.action)) {
      throw new BadRequestException('action must be merge or exclude.');
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException(
        'A reason (at least 3 characters) is required.',
      );
    }
    const identity = await this.prisma.developerIdentity.findFirst({
      where: {
        tenantId,
        sourceSystem: input.sourceSystem,
        sourceKey: input.sourceKey,
      },
      select: { canonicalDeveloperId: true },
    });
    if (!identity) {
      throw new BadRequestException(
        `No ${input.sourceSystem} identity ${input.sourceKey} for this tenant.`,
      );
    }
    let target: string | null = null;
    if (input.action === 'merge') {
      target = input.canonicalDeveloperId ?? null;
      if (!target) {
        throw new BadRequestException('A merge needs canonicalDeveloperId.');
      }
      if (target === identity.canonicalDeveloperId) {
        throw new BadRequestException(
          'That identity already belongs to this developer.',
        );
      }
      const into = await this.prisma.developerIdentity.findFirst({
        where: { tenantId, canonicalDeveloperId: target },
        select: { excluded: true },
      });
      if (!into) {
        throw new BadRequestException(
          `No developer ${target} for this tenant.`,
        );
      }
      if (into.excluded) {
        throw new BadRequestException(
          'Cannot merge into an excluded entity — that would hide a real person.',
        );
      }
    }
    const data = {
      action: input.action,
      canonicalDeveloperId: target,
      reason: reason.slice(0, 500),
      setByUserId: userId,
    };
    await this.prisma.identityOverride.upsert({
      where: {
        tenantId_sourceSystem_sourceKey: {
          tenantId,
          sourceSystem: input.sourceSystem,
          sourceKey: input.sourceKey,
        },
      },
      create: {
        id: newId(),
        tenantId,
        sourceSystem: input.sourceSystem,
        sourceKey: input.sourceKey,
        ...data,
      },
      update: data,
    });
    await this.identities.resolveTenant(tenantId);
    return { ...input, canonicalDeveloperId: target, reason: data.reason };
  }

  /** Merges every identity row of one developer into another, with one reason. */
  async mergeDeveloper(
    tenantId: string,
    userId: string,
    from: string,
    into: string,
    reason: string,
  ) {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId, sourceSystem: 'github', canonicalDeveloperId: from },
      select: { sourceKey: true },
    });
    if (rows.length === 0) {
      throw new BadRequestException(`No GitHub identities under ${from}.`);
    }
    for (const r of rows) {
      await this.set(tenantId, userId, {
        sourceSystem: 'github',
        sourceKey: r.sourceKey,
        action: 'merge',
        canonicalDeveloperId: into,
        reason,
      });
    }
    return { merged: rows.length, from, into };
  }

  /** Removes an override and re-resolves; false when none existed. */
  async remove(
    tenantId: string,
    sourceSystem: string,
    sourceKey: string,
  ): Promise<boolean> {
    const r = await this.prisma.identityOverride.deleteMany({
      where: { tenantId, sourceSystem, sourceKey },
    });
    if (r.count > 0) await this.identities.resolveTenant(tenantId);
    return r.count > 0;
  }

  /**
   * GitHub developers whose names normalise to the same letters — the shape of
   * "one person, two rows" (a personal account beside the corporate one, or a
   * name spelt in capitals). Suggestions only. Excluded entities are never
   * members, and a name that normalises to nothing (non-Latin, or only digits)
   * groups nobody.
   */
  async possibleDuplicates(tenantId: string): Promise<PossibleDuplicate[]> {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId, sourceSystem: 'github', excluded: false },
      select: {
        canonicalDeveloperId: true,
        sourceKey: true,
        sourceLogin: true,
        name: true,
      },
    });
    const byDev = new Map<
      string,
      { names: Set<string>; display: string; keys: string[]; hasLogin: boolean }
    >();
    for (const r of rows) {
      const d = byDev.get(r.canonicalDeveloperId) ?? {
        names: new Set<string>(),
        display:
          r.name ??
          (r.sourceLogin
            ? loginToDisplayName(r.sourceLogin)
            : r.canonicalDeveloperId),
        keys: [],
        hasLogin: false,
      };
      for (const n of [
        r.name,
        r.sourceLogin ? loginToDisplayName(r.sourceLogin) : null,
      ]) {
        const norm = n ? normalizeName(n) : '';
        if (norm.length >= 4) d.names.add(norm);
      }
      d.keys.push(r.sourceKey);
      if (r.sourceLogin) d.hasLogin = true;
      byDev.set(r.canonicalDeveloperId, d);
    }
    const byName = new Map<string, Set<string>>();
    for (const [dev, d] of byDev) {
      for (const n of d.names) {
        byName.set(n, (byName.get(n) ?? new Set()).add(dev));
      }
    }
    const seen = new Set<string>();
    const out: PossibleDuplicate[] = [];
    for (const [name, devs] of byName) {
      if (devs.size < 2) continue;
      const members = [...devs].sort();
      const sig = members.join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({
        name,
        members: members.map((id) => {
          const d = byDev.get(id)!;
          return {
            canonicalDeveloperId: id,
            displayName: d.display,
            sourceKeys: [...d.keys].sort(),
            hasLogin: d.hasLogin,
          };
        }),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
