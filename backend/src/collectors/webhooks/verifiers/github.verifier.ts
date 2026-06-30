import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { SignatureVerifier } from '../signature-verifier';

/**
 * GitHub / GitHub Actions: HMAC-SHA256 of the raw body, compared constant-time
 * against the `X-Hub-Signature-256` header (`sha256=<hex>`).
 */
export class GithubSignatureVerifier implements SignatureVerifier {
  readonly source = 'github';

  verify(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
    secret: string,
  ): boolean {
    const provided = headers['x-hub-signature-256'];
    if (typeof provided !== 'string' || !secret) {
      return false;
    }
    const expected =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
