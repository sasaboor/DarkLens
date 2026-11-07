/**
 * Text reading and the text patterns used to pick candidates. Text comes from
 * text nodes only: the walker never enters input, textarea or select, so values
 * typed by the user can never leak into a candidate.
 */

const SKIP_TEXT = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME']);

export function collapse(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function appendText(node: Node, out: string[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) {
      out.push(child.nodeValue ?? '');
    } else if (child.nodeType === 1) {
      const el = child as Element;
      if (SKIP_TEXT.has(el.tagName)) continue;
      if (el.shadowRoot) appendText(el.shadowRoot, out);
      appendText(el, out);
    }
  }
}

/** Collapsed text of `el` (including open shadow roots), skipping form fields and scripts. */
export function elementText(el: Element): string {
  const out: string[] = [];
  if (el.shadowRoot) appendText(el.shadowRoot, out);
  appendText(el, out);
  return collapse(out.join(' '));
}

/** Text patterns from the spec's "Candidate elements" list. */
export const PRICE_RE = /(?:₹|\bRs\.?)\s?\d[\d,]*(?:\.\d+)?/i;
export const TIMER_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/;
export const FEE_RE = /\b(?:convenience|platform|handling|delivery|packaging)\s+fee\b/i;
export const AD_LABEL_RE = /\bsponsored\b|\bpromoted\b|^\s*(?:ad|ads|advertisement)\s*$/i;
export const SUBSCRIPTION_RE = /\bauto-?renew\w*|\brenews\b|\bsubscriptions?\b|\bmemberships?\b/i;
/**
 * Stock messages from the spec, plus high-demand wording ("23 people are
 * viewing this"), because the false_urgency rule covers "a stock or
 * high-demand message".
 */
export const STOCK_RE =
  /\bonly\s+\d+\s+left\b|\b\d+\s+left\s+in\s+stock\b|\bselling\s+fast\b|\b\d+\s+(?:people|others|users|shoppers)\s+(?:are\s+)?(?:viewing|watching|looking)\b|\bbought\s+in\s+the\s+(?:last|past)\b|\bhigh\s+demand\b|\balmost\s+gone\b/i;

/** Rupee amount from the first price in `s`, e.g. "₹1,299" → 1299. Null if none. */
export function parseRupees(s: string): number | null {
  const m = PRICE_RE.exec(s);
  if (!m) return null;
  const digits = m[0].replace(/^(?:₹|rs\.?)\s?/i, '').replace(/,/g, '');
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

/** Every rupee amount in `s`, in order. */
export function allRupees(s: string): number[] {
  const re = new RegExp(PRICE_RE.source, 'gi');
  const out: number[] = [];
  for (const m of s.matchAll(re)) {
    const n = parseRupees(m[0]);
    if (n !== null) out.push(n);
  }
  return out;
}

/** First time pattern in `s` as seconds (mm:ss or hh:mm:ss). Null if none. */
export function parseTimer(s: string): number | null {
  const m = TIMER_RE.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3]);
}

/** FNV-1a 32-bit hash as 8 hex digits: a short, stable id for a piece of text that does not store the text. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Offer wording on a product card or panel: "50% off", "flat ₹100 off", "buy 1 get 1". */
export const OFFER_RE = /\b\d{1,2}\s?%\s?off\b|\bflat\s+(?:₹|rs\.?)\s?\d[\d,]*\s+off\b|\bbuy\s+\d+\s+get\s+\d+\b/gi;
/** Wording that says an offer is over ("50% off offer ended"). */
export const OFFER_OVER_RE = /\b(?:ended|expired|no longer|not available|sold out)\b/i;

/** Normalised offers in one short text block; none when the block says the offer is over. */
export function liveOffers(s: string): string[] {
  if (OFFER_OVER_RE.test(s)) return [];
  return [...new Set([...s.matchAll(OFFER_RE)].map((m) => normalizeOffer(m[0])))];
}

/** "50 % OFF" → "50% off", "Flat ₹1,000 off" → "flat rs 1000 off". */
export function normalizeOffer(s: string): string {
  return collapse(s.toLowerCase())
    .replace(/\s?%\s?/, '% ')
    .replace(/(?:₹|rs\.?)\s?/, 'rs ')
    .replace(/,/g, '')
    .trim();
}
