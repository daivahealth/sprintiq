import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import type { RunDigestResult } from '../../lib/api/types';
import { previousWorkingDayKey } from '../../lib/utils';
import { Badge, Button, Card } from '../../components/ui';
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
  sendConfirmationCopy,
  type PanelPhase,
  type PanelPhaseState,
} from './notification-test-panel-logic';

const RUN_URL = '/api/admin/notifications/no-commit-digest/run';

type SendOutcomeState =
  | { kind: 'result'; result: RunDigestResult }
  | { kind: 'error'; status: number; message: string }
  | null;

function DigestResultSummary({ result }: { result: RunDigestResult }) {
  const counts = nonZeroCounts(result);
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-fg">
        <span className="font-medium">{result.reportedDay}</span> —{' '}
        {outcomeLabel(result.outcome)}
      </p>
      {result.detail ? (
        <p className="text-sm font-medium text-warning-fg">{result.detail}</p>
      ) : null}
      {result.flagged.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg">
          {result.flagged.map((d) => (
            <li key={d.developer}>{d.displayName}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-subtle">Nobody would be named.</p>
      )}
      {counts.length > 0 ? (
        <p className="text-xs text-fg-subtle">
          {counts.map((c) => `${c.value} ${c.label}`).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

export interface NotificationTestPanelViewProps {
  /** Best-effort reporting day computed client-side before any call has been made. */
  reportedDayGuess: string;
  previewPending: boolean;
  sendPending: boolean;
  forcePending: boolean;
  previewResult: RunDigestResult | null;
  previewErrorMessage: string | null;
  phase: PanelPhase;
  sendOutcome: SendOutcomeState;
  onPreviewClick: () => void;
  onSendClick: () => void;
  onConfirmSendClick: () => void;
  onCancelSendClick: () => void;
  onForceClick: () => void;
  onConfirmForceClick: () => void;
  onCancelForceClick: () => void;
}

/**
 * Pure presentational half of the panel — no hooks, no mutations. Kept
 * separate so the render test (`notification-test-panel-render.test.ts`) can
 * feed it fabricated states via `react-dom/server` and assert on the
 * resulting markup, the same way `MonthlyTrendChart` is tested, without a DOM
 * or a testing-library dependency this repo doesn't otherwise carry.
 */
export function NotificationTestPanelView({
  reportedDayGuess,
  previewPending,
  sendPending,
  forcePending,
  previewResult,
  previewErrorMessage,
  phase,
  sendOutcome,
  onPreviewClick,
  onSendClick,
  onConfirmSendClick,
  onCancelSendClick,
  onForceClick,
  onConfirmForceClick,
  onCancelForceClick,
}: NotificationTestPanelViewProps) {
  const anyPending = previewPending || sendPending || forcePending;
  const conflict =
    sendOutcome?.kind === 'error' &&
    isAlreadySentConflict(sendOutcome.status, sendOutcome.message)
      ? sendOutcome
      : null;
  const otherSendError = sendOutcome?.kind === 'error' && !conflict ? sendOutcome : null;

  const reportedDay =
    previewResult?.reportedDay ??
    (sendOutcome?.kind === 'result' ? sendOutcome.result.reportedDay : undefined) ??
    reportedDayGuess;
  const previewFlaggedCount = previewResult?.flagged.length ?? null;

  return (
    <Card className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-fg">Test the notification</p>
        <p className="mt-1 text-xs text-fg-subtle">
          Trigger the weekday no-activity digest immediately, instead of
          waiting for the 10:30 IST cron. This works regardless of the daily
          schedule switch in Configuration — that switch only arms the
          unattended 10:30 IST run, not this panel.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onPreviewClick}
          disabled={anyPending}
        >
          {previewPending ? 'Previewing…' : 'Preview'}
        </Button>

        {phase === 'confirmingSend' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="max-w-sm text-xs text-fg-subtle">
              {sendConfirmationCopy(reportedDay, previewFlaggedCount)}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCancelSendClick}
              disabled={anyPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onConfirmSendClick}
              disabled={anyPending}
            >
              {sendPending ? 'Sending…' : 'Confirm'}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onSendClick}
            disabled={anyPending}
          >
            {sendPending ? 'Sending…' : 'Send to Teams now'}
          </Button>
        )}
      </div>

      <p className="text-xs text-fg-faint">
        Preview posts nothing to Teams — it only computes what the digest
        would do for {reportedDayGuess} (the day it reports on by default) and
        returns the result.
      </p>

      {previewErrorMessage ? (
        <p className="text-sm text-danger-fg">{previewErrorMessage}</p>
      ) : null}

      {previewResult ? (
        <div className="border-t border-border-subtle pt-2">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
            Preview — nothing was posted
          </p>
          <DigestResultSummary result={previewResult} />
        </div>
      ) : null}

      {sendOutcome?.kind === 'result' ? (
        <div className="border-t border-border-subtle pt-2">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
            Sent
          </p>
          <DigestResultSummary result={sendOutcome.result} />
        </div>
      ) : null}

      {conflict ? (
        <div className="space-y-1.5 border-t border-border-subtle pt-2">
          <Badge tone="neutral">Already sent</Badge>
          <p className="text-sm text-fg-subtle">{conflict.message}</p>
          {phase === 'confirmingForce' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-sm text-xs text-fg-subtle">
                {forceConfirmationCopy(reportedDay, previewFlaggedCount)}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onCancelForceClick}
                disabled={anyPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onConfirmForceClick}
                disabled={anyPending}
              >
                {forcePending ? 'Sending…' : 'Confirm'}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onForceClick}
              disabled={anyPending}
            >
              Send again anyway
            </Button>
          )}
        </div>
      ) : null}

      {otherSendError ? (
        <p className="text-sm text-danger-fg">{otherSendError.message}</p>
      ) : null}
    </Card>
  );
}

