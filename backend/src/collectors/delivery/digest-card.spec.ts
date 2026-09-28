import { buildDigestCard, escapeCardText } from './digest-card';

function textOf(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

describe('escapeCardText', () => {
  it('neutralises markdown a display name could smuggle in', () => {
    // Display names come from ingested GitHub/Jira data, which CLAUDE.md
    // treats as untrusted, and Adaptive Card TextBlock renders a markdown
    // subset — so a crafted name could post a link into the channel.
    expect(escapeCardText('[click](http://evil.example)')).toBe(
      '\\[click\\]\\(http://evil.example\\)',
    );
  });

  it('leaves an ordinary name untouched', () => {
    expect(escapeCardText('Alice Anand')).toBe('Alice Anand');
  });

  it('does not escape hyphens, which appear in real developer names', () => {
    // `Hari-Krishnan-P-C` is on the tracked roster. Under the brief's wider
    // regex `/[\\`*_[\]()#+\-!>|]/g`, this would render as
    // `Hari\-Krishnan\-P\-C` with visible backslashes in the channel. This
    // test guards against re-widening the character class to include `-`.
    expect(escapeCardText('Hari-Krishnan-P-C')).toBe('Hari-Krishnan-P-C');
  });

  it('escapes angle brackets so a display name cannot form a live autolink', () => {
    // Square brackets and parens alone do not stop this: CommonMark (and the
    // Adaptive Card TextBlock renderer) treats `<https://evil.example>` as a
    // live autolink with no `[...](...)` needed at all.
    expect(escapeCardText('<https://evil.example>')).toBe(
      '\\<https://evil.example\\>',
    );
  });
});

describe('buildDigestCard', () => {
  const input = {
    reportedDay: '2026-09-17',
    flagged: [
      { developer: 'bob_athma', displayName: 'Bob Bose' },
      { developer: 'zara_athma', displayName: 'Zara Ahmed' },
    ],
    evaluatedCount: 66,
    unattributedCommits: 0,
  };

  it('states the one-line rule it was computed from, on the named-list card', () => {
    // Governance requirement (CLAUDE.md; ADR-0009 condition 1): the rule
    // ships with the list and is displayed on every card. Trimmed to one
    // line (2026-09-28 footer-length decision) — this pins the new text.
    const body = textOf(buildDigestCard(input));
    expect(body).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
  });

  it('states the same one-line rule on the all-clear card', () => {
    // The ADR-0009 condition applies to every card, not only the named-list
    // one — this guards the all-clear variant specifically.
    const body = textOf(buildDigestCard({ ...input, flagged: [] }));
    expect(body).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
  });

  it('states the same one-line rule on a withheld card', () => {
    // The ADR-0009 condition applies even when names are withheld — this
    // guards the withheld variant specifically.
    const body = textOf(
      buildDigestCard({
        ...input,
        flagged: [],
        withheldDetail: 'Names withheld: collection is behind.',
      }),
    );
    expect(body).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
  });

  it('does not render the removed check-in framing line', () => {
    // Removed 2026-09-28 (footer-length trim): "This is a prompt to check
    // in, not a conclusion about anyone — ask before assuming." must no
    // longer appear on any card variant.
    const named = textOf(buildDigestCard(input));
    const allClear = textOf(buildDigestCard({ ...input, flagged: [] }));
    const withheld = textOf(
      buildDigestCard({
        ...input,
        flagged: [],
        withheldDetail: 'Names withheld: collection is behind.',
      }),
    );
    for (const body of [named, allClear, withheld]) {
      expect(body).not.toContain('ask before assuming');
      expect(body).not.toContain('not a conclusion about anyone');
    }
  });

  it('does not render the removed freshness line', () => {
    // Removed 2026-09-28 (footer-length trim): the "Sources last reached
    // <timestamp>." line (and its null fallback) must no longer appear, and
    // `DigestCardInput` no longer accepts `lastSyncAt` at all.
    const named = textOf(buildDigestCard(input));
    const allClear = textOf(buildDigestCard({ ...input, flagged: [] }));
    const withheld = textOf(
      buildDigestCard({
        ...input,
        flagged: [],
        withheldDetail: 'Names withheld: collection is behind.',
      }),
    );
    for (const body of [named, allClear, withheld]) {
      expect(body).not.toContain('Sources last reached');
      expect(body).not.toContain('never been reached');
    }
  });

  it('reports the count against the number evaluated', () => {
    expect(textOf(buildDigestCard(input))).toContain('2 of 66');
  });

  it('lists names alphabetically and never by volume', () => {
    const body = textOf(buildDigestCard(input));
    expect(body.indexOf('Bob Bose')).toBeLessThan(body.indexOf('Zara Ahmed'));
  });

  it('renders an all-clear card when nobody is flagged', () => {
    const body = textOf(buildDigestCard({ ...input, flagged: [] }));
    expect(body).toContain('All 66');
  });

  it('renders the withheld reason instead of names when given one', () => {
    const body = textOf(
      buildDigestCard({
        ...input,
        flagged: [],
        withheldDetail: 'Names withheld: collection is behind.',
      }),
    );
    expect(body).toContain('Names withheld');
    expect(body).not.toContain('Bob Bose');
  });

  it('is a message-wrapped adaptive card, as the Workflows action expects', () => {
    const card = buildDigestCard(input) as {
      type: string;
      attachments: { contentType: string }[];
    };
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
  });

  it('discloses unattributed commits as counter-evidence when the count is positive', () => {
    // The fix this task ships: a name on the list can be wrong because the
    // person's commit was unattributable, not because they did nothing. This
    // guards against the disclosure line silently going missing.
    const body = textOf(buildDigestCard({ ...input, unattributedCommits: 3 }));
    expect(body).toContain('3 commits');
    expect(body).toContain('2026-09-17');
    expect(body).toMatch(/could not be matched/);
  });

  it('uses the singular for exactly one unattributed commit', () => {
    const body = textOf(buildDigestCard({ ...input, unattributedCommits: 1 }));
    expect(body).toContain('1 commit ');
    expect(body).not.toContain('1 commits');
  });

  it('omits the unattributed-commits line entirely when the count is zero', () => {
    // A zero line every ordinary morning is noise that trains readers to
    // ignore it on the one morning it is non-zero and matters — the whole
    // point of the disclosure decision is that it is NOT a permanent line.
    const body = textOf(buildDigestCard({ ...input, unattributedCommits: 0 }));
    expect(body).not.toMatch(/could not be matched/);
  });
});

describe('buildDigestCard — top-level `text` field for the "Post message" flow', () => {
  const input = {
    reportedDay: '2026-09-17',
    flagged: [
      { developer: 'bob_athma', displayName: 'Bob Bose' },
      { developer: 'zara_athma', displayName: 'Zara Ahmed' },
    ],
    evaluatedCount: 66,
    unattributedCommits: 0,
  };

  it('adds a top-level `text` field without disturbing the existing card attachment', () => {
    // The new Power Automate flow ("Post message in a chat or channel") reads
    // `triggerBody()?['text']`, which does not exist on today's payload — the
    // flow would post an empty message while the webhook still returns 202.
    // A card-based flow must keep working unchanged, so `attachments` and
    // `type` must survive exactly as before.
    const card = buildDigestCard(input) as {
      type: string;
      text: string;
      attachments: { contentType: string }[];
    };
    expect(card.type).toBe('message');
    expect(typeof card.text).toBe('string');
    expect(card.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
  });

  it('separates lines with <br>, not bare newlines, and preserves alphabetical order', () => {
    // The "Post message in a chat or channel" Message field is HTML — a bare
    // `\n` collapses in HTML rendering and would run every name together on
    // one line. This also guards that the caller's alphabetical order (never
    // volume order) survives into the text variant.
    const card = buildDigestCard(input) as { text: string };
    expect(card.text).not.toMatch(/[^<]\n/); // no bare newline outside markup
    expect(card.text).toContain('<br>');
    expect(card.text.indexOf('Bob Bose')).toBeLessThan(
      card.text.indexOf('Zara Ahmed'),
    );
  });

  it('carries the one-line rule in `text` on the named-list variant', () => {
    // ADR-0009 condition 1 ("the rule ships with the list, on every card")
    // applies to the text variant too — dropping it here would silently
    // violate the same governance condition the card already satisfies.
    const card = buildDigestCard(input) as { text: string };
    expect(card.text).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
  });

  it('carries the one-line rule in `text` on the all-clear variant', () => {
    const card = buildDigestCard({ ...input, flagged: [] }) as {
      text: string;
    };
    expect(card.text).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
  });

  it('carries the one-line rule in `text` on a withheld variant', () => {
    const card = buildDigestCard({
      ...input,
      flagged: [],
      withheldDetail: 'Names withheld: collection is behind.',
    }) as { text: string };
    expect(card.text).toContain(
      "Counts commits and PRs opened only — reviews and Jira aren't counted.",
    );
    expect(card.text).toContain('Names withheld');
    expect(card.text).not.toContain('Bob Bose');
  });

  it('renders the all-clear sentence in `text` when nobody is flagged', () => {
    const card = buildDigestCard({ ...input, flagged: [] }) as {
      text: string;
    };
    expect(card.text).toContain('All 66');
  });

  it('includes the unattributed-commits line in `text` only when the count is positive', () => {
    // Same disclosure decision as the card: a zero line every ordinary
    // morning trains readers to stop reading it on the day it matters.
    const withCommits = buildDigestCard({
      ...input,
      unattributedCommits: 3,
    }) as { text: string };
    expect(withCommits.text).toContain('3 commits');
    expect(withCommits.text).toMatch(/could not be matched/);

    const withoutCommits = buildDigestCard({
      ...input,
      unattributedCommits: 0,
    }) as { text: string };
    expect(withoutCommits.text).not.toMatch(/could not be matched/);
  });

  it('HTML-escapes a hostile display name in `text`, and does not markdown-escape it there', () => {
    // Display names are ingested, untrusted data (CLAUDE.md). Unescaped HTML
    // in a "Post message" flow's Message field renders as live markup in the
    // channel, not visible text. The card's markdown escaping (backslashes
    // before `<`/`>`) must NOT leak into the HTML variant — that would show
    // stray backslashes instead of the intended characters.
    const hostile = buildDigestCard({
      ...input,
      flagged: [
        { developer: 'x', displayName: '<img src=x onerror=alert(1)>' },
        { developer: 'y', displayName: 'Tom & "Jerry"' },
      ],
    }) as { text: string };

    expect(containsNoRawTag(hostile.text)).toBe(true);
    expect(hostile.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(hostile.text).toContain('Tom &amp; &quot;Jerry&quot;');
    expect(hostile.text).not.toContain('\\<img');
    expect(hostile.text).not.toContain('\\>');
  });
});

/** True when no unescaped `<img`/`<script`-style tag survives in the text. */
function containsNoRawTag(text: string): boolean {
  return !/<img[\s>]/i.test(text) && !/<script[\s>]/i.test(text);
}
