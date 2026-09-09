import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input } from '../../../components/ui';
import { api } from '../../../lib/api/client';
import { useAuthStore } from '../../../lib/stores/auth-store';

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

/**
 * The one write in Sprint Health: an explicit human statement of when an RC
 * was planned to release, with the name of whoever made it (recorded
 * server-side). Jira cannot answer this question itself — a version carries
 * exactly one date field and overwrites it with the actual release day the
 * moment the version ships, so by the time you'd want to compare planned vs
 * actual, the plan is already gone. SprintIQ records the statement instead
 * of guessing at it.
 *
 * Admin-only, mirroring the server (`@Roles(Role.ADMIN)` on both routes in
 * `release-plan.controller.ts`) — hiding the input here is a UI courtesy,
 * not the enforcement; the server checks regardless. Non-admins get the
 * recorded date as plain text.
 */
export function PlannedDateField({
  projectKey,
  name,
  sprint,
  plannedReleaseAt,
}: {
  projectKey: string;
  name: string;
  sprint: string;
  plannedReleaseAt: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roles.includes('admin') ?? false;
  const queryClient = useQueryClient();

  // Adjusted during render rather than in an effect, same reasoning as
  // CheckInGrid's `trackedSprint`: an effect fires one frame after the prop
  // changes, so this would briefly show a stale draft for a card whose data
  // just refetched (e.g. after another admin's edit lands).
  const [trackedPlanned, setTrackedPlanned] = useState(plannedReleaseAt);
  const [draft, setDraft] = useState(toDateInputValue(plannedReleaseAt));
  if (plannedReleaseAt !== trackedPlanned) {
    setTrackedPlanned(plannedReleaseAt);
    setDraft(toDateInputValue(plannedReleaseAt));
  }

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ['sprint-release-candidates', sprint],
    });

  const revertDraft = () => setDraft(toDateInputValue(plannedReleaseAt));

  const setPlan = useMutation({
    mutationFn: (value: string) =>
      api.put<{ plannedReleaseAt: string }>('/api/dashboards/release-plan', {
        projectKey,
        name,
        plannedReleaseAt: value,
      }),
    onSuccess: invalidate,
    onError: revertDraft,
  });

  const clearPlan = useMutation({
    mutationFn: () => {
      const params = new URLSearchParams({ projectKey, name });
      return api.delete<{ ok: true }>(`/api/dashboards/release-plan?${params}`);
    },
    onSuccess: invalidate,
    onError: revertDraft,
  });

  // Committed on blur/Enter, not on every keystroke: a partially-typed date
  // (e.g. mid-entry on the year) can trip the server's 365-day drift guard,
  // 400, and revert the field while the user is still typing — and each
  // attempted keystroke would otherwise write its own audit row. `draft` is
  // still updated on every keystroke (the input's `onChange`) so the field
  // feels responsive; only the write is deferred to when the user is
  // actually done with it.
  const commitDraft = (value: string) => {
    if (value === toDateInputValue(plannedReleaseAt)) {
      // Nothing changed since the last saved value — e.g. tabbing through
      // the field without editing it. Skip the write and the audit row.
      return;
    }
    // PUTs a new plan, or DELETEs the recorded one when cleared — a
    // rejected write must never leave the field looking saved, so both
    // mutations revert the draft on failure (`revertDraft` above).
    if (value) {
      setPlan.mutate(value);
    } else {
      clearPlan.mutate();
    }
  };

  if (!isAdmin) {
    return <span className="tabular-nums text-fg">{formatDate(plannedReleaseAt)}</span>;
  }

  const error = setPlan.error ?? clearPlan.error;
  const pending = setPlan.isPending || clearPlan.isPending;

  return (
    <div className="space-y-1">
      <Input
        type="date"
        className="w-40"
        value={draft}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commitDraft(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitDraft(draft);
          }
        }}
      />
      {error && (
        <p className="text-xs text-danger-fg">
          {error instanceof Error ? error.message : 'Could not save the planned date.'}
        </p>
      )}
    </div>
  );
}
