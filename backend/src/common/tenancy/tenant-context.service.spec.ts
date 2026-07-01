import { ForbiddenException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let svc: TenantContextService;

  beforeEach(() => {
    svc = new TenantContextService();
  });

  it('exposes the tenant set within a run() scope', () => {
    svc.run(() => {
      svc.setTenant('tenant-a');
      expect(svc.tenantId).toBe('tenant-a');
      expect(svc.requireTenantId()).toBe('tenant-a');
    });
  });

  it('binds a tenant up-front with runWithTenant()', () => {
    svc.runWithTenant('tenant-b', () => {
      expect(svc.requireTenantId()).toBe('tenant-b');
    });
  });

  it('does not leak tenant outside the scope', () => {
    svc.runWithTenant('tenant-c', () => undefined);
    expect(svc.tenantId).toBeUndefined();
  });

  it('throws when tenant context is required but absent', () => {
    expect(() => svc.requireTenantId()).toThrow(ForbiddenException);
  });

  it('isolates concurrent scopes (no cross-tenant bleed)', () => {
    const seen: string[] = [];
    svc.runWithTenant('t1', () => seen.push(svc.requireTenantId()));
    svc.runWithTenant('t2', () => seen.push(svc.requireTenantId()));
    expect(seen).toEqual(['t1', 't2']);
  });
});
