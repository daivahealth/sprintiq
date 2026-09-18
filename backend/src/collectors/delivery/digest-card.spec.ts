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
});

describe('buildDigestCard', () => {
  const input = {
    reportedDay: '2026-09-17',
    flagged: [
      { developer: 'bob_athma', displayName: 'Bob Bose' },
      { developer: 'zara_athma', displayName: 'Zara Ahmed' },
    ],
    evaluatedCount: 66,
    collectedThroughAt: new Date('2026-09-18T04:00:00.000Z'),
  };

  it('states the rule it was computed from', () => {
    // Governance requirement (spec §3): the rule ships with the list and is
    // displayed. Without it the message asserts these people did no work,
    // which the data cannot support.
    const body = textOf(buildDigestCard(input));
    expect(body).toContain('no commit and no pull request opened');
  });

  it('says outright that reviewing is not counted', () => {
    // The largest source of a justified objection to being named: prReview is
    // not in the Overview's set, so a day spent reviewing appears here.
    expect(textOf(buildDigestCard(input))).toContain('review');
  });

  it('reports the count against the number evaluated', () => {
    expect(textOf(buildDigestCard(input))).toContain('2 of 66');
  });

  it('lists names alphabetically and never by volume', () => {
    const body = textOf(buildDigestCard(input));
    expect(body.indexOf('Bob Bose')).toBeLessThan(body.indexOf('Zara Ahmed'));
  });

  it('carries the collection freshness', () => {
    expect(textOf(buildDigestCard(input))).toContain('2026-09-18');
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
});
