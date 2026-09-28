import type { DigestOutcome, RunDigestPayload } from '../../lib/api/types';

/**
 * Pure decision logic behind the "Test the notification" panel on the Tracked
 * Developers page (`NotificationTestPanel.tsx`). Split out for the same
 * reason `tracked-developers-logic.ts` and `activity-range.ts` are: the parts
 * worth pinning here — whether a click is allowed to call the API, and with
 * which exact body — are plain branching logic, and testing them through a
 * rendered component would prove only that the component rendered.
 */

/** Exact request bodies the panel is allowed to send. Never vary these ad hoc. */
export const PREVIEW_BODY: RunDigestPayload = { dryRun: true };
export const SEND_BODY: RunDigestPayload = {};
export const FORCE_BODY: RunDigestPayload = { force: true };

/**
 * Plain-word rendering of `RunDigestResult.outcome`. The raw enum
 * (`withheld_truncated_read`, `sent_all_clear`, ...) is an internal wire
 * value, not something an admin reading this panel should have to decode.
 */
export function outcomeLabel(outcome: DigestOutcome): string {
  switch (outcome) {
    case 'sent':
      return 'Sent — the flagged names were posted to Teams';
    case 'sent_all_clear':
      return 'Sent — an all-clear card was posted (nobody flagged)';
    case 'withheld_stale_data':
      return 'Withheld — the collector pipeline looks stale, nothing was posted';
    case 'withheld_truncated_read':
      return 'Withheld — the commit read was truncated, nothing was posted';
    case 'withheld_unevaluable':
      return 'Withheld — the roster could not be evaluated, nothing was posted';
    case 'withheld_implausible':
      return 'Withheld — the result looked implausible, nothing was posted';
    case 'skipped_no_roster':
      return 'Skipped — no tracked developers are configured, nothing was posted';
    case 'failed':
      return 'Failed — delivery to Teams did not go through';
    default:
      return outcome;
  }
}

/**
 * Whether a failed non-dry send is specifically the "this day already sent"
 * refusal (`NotificationsService.runNoCommitDigest`, backend/src/modules/
 * notifications/notifications.service.ts) rather than some other failure
 * (misconfigured webhook, delivery error, validation error, ...).
 *
 * Identified by status + wording, per the backend's exact message:
 * `` `${reportedDay} was already sent for this tenant. Re-sending would post
 * the same names twice; pass force to override.` `` — matched on "already
 * sent" rather than the full string so a reportedDay-specific prefix doesn't
 * break the match, but still gated on 400 so an unrelated message that
 * happens to contain those words (a different validation error, a 500) is
 * never misread as this specific, recoverable case.
 */
export function isAlreadySentConflict(status: number, message: string): boolean {
  return status === 400 && /already sent/i.test(message);
}

/**
 * Confirmation copy for "Send to Teams now". Uses the live preview's flagged
 * count when one has been run against the same day — falling back to
 * generic wording when no preview exists yet, since an admin should not have
 * to run a preview first, only be told plainly that names will be posted
 * either way.
 */
export function sendConfirmationCopy(
  reportedDay: string,
  previewFlaggedCount: number | null,
): string {
  if (previewFlaggedCount === null) {
    return (
      `Post the ${reportedDay} digest to the Teams channel now? ` +
      `Tracked developers with no delivery activity on ${reportedDay} will ` +
      'be named in the channel.'
    );
  }
  if (previewFlaggedCount === 0) {
    return (
      `Post the ${reportedDay} digest to the Teams channel now? The last ` +
      'preview found nobody to flag, so this would post an all-clear card.'
    );
  }
  return (
    `Post the ${reportedDay} digest to the Teams channel now? ` +
    `${previewFlaggedCount} developer${previewFlaggedCount === 1 ? '' : 's'} ` +
    'will be named in the channel, per the last preview.'
  );
}

/**
 * Confirmation copy for the force re-send, once the 400 already-sent
 * response has surfaced the option. Deliberately does not claim a specific
 * count unless one is actually known (from a preview run against the same
 * day) — the 400 body carries no flagged list, only the refusal message.
 */
export function forceConfirmationCopy(
  reportedDay: string,
  knownFlaggedCount: number | null,
): string {
  const who =
    knownFlaggedCount === null
      ? 'the same names'
      : `the same ${knownFlaggedCount} name${knownFlaggedCount === 1 ? '' : 's'}`;
  return (
    `${reportedDay} was already sent. Sending again will post ${who} to the ` +
    'Teams channel a second time.'
  );
}

/** Which confirmation, if any, the panel is currently showing. */
export type PanelPhase = 'idle' | 'confirmingSend' | 'confirmingForce';

export interface PanelPhaseState {
  phase: PanelPhase;
}

export const INITIAL_PANEL_PHASE: PanelPhaseState = { phase: 'idle' };

/**
 * What a click is allowed to trigger. `'none'` means the click only changed
 * local UI state (e.g. opened a confirmation) — the caller must not fire any
 * request for it.
 */
export type PanelCommand =
  | { kind: 'callPreview' }
  | { kind: 'callSend' }
  | { kind: 'callForce' }
  | { kind: 'none' };

/**
 * Clicking "Preview" is never gated — a dry run posts nothing, so there is
 * nothing to confirm. This is the one action that always produces a command.
 */
export function clickPreview(): PanelCommand {
  return { kind: 'callPreview' };
}

/**
 * Clicking "Send to Teams now" only opens the confirmation. The actual send
 * command is produced solely by `confirmSend`, from the `confirmingSend`
 * phase — this is what makes "requires confirmation before calling"
 * mechanically true rather than a matter of UI copy.
 */
export function clickSend(): { state: PanelPhaseState; command: PanelCommand } {
  return { state: { phase: 'confirmingSend' }, command: { kind: 'none' } };
}

/** Only fires the call when the panel is actually in the confirming phase. */
export function confirmSend(
  state: PanelPhaseState,
): { state: PanelPhaseState; command: PanelCommand } {
  if (state.phase !== 'confirmingSend') {
    return { state, command: { kind: 'none' } };
  }
  return { state: { phase: 'idle' }, command: { kind: 'callSend' } };
}

export function cancelSend(): PanelPhaseState {
  return { phase: 'idle' };
}

/** Mirrors `clickSend`/`confirmSend` for the force re-send, its own gate. */
export function clickForce(): { state: PanelPhaseState; command: PanelCommand } {
  return { state: { phase: 'confirmingForce' }, command: { kind: 'none' } };
}

export function confirmForce(
  state: PanelPhaseState,
): { state: PanelPhaseState; command: PanelCommand } {
  if (state.phase !== 'confirmingForce') {
    return { state, command: { kind: 'none' } };
  }
  return { state: { phase: 'idle' }, command: { kind: 'callForce' } };
}

export function cancelForce(): PanelPhaseState {
  return { phase: 'idle' };
}

/** Counts worth surfacing on a result — omits anything already zero. */
export function nonZeroCounts(result: {
  unresolved: unknown[];
  incomplete: unknown[];
  unattributedCommits: number;
}): { label: string; value: number }[] {
  const counts: { label: string; value: number }[] = [];
  if (result.unresolved.length > 0) {
    counts.push({ label: 'unresolved roster entries', value: result.unresolved.length });
  }
  if (result.incomplete.length > 0) {
    counts.push({ label: 'incomplete (withheld) entries', value: result.incomplete.length });
  }
  if (result.unattributedCommits > 0) {
    counts.push({ label: 'unattributed commits', value: result.unattributedCommits });
  }
  return counts;
}
