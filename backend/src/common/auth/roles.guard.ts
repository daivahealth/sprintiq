import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from './role.enum';
import { ROLES_KEY } from './roles.decorator';

/**
 * Enforces @Roles(...) on top of authentication. Default-allow only when a route
 * declares no roles; otherwise the user must hold at least one required role.
 * (Scope checks — does this role have access to *this* team/repo — are enforced
 * in the owning service, not here.)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    const roles: string[] = user?.roles ?? [];
    const allowed = requiredRoles.some((role) => roles.includes(role));
    if (!allowed) {
      throw new ForbiddenException('Insufficient role for this operation.');
    }
    return true;
  }
}
