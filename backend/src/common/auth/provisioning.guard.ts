import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guards platform-bootstrap routes (tenant provisioning) that run before any
 * tenant/user exists, so JWT can't apply. Authenticates via a static platform
 * token (`x-provisioning-token`). Routes using it must also be @Public() so the
 * global JWT guard skips them.
 */
@Injectable()
export class ProvisioningGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided = req.headers['x-provisioning-token'];
    const expected = this.config.get<string>('auth.provisioningToken');
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('Invalid or missing provisioning token.');
    }
    return true;
  }
}
