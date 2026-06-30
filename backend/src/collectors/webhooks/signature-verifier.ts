import { IncomingHttpHeaders } from 'node:http';

/**
 * Per-provider webhook signature verification (BC-1). Each source has its own
 * scheme; unverified payloads are treated as hostile
 * (docs/api/README.md §2.2, docs/security/AUTH-AND-RBAC.md §7).
 */
export interface SignatureVerifier {
  readonly source: string;
  verify(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
    secret: string,
  ): boolean;
}
