/**
 * Candidate extraction, following "Candidate elements" in CLAUDE.md: controls,
 * checkboxes, dialogs, fixed or sticky banners and short text blocks
 * (prices, timers, stock, fees, ad labels, subscription words), visible only,
 * open shadow roots included, iframes skipped, capped at 300, with
 * accept/decline pairing.
 *
 * Privacy: text comes from labels and text nodes only (see text.ts). Input
 * values are never read, and neither are data-dp-* attributes.
 */
import { ancestors, closestAcross, distance, domLayout, visibleArea, type Layout } from './layout';
import { detectPageType } from './pageType';
import {
  AD_LABEL_RE,
  FEE_RE,
  PRICE_RE,
  STOCK_RE,
  SUBSCRIPTION_RE,
  TIMER_RE,
  collapse,
  elementText,
  truncate,
} from './text';
import type { Candidate, CandidateKind, PageType } from './types';
import { createVisibility, type Visibility } from './visibility';

export const MAX_CANDIDATES = 300;
export const MAX_TEXT_BLOCK = 300;
export const PAIR_MAX_DISTANCE = 400;
export const FEATURE_COUNT = 12;

export const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
export const CHECKBOX_SELECTOR = 'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"]';
export const CONTROL_SELECTOR =
  'button, a, [role="button"], input[type="submit"], input[type="button"], select';