/**
 * Stateful container: wires the three digest-run calls (preview / send /
 * force) and the confirmation gating in `notification-test-panel-logic.ts` to
 * `NotificationTestPanelView`.
 *
 * Three separate mutations, not one shared mutation reused for all three
 * bodies — `anyPending` (used to disable every button) is the OR of their
 * `isPending` flags, so a double-click on any button while any of the three
 * is in flight is blocked, without a fourth boolean to keep in sync by hand.
 */
export function NotificationTestPanel() {
  const [phaseState, setPhaseState] = useState<PanelPhaseState>(INITIAL_PANEL_PHASE);
  const [sendOutcome, setSendOutcome] = useState<SendOutcomeState>(null);

  const previewMutation = useMutation({
    mutationFn: () => api.post<RunDigestResult>(RUN_URL, PREVIEW_BODY),
  });
  const sendMutation = useMutation({
    mutationFn: () => api.post<RunDigestResult>(RUN_URL, SEND_BODY),
  });
  const forceMutation = useMutation({
    mutationFn: () => api.post<RunDigestResult>(RUN_URL, FORCE_BODY),
  });

  const recordOutcome = (result: RunDigestResult) =>
    setSendOutcome({ kind: 'result', result });
  const recordError = (error: unknown) =>
    setSendOutcome(
      error instanceof ApiError
        ? { kind: 'error', status: error.status, message: error.message }
        : { kind: 'error', status: 0, message: 'Could not reach the server.' },
    );

  const handlePreviewClick = () => {
    const command = clickPreview();
    if (command.kind === 'callPreview') {
      previewMutation.mutate();
    }
  };

  const handleSendClick = () => setPhaseState(clickSend().state);
  const handleCancelSendClick = () => setPhaseState(cancelSend());
  const handleConfirmSendClick = () => {
    const { state, command } = confirmSend(phaseState);
    setPhaseState(state);
    if (command.kind === 'callSend') {
      sendMutation.mutate(undefined, {
        onSuccess: recordOutcome,
        onError: recordError,
      });
    }
  };

  const handleForceClick = () => setPhaseState(clickForce().state);
  const handleCancelForceClick = () => setPhaseState(cancelForce());
  const handleConfirmForceClick = () => {
    const { state, command } = confirmForce(phaseState);
    setPhaseState(state);
    if (command.kind === 'callForce') {
      forceMutation.mutate(undefined, {
        onSuccess: recordOutcome,
        onError: recordError,
      });
    }
  };

  return (
    <NotificationTestPanelView
      reportedDayGuess={previousWorkingDayKey()}
      previewPending={previewMutation.isPending}
      sendPending={sendMutation.isPending}
      forcePending={forceMutation.isPending}
      previewResult={previewMutation.data ?? null}
      previewErrorMessage={
        previewMutation.isError
          ? previewMutation.error instanceof ApiError
            ? previewMutation.error.message
            : 'Could not run the preview.'
          : null
      }
      phase={phaseState.phase}
      sendOutcome={sendOutcome}
      onPreviewClick={handlePreviewClick}
      onSendClick={handleSendClick}
      onConfirmSendClick={handleConfirmSendClick}
      onCancelSendClick={handleCancelSendClick}
      onForceClick={handleForceClick}
      onConfirmForceClick={handleConfirmForceClick}
      onCancelForceClick={handleCancelForceClick}
    />
  );
}
