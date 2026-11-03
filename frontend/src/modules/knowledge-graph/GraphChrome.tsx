import {
  ChevronRight,
  Maximize2,
  RotateCcw,
  Tags,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  DRAWABLE_ENTITIES,
  ENTITY_REGISTRY,
  RELATION_REGISTRY,
  type EntityType,
} from './entity-registry';

/** Toolbar, legend and breadcrumb around the canvas. Props only. */

function ToolButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      title={label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-border-strong px-2.5 py-1.5 text-xs text-fg-muted transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50',
        pressed && 'bg-fg text-canvas hover:bg-fg',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

export function GraphToolbar({
  onZoomIn,
  onZoomOut,
  onFit,
  onReset,
  showEdgeLabels,
  onToggleEdgeLabels,
  canReset,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
  showEdgeLabels: boolean;
  onToggleEdgeLabels: () => void;
  canReset: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToolButton icon={ZoomIn} label="Zoom in" onClick={onZoomIn} />
      <ToolButton icon={ZoomOut} label="Zoom out" onClick={onZoomOut} />
      <ToolButton icon={Maximize2} label="Fit" onClick={onFit} />
      <ToolButton
        icon={RotateCcw}
        label="Reset"
        onClick={onReset}
        disabled={!canReset}
      />
      <ToolButton
        icon={Tags}
        label="Relationship labels"
        onClick={onToggleEdgeLabels}
        pressed={showEdgeLabels}
      />
    </div>
  );
}

/** A registry entity's swatch: its token colour, its icon. */
export function EntitySwatch({ type }: { type: EntityType }) {
  const entity = ENTITY_REGISTRY[type];
  const Icon = entity.icon;
  return (
    <span
      className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-sm text-on-brand"
      style={{ backgroundColor: `rgb(var(${entity.colorToken}))` }}
      aria-hidden
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

export function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-subtle">
      {DRAWABLE_ENTITIES.map((entity) => (
        <span key={entity.type} className="inline-flex items-center gap-1.5">
          <EntitySwatch type={entity.type} />
          {entity.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="w-6 border-t border-fg-muted" aria-hidden />
        recorded
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        title={`${RELATION_REGISTRY.CONTRIBUTED_TO.description} ${RELATION_REGISTRY.REFERENCES.description}`}
      >
        <span className="w-6 border-t border-dashed border-fg-muted" aria-hidden />
        derived or inferred
      </span>
    </div>
  );
}

export interface Crumb {
  key: string;
  type: EntityType;
  label: string;
}

export function GraphBreadcrumb({
  crumbs,
  onNavigate,
}: {
  crumbs: Crumb[];
  onNavigate: (index: number) => void;
}) {
  if (crumbs.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Exploration history" className="flex flex-wrap items-center gap-1 text-xs">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={`${crumb.key}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3 w-3 text-fg-faint" aria-hidden />}
            <button
              type="button"
              onClick={() => onNavigate(index)}
              disabled={last}
              aria-current={last ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5',
                last
                  ? 'font-semibold text-fg'
                  : 'text-brand hover:bg-brand/5',
              )}
            >
              <span className="text-fg-faint">{ENTITY_REGISTRY[crumb.type].label}:</span>
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
