/**
 * RBAC roles. Tenant-local; there is no super-role that crosses tenants in the
 * application plane (docs/security/AUTH-AND-RBAC.md §3).
 */
export enum Role {
  DEVELOPER = 'developer',
  TEAM_LEAD = 'team_lead',
  SCRUM_MASTER = 'scrum_master',
  ENG_MANAGER = 'eng_manager',
  PRODUCT_OWNER = 'product_owner',
  CTO = 'cto',
  EXEC = 'exec',
  ADMIN = 'admin',
}
