/**
 * The 12 visual-structural features, in the fixed order from CLAUDE.md. The
 * model head depends on this order, so never reorder FEATURE_NAMES.
 *
 * f03 and f04 are computed from CSS here; pixel refinement (screenshot crops)
 * replaces them later and records featureSource = 'pixels'.
 *
 * f07 needs two reads 2 seconds apart, so it is two-phase:
 *   const snap = snapshotCountdowns(ex); ...wait 2 s...; compareCountdowns(ex, snap)
 * or simply `await detectCountdowns(ex)`. Pass the result to computeFeatures.
 */
import {
  contrastRatio,
  deltaE76,
  effectiveBackground,
  ownBackground,
  salience,
  textColor,
  type RGBA,
} from './color';
import {
  CHECKBOX_SELECTOR,
  blockingOverlay,
  isAcceptText,
  isDeclineText,
  type Extraction,
} from './extractor';
import { clamp, distance, parentOf, px, visibleArea, type Layout } from './layout';
import { allRupees, collapse, elementText, parseTimer } from './text';
import type { Candidate } from './types';
import { createVisibility, type Visibility } from './visibility';

export const FEATURE_NAMES = [
  'font_ratio',
  'area_ratio',
  'contrast',
  'salience',
  'default_checked',
  'faded',
  'countdown',
  'overlay_coverage',
  'unclosable_modal',
  'decline_as_link',
  'cta_distance',
  'price_delta',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** A close control smaller than this in both dimensions does not count. */
const MIN_CLOSE_SIZE = 16;
/** A primary CTA larger than this share of the viewport is a banner, not a button. */
const MAX_CTA_SHARE = 0.25;
/** An own background this far (CIE76) from its parent's reads as a filled button. */
const FILLED_DELTA_E = 10;

const CLOSE_TEXT_RE = /^(?:×|✕|✖|✗|x|close|dismiss)$/i;
const CLOSE_LABEL_RE = /\b(?:close|dismiss)\b/i;
const FORM_FIELDS = new Set(['SELECT', 'INPUT', 'TEXTAREA']);
const CLOSABLE_CONTROLS = 'button, a, [role="button"], input[type="button"]';

export interface FeatureOptions {
  layout: Layout;
  doc: Document;
  /** Candidate ids whose timer counted down (from detectCountdowns). */
  countdowns?: ReadonlySet<string>;
  /** Checked states at page load (from snapshotCheckedStates). */
  initialChecked?: WeakMap<Element, boolean>;
  /** The product price remembered from the product page, for f12. */
  rememberedPrice?: number | null;
}

// ---------- f05 default_checked ----------

function currentlyChecked(el: Element): boolean {
  if (el.getAttribute('aria-checked') === 'true') return true;
  if (el.tagName !== 'INPUT') return false;
  const input = el as HTMLInputElement;
  return input.checked || input.defaultChecked;
}

function* walkAll(root: ParentNode): Generator<Element> {
  for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
    if (c.tagName === 'IFRAME' || c.tagName === 'FRAME') continue;
    yield c;
    if (c.shadowRoot) yield* walkAll(c.shadowRoot);
    yield* walkAll(c);
  }
}

/** Checked state of every checkbox, radio and switch now. Take it at page load, before the user interacts. */
export function snapshotCheckedStates(doc: Document): WeakMap<Element, boolean> {
  const out = new WeakMap<Element, boolean>();
  for (const el of walkAll(doc)) if (el.matches(CHECKBOX_SELECTOR)) out.set(el, currentlyChecked(el));
  return out;
}

function defaultChecked(el: Element, initial?: WeakMap<Element, boolean>): boolean {
  if (!el.matches(CHECKBOX_SELECTOR)) return false;
  const known = initial?.get(el);
  return known ?? currentlyChecked(el);
}

// ---------- f07 countdown ----------

export type CountdownSnapshot = Map<string, number>;

/** Phase 1: the seconds shown by every candidate whose text contains a time. */
export function snapshotCountdowns(ex: Extraction): CountdownSnapshot {
  const snap: CountdownSnapshot = new Map();
  for (const [id, el] of ex.elements) {
    const t = parseTimer(elementText(el));
    if (t !== null) snap.set(id, t);
  }
  return snap;
}

/** Phase 2: ids whose time went down since the snapshot. */
export function compareCountdowns(ex: Extraction, before: CountdownSnapshot): Set<string> {
  const out = new Set<string>();
  for (const [id, was] of before) {
    const el = ex.elements.get(id);
    const now = el ? parseTimer(elementText(el)) : null;
    if (now !== null && now < was) out.add(id);
  }
  return out;
}

