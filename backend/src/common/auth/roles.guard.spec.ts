import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from './role.enum';
import { RolesGuard } from './roles.guard';

function contextWithUser(roles: string[]): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  function guardReturning(required?: Role[]) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('allows when no roles are required', () => {
    expect(guardReturning(undefined).canActivate(contextWithUser([]))).toBe(
      true,
    );
  });

  it('allows when the user holds a required role', () => {
    const guard = guardReturning([Role.ADMIN]);
    expect(guard.canActivate(contextWithUser(['admin']))).toBe(true);
  });

  it('denies when the user lacks every required role', () => {
    const guard = guardReturning([Role.ADMIN]);
    expect(() => guard.canActivate(contextWithUser(['developer']))).toThrow(
      ForbiddenException,
    );
  });
});
