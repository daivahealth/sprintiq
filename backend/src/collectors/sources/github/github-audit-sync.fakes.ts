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
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('gte' in v) return row[k] >= v.gte;
      if ('lte' in v) return row[k] <= v.lte;
      if ('lt' in v) return row[k] != null && row[k] < v.lt;
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
    githubAuditCheckpoint: table(calls, [], (w) => w),
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
  opts: { auditRef?: string } = { auditRef: 'GITHUB_AUDIT_TOKEN' },
) {
  prisma.tenantConfiguration.rows.push({
    tenantId,
    namespace: 'github',
    key: 'default',
    status: 'active',
    values: { organization: 'acme' },
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
