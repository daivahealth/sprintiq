import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import {
  IdentityMatch,
  SourceIdentity,
  indexLoginsByNormalizedKey,
  isMachineEmail,
  normalizeIdentityKey,
  resolveIdentity,
  sourceKeyOf,
} from './developer-identity.util';

const SOURCE_SYSTEM = 'github';

export interface IdentityResolveResult {
  /** Distinct source identities observed on commits and pull requests. */
  observed: number;
  /** Identities that resolved to a GitHub account. */
  resolved: number;
  /** Identities carrying no login that a name/email match recovered. */
  recovered: number;
  /** Identities left deliberately unmerged: no evidence, or evidence for several people. */
  unresolved: number;
  ambiguous: number;
}

/** One selectable developer in the picker. */
export interface DeveloperCatalogEntry {
  canonicalDeveloperId: string;
  displayName: string;
  /** False when no GitHub account could be matched — their work is still counted. */
  attributed: boolean;
  /**
   * Newest commit across every identity this person commits under. Lets a board
   * open on someone with recent work instead of whoever sorts first
   * alphabetically — on this tenant only 36 of 83 developers committed in the
   * last week, so an alphabetical default lands on an empty board more often
   * than not, which reads as the board being broken.
   */
  lastActiveAt: string | null;
}

/** Every source identity one canonical developer commits or opens PRs under. */
export interface DeveloperAliases {
  canonicalDeveloperId: string;
  logins: string[];
  emails: string[];
}

/**
 * Bulk alias→person lookup for reads that bucket EVERY commit in a window —
 * the counterpart of `aliasesFor`, which widens one developer's query.
 * Attribution order mirrors collection reality: a commit's `authorLogin` is
 * authoritative when present; otherwise its email (lowercased) is the match.
 */
export interface AttributionIndex {
  /** sourceLogin → canonicalDeveloperId */
  byLogin: Map<string, string>;
  /** lowercased email → canonicalDeveloperId */
  byEmail: Map<string, string>;
  /** canonicalDeveloperId → what the UI should call this person */
  displayNames: Map<string, string>;
}

/** How much of a window's commit volume can be attributed to a person at all. */
export interface AttributionCoverage {
  commitsInScope: number;
  commitsAttributed: number;
  /** Commits whose author matches no known developer — counted, never hidden. */
  commitsUnattributed: number;
  coveragePct: number | null;
  /** Distinct git identities behind `commitsUnattributed`. */
  unattributedIdentities: number;
}

/**
 * BC-5 developer identity resolution (PRODUCT-ARCHITECTURE.md BC-5,
 * DATA-MODEL.md §3).
 *
 * A git identity is not a GitHub account. GitHub sets `commit.author.login`
 * only when the commit's email is verified on some account; otherwise the
 * commit arrives with a name and an email and no login, while the same
 * person's pull requests always carry `user.login`. Read models that query
 * commits by raw login therefore return nothing for those people and render
 * "0 commits" as though it were a fact about them.
 *
 * This service builds the mapping that makes those two halves one person, and
 * it is deliberately conservative: it merges only on evidence, records what
 * that evidence was, and queues ambiguity as an orphan instead of guessing
 * (CLAUDE.md — "surface orphans/ambiguities rather than guessing silently").
 *
 * Pure in-database work over facts already collected — no external API calls,
 * so the collector boundary is untouched, and it is safe to re-run.
 */
