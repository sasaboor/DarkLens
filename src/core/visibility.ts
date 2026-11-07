import { ancestors, type Layout } from './layout';

export interface Visibility {
  /** False if the element or any ancestor has display: none. */
  displayed(el: Element): boolean;
  /** Product of opacity over the element and its ancestors. */
  opacity(el: Element): number;
  /** The spec's visibility test: rendered, not hidden, not transparent, has size, not fully off the document. */
  isVisible(el: Element): boolean;
}

/** Caches per element, so make one per scan. */
export function createVisibility(layout: Layout): Visibility {
  const displayedCache = new Map<Element, boolean>();
  const opacityCache = new Map<Element, number>();

  function displayed(el: Element): boolean {
    const hit = displayedCache.get(el);
    if (hit !== undefined) return hit;
    const chain: Element[] = [];
    let result = true;
    for (const a of ancestors(el)) {
      const cached = displayedCache.get(a);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      chain.push(a);
      if (layout.style(a).display === 'none') {
        result = false;
        break;
      }
    }
    // Everything below a display:none ancestor is hidden too; everything above it is unknown.
    if (result) for (const a of chain) displayedCache.set(a, true);
    else displayedCache.set(el, false);
    return result;
  }

  function opacity(el: Element): number {
    const hit = opacityCache.get(el);
    if (hit !== undefined) return hit;
    const own = parseFloat(layout.style(el).opacity);
    let parentOpacity = 1;
    for (const a of ancestors(el)) {
      if (a === el) continue;
      parentOpacity = opacity(a);
      break;
    }
    const value = (Number.isFinite(own) ? own : 1) * parentOpacity;
    opacityCache.set(el, value);
    return value;
  }

  function isVisible(el: Element): boolean {
    if (!displayed(el)) return false;
    const style = layout.style(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (opacity(el) <= 0.01) return false;
    const r = layout.rect(el);
    if (r.w <= 0 || r.h <= 0 || (r.w < 2 && r.h < 2)) return false;
    const vp = layout.viewport();
    if (r.x + vp.scrollX + r.w <= 0 || r.y + vp.scrollY + r.h <= 0) return false;
    return true;
  }

  return { displayed, opacity, isVisible };
}
