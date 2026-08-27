import { useState } from 'react';
import { Field, Input, SegmentedControl } from '../../../components/ui';
import { istTodayKey } from '../../../lib/utils';
import {
  isValidCustom,
  presetDateKeys,
  type ActivityRange,
} from '../activity-range';
import { WINDOWS } from '../activity-window';
import type { ActivityWindow } from '../useInsights';

/**
 * The section's range: five presets, or an interval of your own.
 *
 * A sixth segment rather than a popover, because the presets stay one click
 * away instead of two and the whole thing is keyboard-reachable without a
 * focus trap. The date fields appear only when Custom is selected — four tabs
 * carrying two permanently-empty inputs would be paying for the rare case on
 * every visit.
 */
export function RangeToggle({
  value,
  onChange,
}: {
  value: ActivityRange;
  onChange: (range: ActivityRange) => void;
}) {
  const today = istTodayKey();
  // Seeded from the preset you were reading, so choosing Custom never blanks
  // the board: you land on the range you were already looking at.
  const [draft, setDraft] = useState(() =>
    value.kind === 'custom'
      ? { from: value.from, to: value.to }
      : presetDateKeys(value.window),
  );

  const select = (key: string) => {
    if (key !== 'custom') {
      onChange({ kind: 'preset', window: key as ActivityWindow });
      return;
    }
    const seeded =
      value.kind === 'custom'
        ? { from: value.from, to: value.to }
        : presetDateKeys(value.window);
    setDraft(seeded);
    onChange({ kind: 'custom', ...seeded });
  };

  const edit = (patch: { from?: string; to?: string }) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // Only a valid pair re-keys the query. An invalid one leaves the boards on
    // the last range they actually fetched — whose interval their own headings
    // still state, so nothing on screen is ever mislabelled.
    if (isValidCustom(next.from, next.to)) {
      onChange({ kind: 'custom', ...next });
    }
  };

  const invalid =
    value.kind === 'custom' && !isValidCustom(draft.from, draft.to);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <SegmentedControl
        label="Window"
        value={value.kind === 'custom' ? 'custom' : value.window}
        onChange={select}
        options={[
          ...WINDOWS.map((w) => ({ value: w.key as string, label: w.label })),
          { value: 'custom', label: 'Custom' },
        ]}
      />

      {value.kind === 'custom' && (
        <>
          <Field label="From">
            <Input
              type="date"
              className="w-40"
              value={draft.from}
              max={draft.to || today}
              onChange={(e) => edit({ from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              className="w-40"
              value={draft.to}
              min={draft.from}
              max={today}
              onChange={(e) => edit({ to: e.target.value })}
            />
          </Field>
          {invalid && (
            <p className="pb-2 text-xs text-warning-fg">
              Pick a start on or before the end, and an end no later than today.
              Still showing the last valid range.
            </p>
          )}
        </>
      )}
    </div>
  );
}
