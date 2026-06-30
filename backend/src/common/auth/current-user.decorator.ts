import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../tenancy/tenant-context.service';

/** Injects the authenticated user (set by JwtStrategy) into a controller param. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
