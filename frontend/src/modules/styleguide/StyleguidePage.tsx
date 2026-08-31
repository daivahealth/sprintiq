import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Field,
  FilterBar,
  Input,
  NavItem,
  ProvenanceNote,
  SegmentedControl,
  Skeleton,
  Spinner,
  StatusDot,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { cn } from '../../lib/utils';

/**
 * Dev-only review surface for the design system. Mounted at `/_styleguide`
 * under `import.meta.env.DEV` only, and deliberately outside `RequireAuth` so
 * it renders with no backend and no login.
 *
 * It exists because this repository has no component tests — `vitest` runs in a
 * node environment with no DOM. `tsc`, `eslint` and `vite build` prove the
 * primitives compile; only a person looking at this page can say whether they
 * look right. Keep it current when adding a primitive.
 */

const CHART_SWATCHES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
] as const;

const ROWS = [
  { repo: 'sprintiq/api', prs: 12, linked: '94%', tone: 'good' as const },
  { repo: 'sprintiq/web', prs: 7, linked: '71%', tone: 'warn' as const },
  { repo: 'sprintiq/infra', prs: 3, linked: '38%', tone: 'bad' as const },
  { repo: 'sprintiq/collectors', prs: 9, linked: '88%', tone: 'good' as const },
  { repo: 'sprintiq/docs', prs: 1, linked: '52%', tone: 'warn' as const },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Gallery() {
  return (
    <div className="min-h-full bg-canvas p-6 text-fg">
      <div className="space-y-8">
        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Run analysis</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">Details</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="primary" disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Badges and status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">Neutral</Badge>
            <Badge tone="good">On track</Badge>
            <Badge tone="warn">At risk</Badge>
            <Badge tone="bad">Blocked</Badge>
            <StatusDot tone="good" />
            <StatusDot tone="warn" />
            <StatusDot tone="bad" />
            <StatusDot tone="neutral" size="md" />
            <Spinner />
          </div>
        </Section>

        <Section title="Status tints on popover surface">
          <div className="flex flex-wrap items-center gap-2 bg-popover p-3">
            <Badge tone="good">On track</Badge>
            <Badge tone="warn">At risk</Badge>
            <Badge tone="bad">Blocked</Badge>
          </div>
        </Section>

        <Section title="KPI trio">
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Cycle time', '3.2d', '−0.4d vs prev'],
              ['Review latency', '14h', '+2h vs prev'],
              ['Deploy freq', '4.1/d', 'stable'],
            ].map(([label, value, hint]) => (
              <Card key={label}>
                <div className="text-[28px] font-bold tracking-[-0.045em] tabular-nums text-fg">
                  {value}
                </div>
                <div className="text-xs text-fg-subtle">{label}</div>
                <div className="mt-0.5 text-[11px] text-fg-faint">{hint}</div>
              </Card>
            ))}
          </div>
        </Section>

        <Section title="Dense table">
          <Card>
            <table className="w-full">
              <thead>
                <TableHeadRow>
                  <th className="py-2 pr-3">Repository</th>
                  <th className="py-2 pr-3">Open PRs</th>
                  <th className="py-2 pr-3">Linked</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <TableBodyRow key={r.repo}>
                    <td className="py-2.5 pr-3 text-sm">
                      <StatusDot tone={r.tone} /> {r.repo}
                    </td>
                    <td className="py-2.5 pr-3 text-sm tabular-nums">{r.prs}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={r.tone}>{r.linked}</Badge>
                    </td>
                  </TableBodyRow>
                ))}
              </tbody>
            </table>
            <ProvenanceNote className="mt-3">
              Computed 6 minutes ago · 214 events · linkage coverage 78%
            </ProvenanceNote>
          </Card>
        </Section>

        <Section title="Chart series">
          <div className="flex items-end gap-1">
            {CHART_SWATCHES.map((c, i) => (
              <span key={c} className={cn(c, 'block w-8')} style={{ height: 24 + i * 8 }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-fg-subtle">
            {CHART_SWATCHES.map((c, i) => (
              <span key={c} className="flex items-center gap-1.5">
                <span className={cn(c, 'inline-block h-2 w-2')} />
                Series {i + 1}
              </span>
            ))}
          </div>
        </Section>

        <Section title="Controls">
          <FilterBar>
            <Field label="Repository">
              <Input placeholder="sprintiq/api" />
            </Field>
            <Field label="Disabled">
              <Input placeholder="Disabled" disabled />
            </Field>
            <SegmentedControl
              label="Range"
              value="30d"
              options={[
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: '90d', label: '90 days' },
              ]}
              onChange={() => undefined}
            />
          </FilterBar>
        </Section>

        <Section title="Navigation">
          <div className="w-56 space-y-1">
            <NavItem to="/_styleguide" active>Active item</NavItem>
            <NavItem to="/_styleguide/never">Inactive item</NavItem>
          </div>
        </Section>

        <Section title="Skeletons">
          <div className="space-y-2">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Section>
      </div>
    </div>
  );
}

export function StyleguidePage() {
  return (
    <div className="grid min-h-screen grid-cols-2">
      <Gallery />
      <div className="dark">
        <Gallery />
      </div>
    </div>
  );
}
