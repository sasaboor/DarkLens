/**
 * Pixel refinement of f03 and f04 from the content script's side. Our
 * highlights are hidden while the background captures the visible tab, and
 * come back as soon as the capture is taken; the offscreen document then
 * crops and measures each on-screen candidate. Results are cached per element
 * for this page, so a scan whose capture is throttled (at most one per 2 s)
 * keeps the earlier pixel values instead of flipping back to CSS ones. Any
 * failure keeps the CSS values silently.
 */
import { boxesNow, frameOf } from '@/src/core/capture';
import { applyPixelRefinement, type PixelRefinement } from '@/src/core/pixels';
import type { Candidate } from '@/src/core/types';
import {
  PIXELS_CAPTURE,
  PIXELS_RESULT,
  type PixelsCaptureMessage,
  type PixelsCaptureReply,
  type PixelsResultMessage,
  type PixelsResultReply,
} from '@/src/messages';
import type { Overlay } from './overlay';

/** How long a scan waits for the offscreen measurement before using CSS values. */
const RESULT_TIMEOUT_MS = 1500;

/** Two animation frames (so the hidden overlay is really off screen), or 100 ms if frames are not running. */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(done);
        resolve();
      }),
    );
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

export function createPixelRefiner(overlay: Overlay) {
  let cache = new WeakMap<Element, PixelRefinement>();

  /** Fresh measurements, and a short status for the debug log ("measured 21", "throttled", …). */
  async function measure(
    candidates: Candidate[],
    elements: Map<string, Element>,
  ): Promise<{ refined: Record<string, PixelRefinement>; status: string }> {
    const none = (status: string) => ({ refined: {}, status });
    if (document.visibilityState !== 'visible') return none('tab hidden');
    let capture: PixelsCaptureReply | undefined;
    overlay.hideForCapture(true);
    try {
      await painted();
      // With our highlights hidden, so they never count as covering a candidate.
      const boxes = boxesNow(candidates, elements, window);
      if (!boxes.length) return none('no on-screen candidates');
      const msg: PixelsCaptureMessage = { type: PIXELS_CAPTURE, frame: frameOf(window), boxes };
      capture = (await browser.runtime.sendMessage(msg)) as PixelsCaptureReply | undefined;
    } catch (err) {
      return none(String(err));
    } finally {
      overlay.hideForCapture(false);
    }
    if (!capture) return none('no reply from the background');
    if (!capture.ok) return none(capture.reason);
    const msg: PixelsResultMessage = { type: PIXELS_RESULT, captureId: capture.captureId };
    const result = (await withTimeout(browser.runtime.sendMessage(msg) as Promise<PixelsResultReply | undefined>, RESULT_TIMEOUT_MS).catch(
      () => null,
    )) as PixelsResultReply | null | undefined;
    if (!result) return none('measurement timed out');
    if (!result.ok) return none(result.reason);
    return { refined: result.refined, status: `measured ${Object.keys(result.refined).length}` };
  }

  return {
    /** The candidates with f03/f04 from pixels where measured now or earlier on this page. */
    async refine(candidates: Candidate[], elements: Map<string, Element>): Promise<{ candidates: Candidate[]; status: string }> {
      const { refined: fresh, status } = await measure(candidates, elements);
      const merged: Record<string, PixelRefinement> = {};
      for (const c of candidates) {
        const el = elements.get(c.id);
        const r = fresh[c.id] ?? (el ? cache.get(el) : undefined);
        if (!r) continue;
        merged[c.id] = r;
        if (el && fresh[c.id]) cache.set(el, r);
      }
      return { candidates: applyPixelRefinement(candidates, merged), status };
    },

    /** A new page (SPA navigation): forget cached measurements. */
    reset(): void {
      cache = new WeakMap();
    },
  };
}
