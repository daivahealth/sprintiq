import cytoscape from 'cytoscape';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { ENTITY_REGISTRY, RELATION_REGISTRY } from './entity-registry';
import type { GraphData } from './graph-model';

export interface GraphCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  relayout: () => void;
}

interface GraphCanvasProps {
  graph: GraphData;
  /** The node the layout radiates from. */
  rootId: string | null;
  selectedId: string | null;
  showEdgeLabels: boolean;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string) => void;
  onExpandNode: (id: string) => void;
}

interface Hover {
  x: number;
  y: number;
  title: string;
  kind: string;
}

/** A design token's `R G B` channels as a colour Cytoscape understands. */
function tokenColor(token: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return raw ? `rgb(${raw.split(/\s+/).join(',')})` : '#888';
}

function stylesheet(): cytoscape.StylesheetJson {
  const fg = tokenColor('--fg');
  const muted = tokenColor('--fg-muted');
  const line = tokenColor('--border-strong');
  const surface = tokenColor('--surface');
  const brand = tokenColor('--brand');
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        shape: 'data(shape)' as never,
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        color: fg,
        'font-size': 10,
        'font-family': 'Inter Variable, ui-sans-serif, system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-max-width': '120px',
        'text-wrap': 'ellipsis',
        'text-background-color': surface,
        'text-background-opacity': 0.85,
        'text-background-padding': '1px',
        'border-width': 0,
      },
    },
    {
      selector: 'node.is-root',
      style: { 'font-weight': 'bold', 'font-size': 12 },
    },
    {
      selector: 'node.is-selected',
      style: { 'border-width': 3, 'border-color': brand },
    },
    {
      selector: 'node.is-placeholder',
      style: { 'background-opacity': 0.35 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.25,
        'line-color': line,
        'target-arrow-color': line,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
        'line-style': 'data(lineStyle)' as never,
        'font-size': 8,
        color: muted,
        'text-rotation': 'autorotate',
        'text-background-color': surface,
        'text-background-opacity': 0.85,
      },
    },
    { selector: 'edge.with-label', style: { label: 'data(label)' } },
    {
      selector: 'edge.is-selected',
      style: { width: 2.5, 'line-color': brand, 'target-arrow-color': brand },
    },
  ];
}