export const COUNTDOWN_WAIT_MS = 2000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Both phases, `waitMs` apart. */
export async function detectCountdowns(
  ex: Extraction,
  { waitMs = COUNTDOWN_WAIT_MS, sleep = defaultSleep }: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Set<string>> {
  const snap = snapshotCountdowns(ex);
  if (snap.size === 0) return new Set();
  await sleep(waitMs);
  return compareCountdowns(ex, snap);
}

// ---------- f12 price_delta ----------

const TOTAL_STRONG_RE = /\b(?:grand total|order total|total payable|total amount|amount payable|to pay|you pay)\b/i;
const TOTAL_RE = /\btotal\b/i;
const NOT_TOTAL_RE = /\bsub-?\s?total\b|\bsavings?\b|\byou save\b|\bitems? total\b|\bmrp\b/i;
const MAX_TOTAL_ROW = 80;

/** The order total on a cart or checkout page: the last amount on the best "Total" row. Null if none. */
export function findOrderTotal(doc: Document): number | null {
  let best: { strength: number; amount: number } | null = null;
  for (const el of walkAll(doc.body ?? doc.documentElement)) {
    if ((el.textContent ?? '').length > MAX_TOTAL_ROW * 4) continue;
    const text = elementText(el);
    if (!text || text.length > MAX_TOTAL_ROW || NOT_TOTAL_RE.test(text)) continue;
    const strength = TOTAL_STRONG_RE.test(text) ? 2 : TOTAL_RE.test(text) ? 1 : 0;
    if (!strength) continue;
    const amounts = allRupees(text);
    const amount = amounts[amounts.length - 1];
    if (amount === undefined) continue;
    // Stronger label wins; at equal strength the later row wins (summaries end with the total).
    if (!best || strength >= best.strength) best = { strength, amount };
  }
  return best?.amount ?? null;
}

/** (total − remembered) / remembered on cart and checkout pages; 0 when unknown. */
export function priceDelta(ex: Extraction, doc: Document, rememberedPrice: number | null | undefined): number {
  if (ex.pageType !== 'cart' && ex.pageType !== 'checkout') return 0;
  if (!rememberedPrice || rememberedPrice <= 0) return 0;
  const total = findOrderTotal(doc);
  return total === null ? 0 : (total - rememberedPrice) / rememberedPrice;
}

// ---------- per-element style measures ----------

interface Measures {
  fontSize: number;
  area: number;
  background: RGBA;
  contrast: number;
  salience: number;
  faded: number;
}

/** 1 at ≤ 11px, ≤ 0.6 effective opacity or ≤ 3:1 contrast; partial up to 12px, 0.8 and 4.5:1. */
export function fadedScore(fontSize: number, opacity: number, contrast: number): number {
  const size = clamp(12 - fontSize);
  const op = clamp((0.8 - opacity) / 0.2);
  const con = clamp((4.5 - contrast) / 1.5);
  return Math.max(size, op, con);
}

function hasVisibleBorder(style: CSSStyleDeclaration): boolean {
  return ['top', 'right', 'bottom', 'left'].some(
    (side) =>
      px(style.getPropertyValue(`border-${side}-width`)) > 0 &&
      !['none', 'hidden', ''].includes(style.getPropertyValue(`border-${side}-style`)),
  );
}

function makeMeasurer(layout: Layout, vis: Visibility, pageBg: RGBA) {
  const cache = new Map<Element, Measures>();
  return (el: Element): Measures => {
    const hit = cache.get(el);
    if (hit) return hit;
    const style = layout.style(el);
    const rect = layout.rect(el);
    const background = effectiveBackground(el, layout);
    const own = ownBackground(style);
    let contrast: number;
    const parent = parentOf(el);
    if (!elementText(el) && !FORM_FIELDS.has(el.tagName) && own && own.a >= 1 && parent) {
      // No text (an icon-only switch or button): WCAG 1.4.11 non-text contrast against what is behind it.
      // Form fields are excluded: their text exists but is deliberately never read.
      contrast = contrastRatio(own, effectiveBackground(parent, layout));
    } else {
      contrast = contrastRatio(textColor(el, layout, background), background);
    }
    const fontSize = px(style.fontSize) || 16;
    const m: Measures = {
      fontSize,
      area: rect.w * rect.h,
      background,
      contrast,
      salience: salience(background, pageBg),
      faded: fadedScore(fontSize, vis.opacity(el), contrast),
    };
    cache.set(el, m);
    return m;
  };
}

// ---------- f09 unclosable_modal ----------

function isCloseControl(el: Element): boolean {
  const text = collapse(el.textContent);
  const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
  return CLOSE_TEXT_RE.test(text) || CLOSE_LABEL_RE.test(label) || isDeclineText(text);
}

function hasUsableClose(
  overlay: Element,
  layout: Layout,
  vis: Visibility,
  measure: (el: Element) => Measures,
): boolean {
  const controls = [...overlay.querySelectorAll(CLOSABLE_CONTROLS)];
  if (overlay.shadowRoot) controls.push(...overlay.shadowRoot.querySelectorAll(CLOSABLE_CONTROLS));
  return controls.some((c) => {
    if (!isCloseControl(c) || !vis.isVisible(c)) return false;
    const r = layout.rect(c);
    if (r.w < MIN_CLOSE_SIZE && r.h < MIN_CLOSE_SIZE) return false;
    return measure(c).faded < 1;
  });
}

// ---------- f11 cta_distance ----------

/** The most prominent call to action: the filled control with the largest area × (0.25 + salience). */
export function findPrimaryCta(
  ex: Extraction,
  layout: Layout,
  measure: (el: Element) => Measures,
): Candidate | null {
  const vp = layout.viewport();
  const maxArea = vp.w * vp.h * MAX_CTA_SHARE;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of ex.candidates) {
    if (c.kind !== 'control' || c.tag === 'select') continue;
    const el = ex.elements.get(c.id)!;
    const m = measure(el);
    if (m.area <= 0 || m.area > maxArea) continue;
    const filled = ownBackground(layout.style(el)) !== null;
    const score = m.area * (0.25 + (filled ? m.salience : 0));
    if (!best || score > best.score) best = { c, score };
  }
  return best?.c ?? null;
}

