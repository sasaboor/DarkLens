/**
 * Every layout-dependent read (rects, computed styles, viewport) goes through
 * a Layout, so the extractor and features can be unit tested with fake rects
 * in a DOM implementation that has no layout engine.
 */
import type { Rect } from './types';

export interface Viewport {
  w: number;
  h: number;
  scrollX: number;
  scrollY: number;
}

export interface Layout {
  rect(el: Element): Rect;
  style(el: Element): CSSStyleDeclaration;
  viewport(): Viewport;
}

/** The real browser layout. Styles are cached for the lifetime of the object, so make one per scan. */
export function domLayout(win: Window): Layout {
  const styles = new Map<Element, CSSStyleDeclaration>();
  return {
    rect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    style(el) {
      let s = styles.get(el);
      if (!s) {
        s = win.getComputedStyle(el);
        styles.set(el, s);
      }
      return s;
    },
    viewport() {
      const de = win.document.documentElement;
      return {
        w: de.clientWidth || win.innerWidth,
        h: de.clientHeight || win.innerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
      };
    },
  };
}

/** Parent element, crossing open shadow-root boundaries to the host. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.parentNode;
  if (root && root.nodeType === 11 && 'host' in root) return (root as ShadowRoot).host;
  return null;
}

/** Inclusive ancestors, crossing shadow boundaries. */
export function* ancestors(el: Element): Generator<Element> {
  for (let cur: Element | null = el; cur; cur = parentOf(cur)) yield cur;
}

export function closestAcross(el: Element, selector: string): Element | null {
  for (const a of ancestors(el)) if (a.matches(selector)) return a;
  return null;
}

export function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function distance(a: Rect, b: Rect): number {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** Area of r inside the viewport. */
export function visibleArea(r: Rect, vp: Viewport): number {
  const w = Math.max(0, Math.min(r.x + r.w, vp.w) - Math.max(r.x, 0));
  const h = Math.max(0, Math.min(r.y + r.h, vp.h) - Math.max(r.y, 0));
  return w * h;
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}
