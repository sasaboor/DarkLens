/**
 * Pixel refinement of f03 (contrast) and f04 (salience), as pure functions
 * over RGBA arrays so the offscreen document and the Playwright tools run the
 * same code.
 *
 * Each candidate's box is cropped from a screenshot of the visible tab
 * (scaled by devicePixelRatio). The crop's two main colour clusters give the
 * background (the most common colour) and the text colour (the core of the
 * pixels clearly different from the background: the quarter farthest from
 * it, so anti-aliased glyph edges do not wash the colour out). f03 is the
 * WCAG contrast of the two; f04 uses the same salience formula as the CSS
 * path, against the screenshot's most common colour.
 *
 * Privacy: only candidate boxes are analysed, and candidates never include
 * text fields. Nothing here stores or sends pixels.
 */
import { contrastRatio, deltaE76, salience, type RGBA } from './color';
import type { Candidate, Rect } from './types';

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray | Uint8Array;
}

/** A candidate box to refine, in CSS px relative to the viewport. */
export interface PixelBox {
  id: string;
  rect: Rect;
  /** False for text-less elements: f03 stays the CSS value (non-text contrast), only f04 is refined. */
  text: boolean;
}

export interface PixelRefinement {
  contrast?: number;
  salience?: number;
}

export interface Clusters {
  background: RGBA;
  /** Null when too few pixels differ from the background (no visible text). */
  foreground: RGBA | null;
  /** Share of the crop's pixels that differ clearly from the background. */
  foregroundShare: number;
}

export const PIXEL_CONFIG = {
  /** Histogram bins: this many bits per channel. */
  binBits: 4,
  /** A pixel belongs to the text cluster when it is at least this far (CIE76) from the background. */
  minForegroundDeltaE: 12,
  /** The text colour is the mean of this share of the text cluster farthest from the background. */
  foregroundCoreShare: 0.25,
  /** Below this share of text-cluster pixels there is no measurable text. */
  minForegroundShare: 0.005,
  /** Boxes smaller than this (CSS px) in either dimension are skipped. */
  minBoxPx: 6,
  /** Boxes larger than this share of the viewport are skipped (dialogs, banners, whole sections). */
  maxViewportShare: 0.3,
  /** Boxes at least this big (CSS px) lose this inset on each side, so borders do not count as text. */
  insetPx: 2,
  insetMinPx: 16,
  /** The page background is sampled every this many device pixels in each direction. */
  pageSampleStep: 4,
  /** Crops with fewer pixels than this are not measured. */
  minPixels: 16,
  /** At most one tab capture per this many ms (Chrome also caps captureVisibleTab at 2 per second). */
  minCaptureGapMs: 2000,
};

const KINDS_SKIPPED = new Set(['dialog', 'banner', 'checkbox']);

// ---------- crops ----------

/** The part of `img` under `rect` (CSS px), scaled by `dpr` and clamped to the image. A copy. */
export function cropBox(img: RgbaImage, rect: Rect, dpr: number): RgbaImage {
  const inset = rect.w >= PIXEL_CONFIG.insetMinPx && rect.h >= PIXEL_CONFIG.insetMinPx ? PIXEL_CONFIG.insetPx : 0;
  const x0 = Math.max(0, Math.round((rect.x + inset) * dpr));
  const y0 = Math.max(0, Math.round((rect.y + inset) * dpr));
  const x1 = Math.min(img.width, Math.round((rect.x + rect.w - inset) * dpr));
  const y1 = Math.min(img.height, Math.round((rect.y + rect.h - inset) * dpr));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

// ---------- colour clusters ----------

interface Bin {
  n: number;
  r: number;
  g: number;
  b: number;
}

function histogram(img: RgbaImage, step = 1): Map<number, Bin> {
  const shift = 8 - PIXEL_CONFIG.binBits;
  const bits = PIXEL_CONFIG.binBits;
  const bins = new Map<number, Bin>();
  const d = img.data;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      const key = ((r >> shift) << (2 * bits)) | ((g >> shift) << bits) | (b >> shift);
      const bin = bins.get(key);
      if (bin) {
        bin.n++;
        bin.r += r;
        bin.g += g;
        bin.b += b;
      } else bins.set(key, { n: 1, r, g, b });
    }
  }
  return bins;
}

function mean(bin: Bin): RGBA {
  return { r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n, a: 1 };
}

function modeBin(bins: Map<number, Bin>): Bin | null {
  let best: Bin | null = null;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  return best;
}

