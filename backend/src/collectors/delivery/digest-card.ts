/**
 * Who to name on the card.
 *
 * Declared here rather than imported from `metrics/` on purpose: the Collector
 * context must not depend on a domain context, or the boundary that keeps
 * delivery extractable stops meaning anything. Structurally compatible with
 * the detection service's `NamedDeveloper`, so callers pass those rows
 * directly with no mapping.
 */
export interface DigestRecipient {
  developer: string;
  displayName: string;
}

export interface DigestCardInput {
  /** The IST calendar day reported on (YYYY-MM-DD). */
  reportedDay: string;
  /** Already alphabetical by display name — this function does not reorder. */
  flagged: DigestRecipient[];
  /** Roster size after unresolved and suppressed entries are removed. */
  evaluatedCount: number;
  /**
   * Oldest `lastSyncAt` across the tenant's active connections — when
   * collection last REACHED a source, not the completeness watermark.
   *
   * Deliberately not `DataFreshness.collectedThroughAt`/`ConnectionsService`'s
   * completeness watermark: `collectedThroughAt` is null the instant any
   * active connection is mid-backfill and has no watermark yet — measured
   * permanently true on the real deployment (13 active connections
   * mid-PR-backfill), which made the card read "Data collected through
   * unknown." on every single send, forever. `no-commit-detection.service.ts`
   * gate 1 was rewritten off the same reasoning (see its docblock) — this is
   * the card catching up to that same fix. Null only when NO active
   * connection has ever reached its source, which gate 1's `neverSynced`
   * check makes rare: a tenant with any never-synced active connection is
   * withheld before a card naming anyone is even considered.
   */
  lastSyncAt: Date | null;
  /** When set, the reason names were withheld; names are not rendered. */
  withheldDetail?: string;
  /**
   * Commits on the reported day that could not be attributed to any tracked
   * developer — the counter-evidence to a name on this list. Disclosed, never
   * gated on: a person named above may be the author of one of these commits,
   * missed only because GitHub omitted a verified-email login and the email
   * was not in the attribution index. Rendered only when positive — see
   * `buildDigestCard`.
   */
  unattributedCommits: number;
}

/**
 * The rule the list was computed from, displayed in every card.
 *
 * Required by the ethics-first exception this feature ships under (CLAUDE.md;
 * spec §3): where an attributed ranking or list ships, the rule it is computed
 * from ships with it and is displayed. It names what was counted AND states
 * that reviewing was not, because the narrow definition is the honest
 * explanation for most objections to being on this list.
 */
const RULE_TEXT =
  'Flagged = no commit and no pull request opened on this day (IST) — the same reads as the Activity Overview board. ' +
  'Code review, merging work opened earlier, and Jira activity are **not** counted, so a day spent reviewing shows here as inactive. ' +
  'Excludes bots, admin-excluded accounts, and developers on recorded leave.';

/**
 * Neutralise the markdown subset an Adaptive Card `TextBlock` renders.
 *
 * Display names arrive from ingested GitHub and Jira data, which CLAUDE.md
 * classifies as untrusted. An unescaped crafted name could post a live link
 * into a channel every morning. This escapes the characters that can
 * actually form links, images, code spans or emphasis in Adaptive Card
 * markdown: backslash, backtick, asterisk, underscore, square brackets,
 * parentheses, and angle brackets — `<https://evil.example>` is a live
 * CommonMark autolink on its own, with no need for the brackets/parens this
 * function already escapes. Characters like # + - ! | carry meaning only at
 * the start of a line in block contexts, and escaping them would mangle
 * ordinary names (`Hari-Krishnan-P-C` is on the tracked roster) — `<`/`>` are
 * the one pair from that set that also does damage mid-string, which is why
 * they are escaped here and the rest are not.
 */
export function escapeCardText(value: string): string {
  return value.replace(/[\\`*_[\]()<>]/g, (ch) => `\\${ch}`);
}

function block(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'TextBlock', wrap: true, text, ...extra };
}

/**
 * The daily digest as a Teams message payload.
 *
 * Wrapped as `{ type: 'message', attachments: [...] }` because that is what
 * the Power Automate "Post card in a chat or channel" action expects; a bare
 * adaptive card is accepted by the HTTP trigger and then posts nothing.
 */
export function buildDigestCard(
  input: DigestCardInput,
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    block(`Daily activity check — ${input.reportedDay}`, {
      size: 'Medium',
      weight: 'Bolder',
    }),
  ];

  if (input.withheldDetail) {
    body.push(block(input.withheldDetail, { weight: 'Bolder' }));
  } else if (input.flagged.length === 0) {
    body.push(
      block(
        `All ${input.evaluatedCount} tracked developers had activity on ${input.reportedDay}.`,
      ),
    );
  } else {
    body.push(
      block(
        `${input.flagged.length} of ${input.evaluatedCount} tracked developers had no activity:`,
      ),
    );
    // Alphabetical order is the caller's guarantee; rendering must not sort.
    body.push(
      block(
        input.flagged
          .map((person) => `• ${escapeCardText(person.displayName)}`)
          .join('\n'),
      ),
    );
    body.push(
      block(
        'This is a prompt to check in, not a conclusion about anyone — ask before assuming.',
        { isSubtle: true },
      ),
    );
  }

  body.push(block(RULE_TEXT, { isSubtle: true, size: 'Small' }));
  // "Sources last reached", not "data collected through": this card cannot
  // use the completeness watermark (`DataFreshness.collectedThroughAt`) — see
  // the docblock on `DigestCardInput.lastSyncAt` for why it is permanently
  // null on this deployment. `lastSyncAt` is liveness, not coverage, but it
  // is the honest answer to what a person named above actually needs: was
  // anything checked recently, or has this pipeline gone quiet. The null
  // case is stated plainly rather than as "unknown" — it means no active
  // connection has EVER reached its source, which gate 1's `neverSynced`
  // check already makes rare on a card that names anyone.
  body.push(
    block(
      input.lastSyncAt
        ? `Sources last reached ${input.lastSyncAt.toISOString()}.`
        : 'Sources have never been reached — no connection has completed a sync yet.',
      { isSubtle: true, size: 'Small' },
    ),
  );
  // Rendered only when positive — a zero here is noise on every ordinary
  // morning, and would train readers to stop reading this line on the one
  // morning it matters. Placed beside the freshness line rather than folded
  // into RULE_TEXT: this is a fact about THIS day's read, not the standing
  // rule the list is computed from.
  if (input.unattributedCommits > 0) {
    const plural = input.unattributedCommits === 1 ? '' : 's';
    body.push(
      block(
        `${input.unattributedCommits} commit${plural} on ${input.reportedDay} could not be matched to any developer, so this list may be incomplete or wrong. Worth checking identity resolution.`,
        { isSubtle: true, size: 'Small' },
      ),
    );
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}