@Injectable()
export class DeveloperIdentityService {
  private readonly logger = new Logger(DeveloperIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rebuilds the tenant's identity map from collected commits and PRs.
   *
   * Idempotent: re-running re-derives every row from the same facts, so an
   * identity that later gains a login (the person verified their email, and a
   * newer commit carried it) is upgraded on the next pass rather than being
   * stuck at whatever the first pass concluded.
   */
  async resolveTenant(tenantId: string): Promise<IdentityResolveResult> {
    const [commitIdentities, prLogins] = await Promise.all([
      this.prisma.commit.groupBy({
        by: ['authorLogin', 'authorEmail', 'authorName'],
        where: { tenantId },
      }),
      this.prisma.pullRequest.groupBy({
        by: ['authorLogin'],
        where: { tenantId, authorLogin: { not: null } },
      }),
    ]);

    const knownLogins = new Set<string>();
    for (const row of commitIdentities) {
      if (row.authorLogin) {
        knownLogins.add(row.authorLogin);
      }
    }
    for (const row of prLogins) {
      if (row.authorLogin) {
        knownLogins.add(row.authorLogin);
      }
    }

    const loginByEmail = buildEmailIndex(commitIdentities);
    const loginsByNameKey = indexLoginsByNormalizedKey(knownLogins);

    const observed: { identity: SourceIdentity; key: string }[] = [];
    for (const row of commitIdentities) {
      const identity: SourceIdentity = {
        login: row.authorLogin,
        email: row.authorEmail,
        name: row.authorName,
      };
      const key = sourceKeyOf(identity);
      if (key) {
        observed.push({ identity, key });
      }
    }
    for (const row of prLogins) {
      if (row.authorLogin) {
        observed.push({
          identity: { login: row.authorLogin },
          key: `login:${row.authorLogin}`,
        });
      }
    }

    const result: IdentityResolveResult = {
      observed: 0,
      resolved: 0,
      recovered: 0,
      unresolved: 0,
      ambiguous: 0,
    };
    const seen = new Set<string>();
    // Names already claimed by an unresolved identity, so a second unrelated
    // person with the same git name can't quietly inherit the first one's id.
    const claimedNames = new Set<string>();

    for (const { identity, key } of observed) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.observed++;

      const match = resolveIdentity(identity, loginByEmail, loginsByNameKey);
      if (!match) {
        // Several colleagues normalize to the same key. Recorded for review;
        // their commits stay unattributed rather than credited to a coin flip.
        result.ambiguous++;
        await this.upsertOrphan(tenantId, key, 'ambiguous_identity');
        continue;
      }

      const resolvedMatch =
        match.method === 'unresolved'
          ? this.withReadableId(match, identity, claimedNames)
          : match;

      if (resolvedMatch.method === 'github_login') {
        result.resolved++;
      } else if (resolvedMatch.method === 'unresolved') {
        result.unresolved++;
        await this.upsertOrphan(tenantId, key, 'unresolved_identity');
      } else {
        result.recovered++;
      }

      await this.upsertIdentity(tenantId, key, identity, resolvedMatch);
    }

    this.logger.log(
      `Identity resolution (tenant ${tenantId}): ${result.observed} identities — ${result.resolved} from source, ${result.recovered} recovered, ${result.unresolved} unresolved, ${result.ambiguous} ambiguous.`,
    );
    return result;
  }

