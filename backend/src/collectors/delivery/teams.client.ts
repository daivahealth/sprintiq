import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../common/secrets/secrets.service';

/** Attempts per send, including the first. */
const MAX_ATTEMPTS = 3;
/** Base backoff; attempt N waits BASE * 2^(N-1). */
const BACKOFF_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * Outbound delivery to a Microsoft Teams channel via a Power Automate
 * Workflows URL.
 *
 * In the Collector context because that is where this codebase puts clients
 * that talk to the outside world — `NotificationsService` decides *whether and
 * whom*, this decides *how*. The URL never leaves this file.
 *
 * Targets Power Automate ("Post card in a chat or channel") rather than the
 * retired O365 connector webhook. Two consequences are load-bearing: success
 * is 202 with an empty body, not 200/"1"; and the URL carries its credential
 * in the query string, so it is never logged at any level.
 */
@Injectable()
export class TeamsClient {
  private readonly logger = new Logger(TeamsClient.name);

  constructor(private readonly secrets: SecretsService) {}

  async postAdaptiveCard(
    tenantId: string,
    ref: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const url = await this.secrets.resolve(tenantId, ref);
    if (!url) {
      throw new Error(
        `No Teams webhook resolved for secret ref "${ref}" — set it in admin/configuration or as an environment variable.`,
      );
    }

    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
          // A hung POST must not wedge the cron that called it.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // `fetch` REJECTS rather than resolving with a bad status for a
        // malformed URL, a DNS failure, or a network reset — no response
        // object ever exists, so the no-logging discipline below (which only
        // handles the status-code path) never runs. The rejection's own
        // message can embed the whole URL: Node throws exactly
        // `TypeError: Failed to parse URL from <the whole string>` for a
        // malformed URL, and this ref is a Power Automate Workflows URL,
        // which carries its credential in the query string (`&sig=...`) — a
        // copy-paste line wrap is enough to produce this. Nothing from
        // `error` (its message, its stack) may reach a log or a stored
        // column; only the secret ref name and the failure's class survive
        // into what this method raises.
        const failureClass =
          error instanceof Error ? error.constructor.name : typeof error;
        this.logger.error(
          `Teams delivery for ref "${ref}" failed before a response was received (${failureClass}).`,
        );
        throw new Error(
          `Teams delivery failed for ref "${ref}": request could not be sent (${failureClass}).`,
        );
      }

      // Any 2xx. Power Automate returns 202 Accepted with an empty body.
      if (response.ok) {
        return;
      }

      lastStatus = response.status;
      lastBody = (await response.text()).slice(0, 500);

      if (!RETRYABLE(response.status)) {
        // A 403 means the flow was deleted or the URL rotated. Retrying only
        // delays the diagnosis.
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        this.logger.warn(
          `Teams delivery attempt ${attempt} returned ${response.status}; retrying.`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, BACKOFF_BASE_MS * 2 ** (attempt - 1)),
        );
      }
    }

    // Status and response body only — never the URL, which is a credential.
    this.logger.error(
      `Teams delivery failed with ${lastStatus}: ${lastBody || '(empty body)'}`,
    );
    throw new Error(`Teams delivery failed with status ${lastStatus}`);
  }
}
