import { useEffect, useLayoutEffect, useState } from 'react';
import { FALLBACK_CHART_WIDTH } from './chart-axes';

// Measure before paint in the browser (no flash at the fallback width); plain
// effect on the server, where a layout effect only warns.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The container's width in px, so a chart's SVG can draw 1:1 instead of
 * scaling a fixed viewBox (which shrank 10px labels to ~5px on a phone).
 * Before the first measurement — and in server rendering and tests — it is
 * `FALLBACK_CHART_WIDTH`.
 */
export function useMeasuredWidth<T extends HTMLElement>() {
  // A callback ref held in state, not a ref object: a chart that first renders
  // its empty state attaches the element later, and the effect must re-run then.
  const [el, ref] = useState<T | null>(null);
  const [width, setWidth] = useState(FALLBACK_CHART_WIDTH);
  useIsomorphicLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [ref, width] as const;
}