  /**
   * Every login and email that rolls up to one canonical developer.
   *
   * Read models widen their queries with this instead of filtering on a single
   * login — that is what makes a commit GitHub could not attribute reachable
   * from the person's page.
   */
  async aliasesFor(
    tenantId: string,
    canonicalDeveloperId: string,
  ): Promise<DeveloperAliases> {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId, canonicalDeveloperId },
      select: { sourceLogin: true, email: true },
    });

    const logins = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      if (row.sourceLogin) {
        logins.add(row.sourceLogin);
      }
      if (row.email) {
        emails.add(row.email.toLowerCase());
      }
    }
    // Never return an empty alias set for a real request: before the first
    // resolution pass the table is empty, and an empty set would silently widen
    // "this developer's commits" into "every commit". Falling back to the
    // requested id reproduces exactly today's behaviour instead.
    if (logins.size === 0 && emails.size === 0) {
      logins.add(canonicalDeveloperId);
    }
    return {
      canonicalDeveloperId,
      logins: [...logins],
      emails: [...emails],
    };
  }

  /**
   * Every known alias mapped to its canonical developer, in one read — for
   * reads that bucket a whole window of commits by person (e.g. the daily
   * activity grid), where calling `aliasesFor` per developer would be N+1
   * and filtering per person would re-scan the window N times.
   */
  async attributionIndex(tenantId: string): Promise<AttributionIndex> {
    const rows = await this.prisma.developerIdentity.findMany({
      where: { tenantId },
      select: {
        canonicalDeveloperId: true,
        sourceLogin: true,
        email: true,
        name: true,
      },
    });

    const byLogin = new Map<string, string>();
    const byEmail = new Map<string, string>();
    const displayNames = new Map<string, string>();
    for (const row of rows) {
      if (row.sourceLogin) {
        byLogin.set(row.sourceLogin, row.canonicalDeveloperId);
      }
      if (row.email) {
        byEmail.set(row.email.toLowerCase(), row.canonicalDeveloperId);
      }
      // Same preference order as the picker (`listDevelopers`): the login is
      // the name people know from GitHub; the recorded git name is the
      // fallback for the unresolved.
      const current = displayNames.get(row.canonicalDeveloperId);
      const candidate =
        row.sourceLogin ?? current ?? row.name ?? row.canonicalDeveloperId;
      displayNames.set(row.canonicalDeveloperId, candidate);
    }
    return { byLogin, byEmail, displayNames };
  }

  /**
   * Canonical developers for the picker: everyone with collected work,
   * including the people no GitHub account could be found for — they are the
   * ones the old login-only catalog made invisible.
   */
  async listDevelopers(
    tenantId: string,
    search?: string,
  ): Promise<DeveloperCatalogEntry[]> {
    const [rows, lastCommitByKey] = await Promise.all([
      this.prisma.developerIdentity.findMany({
        where: { tenantId },
        select: {
          canonicalDeveloperId: true,
          sourceKey: true,
          sourceLogin: true,
          name: true,
          method: true,
        },
      }),
      this.lastCommitBySourceKey(tenantId),
    ]);

    const byCanonical = new Map<
      string,
      { displayName: string; attributed: boolean; lastActiveAt: Date | null }
    >();
    for (const row of rows) {
      const attributed = row.method !== 'unresolved';
      const existing = byCanonical.get(row.canonicalDeveloperId);
      const seen = lastCommitByKey.get(row.sourceKey) ?? null;
      byCanonical.set(row.canonicalDeveloperId, {
        displayName:
          existing?.displayName ??
          row.sourceLogin ??
          row.name ??
          row.canonicalDeveloperId,
        attributed: existing ? existing.attributed || attributed : attributed,
        // Newest across all of this person's identities — the whole point of
        // resolving them is that their activity is one timeline, not several.
        lastActiveAt: newest(existing?.lastActiveAt ?? null, seen),
      });
    }

    const needle = search?.toLowerCase();
    return (
      [...byCanonical.entries()]
        .map(([canonicalDeveloperId, v]) => ({
          canonicalDeveloperId,
          displayName: v.displayName,
          attributed: v.attributed,
          lastActiveAt: v.lastActiveAt ? v.lastActiveAt.toISOString() : null,
        }))
        .filter(
          (d) =>
            !needle ||
            d.canonicalDeveloperId.toLowerCase().includes(needle) ||
            d.displayName.toLowerCase().includes(needle),
        )
        // Alphabetical: this is a searchable picker, and someone looking for a
        // name scans for it. Recency rides along as a field so the board can
        // OPEN on someone who has actually committed lately without reordering
        // the list out from under the reader.
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    );
  }

  /** Newest commit per source identity, keyed the same way as `sourceKey`. */
  private async lastCommitBySourceKey(
    tenantId: string,
  ): Promise<Map<string, Date>> {
    const rows = await this.prisma.commit.groupBy({
      by: ['authorLogin', 'authorEmail'],
      where: { tenantId },
      _max: { committedAt: true },
    });
    const out = new Map<string, Date>();
    for (const row of rows) {
      const at = row._max.committedAt;
      if (!at) {
        continue;
      }
      const key = row.authorLogin
        ? `login:${row.authorLogin}`
        : row.authorEmail
          ? `email:${row.authorEmail.toLowerCase()}`
          : null;
      if (!key) {
        continue;
      }
      const existing = out.get(key);
      if (!existing || at > existing) {
        out.set(key, at);
      }
    }
    return out;
  }

  /**
   * Share of a window's commits that can be attributed to any developer.
   *
   * Surfaced on every board that counts commits, because "0 commits" and
   * "commits we cannot attribute" look identical on screen and mean opposite
   * things (CLAUDE.md — always surface linkage coverage).
   */
  async attributionCoverage(
    tenantId: string,
    from: Date,
    to: Date,
    repos?: string[],
  ): Promise<AttributionCoverage> {
    const recoveredEmails = await this.prisma.developerIdentity.findMany({
      where: {
        tenantId,
        method: { in: ['email_exact', 'name_normalized'] },
        email: { not: null },
      },
      select: { email: true },
    });
    const attributableEmails = recoveredEmails
      .map((r) => r.email)
      .filter((e): e is string => Boolean(e));

    const window = {
      tenantId,
      ...(repos && repos.length > 0 ? { repoFullName: { in: repos } } : {}),
      committedAt: { gte: from, lte: to },
    };

    const [commitsInScope, unattributed, identities] = await Promise.all([
      this.prisma.commit.count({ where: window }),
      this.prisma.commit.count({
        where: {
          ...window,
          authorLogin: null,
          ...(attributableEmails.length > 0
            ? { NOT: { authorEmail: { in: attributableEmails } } }
            : {}),
        },
      }),
      this.prisma.commit.groupBy({
        by: ['authorEmail'],
        where: {
          ...window,
          authorLogin: null,
          ...(attributableEmails.length > 0
            ? { NOT: { authorEmail: { in: attributableEmails } } }
            : {}),
        },
      }),
    ]);

    return {
      commitsInScope,
      commitsAttributed: commitsInScope - unattributed,
      commitsUnattributed: unattributed,
      coveragePct:
        commitsInScope > 0
          ? Number(
              (
                ((commitsInScope - unattributed) / commitsInScope) *
                100
              ).toFixed(1),
            )
          : null,
      unattributedIdentities: identities.length,
    };
  }

  /**
   * Gives an unresolved identity a human-readable canonical id (its git name)
   * when that name is free, so the picker shows "saravanakumar_athma" rather
   * than "email:357486@example.org".
   *
   * Safe by construction: a name that matched any known login would have been
   * resolved a rung earlier, so it cannot collide with a real developer here.
   * The `claimedNames` guard covers the remaining case — two different people
   * committing under the same git name from different emails — by leaving the
   * second on its email key rather than merging them.
   */
  private withReadableId(
    match: IdentityMatch,
    identity: SourceIdentity,
    claimedNames: Set<string>,
  ): IdentityMatch {
    const nameKey = normalizeIdentityKey(identity.name);
    if (!identity.name || !nameKey || claimedNames.has(nameKey)) {
      return match;
    }
    claimedNames.add(nameKey);
    return { ...match, canonicalDeveloperId: identity.name };
  }

  private async upsertIdentity(
    tenantId: string,
    sourceKey: string,
    identity: SourceIdentity,
    match: IdentityMatch,
  ): Promise<void> {
    const data = {
      sourceLogin: identity.login ?? null,
      email:
        identity.email && !isMachineEmail(identity.email)
          ? identity.email
          : null,
      name: identity.name ?? null,
      canonicalDeveloperId: match.canonicalDeveloperId,
      confidence: match.confidence,
      method: match.method,
      evidence: match.evidence,
    };
    await this.prisma.developerIdentity.upsert({
      where: {
        tenantId_sourceSystem_sourceKey: {
          tenantId,
          sourceSystem: SOURCE_SYSTEM,
          sourceKey,
        },
      },
      create: {
        id: newId(),
        tenantId,
        sourceSystem: SOURCE_SYSTEM,
        sourceKey,
        ...data,
      },
      update: data,
    });
  }

  private async upsertOrphan(
    tenantId: string,
    nodeRef: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.prisma.orphan.findFirst({
      where: {
        tenantId,
        nodeType: 'developer_identity',
        nodeRef,
        resolvedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      return;
    }
    await this.prisma.orphan.create({
      data: {
        id: newId(),
        tenantId,
        nodeType: 'developer_identity',
        nodeRef,
        reason,
      },
    });
  }
}

function newest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * email → login, from commits GitHub DID attribute. Only unambiguous mappings
 * survive: a shared or machine address seen under several logins identifies no
 * one, and keeping it would merge those people together.
 */
function buildEmailIndex(
  rows: {
    authorLogin: string | null;
    authorEmail: string | null;
  }[],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      !row.authorLogin ||
      !row.authorEmail ||
      isMachineEmail(row.authorEmail)
    ) {
      continue;
    }
    const email = row.authorEmail.toLowerCase();
    const set = candidates.get(email) ?? new Set<string>();
    set.add(row.authorLogin);
    candidates.set(email, set);
  }
  const index = new Map<string, string>();
  for (const [email, logins] of candidates) {
    if (logins.size === 1) {
      index.set(email, [...logins][0]);
    }
  }
  return index;
}