// ---------- all 12 ----------

function isFilled(el: Element, layout: Layout): boolean {
  const own = ownBackground(layout.style(el));
  const parent = parentOf(el);
  if (!own || own.a < 0.5 || !parent) return false;
  return deltaE76(own, effectiveBackground(parent, layout)) > FILLED_DELTA_E;
}

function isPlain(el: Element, layout: Layout): boolean {
  const style = layout.style(el);
  const own = ownBackground(style);
  return (!own || own.a < 0.1) && !hasVisibleBorder(style);
}

/** Returns copies of the candidates with all 12 features filled in (CSS source for f03 and f04). */
export function computeFeatures(ex: Extraction, opts: FeatureOptions): Candidate[] {
  const { layout, doc } = opts;
  const vis = createVisibility(layout);
  const pageBg = doc.body ? effectiveBackground(doc.body, layout) : effectiveBackground(doc.documentElement, layout);
  const measure = makeMeasurer(layout, vis, pageBg);
  const vp = layout.viewport();
  const vpArea = vp.w * vp.h;
  const diagonal = Math.hypot(vp.w, vp.h) || 1;
  const byId = new Map(ex.candidates.map((c) => [c.id, c]));
  const cta = findPrimaryCta(ex, layout, measure);
  const delta = priceDelta(ex, doc, opts.rememberedPrice);
  const closable = new Map<Element, boolean>();

  return ex.candidates.map((c) => {
    const el = ex.elements.get(c.id)!;
    const m = measure(el);
    const counterpart = c.counterpartId ? byId.get(c.counterpartId) : undefined;
    const cpEl = counterpart ? ex.elements.get(counterpart.id) : undefined;
    const cp = cpEl ? measure(cpEl) : undefined;

    const f01 = cp && cp.fontSize > 0 ? m.fontSize / cp.fontSize : 1;
    const f02 = cp && cp.area > 0 ? m.area / cp.area : 1;
    const f03 = m.contrast;
    const f04 = m.salience;
    const f05 = defaultChecked(el, opts.initialChecked) ? 1 : 0;
    const f06 = m.faded;
    const f07 = opts.countdowns?.has(c.id) ? 1 : 0;

    const position = layout.style(el).position;
    const f08 =
      (position === 'fixed' || position === 'sticky') && vpArea > 0 ? clamp(visibleArea(c.rect, vp) / vpArea) : 0;

    const overlay = blockingOverlay(el, layout);
    let f09 = 0;
    if (overlay) {
      let ok = closable.get(overlay);
      if (ok === undefined) {
        ok = hasUsableClose(overlay, layout, vis, measure);
        closable.set(overlay, ok);
      }
      f09 = ok ? 0 : 1;
    }

    const f10 =
      cpEl && isDeclineText(c.text) && isAcceptText(counterpart!.text) && isPlain(el, layout) && isFilled(cpEl, layout)
        ? 1
        : 0;

    const f11 = cta ? clamp(distance(c.rect, cta.rect) / diagonal) : 1;
    const f12 = delta;

    return {
      ...c,
      features: [f01, f02, f03, f04, f05, f06, f07, f08, f09, f10, f11, f12],
      featureSource: { f03: 'css', f04: 'css' },
    };
  });
}
