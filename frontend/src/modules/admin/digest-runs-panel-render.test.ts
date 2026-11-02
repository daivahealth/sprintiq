import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DigestRunsPanelView, type DigestRunsPanelViewProps } from './DigestRunsPanel';
import type { DigestRunSummary } from '../../lib/api/types';

function run(overrides: Partial<DigestRunSummary> = {}): DigestRunSummary {
  return {
    reportedDay: '2026-10-29',
    outcome: 'sent',
    trigger: 'cron',
    rosterCount: 65,
    flaggedCount: 12,
    deliveredAt: '2026-10-30T04:00:02.000Z',
    createdAt: '2026-10-30T04:00:00.000Z',
    detail: null,
    ...overrides,
  };
}

function render(props: Partial<DigestRunsPanelViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DigestRunsPanelView, {
      automaticEnabled: true,
      runs: [],
      loading: false,
      errorMessage: null,
      ...props,
    }),
  );
}

describe('DigestRunsPanelView', () => {
  it('shows an automatic run with its day, trigger, outcome and counts', () => {
    const markup = render({ runs: [run()] });
    expect(markup).toContain('2026-10-29');
    expect(markup).toContain('Automatic (09:30 IST)');
    expect(markup).toContain('Sent — the flagged names were posted to Teams');
    expect(markup).toContain('12 of 65 named');
  });

  it('shows a manual run as manual and surfaces a withheld detail', () => {
    const markup = render({
      runs: [
        run({
          trigger: 'manual',
          outcome: 'withheld_stale_data',
          flaggedCount: 0,
          detail: 'GitHub audit sync has not covered 2026-10-29. Names withheld.',
        }),
      ],
    });
    expect(markup).toContain('Manual');
    expect(markup).toContain('Names withheld.');
  });

  it('says when the automatic send is off', () => {
    expect(render({ automaticEnabled: false })).toContain('Automatic weekday send: off');
  });

  it('says when nothing has run yet', () => {
    expect(render({ runs: [] })).toContain('No digest has run yet.');
  });

  it('renders the load error plainly', () => {
    expect(
      render({ runs: null, errorMessage: 'The digest runs could not be loaded.' }),
    ).toContain('could not be loaded');
  });
});
