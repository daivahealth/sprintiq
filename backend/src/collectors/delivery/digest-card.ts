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
  collectedThroughAt: Date | null;
  /** When set, the reason names were withheld; names are not rendered. */
  withheldDetail?: string;
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
  body.push(
    block(
      `Data collected through ${
        input.collectedThroughAt?.toISOString() ?? 'unknown'
      }.`,
      { isSubtle: true, size: 'Small' },
    ),
  );

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
