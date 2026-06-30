import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Establishes an (initially empty) tenant context for every request. The
 * concrete tenant is populated later by the JWT strategy (application plane)
 * once the caller is authenticated — the AsyncLocalStorage store created here
 * propagates through guards and handlers, so a value set downstream is visible
 * to all subsequent async work in the request.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(_req: Request, _res: Response, next: NextFunction): void {
    this.tenantContext.run(() => next());
  }
}
