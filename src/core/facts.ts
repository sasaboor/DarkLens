/**
 * Facts the rules need that the 12 features do not carry: absolute font size,
 * grey text, struck-through prices, "inside a product grid or review list",
 * the amount on a fee row, the priced items on the page (for bait and switch)
 * and the cart badge count (for basket sneaking).
 *
 * Privacy: like the extractor, this reads text nodes, labels and attributes
 * only, never input values or data-dp-* ground truth.
 */
import { hsvSaturation, effectiveBackground, relativeLuminance, textColor } from './color';
import type { Extraction } from './extractor';
import { ancestors, parentOf, px, type Layout } from './layout';
import { OFFER_OVER_RE, OFFER_RE, PRICE_RE, allRupees, elementText, liveOffers, parseRupees } from './text';
import type { PageType } from './types';

export interface CandidateFacts {
  /** Computed font size in px. */
  fontSize: number;
  /** Text is a light or mid grey (low saturation, not near-black). */
  grey: boolean;
  /** Struck through (an MRP next to the real price). */
  struck: boolean;
  /** Inside a repeated card or review (a product grid, search results, a review list). */
  inRepeatedList: boolean;
  /** Last rupee amount on the element's row, e.g. 9 for "Platform fee ₹9". */
  lineAmount: number | null;
  /** A radio button (one option of a group is always selected, so "checked by default" means less). */
  radio: boolean;
}

/** A price with the title of the item it belongs to. */
export interface PricedItem {
  title: string;
  /** origin + path of the item's link; null when the item has no real link. */
  href: string | null;
  price: number;
  candidateId: string;
  /** Live offers shown with the item ("50% off"), normalised; offers marked as ended are left out. */
  offers: string[];
}

export interface PageFacts {
  url: string;
  /** origin + path: the per-URL key for stored timers, stock and product prices. */
  urlKey: string;
  /** The site key for session memory (protocol + host). */
  site: string;
  /** link[rel=canonical] as origin + path, if the page has one. */
  canonical: string | null;
  pageType: PageType;
  /** One per item container: listing cards, the product panel, cart rows. */
  items: PricedItem[];
  /** On product pages: the main product (the item titled by the h1, else the largest price). Its href is the product key: the canonical URL, else the page URL. */
  product: PricedItem | null;
  /** The number on the cart badge, if any. */
  cartCount: { count: number; candidateId: string | null } | null;
}

export interface Facts {
  byId: Record<string, CandidateFacts>;
  page: PageFacts;
}

const TITLE_SELECTOR = 'h1, h2, h3, h4, a[href], b, strong, [class*="title"], [class*="name"]';
const TITLE_MIN = 8;
const TITLE_MAX = 150;
const MAX_ITEM_LEVELS = 6;
const MAX_LIST_LEVELS = 8;
const MIN_REPEATS = 3;
const LIST_HINT_RE = /review|product|card|item|result|tile|grid|listing|search|sku/i;
const LINE_MAX = 120;
const CART_RE = /\b(?:cart|bag|basket|trolley)\b/i;
const CART_CONTROLS = 'a, button, [role="button"]';
const LINE_KINDS = new Set(['fee', 'checkbox', 'subscription', 'price', 'text']);
/** Offer text blocks longer than this are not read (a whole panel, not an offer badge). */
const OFFER_BLOCK_MAX = 80;

// ---------- URLs ----------

function parseUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** origin + path, no query or hash. */
export function urlKey(url: string): string {
  const u = parseUrl(url);
  return u ? `${u.protocol}//${u.host}${u.pathname}` : url;
}

/** protocol + host: one "site" for session memory. */
export function siteKey(url: string): string {
  const u = parseUrl(url);
  return u ? `${u.protocol}//${u.host}` : url;
}

/** The link target as origin + path, or null for "#", javascript: and missing links. */
export function linkKey(el: Element | null, pageUrl: string): string | null {
  const raw = el?.getAttribute('href')?.trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
  const u = parseUrl(raw, pageUrl);
  return u ? `${u.protocol}//${u.host}${u.pathname}` : null;
}

