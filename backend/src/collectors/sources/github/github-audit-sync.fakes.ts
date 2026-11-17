/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory stand-ins for the Prisma delegates and the ingestion pipeline the
 * audit sync touches. Test-only. `calls` records every where/data so a test
 * can assert tenant scoping on EVERY access, not just the ones it thought of.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    // Top-level `OR`: an array of sub-wheres, satisfied if any one matches —
    // just enough to let the audit-range query express "pending, OR shadowed
    // within the replay window" (review round 1, issue 4).
    if (k === 'OR' && Array.isArray(v)) {
      return v.some((cond) => matches(row, cond as Row));
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      // Every operator present must hold, as in Prisma — a `{ gte, lte }`
      // window is a window, not just its lower bound.
      const ops = ['in', 'gte', 'gt', 'lte', 'lt', 'startsWith'].filter(
        (op) => op in v,
      );
      if (ops.length > 0) {
        const x = row[k];
        if ('in' in v && !(v.in as unknown[]).includes(x)) return false;
        if ('gte' in v && !(x != null && x >= v.gte)) return false;
        if ('gt' in v && !(x != null && x > v.gt)) return false;
        if ('lte' in v && !(x != null && x <= v.lte)) return false;
        if ('lt' in v && !(x != null && x < v.lt)) return false;
        if ('startsWith' in v) {
          const s = String(x ?? '');
          const p = String(v.startsWith);
          const hit =
            v.mode === 'insensitive'
              ? s.toLowerCase().startsWith(p.toLowerCase())
              : s.startsWith(p);
          if (!hit) return false;
        }
        return true;
      }
    }
    // Prisma's `{ col: null }` also matches a column the fake never set.
    if (v === null) return row[k] == null;
    return row[k] === v;
  });
}

