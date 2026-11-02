import { describe, expect, it, vi } from 'vitest';
import {
  FORCE_BODY,
  INITIAL_PANEL_PHASE,
  PREVIEW_BODY,
  SEND_BODY,
  cancelForce,
  cancelSend,
  clickForce,
  clickPreview,
  clickSend,
  confirmForce,
  confirmSend,
  forceConfirmationCopy,
  isAlreadySentConflict,
  nonZeroCounts,
  outcomeLabel,
  previewActiveLine,
  sendConfirmationCopy,
  automaticSendEnabled,
  automaticSendLine,
  triggerLabel,
} from './notification-test-panel-logic';
import type { TenantConfiguration } from '../../lib/api/types';

describe('automatic weekday send', () => {
  function notificationsRow(
    values: Record<string, unknown>,
    status: 'active' | 'disabled' = 'active',
  ): TenantConfiguration {
    return {
      id: 'c1',
      namespace: 'notifications',
      key: 'default',
      values,
      secretRefs: {},
      status,
      updatedAt: '2026-10-30T00:00:00Z',
      connection: null,
      secretsConfigured: {},
    };
  }

  it('is on only when dailyDigestEnabled is true on an active notifications row', () => {
    expect(automaticSendEnabled([notificationsRow({ dailyDigestEnabled: true })])).toBe(true);
    expect(automaticSendEnabled([notificationsRow({ dailyDigestEnabled: false })])).toBe(false);
    expect(
      automaticSendEnabled([notificationsRow({ dailyDigestEnabled: true }, 'disabled')]),
    ).toBe(false);
    expect(automaticSendEnabled([])).toBe(false);
  });

  it('is unknown, not off, when the configurations were not read', () => {
    expect(automaticSendEnabled(undefined)).toBeNull();
    expect(automaticSendLine(null)).toMatch(/unknown/);
  });

  it('names the 09:30 IST schedule when on', () => {
    expect(automaticSendLine(true)).toContain('09:30 IST');
    expect(automaticSendLine(false)).toMatch(/off/);
  });

  it('labels cron runs as automatic', () => {
    expect(triggerLabel('cron')).toBe('Automatic (09:30 IST)');
    expect(triggerLabel('manual')).toBe('Manual');
  });
});

describe('request bodies', () => {
  // Pins the exact wire shape each action is allowed to send — a body drifting
  // (e.g. picking up a stray `day` or losing `force: true`) would silently
  // change which endpoint behavior fires.
  it('preview is dryRun only', () => {
    expect(PREVIEW_BODY).toEqual({ dryRun: true });
  });
  it('a confirmed send carries no flags at all', () => {
    expect(SEND_BODY).toEqual({});
  });
  it('force carries force and nothing else', () => {
    expect(FORCE_BODY).toEqual({ force: true });
  });
});

describe('outcomeLabel', () => {
  // The raw enum is a wire value for the backend, not something an admin
  // reading this panel should have to decode.
  it('never leaks the raw snake_case enum through to its label', () => {
    const outcomes = [
      'sent',
      'sent_all_clear',
      'withheld_stale_data',
      'withheld_truncated_read',
      'withheld_unevaluable',
      'withheld_implausible',
      'skipped_no_roster',
      'failed',
    ] as const;
    for (const outcome of outcomes) {
      expect(outcomeLabel(outcome)).not.toMatch(/_/);
    }
  });

  it('reads a withheld outcome as withheld, not as a plain success', () => {
    expect(outcomeLabel('withheld_stale_data')).toMatch(/withheld/i);
  });

  it('reads a failure as a failure', () => {
    expect(outcomeLabel('failed')).toMatch(/fail/i);
  });
});

describe('isAlreadySentConflict', () => {
  // Exact backend wording, from notifications.service.ts's BadRequestException.
  const BACKEND_MESSAGE =
    '2026-09-25 was already sent for this tenant. Re-sending would post the same names twice; pass force to override.';

  it('identifies the real already-sent refusal', () => {
    expect(isAlreadySentConflict(400, BACKEND_MESSAGE)).toBe(true);
  });

  it('does not treat every 400 as the already-sent case', () => {
    expect(isAlreadySentConflict(400, 'day must be an IST date key, YYYY-MM-DD')).toBe(
      false,
    );
  });

  it('does not treat a non-400 status as the already-sent case even with matching wording', () => {
    // e.g. a 500 whose message happens to mention "already sent" is a bug
    // report, not the recoverable refusal this triggers the force option for.
    expect(isAlreadySentConflict(500, BACKEND_MESSAGE)).toBe(false);
  });
});

describe('confirmation copy', () => {
  it('states the reporting day even with no preview run yet', () => {
    const copy = sendConfirmationCopy('2026-09-25', null);
    expect(copy).toContain('2026-09-25');
    expect(copy).toMatch(/named/i);
  });

  it('uses the preview count when one is known', () => {
    const copy = sendConfirmationCopy('2026-09-25', 3);
    expect(copy).toContain('2026-09-25');
    expect(copy).toContain('3');
  });

  it('singularizes a count of exactly one developer', () => {
    expect(sendConfirmationCopy('2026-09-25', 1)).not.toContain('1 developers');
  });

  it('force copy states the reporting day and that it posts a second time', () => {
    const copy = forceConfirmationCopy('2026-09-25', null);
    expect(copy).toContain('2026-09-25');
    expect(copy).toMatch(/second time/i);
  });

  it('force copy names a specific count when one is known', () => {
    expect(forceConfirmationCopy('2026-09-25', 4)).toContain('4');
  });
});