function toElements(graph: GraphData): cytoscape.ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => {
      const entity = ENTITY_REGISTRY[node.type];
      return {
        group: 'nodes' as const,
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
          shape: entity.shape,
          size: entity.size,
          color: tokenColor(entity.colorToken),
        },
        classes:
          node.detail.kind === 'pull_request' && node.detail.pullRequest === null
            ? 'is-placeholder'
            : '',
      };
    }),
    ...graph.edges.map((edge) => {
      const relation = RELATION_REGISTRY[edge.relation];
      return {
        group: 'edges' as const,
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label:
            edge.confidence !== undefined
              ? `${relation.label} (${Math.round(edge.confidence * 100)}%)`
              : relation.label,
          lineStyle: relation.style,
        },
      };
    }),
  ];
}

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The interactive canvas. Generic over entity types: every type-specific
 * choice (shape, colour, size, edge style) comes from the registries, so a new
 * entity type never touches this file.
 *
 * Elements are reconciled by id rather than rebuilt, so a node the user dragged
 * keeps its place until the layout is explicitly re-run; additions re-run the
 * layout so expanded nodes land beside what they expand.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(
    {
      graph,
      rootId,
      selectedId,
      showEdgeLabels,
      onSelectNode,
      onSelectEdge,
      onExpandNode,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<cytoscape.Core | null>(null);
    const [hover, setHover] = useState<Hover | null>(null);
    // Latest callbacks, so the listeners bound once never go stale.
    const handlers = useRef({ onSelectNode, onSelectEdge, onExpandNode });
    handlers.current = { onSelectNode, onSelectEdge, onExpandNode };

    const runLayout = () => {
      const cy = cyRef.current;
      if (!cy || cy.nodes().length === 0) {
        return;
      }
      const roots = rootId ? cy.getElementById(rootId) : undefined;
      cy.layout({
        name: 'breadthfirst',
        directed: false,
        roots: roots && roots.length ? roots : undefined,
        spacingFactor: 1.15,
        avoidOverlap: true,
        animate: !prefersReducedMotion(),
        animationDuration: 250,
        fit: true,
        padding: 24,
      } as cytoscape.LayoutOptions).run();
    };

    useImperativeHandle(ref, () => ({
      zoomIn: () => cyRef.current?.zoom(cyRef.current.zoom() * 1.25),
      zoomOut: () => cyRef.current?.zoom(cyRef.current.zoom() / 1.25),
      fit: () => cyRef.current?.fit(undefined, 24),
      relayout: runLayout,
    }));

    // Create once.
    useEffect(() => {
      if (!containerRef.current) {
        return;
      }
      const cy = cytoscape({
        container: containerRef.current,
        style: stylesheet(),
        autounselectify: true,
        minZoom: 0.15,
        maxZoom: 3,
        wheelSensitivity: 0.25,
      });
      cyRef.current = cy;

      cy.on('tap', 'node', (e) => handlers.current.onSelectNode(e.target.id()));
      cy.on('tap', 'edge', (e) => handlers.current.onSelectEdge(e.target.id()));
      cy.on('tap', (e) => {
        if (e.target === cy) {
          handlers.current.onSelectNode(null);
        }
      });
      cy.on('dbltap', 'node', (e) => handlers.current.onExpandNode(e.target.id()));
      cy.on('mouseover', 'node', (e) => {
        const pos = e.target.renderedPosition();
        setHover({
          x: pos.x,
          y: pos.y,
          title: e.target.data('label'),
          kind: ENTITY_REGISTRY[e.target.data('type') as keyof typeof ENTITY_REGISTRY]?.label ?? '',
        });
      });
      cy.on('mouseout', 'node', () => setHover(null));
      cy.on('pan zoom drag', () => setHover(null));

      // Colours are tokens: re-resolve them when the theme flips.
      const observer = new MutationObserver(() => {
        cy.style(stylesheet());
        cy.nodes().forEach((node) => {
          const type = node.data('type') as keyof typeof ENTITY_REGISTRY;
          node.data('color', tokenColor(ENTITY_REGISTRY[type].colorToken));
        });
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });

      return () => {
        observer.disconnect();
        cy.destroy();
        cyRef.current = null;
      };
    }, []);

    // Reconcile elements by id.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      const next = toElements(graph);
      const nextIds = new Set(next.map((el) => el.data.id as string));
      let changed = false;
      cy.batch(() => {
        cy.elements().forEach((el) => {
          if (!nextIds.has(el.id())) {
            el.remove();
            changed = true;
          }
        });
        // Nodes before edges, so every edge finds its endpoints.
        for (const el of next) {
          const existing = cy.getElementById(el.data.id as string);
          if (existing.length) {
            existing.data(el.data);
            existing.classes(el.classes ?? '');
          } else {
            cy.add(el);
            changed = true;
          }
        }
      });
      if (changed) {
        runLayout();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graph]);

    // Root, selection and labels are classes, not elements.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      cy.batch(() => {
        cy.elements().removeClass('is-root is-selected');
        if (rootId) cy.getElementById(rootId).addClass('is-root');
        if (selectedId) cy.getElementById(selectedId).addClass('is-selected');
        cy.edges().toggleClass('with-label', showEdgeLabels);
      });
    }, [graph, rootId, selectedId, showEdgeLabels]);

    return (
      <div className="relative h-full w-full">
        <div
          ref={containerRef}
          className="h-full w-full"
          role="img"
          aria-label="Knowledge graph. Use the details panel and activity tables for a text view of the same relationships."
        />
        {hover && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-sm border border-border bg-popover px-2 py-1 text-xs shadow-lg"
            style={{ left: hover.x, top: hover.y - 18 }}
          >
            <span className="font-medium text-fg">{hover.title}</span>
            <span className="ml-1.5 text-fg-faint">{hover.kind}</span>
          </div>
        )}
      </div>
    );
  },
);