/** The two main colour clusters of a crop: background (most common) and text (the core of what differs). Null for an empty crop. */
export function colorClusters(img: RgbaImage): Clusters | null {
  const total = img.width * img.height;
  if (total < PIXEL_CONFIG.minPixels) return null;
  const bins = histogram(img);
  const bgBin = modeBin(bins)!;
  const background = mean(bgBin);

  const far: { bin: Bin; dist: number }[] = [];
  let farCount = 0;
  for (const bin of bins.values()) {
    if (bin === bgBin) continue;
    const dist = deltaE76(mean(bin), background);
    if (dist < PIXEL_CONFIG.minForegroundDeltaE) continue;
    far.push({ bin, dist });
    farCount += bin.n;
  }
  const foregroundShare = farCount / total;
  if (foregroundShare < PIXEL_CONFIG.minForegroundShare) return { background, foreground: null, foregroundShare };

  far.sort((a, b) => b.dist - a.dist);
  const want = Math.max(1, Math.round(farCount * PIXEL_CONFIG.foregroundCoreShare));
  const core: Bin = { n: 0, r: 0, g: 0, b: 0 };
  for (const { bin } of far) {
    core.n += bin.n;
    core.r += bin.r;
    core.g += bin.g;
    core.b += bin.b;
    if (core.n >= want) break;
  }
  return { background, foreground: mean(core), foregroundShare };
}

/** WCAG contrast of the text cluster against the background cluster; null with no measurable text. */
export function pixelContrast(clusters: Clusters): number | null {
  return clusters.foreground ? contrastRatio(clusters.foreground, clusters.background) : null;
}

/** The page background: the most common colour of the screenshot, sampled on a grid. */
export function pageBackground(img: RgbaImage): RGBA | null {
  const bin = modeBin(histogram(img, PIXEL_CONFIG.pageSampleStep));
  return bin ? mean(bin) : null;
}

// ---------- candidates ----------

/**
 * The candidates worth measuring, with their current boxes: fully on screen,
 * at least 6px, at most 30% of the viewport, not dialogs, banners or
 * checkboxes (a checkbox's box is its tick, not its label).
 */
export function pixelBoxes(
  candidates: Candidate[],
  rects: Map<string, Rect>,
  viewport: { w: number; h: number },
): PixelBox[] {
  const maxArea = viewport.w * viewport.h * PIXEL_CONFIG.maxViewportShare;
  const out: PixelBox[] = [];
  for (const c of candidates) {
    if (KINDS_SKIPPED.has(c.kind)) continue;
    const r = rects.get(c.id);
    if (!r) continue;
    if (r.w < PIXEL_CONFIG.minBoxPx || r.h < PIXEL_CONFIG.minBoxPx || r.w * r.h > maxArea) continue;
    if (r.x < 0 || r.y < 0 || r.x + r.w > viewport.w || r.y + r.h > viewport.h) continue;
    out.push({ id: c.id, rect: r, text: c.text.trim().length > 0 });
  }
  return out;
}

/** The screenshot really is this window at this devicePixelRatio (within 2 device px), so CSS boxes map onto it. */
export function imageMatchesFrame(img: { width: number; height: number }, frame: { dpr: number; width: number; height: number }): boolean {
  return Math.abs(img.width - frame.width * frame.dpr) <= 2 && Math.abs(img.height - frame.height * frame.dpr) <= 2;
}

/** Contrast and salience from pixels for each box that could be measured. */
export function refineFromPixels(img: RgbaImage, dpr: number, boxes: PixelBox[]): Record<string, PixelRefinement> {
  const out: Record<string, PixelRefinement> = {};
  const pageBg = pageBackground(img);
  if (!pageBg) return out;
  for (const box of boxes) {
    const clusters = colorClusters(cropBox(img, box.rect, dpr));
    if (!clusters) continue;
    const r: PixelRefinement = { salience: salience(clusters.background, pageBg) };
    const contrast = box.text ? pixelContrast(clusters) : null;
    if (contrast !== null) r.contrast = contrast;
    out[box.id] = r;
  }
  return out;
}

/** Copies of the candidates with f03 and f04 replaced where pixels measured them, and featureSource updated. */
export function applyPixelRefinement(candidates: Candidate[], refined: Record<string, PixelRefinement>): Candidate[] {
  return candidates.map((c) => {
    const r = refined[c.id];
    if (!r || (r.contrast === undefined && r.salience === undefined)) return c;
    const features = [...c.features];
    const featureSource = { ...c.featureSource };
    if (r.contrast !== undefined) {
      features[2] = r.contrast;
      featureSource.f03 = 'pixels';
    }
    if (r.salience !== undefined) {
      features[3] = r.salience;
      featureSource.f04 = 'pixels';
    }
    return { ...c, features, featureSource };
  });
}

/** How many candidates got f03 and f04 from pixels vs CSS, for reports. */
export function featureSourceCounts(candidates: Candidate[]): { f03: { pixels: number; css: number }; f04: { pixels: number; css: number } } {
  const out = { f03: { pixels: 0, css: 0 }, f04: { pixels: 0, css: 0 } };
  for (const c of candidates) {
    out.f03[c.featureSource.f03]++;
    out.f04[c.featureSource.f04]++;
  }
  return out;
}

/** True when a capture may run now (at most one per PIXEL_CONFIG.minCaptureGapMs); records it. */
export function createCaptureThrottle(minGapMs = PIXEL_CONFIG.minCaptureGapMs): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < minGapMs) return false;
    last = now;
    return true;
  };
}
