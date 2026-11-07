/**
 * The browser side of pixel refinement: which candidate boxes are on screen
 * right now, and decoding a screenshot (PNG data URL) to RGBA with
 * createImageBitmap and OffscreenCanvas. Browser-only (content script,
 * offscreen document, pages under Playwright), no chrome.* calls. The data
 * URL is decoded in memory; nothing is fetched or stored.
 */
import { applyPixelRefinement, imageMatchesFrame, pixelBoxes, refineFromPixels, type PixelBox, type RgbaImage } from './pixels';
import { ancestors } from './layout';
import type { Candidate, Rect } from './types';

/** What a screenshot of this window should look like. */
export interface CaptureFrame {
  dpr: number;
  /** innerWidth / innerHeight: the screenshot includes the scrollbar. */
  width: number;
  height: number;
}

export function frameOf(win: Window): CaptureFrame {
  return { dpr: win.devicePixelRatio || 1, width: win.innerWidth, height: win.innerHeight };
}

/**
 * True when `el` is what the user sees at the centre of its box: not covered
 * by a pop-up, its backdrop or a sticky bar. Under a dimming backdrop the
 * pixels show the dimmed page, not the element's own colours, so covered
 * elements keep their CSS values.
 */
export function onTop(el: Element, r: Rect, doc: Document): boolean {
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  let hit = doc.elementFromPoint(x, y);
  // Into open shadow roots, where elementFromPoint on the document stops at the host.
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return false;
  if (hit === el || el.contains(hit)) return true;
  for (const a of ancestors(el)) if (a === hit) return true;
  return false;
}

/**
 * The candidates' boxes as they are now (the page may have scrolled since the
 * scan), filtered by pixelBoxes and to elements on top at their centre.
 * Call it with our own highlights hidden, so they never count as covering.
 */
export function boxesNow(candidates: Candidate[], elements: Map<string, Element>, win: Window): PixelBox[] {
  const doc = win.document;
  const de = doc.documentElement;
  const viewport = { w: de.clientWidth || win.innerWidth, h: de.clientHeight || win.innerHeight };
  const rects = new Map<string, Rect>();
  for (const c of candidates) {
    const el = elements.get(c.id);
    if (!el?.isConnected) continue;
    const b = el.getBoundingClientRect();
    rects.set(c.id, { x: b.left, y: b.top, w: b.width, h: b.height });
  }
  return pixelBoxes(candidates, rects, viewport).filter((box) => onTop(elements.get(box.id)!, box.rect, doc));
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function decodeImage(src: string | Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(typeof src === 'string' ? dataUrlToBlob(src) : src);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/**
 * One-process refinement for the Playwright tools: boxes now, one capture,
 * decode, refine, apply. Any failure keeps the CSS values.
 */
export async function refineWithCapture(
  candidates: Candidate[],
  elements: Map<string, Element>,
  win: Window,
  capture: () => Promise<string | null>,
): Promise<Candidate[]> {
  try {
    const boxes = boxesNow(candidates, elements, win);
    if (!boxes.length) return candidates;
    const frame = frameOf(win);
    const dataUrl = await capture();
    if (!dataUrl) return candidates;
    const img = await decodeImage(dataUrl);
    if (!imageMatchesFrame(img, frame)) return candidates;
    return applyPixelRefinement(candidates, refineFromPixels(img, frame.dpr, boxes));
  } catch {
    return candidates;
  }
}