describe('nonZeroCounts', () => {
  it('omits every count that is zero', () => {
    expect(
      nonZeroCounts({ unresolved: [], incomplete: [], unattributedCommits: 0 }),
    ).toEqual([]);
  });

  it('includes only the non-zero counts, with the right labels', () => {
    const counts = nonZeroCounts({
      unresolved: [{}],
      incomplete: [{}, {}],
      unattributedCommits: 5,
    });
    expect(counts).toEqual([
      { label: 'unresolved roster entries', value: 1 },
      { label: 'incomplete (withheld) entries', value: 2 },
      { label: 'unattributed commits', value: 5 },
    ]);
  });
});

describe('panel command gating', () => {
  // These are the behaviors the task pins: preview always calls, send/force
  // never call until their own separate confirmation says so.

  it('preview always produces a call command — nothing to gate, since a dry run posts nothing', () => {
    expect(clickPreview()).toEqual({ kind: 'callPreview' });
  });

  it('clicking Send only opens confirmation and produces no call', () => {
    const { state, command } = clickSend();
    expect(command).toEqual({ kind: 'none' });
    expect(state.phase).toBe('confirmingSend');
  });

  it('confirming from the idle phase (no prior Send click) never calls', () => {
    const { command } = confirmSend(INITIAL_PANEL_PHASE);
    expect(command).toEqual({ kind: 'none' });
  });

  it('confirming from the confirmingSend phase calls, exactly once, and returns to idle', () => {
    const afterClick = clickSend().state;
    const { state, command } = confirmSend(afterClick);
    expect(command).toEqual({ kind: 'callSend' });
    expect(state.phase).toBe('idle');
  });

  it('cancelling a pending send confirmation returns to idle without a call', () => {
    expect(cancelSend()).toEqual({ phase: 'idle' });
  });

  it('cancelling a pending force confirmation returns to idle without a call', () => {
    expect(cancelForce()).toEqual({ phase: 'idle' });
  });

  it('clicking force only opens its own confirmation and produces no call', () => {
    const { state, command } = clickForce();
    expect(command).toEqual({ kind: 'none' });
    expect(state.phase).toBe('confirmingForce');
  });

  it('confirming force from the idle phase never calls', () => {
    const { command } = confirmForce(INITIAL_PANEL_PHASE);
    expect(command).toEqual({ kind: 'none' });
  });

  it('confirming force from its own confirmingForce phase calls, and only that phase', () => {
    const afterClick = clickForce().state;
    const { state, command } = confirmForce(afterClick);
    expect(command).toEqual({ kind: 'callForce' });
    expect(state.phase).toBe('idle');
  });

  it('the send confirmation phase cannot be force-confirmed, or vice versa', () => {
    // Regression: force's own confirmation must not also satisfy send's, and
    // a leftover confirmingSend phase must not let a force click through.
    const sendPhase = clickSend().state;
    expect(confirmForce(sendPhase).command).toEqual({ kind: 'none' });

    const forcePhase = clickForce().state;
    expect(confirmSend(forcePhase).command).toEqual({ kind: 'none' });
  });

  it('a caller wiring these to real mutations never invokes the API before confirmation', () => {
    // Simulates the component's wiring with spies standing in for
    // sendMutation.mutate / forceMutation.mutate, proving the gate holds even
    // once real side effects are attached to the commands.
    const sendCall = vi.fn();
    const forceCall = vi.fn();

    let phase = INITIAL_PANEL_PHASE;

    const onSendClick = () => {
      phase = clickSend().state;
    };
    const onConfirmSendClick = () => {
      const result = confirmSend(phase);
      phase = result.state;
      if (result.command.kind === 'callSend') sendCall();
    };

    onSendClick();
    expect(sendCall).not.toHaveBeenCalled();
    onConfirmSendClick();
    expect(sendCall).toHaveBeenCalledTimes(1);

    // A second confirm click with no intervening Send click must not fire again.
    onConfirmSendClick();
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(forceCall).not.toHaveBeenCalled();
  });
});

describe('previewActiveLine', () => {
  it('reads like the Overview tile: active tracked developers out of the list', () => {
    expect(previewActiveLine({ rosterCount: 66, activeCount: 40 })).toBe(
      'Active developers: 40 / 66 · tracked developers with a commit or PR',
    );
  });

  it('says "not evaluated" — never 0 — when the run withheld before reading the roster', () => {
    expect(previewActiveLine({ rosterCount: 66, activeCount: null })).toBe(
      'Active developers: not evaluated (66 tracked)',
    );
  });

  it('shows nothing on an older API that sends no counts', () => {
    expect(previewActiveLine({})).toBeNull();
  });
});
