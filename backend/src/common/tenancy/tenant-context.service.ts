import { ForbiddenException, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthUser {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
}

interface TenantStore {
  tenantId?: string;
  user?: AuthUser;
}

/**
 * Request/job-scoped tenant context backed by AsyncLocalStorage.
 *
 * The store is established once per request (TenantMiddleware) or per job
 * (collectors/workers via runWithTenant) and populated with the resolved
 * tenant once authentication / connection resolution completes. Repositories
 * read `tenantId` from here so no query can forget to scope by tenant.
 *
 * This is the single enforcement point for "no cross-tenant read, ever"
 * (ADR-0004, docs/security/AUTH-AND-RBAC.md §4).
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** Establish an empty store for the lifetime of `callback` (HTTP requests). */
  run<T>(callback: () => T): T {
    return this.als.run({}, callback);
  }

  /** Establish a store already bound to a tenant (collectors / scheduled jobs). */
  runWithTenant<T>(tenantId: string, callback: () => T): T {
    return this.als.run({ tenantId }, callback);
  }

  private get store(): TenantStore | undefined {
    return this.als.getStore();
  }

  setTenant(tenantId: string): void {
    const store = this.store;
    if (store) {
      store.tenantId = tenantId;
    }
  }

  setUser(user: AuthUser): void {
    const store = this.store;
    if (store) {
      store.user = user;
      store.tenantId = user.tenantId;
    }
  }

  get tenantId(): string | undefined {
    return this.store?.tenantId;
  }

  get user(): AuthUser | undefined {
    return this.store?.user;
  }

  /** Use in any tenant-scoped query path; throws if context is missing. */
  requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ForbiddenException(
        'Tenant context is not established for this operation.',
      );
    }
    return tenantId;
  }
}
