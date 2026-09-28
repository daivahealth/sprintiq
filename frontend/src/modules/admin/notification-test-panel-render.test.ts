import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  NotificationTestPanelView,
  type NotificationTestPanelViewProps,
} from './NotificationTestPanel';
import type { RunDigestResult } from '../../lib/api/types';

/**
 * Structural markup assertions for the pure view half of the panel, the same
 * way `monthly-trend-render.test.ts` checks `MonthlyTrendChart` — via
 * `renderToStaticMarkup`, so no jsdom/testing-library dependency is needed in
 * a repo that otherwise tests only pure logic. This cannot simulate a click
 * (static markup carries no event handlers), so it proves what got RENDERED
 * for a given state; `notification-test-panel-logic.test.ts` proves which
 * clicks are allowed to call the API in the first place.
 */

function result(overrides: Partial<RunDigestResult> = {}): RunDigestResult {
  return {
    reportedDay: '2026-09-25',
    outcome: 'sent',
    flagged: [],
    unresolved: [],
    incomplete: [],
    detail: null,
    dryRun: false,
    unattributedCommits: 0,
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<NotificationTestPanelViewProps> = {},
): NotificationTestPanelViewProps {
  return {
    reportedDayGuess: '2026-09-25',
    previewPending: false,
    sendPending: false,
    forcePending: false,
    previewResult: null,
    previewErrorMessage: null,
    phase: 'idle',
    sendOutcome: null,
    onPreviewClick: () => {},
    onSendClick: () => {},
    onConfirmSendClick: () => {},
    onCancelSendClick: () => {},
    onForceClick: () => {},
    onConfirmForceClick: () => {},
    onCancelForceClick: () => {},
    ...overrides,
  };
}

function render(props: Partial<NotificationTestPanelViewProps> = {}): string {
  return renderToStaticMarkup(createElement(NotificationTestPanelView, baseProps(props)));
}

describe('preview result', () => {
  it('renders every flagged display name', () => {
    const markup = render({
      previewResult: result({
        dryRun: true,
        flagged: [
          { developer: 'a-login', displayName: 'Amit Rao' },
          { developer: 'z-login', displayName: 'Zeta Iyer' },
        ],
      }),
    });
    expect(markup).toContain('Amit Rao');
    expect(markup).toContain('Zeta Iyer');
  });

  it('says nothing was posted, for a preview specifically', () => {
    const markup = render({ previewResult: result({ dryRun: true }) });
    expect(markup).toMatch(/nothing was posted/i);
    expect(markup).toMatch(/posts nothing/i);
  });

  it('surfaces a withheld/skipped detail string prominently, in plain words', () => {
    const markup = render({
      previewResult: result({
        dryRun: true,
        outcome: 'withheld_stale_data',
        detail:
          'Collector pipeline looks broken ahead of 2026-09-25: no sync in 3 days. Names withheld.',
      }),
    });
    expect(markup).toContain('Collector pipeline looks broken ahead of 2026-09-25');
  });

  it('shows non-zero unresolved/incomplete/unattributed counts', () => {
    const markup = render({
      previewResult: result({
        dryRun: true,
        unresolved: [{ developer: 'x', addedAs: 'x' }],
        incomplete: [{ developer: 'y', displayName: 'Y' }],
        unattributedCommits: 7,
      }),
    });
    expect(markup).toContain('1 unresolved roster entries');
    expect(markup).toContain('1 incomplete (withheld) entries');
    expect(markup).toContain('7 unattributed commits');
  });
});

/**
 * The `disabled` HTML attribute, not the always-present Tailwind
 * `disabled:cursor-not-allowed` variant class baked into every `<button>`'s
 * `class` — a bare `.toContain('disabled')` would pass regardless of the
 * actual disabled state, since that substring sits in every button's class
 * string either way. React serializes a true boolean attribute as
 * `disabled=""` and omits it entirely when false, so that exact form is what
 * distinguishes an actually-disabled button from an enabled one.
 */
function isDisabledButton(buttonTag: string): boolean {
  return / disabled=""/.test(buttonTag);
}

describe('pending state disables every button', () => {
  // Guards the double-click-cannot-double-post requirement at the markup
  // level: whichever action is in flight, all three buttons must render
  // disabled, not just the one that was clicked.
  it('disables the preview button while a preview is pending', () => {
    const markup = render({ previewPending: true });
    const [previewButton] = markup.match(/<button[^>]*>Previewing…<\/button>/) ?? [];
    expect(previewButton).toBeDefined();
    expect(isDisabledButton(previewButton!)).toBe(true);
  });

  it('disables the send button while a send is pending', () => {
    const markup = render({ sendPending: true });
    expect(markup).toContain('Sending…');
    const [sendButton] = markup.match(/<button[^>]*>Sending…<\/button>/) ?? [];
    expect(isDisabledButton(sendButton!)).toBe(true);
  });

  it('disables the (idle) preview button too while a send is pending, not only the send button', () => {
    const markup = render({ sendPending: true });
    const [previewButton] = markup.match(/<button[^>]*>Preview<\/button>/) ?? [];
    expect(previewButton).toBeDefined();
    expect(isDisabledButton(previewButton!)).toBe(true);
  });

  it('renders no button as disabled when nothing is pending', () => {
    const markup = render();
    const buttons = [...markup.matchAll(/<button[^>]*>/g)];
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(isDisabledButton(btn[0])).toBe(false);
    }
  });
});