// ---------- per-candidate ----------

function isGrey(el: Element, layout: Layout): boolean {
  const c = textColor(el, layout, effectiveBackground(el, layout));
  const lum = relativeLuminance(c);
  return hsvSaturation(c) < 0.2 && lum > 0.12 && lum < 0.9;
}

function isStruck(el: Element, layout: Layout): boolean {
  let level = 0;
  for (const a of ancestors(el)) {
    if (level++ > 2) break;
    if (a.tagName === 'S' || a.tagName === 'DEL' || a.tagName === 'STRIKE') return true;
    const style = layout.style(a);
    const line = style.getPropertyValue('text-decoration-line') || style.getPropertyValue('text-decoration');
    if (line.includes('line-through')) return true;
  }
  return false;
}

function classes(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** Same tag and, if classed, at least one shared class ("review" and "review review-ad" are peers). */
function sameShape(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;
  const ca = classes(a);
  const cb = classes(b);
  if (!ca.length || !cb.length) return !ca.length && !cb.length;
  return ca.some((c) => cb.includes(c));
}

/** An ancestor that repeats ≥3 times among its siblings and looks like a card, result or review. */
export function inRepeatedList(el: Element): boolean {
  let level = 0;
  for (const a of ancestors(el)) {
    if (level++ > MAX_LIST_LEVELS || a.tagName === 'BODY') break;
    const parent = parentOf(a);
    if (!parent) break;
    const peers = [...parent.children].filter((s) => sameShape(s, a));
    if (peers.length < MIN_REPEATS) continue;
    const hint = `${a.getAttribute('class') ?? ''} ${a.id} ${parent.getAttribute('class') ?? ''} ${parent.id}`;
    const priced = peers.filter((p) => PRICE_RE.test(p.textContent ?? '')).length;
    if (LIST_HINT_RE.test(hint) || priced >= 2) return true;
  }
  return false;
}

function lineAmount(el: Element): number | null {
  let level = 0;
  for (const a of ancestors(el)) {
    if (level++ > 3 || a.tagName === 'BODY') break;
    if ((a.textContent ?? '').length > LINE_MAX * 4) break;
    const text = elementText(a);
    if (text.length > LINE_MAX) break;
    const amounts = allRupees(text);
    if (amounts.length) return amounts[amounts.length - 1]!;
  }
  return null;
}

// ---------- priced items ----------

/**
 * Live offers inside `container`: from the innermost short blocks that
 * mention an offer, skipping a block (or its short parent) that says the
 * offer ended.
 */
export function offersIn(container: Element): string[] {
  const out = new Set<string>();
  const re = new RegExp(OFFER_RE.source, 'i');
  for (const el of container.querySelectorAll('*')) {
    const text = elementText(el);
    if (text.length > OFFER_BLOCK_MAX || !re.test(text)) continue;
    if ([...el.children].some((ch) => re.test(elementText(ch)))) continue;
    const parent = parentOf(el);
    const parentText = parent && parent !== container ? elementText(parent) : '';
    if (parentText.length <= OFFER_BLOCK_MAX && OFFER_OVER_RE.test(parentText)) continue;
    for (const o of liveOffers(text)) out.add(o);
  }
  return [...out];
}

/** The first title-like element in `container` that comes before `priceEl` and is not part of it. */
function titleBefore(container: Element, priceEl: Element): Element | null {
  for (const node of container.querySelectorAll(TITLE_SELECTOR)) {
    if (node === priceEl || node.contains(priceEl) || priceEl.contains(node)) continue;
    if (!(node.compareDocumentPosition(priceEl) & 4 /* DOCUMENT_POSITION_FOLLOWING */)) continue;
    const text = elementText(node);
    if (text.length < TITLE_MIN || text.length > TITLE_MAX || PRICE_RE.test(text)) continue;
    return node;
  }
  return null;
}

interface ItemGroup {
  container: Element;
  titleEl: Element;
  ids: string[];
}

function pricedItems(ex: Extraction, byId: Record<string, CandidateFacts>, pageUrl: string): {
  items: PricedItem[];
  titled: Map<PricedItem, Element>;
} {
  const groups = new Map<Element, ItemGroup>();
  for (const c of ex.candidates) {
    if (c.kind !== 'price') continue;
    const el = ex.elements.get(c.id)!;
    let level = 0;
    for (const a of ancestors(el)) {
      if (a === el) continue;
      if (level++ >= MAX_ITEM_LEVELS || a.tagName === 'BODY') break;
      const titleEl = titleBefore(a, el);
      if (!titleEl) continue;
      const group = groups.get(a) ?? { container: a, titleEl, ids: [] };
      group.ids.push(c.id);
      groups.set(a, group);
      break;
    }
  }
  const byCandidate = new Map(ex.candidates.map((c) => [c.id, c]));
  const items: PricedItem[] = [];
  const titled = new Map<PricedItem, Element>();
  for (const { container, titleEl, ids } of groups.values()) {
    const id = ids.find((i) => !byId[i]?.struck && parseRupees(byCandidate.get(i)!.text) !== null);
    if (!id) continue;
    const item: PricedItem = {
      title: elementText(titleEl),
      href: linkKey(titleEl.closest('a[href]'), pageUrl),
      price: parseRupees(byCandidate.get(id)!.text)!,
      candidateId: id,
      offers: offersIn(container),
    };
    items.push(item);
    titled.set(item, titleEl);
  }
  return { items, titled };
}

// ---------- cart badge ----------

/** The number on the cart badge: a cart/bag/basket link or button holding a 1–3 digit element. */
export function readCartCount(doc: Document): { count: number; el: Element } | null {
  for (const el of doc.querySelectorAll(CART_CONTROLS)) {
    const hint = `${elementText(el)} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('href') ?? ''} ${el.id} ${el.getAttribute('class') ?? ''}`;
    if (!CART_RE.test(hint)) continue;
    for (const d of el.querySelectorAll('*')) {
      const t = elementText(d);
      if (/^\d{1,3}$/.test(t)) return { count: Number(t), el };
    }
    const m = /(\d{1,3})\s*items?\b/i.exec(el.getAttribute('aria-label') ?? '');
    if (m) return { count: Number(m[1]), el };
  }
  return null;
}

// ---------- all ----------

export function collectFacts(ex: Extraction, layout: Layout, doc: Document, url: string): Facts {
  const byId: Record<string, CandidateFacts> = {};
  for (const c of ex.candidates) {
    const el = ex.elements.get(c.id)!;
    byId[c.id] = {
      fontSize: px(layout.style(el).fontSize) || 16,
      grey: isGrey(el, layout),
      struck: c.kind === 'price' ? isStruck(el, layout) : false,
      inRepeatedList: c.kind === 'ad_label' || c.kind === 'price' ? inRepeatedList(el) : false,
      lineAmount: LINE_KINDS.has(c.kind) ? lineAmount(el) : null,
      radio: el.matches('input[type="radio"], [role="radio"]'),
    };
  }

  const key = urlKey(url);
  const canonical = linkKey(doc.querySelector('link[rel~="canonical"][href]'), url);
  const { items, titled } = pricedItems(ex, byId, url);
  let product: PricedItem | null = null;
  if (ex.pageType === 'product') {
    const h1 = items.find((i) => titled.get(i)?.tagName === 'H1');
    const biggest = [...items].sort((a, b) => byId[b.candidateId]!.fontSize - byId[a.candidateId]!.fontSize)[0];
    const main = h1 ?? biggest;
    product = main ? { ...main, href: canonical ?? key } : null;
  }

  const cart = readCartCount(doc);
  let cartCount: PageFacts['cartCount'] = null;
  if (cart) {
    let candidateId: string | null = null;
    for (const [id, el] of ex.elements) if (el === cart.el) candidateId = id;
    cartCount = { count: cart.count, candidateId };
  }

  return {
    byId,
    page: { url, urlKey: key, site: siteKey(url), canonical, pageType: ex.pageType, items, product, cartCount },
  };
}
