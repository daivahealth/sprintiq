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
  /**
   * The tenant's GitHub organization login (e.g. `athmahealth`), named in the
   * lead-in and all-clear lines so readers know which source "recorded
   * activity" refers to.
   * Callers pass it only when it is a valid GitHub login (letters, digits,
   * hyphens), so it needs no markdown escaping; omitted, the line says
   * "in GitHub" alone.
   */
  githubOrganization?: string;
}

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

/**
 * HTML-escape for the top-level `text` field (see `buildDigestText` below).
 *
 * A sibling to `escapeCardText`, not a replacement for it: the Adaptive Card
 * `TextBlock` renderer understands a markdown subset, but the "Post message
 * in a chat or channel" action's Message field is HTML, where `escapeCardText`'s
 * backslash-escaping would show up as literal stray backslashes instead of
 * the intended characters. The two escaping schemes must never cross —
 * `escapeCardText` output must never flow through this function or vice versa.
 * Order matters: `&` must be replaced first, or the entities this function
 * inserts (`&amp;`, `&lt;`, ...) would themselves be re-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function block(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'TextBlock', wrap: true, text, ...extra };
}

/**
 * The heading, all-clear sentence, and count-line templates shared by
 * `buildDigestCard`'s Adaptive Card body and `buildDigestText`'s HTML string.
 *
 * None of these three interpolate untrusted data (only `reportedDay`, an IST
 * date key, integers, and `githubOrganization`, which callers restrict to a
 * valid GitHub login) — factored out purely so the card and the text
 * variant cannot drift apart by one of them being edited and not the other.
 * Their fixed wording contains no markdown or HTML-special characters, so
 * each renderer can use them unescaped. Anything that DOES interpolate
 * untrusted data (display names, `withheldDetail`) stays inline in each
 * renderer, escaped with that renderer's own scheme.
 */
function headingText(reportedDay: string): string {
  return `GH activity check as on ${reportedDay}`;
}

/**
 * Bolds the organization name in the renderer's own markup — `**…**` for the
 * card's markdown, `<b>…</b>` for the HTML `text` field — and escapes it with
 * that renderer's scheme as a second line of defence behind the caller's
 * login validation.
 */
type Emphasise = (value: string) => string;

const cardBold: Emphasise = (value) => `**${escapeCardText(value)}**`;
const htmlBold: Emphasise = (value) => `<b>${escapeHtml(value)}</b>`;

function sourceText(input: DigestCardInput, bold: Emphasise): string {
  return input.githubOrganization
    ? `GitHub ${bold(input.githubOrganization)} organisation`
    : 'GitHub';
}

function allClearText(input: DigestCardInput, bold: Emphasise): string {
  return `All ${input.evaluatedCount} tracked developers had recorded activity in ${sourceText(input, bold)} on ${input.reportedDay}.`;
}

/**
 * Introduces the names. Carries no "N of M" count (2026-11-03 product
 * decision) — the names below are the finding, and ADR-0009 does not require
 * the count; the all-clear line still states how many were evaluated.
 */
function countLineText(input: DigestCardInput, bold: Emphasise): string {
  return `Below developers had no recorded activity in ${sourceText(input, bold)}:`;
}

/**
 * The unattributed-commits disclosure sentence, or `null` when there is
 * nothing to disclose (count is zero — see the docblock on
 * `DigestCardInput.unattributedCommits`). Shared by both renderers for the
 * same anti-drift reason as the templates above.
 */
function unattributedDisclosureText(input: DigestCardInput): string | null {
  if (input.unattributedCommits <= 0) {
    return null;
  }
  const plural = input.unattributedCommits === 1 ? '' : 's';
  return `${input.unattributedCommits} commit${plural} on ${input.reportedDay} could not be matched to any developer, so this list may be incomplete or wrong. Worth checking identity resolution.`;
}

/**
 * The daily digest as HTML for a top-level `text` field.
 *
 * Added because the team's Power Automate flow changed to a "Post message in
 * a chat or channel" action whose Message field reads
 * `@{triggerBody()?['text']}` — a field the Adaptive-Card-only payload never
 * had. Without it, that flow posts an empty message while the webhook still
 * returns 202, so the run is recorded `sent` with nothing visible in the
 * channel.
 *
 * HTML, not plain text: the Message field renders HTML, and a bare `\n`
 * collapses there, which would run every name together on one line — `<br>`
 * is used between every line instead. Carries the same content as the card
 * in every variant (named list, all-clear, withheld, unattributed-commits
 * disclosure) — see
 * `headingText`/`allClearText`/`countLineText`/`unattributedDisclosureText`
 * above, shared with `buildDigestCard` so the two cannot silently diverge.
 * Neither carries the rule line (ADR-0009 amendment, 2026-11-03).
 *
 * Every interpolated value that can carry untrusted content (display names,
 * `withheldDetail`) is passed through `escapeHtml`, never `escapeCardText` —
 * the card's markdown escaping would show stray backslashes in HTML.
 */
function buildDigestText(input: DigestCardInput): string {
  const lines: string[] = [
    `<b>${escapeHtml(headingText(input.reportedDay))}</b>`,
    // Blank line between the heading and the body.
    '',
  ];

  if (input.withheldDetail) {
    lines.push(`<b>${escapeHtml(input.withheldDetail)}</b>`);
  } else if (input.flagged.length === 0) {
    lines.push(allClearText(input, htmlBold));
  } else {
    lines.push(countLineText(input, htmlBold));
    // Alphabetical order is the caller's guarantee; rendering must not sort.
    for (const person of input.flagged) {
      lines.push(`• ${escapeHtml(person.displayName)}`);
    }
  }

  const unattributed = unattributedDisclosureText(input);
  if (unattributed) {
    lines.push(`<i>${unattributed}</i>`);
  }

  return lines.join('<br>');
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
    block(headingText(input.reportedDay), {
      size: 'Medium',
      weight: 'Bolder',
    }),
  ];

  if (input.withheldDetail) {
    body.push(block(input.withheldDetail, { weight: 'Bolder' }));
  } else if (input.flagged.length === 0) {
    body.push(block(allClearText(input, cardBold), { spacing: 'Large' }));
  } else {
    body.push(block(countLineText(input, cardBold), { spacing: 'Large' }));
    // Alphabetical order is the caller's guarantee; rendering must not sort.
    body.push(
      block(
        input.flagged
          .map((person) => `• ${escapeCardText(person.displayName)}`)
          .join('\n'),
      ),
    );
  }

  // No rule line: removed from the card by the ADR-0009 amendment of
  // 2026-11-03. The rule is still shown beside the same list on the admin
  // Watchlist (`DIGEST_RULE_TEXT`).
  //
  // Rendered only when positive — a zero here is noise on every ordinary
  // morning, and would train readers to stop reading this line on the one
  // morning it matters. This is a fact about THIS day's read, not a rule.
  const unattributed = unattributedDisclosureText(input);
  if (unattributed) {
    body.push(block(unattributed, { isSubtle: true, size: 'Small' }));
  }

  return {
    type: 'message',
    // HTML for the "Post message in a chat or channel" flow, which reads
    // `@{triggerBody()?['text']}` and has no notion of `attachments` — see
    // `buildDigestText`. `attachments` below is unchanged, so a card-based
    // flow ("Post card in a chat or channel") keeps working exactly as
    // before; the two fields are independent renderings of the same content.
    text: buildDigestText(input),
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
