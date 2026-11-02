import { useState } from 'react';
import { Field, Input, SegmentedControl } from '../../../components/ui';
import { istTodayKey } from '../../../lib/utils';
import {
  customSeed,
  isValidCustom,
  normalizeRange,
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
 *
 * Whether the fields are showing is this component's own state, not read off
 * the applied range: today → today is applied as the Today preset
 * (`normalizeRange`), and the fields must stay open while it is, or picking
 * today would snatch away the inputs you just used. The segments follow the
 * applied range, so they say Today whenever Today's numbers are on screen.
 *
 * The dates are IST calendar days, and the labels say so: the browser's own
 * picker marks "today" in the machine's timezone, which west of India can be
 * a day behind the IST date the board actually reads.
 */
export function RangeToggle({
  value,
  onChange,
}: {
  value: ActivityRange;
  onChange: (range: ActivityRange) => void;
}) {
  const today = istTodayKey();
  const [open, setOpen] = useState(value.kind === 'custom');
  const [draft, setDraft] = useState(() =>
    value.kind === 'custom' ? { from: value.from, to: value.to } : customSeed(),
  );
  const showFields = open || value.kind === 'custom';

  const select = (key: string) => {
    if (key !== 'custom') {
      setOpen(false);
      onChange({ kind: 'preset', window: key as ActivityWindow });
      return;
    }
    const seeded =
      value.kind === 'custom' ? { from: value.from, to: value.to } : customSeed();
    setDraft(seeded);
    setOpen(true);
    onChange(normalizeRange({ kind: 'custom', ...seeded }));
  };

  const edit = (patch: { from?: string; to?: string }) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // Only a valid pair re-keys the query. An invalid one leaves the boards on
    // the last range they actually fetched — whose interval their own headings
    // still state, so nothing on screen is ever mislabelled.
    if (isValidCustom(next.from, next.to)) {
      onChange(normalizeRange({ kind: 'custom', ...next }));
    }
  };

  const invalid = showFields && !isValidCustom(draft.from, draft.to);

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

      {showFields && (
        <>
          <Field label="From (IST)">
            <Input
              type="date"
              className="w-40"
              value={draft.from}
              max={draft.to || today}
              onChange={(e) => edit({ from: e.target.value })}
            />
          </Field>
          <Field label="To (IST)">
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