/** Subtrees never entered. iframes are skipped entirely. */
const SKIP_TREE = new Set(['IFRAME', 'FRAME', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

/** Text-block kinds in priority order: the first pattern that matches wins. */
const TEXT_KINDS: [CandidateKind, RegExp][] = [
  ['ad_label', AD_LABEL_RE],
  ['subscription', SUBSCRIPTION_RE],
  ['fee', FEE_RE],
  ['timer', TIMER_RE],
  ['stock', STOCK_RE],
  ['price', PRICE_RE],
];

/**
 * The spec's decline words, plus "continue with standard/basic/free …" and
 * "continue without …", the decline side of an upsell (tuned on the test shop).
 */
const DECLINE_RE =
  /^\s*no\b|\b(?:no thanks|skip|later|decline|cancel|not now|maybe later|i don'?t want|i do not want)\b|^\s*continue (?:with (?:the )?(?:standard|basic|free|regular|normal)|without)\b/i;
/** The spec's accept words, plus "upgrade" (the accept side of an upsell). */
const ACCEPT_RE = /\b(?:accept|continue|yes|add|buy|subscribe|allow|ok|okay|get|claim|upgrade)\b/i;
/** Longer control text is a sentence or a card, not one side of a choice. */
const MAX_CHOICE_TEXT = 60;

const CHECKOUT_AREA_RE = /cart|checkout|payment|order|summary/i;

export interface Extraction {
  pageType: PageType;
  candidates: Candidate[];
  /** Candidate id → element, for highlighting and for computing features. */
  elements: Map<string, Element>;
}

export interface ExtractOptions {
  layout?: Layout;
  /** Defaults to doc.location.href. */
  url?: string;
  maxCandidates?: number;
}

export function isDeclineText(text: string): boolean {
  return text.length <= MAX_CHOICE_TEXT && DECLINE_RE.test(text);
}

/** Accept-like and not decline-like (decline wins: "No, I don't want to add"). */
export function isAcceptText(text: string): boolean {
  return text.length <= MAX_CHOICE_TEXT && !DECLINE_RE.test(text) && ACCEPT_RE.test(text);
}

export function isDialogLike(el: Element): boolean {
  return el.matches(DIALOG_SELECTOR);
}

/** True for a <dialog> opened with showModal(); false where :modal is unsupported. */
export function isModalDialog(el: Element): boolean {
  try {
    return el.matches(':modal');
  } catch {
    return false;
  }
}

export function isFixedOrSticky(el: Element, layout: Layout): boolean {
  const p = layout.style(el).position;
  return p === 'fixed' || p === 'sticky';
}

/** Share of the viewport `el` covers (1 for a modal <dialog>, whose backdrop covers everything). */
export function viewportCoverage(el: Element, layout: Layout): number {
  if (isModalDialog(el)) return 1;
  const vp = layout.viewport();
  const area = vp.w * vp.h;
  return area > 0 ? visibleArea(layout.rect(el), vp) / area : 0;
}

/**
 * The overlay `el` is or is inside: the outermost dialog-like or fixed
 * ancestor covering more than half the viewport. Null if none.
 */
export function blockingOverlay(el: Element, layout: Layout): Element | null {
  let found: Element | null = null;
  for (const a of ancestors(el)) {
    if (!isDialogLike(a) && layout.style(a).position !== 'fixed') continue;
    if (viewportCoverage(a, layout) > 0.5) found = a;
  }
  return found;
}

function rootOf(el: Element): Document | ShadowRoot | null {
  const root = el.getRootNode();
  return root && 'getElementById' in root ? (root as Document | ShadowRoot) : null;
}

function labelledByText(el: Element): string {
  const ids = collapse(el.getAttribute('aria-labelledby'));
  const root = rootOf(el);
  if (!ids || !root) return '';
  return collapse(
    ids
      .split(' ')
      .map((id) => {
        const target = root.getElementById(id);
        return target ? elementText(target) : '';
      })
      .join(' '),
  );
}

function labelElementText(el: Element): string {
  const root = rootOf(el);
  const id = el.getAttribute('id');
  if (id && root) {
    const label = root.querySelector(`label[for="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (label) return elementText(label);
  }
  const wrapping = el.closest('label');
  return wrapping ? elementText(wrapping) : '';
}

/**
 * The text a candidate is judged by. Controls: visible text, else aria-label
 * or title. Checkboxes, switches and selects: their label. Submit and button
 * inputs: their value *attribute* (the author's caption, never typed input).
 */
export function candidateText(el: Element, kind: CandidateKind): string {
  const aria = collapse(el.getAttribute('aria-label'));
  const title = collapse(el.getAttribute('title'));
  let text = '';
  if (kind === 'checkbox' || el.tagName === 'SELECT') {
    text = aria || labelledByText(el) || labelElementText(el) || elementText(el) || title;
  } else if (el.tagName === 'INPUT') {
    text = aria || collapse(el.getAttribute('value')) || title;
  } else if (kind === 'control') {
    const alt = collapse(el.querySelector('img[alt]')?.getAttribute('alt'));
    text = elementText(el) || aria || labelledByText(el) || title || alt;
  } else {
    text = elementText(el) || aria || labelledByText(el);
  }
  return truncate(text, MAX_TEXT_BLOCK);
}

function textKind(text: string): [CandidateKind, RegExp] | null {
  for (const entry of TEXT_KINDS) if (entry[1].test(text)) return entry;
  return null;
}

function childElements(el: Element): Element[] {
  const out = [...el.children];
  if (el.shadowRoot) out.push(...el.shadowRoot.children);
  return out;
}

/** The kind of a short text block whose pattern no child element also matches (deepest match). */
function textBlockKind(el: Element): CandidateKind | null {
  if ((el.textContent ?? '').length > MAX_TEXT_BLOCK * 10) return null;
  const text = elementText(el);
  if (!text || text.length > MAX_TEXT_BLOCK) return null;
  const hit = textKind(text);
  if (!hit) return null;
  const [kind, re] = hit;
  for (const child of childElements(el)) {
    if (SKIP_TREE.has(child.tagName)) continue;
    if (re.test(elementText(child))) return null;
  }
  return kind;
}

interface Raw {
  el: Element;
  kind: CandidateKind;
  order: number;
  inDialog: boolean;
  priority: number;
}

function structuralKind(el: Element, layout: Layout): CandidateKind | null {
  if (isDialogLike(el)) return 'dialog';
  if (el.matches(CHECKBOX_SELECTOR)) return 'checkbox';
  if (el.matches(CONTROL_SELECTOR)) return 'control';
  if (isFixedOrSticky(el, layout)) return 'banner';
  return null;
}

function inDialogContext(el: Element, layout: Layout): boolean {
  for (const a of ancestors(el)) if (isDialogLike(a)) return true;
  return blockingOverlay(el, layout) !== null;
}

function inCheckoutArea(el: Element): boolean {
  for (const a of ancestors(el)) {
    if (a.tagName === 'BODY') return false;
    if (CHECKOUT_AREA_RE.test(`${a.id} ${a.getAttribute('class') ?? ''}`)) return true;
  }
  return false;
}

function priorityOf(raw: Omit<Raw, 'priority'>): number {
  let p = 0;
  if (raw.inDialog) p += 3;
  if (raw.kind === 'control' || raw.kind === 'checkbox' || raw.kind === 'dialog' || raw.kind === 'banner') p += 2;
  else p += 1; // text of interest: price, timer, stock, fee, ad label, subscription
  if (closestAcross(raw.el, 'form')) p += 1;
  if (inCheckoutArea(raw.el)) p += 1;
  return p;
}

function collect(doc: Document, layout: Layout, vis: Visibility): Raw[] {
  const out: Raw[] = [];
  const textBlocks = new Set<Element>();
  let order = 0;

  const visit = (el: Element) => {
    let kind = structuralKind(el, layout);
    if (!kind) {
      // A text block inside a label, a control or another text block is covered by that one.
      const covered =
        closestAcross(el, `label, ${CONTROL_SELECTOR}, ${CHECKBOX_SELECTOR}`) !== null ||
        [...ancestors(el)].some((a) => a !== el && textBlocks.has(a));
      kind = covered ? null : textBlockKind(el);
    }
    if (!kind || !vis.isVisible(el)) return;
    if (kind !== 'control' && kind !== 'checkbox' && kind !== 'dialog' && kind !== 'banner') textBlocks.add(el);
    const raw = { el, kind, order: order++, inDialog: inDialogContext(el, layout) };
    out.push({ ...raw, priority: priorityOf(raw) });
  };

  const walk = (root: ParentNode) => {
    for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
      if (SKIP_TREE.has(c.tagName)) continue;
      // Nothing under display:none or opacity:0 can be visible.
      if (!vis.displayed(c) || vis.opacity(c) <= 0.01) continue;
      visit(c);
      if (c.tagName.toLowerCase() === 'svg') continue;
      if (c.shadowRoot) walk(c.shadowRoot);
      walk(c);
    }
  };

  walk(doc.body ?? doc.documentElement);
  return out;
}

/** Keeps the top `max` by priority (stable), back in DOM order. */
export function applyCap<T extends { order: number; priority: number }>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return [...items]
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order);
}

function nearbyPrice(el: Element): string | null {
  let level = 0;
  for (const a of ancestors(el)) {
    if (level++ > 4) break;
    if ((a.textContent ?? '').length > 1500) break;
    const m = PRICE_RE.exec(elementText(a));
    if (m) return m[0];
  }
  return null;
}

function choiceScope(el: Element): Element | null {
  for (const a of ancestors(el)) if (a.tagName === 'FORM' || isDialogLike(a)) return a;
  return null;
}

/**
 * Pairs accept-like controls with decline-like ones: same dialog or form, or
 * centres under 400px apart. Closest pairs are matched first, so each control
 * gets at most one counterpart.
 */
export function pairChoices(candidates: Candidate[], elements: Map<string, Element>): void {
  const controls = candidates.filter((c) => c.kind === 'control' && c.tag !== 'select');
  const declines = controls.filter((c) => isDeclineText(c.text));
  const accepts = controls.filter((c) => isAcceptText(c.text));
  const pairs: { d: Candidate; a: Candidate; dist: number }[] = [];
  for (const d of declines) {
    const dScope = choiceScope(elements.get(d.id)!);
    for (const a of accepts) {
      const dist = distance(d.rect, a.rect);
      const sameScope = dScope !== null && dScope === choiceScope(elements.get(a.id)!);
      if (sameScope || dist < PAIR_MAX_DISTANCE) pairs.push({ d, a, dist });
    }
  }
  pairs.sort((x, y) => x.dist - y.dist);
  const taken = new Set<string>();
  for (const { d, a } of pairs) {
    if (taken.has(d.id) || taken.has(a.id)) continue;
    taken.add(d.id);
    taken.add(a.id);
    d.counterpartId = a.id;
    a.counterpartId = d.id;
  }
}

export function extractCandidates(doc: Document, options: ExtractOptions = {}): Extraction {
  const win = doc.defaultView;
  const layout = options.layout ?? (win ? domLayout(win) : null);
  if (!layout) throw new Error('extractCandidates needs a Layout when the document has no window');
  const vis = createVisibility(layout);
  const pageType = detectPageType(doc, options.url ?? doc.location?.href ?? '');

  const raws = applyCap(collect(doc, layout, vis), options.maxCandidates ?? MAX_CANDIDATES);
  const elements = new Map<string, Element>();
  const candidates = raws.map((raw, i): Candidate => {
    const id = `c${i}`;
    elements.set(id, raw.el);
    return {
      id,
      text: candidateText(raw.el, raw.kind),
      tag: raw.el.tagName.toLowerCase(),
      role: raw.el.getAttribute('role'),
      kind: raw.kind,
      rect: layout.rect(raw.el),
      counterpartId: null,
      features: new Array<number>(FEATURE_COUNT).fill(0),
      featureSource: { f03: 'css', f04: 'css' },
      context: { pageType, inDialog: raw.inDialog, nearbyPrice: nearbyPrice(raw.el) },
    };
  });
  pairChoices(candidates, elements);
  return { pageType, candidates, elements };
}