describe('send confirmation', () => {
  it('shows the reporting day and a Cancel/Confirm pair while confirming', () => {
    const markup = render({ phase: 'confirmingSend', reportedDayGuess: '2026-09-25' });
    expect(markup).toContain('2026-09-25');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Confirm');
    // The plain "Send to Teams now" trigger button must not also be showing —
    // there is exactly one send action visible at a time.
    expect(markup).not.toContain('Send to Teams now');
  });
});

describe('already-sent conflict', () => {
  const conflict = {
    kind: 'error' as const,
    status: 400,
    message:
      '2026-09-25 was already sent for this tenant. Re-sending would post the same names twice; pass force to override.',
  };

  it('surfaces the force option instead of a generic error', () => {
    const markup = render({ sendOutcome: conflict });
    expect(markup).toContain('Already sent');
    expect(markup).toContain('Send again anyway');
    expect(markup).toContain(conflict.message);
  });

  it('does not also render the already-sent message as a plain danger error', () => {
    const markup = render({ sendOutcome: conflict });
    // The generic-error paragraph uses text-danger-fg; the conflict message
    // must appear outside of it, in the informational block instead.
    const dangerParagraphs = [...markup.matchAll(/<p class="text-sm text-danger-fg">(.*?)<\/p>/g)];
    for (const [, text] of dangerParagraphs) {
      expect(text).not.toContain('already sent');
    }
  });

  it('shows its own confirmation, separate from the send confirmation, before force-calling', () => {
    const markup = render({ sendOutcome: conflict, phase: 'confirmingForce' });
    expect(markup).toMatch(/second time/i);
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Confirm');
    expect(markup).not.toContain('Send again anyway');
  });
});

describe('other failures are not swallowed', () => {
  it('renders a non-conflict error message plainly', () => {
    const markup = render({
      sendOutcome: {
        kind: 'error',
        status: 500,
        message: 'Tenant t1 has no Teams webhook ref configured for "teamsWebhookRef".',
      },
    });
    expect(markup).toContain('no Teams webhook ref configured');
    expect(markup).not.toContain('Send again anyway');
  });

  it('renders a preview error message plainly rather than hiding it', () => {
    const markup = render({ previewErrorMessage: 'Could not reach the server.' });
    expect(markup).toContain('Could not reach the server.');
  });
});
