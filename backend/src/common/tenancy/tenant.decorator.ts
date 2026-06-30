import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Convenience param decorator to read the resolved tenant id off the request.
 * Prefer TenantContextService in services; this is for controller signatures.
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.tenantId;
  },
);
