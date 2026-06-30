import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'sprintiq:isPublic';

/**
 * Marks a route as not requiring application-plane JWT auth.
 * Used for /health and the collector webhook receivers (which authenticate via
 * per-provider signature verification, not user JWT).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
