/**
 * Test helpers (not bundled): fixtures in the happy-dom document and a fake
 * Layout that uses happy-dom's real computed styles but rects from a map,
 * because happy-dom has no layout engine.
 */
import type { Layout, Viewport } from './layout';
import type { Rect } from './types';

export const DEFAULT_RECT: Rect = { x: 0, y: 0, w: 100, h: 20 };
export const VIEWPORT: Viewport = { w: 1280, h: 800, scrollX: 0, scrollY: 0 };

/** Replaces the current document's head and body. */
export function fixture(body: string, css = ''): Document {
  document.head.innerHTML = css ? `<style>${css}</style>` : '';
  document.body.innerHTML = body;
  return document;
}

/** Rects keyed by element id; elements without an entry get DEFAULT_RECT (so they count as visible). */
export function fakeLayout(rects: Record<string, Partial<Rect>> = {}, viewport: Viewport = VIEWPORT): Layout {
  return {
    rect(el) {
      const r = rects[el.id];
      return r ? { ...DEFAULT_RECT, ...r } : { ...DEFAULT_RECT };
    },
    style(el) {
      return getComputedStyle(el);
    },
    viewport() {
      return viewport;
    },
  };
}