function table(calls: Row[], rows: Row[], uniqueOf: (where: Row) => Row) {
  return {
    rows,
    findUnique: jest.fn(async ({ where }: Row) => {
      calls.push({ where });
      return rows.find((r) => matches(r, uniqueOf(where))) ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => {
      calls.push({ where });
      let out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt === 'asc')
        out = [...out].sort((a, b) => a.createdAt - b.createdAt);
      return take ? out.slice(0, take) : out;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => {
      calls.push({ where });
      let out = rows.filter((r) => matches(r, where));
      // Only a single date field is ever ordered on here (e.g.
      // `{ startedAt: 'desc' }`), as Prisma's `orderBy` would be for this use.
      const entry = orderBy && Object.entries(orderBy)[0];
      if (entry) {
        const [field, dir] = entry as [string, 'asc' | 'desc'];
        out = [...out].sort((a, b) => {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          return dir === 'desc' ? bv - av : av - bv;
        });
      }
      return out[0] ?? null;
    }),
    count: jest.fn(async ({ where }: Row = {}) => {
      calls.push({ where });
      return rows.filter((r) => matches(r, where)).length;
    }),
    create: jest.fn(async ({ data }: Row) => {
      calls.push({ data });
      const row = { createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    createMany: jest.fn(async ({ data }: Row) => {
      for (const d of data) calls.push({ data: d });
      rows.push(...data.map((d: Row) => ({ createdAt: new Date(), ...d })));
      return { count: data.length };
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      calls.push({ where, data });
      const row = rows.find((r) => matches(r, uniqueOf(where)));
      if (!row) throw new Error('not found');
      for (const [k, v] of Object.entries(data)) {
        row[k] =
          v && typeof v === 'object' && 'increment' in (v as Row)
            ? (row[k] ?? 0) + (v as Row).increment
            : v;
      }
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      calls.push({ where, data });
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: Row) => {
      calls.push({ where, create, update });
      const row = rows.find((r) => matches(r, uniqueOf(where)));
      if (row) return Object.assign(row, update);
      const created = { createdAt: new Date(), ...create };
      rows.push(created);
      return created;
    }),
    deleteMany: jest.fn(async ({ where }: Row) => {
      calls.push({ where });
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
  };
}

export function fakePrisma() {
  const calls: Row[] = [];
  const rawKeys = new Set<string>(); // `${tenantId}|${idempotencyKey}`
  const prisma = {
    calls,
    rawKeys,
    tenantConfiguration: table(calls, [], (w) => w.tenantId_namespace_key ?? w),
    connection: table(calls, [], (w) => w),
    githubAuditCheckpoint: table(
      calls,
      [],
      (w) => w.tenantId_organization ?? w,
    ),
    githubAuditRun: table(calls, [], (w) => w),
    githubPushRange: table(calls, [], (w) => w),
    githubRefTip: table(calls, [], (w) => w.tenantId_repoFullName_ref ?? w),
    rawEvent: {
      findUnique: jest.fn(async ({ where }: Row) => {
        const { tenantId, idempotencyKey } = where.tenantId_idempotencyKey;
        calls.push({ where: { tenantId } });
        return rawKeys.has(`${tenantId}|${idempotencyKey}`)
          ? { id: 'raw' }
          : null;
      }),
    },
  };
  // `$transaction` is added after the fact (rather than inline) so its callback can
  // close over `prisma` without TS seeing a self-referential initializer (TS7022).
  return {
    ...prisma,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
}

export function fakeIngestion(prisma: ReturnType<typeof fakePrisma>) {
  return {
    ingest: jest.fn(async (tenantId: string, envelope: Row) => {
      const key = `${tenantId}|${envelope.idempotencyKey}`;
      if (prisma.rawKeys.has(key))
        return { status: 'duplicate', eventId: 'raw' };
      prisma.rawKeys.add(key);
      return { status: 'accepted', eventId: 'new' };
    }),
  };
}

export function seedTenant(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  repos: string[],
  opts: { auditRef?: string; organization?: string } = {
    auditRef: 'GITHUB_AUDIT_TOKEN',
  },
) {
  // The org is the repos' owner unless named, so per-org repo filtering keeps
  // every repo a test registers (ADR-0013).
  const organization = opts.organization ?? repos[0]?.split('/')[0] ?? 'acme';
  prisma.tenantConfiguration.rows.push({
    id: `${tenantId}-cfg-default`,
    tenantId,
    namespace: 'github',
    key: 'default',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    values: { organization },
    secretRefs: {
      tokenRef: 'GITHUB_TOKEN',
      ...(opts.auditRef ? { auditLogTokenRef: opts.auditRef } : {}),
    },
  });
  repos.forEach((repo, i) =>
    prisma.connection.rows.push({
      id: `${tenantId}-conn-${i}`,
      tenantId,
      sourceSystem: 'github',
      status: 'active',
      name: repo,
      secretRef: 'GITHUB_TOKEN',
      config: { repoFullName: repo },
    }),
  );
}

/** A second (non-default) organisation row and its repo connections. */
export function seedOrg(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  organization: string,
  repos: string[],
  opts: {
    tokenRef?: string;
    auditRef?: string;
    status?: string;
    values?: Record<string, unknown>;
  } = {},
) {
  prisma.tenantConfiguration.rows.push({
    id: `${tenantId}-cfg-${organization.toLowerCase()}`,
    tenantId,
    namespace: 'github',
    key: organization.toLowerCase(),
    status: opts.status ?? 'active',
    createdAt: new Date('2026-11-16T00:00:00Z'),
    values: { organization, ...(opts.values ?? {}) },
    secretRefs: {
      ...(opts.tokenRef ? { tokenRef: opts.tokenRef } : {}),
      ...(opts.auditRef ? { auditLogTokenRef: opts.auditRef } : {}),
    },
  });
  repos.forEach((repo, i) =>
    prisma.connection.rows.push({
      id: `${tenantId}-${organization.toLowerCase()}-conn-${i}`,
      tenantId,
      sourceSystem: 'github',
      status: 'active',
      name: repo,
      secretRef: opts.tokenRef ?? 'GITHUB_TOKEN',
      config: { repoFullName: repo },
    }),
  );
}
