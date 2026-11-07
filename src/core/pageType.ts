/**
 * Page type from URL patterns first, then DOM cues: address or payment step =
 * checkout; order summary or proceed-to-checkout = cart; several add-to-cart
 * buttons = listing; one add-to-cart or buy-now = product.
 */
import type { PageType } from './types';
import { collapse, elementText } from './text';

const seg = (words: string) => new RegExp(`(?:^|[/_.-])(?:${words})(?:[/_.?=-]|$)`, 'i');

const URL_RULES: [RegExp, PageType][] = [
  [seg('checkout|payment|payments|shipping'), 'checkout'],
  [seg('cart|viewcart|basket|bag'), 'cart'],
  [seg('product|products|dp|p'), 'product'],
  [seg('search|category|categories|collections?|s'), 'listing'],
];

const CHECKOUT_FIELDS =
  '[autocomplete~="street-address"], [autocomplete~="postal-code"], [autocomplete~="address-line1"], [autocomplete^="cc-"]';
const CONTROLS = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

function controlText(el: Element): string {
  if (el.tagName === 'INPUT') return collapse(el.getAttribute('value'));
  return elementText(el);
}

export function pageTypeFromUrl(url: string): PageType | null {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    path = url;
  }
  for (const [re, type] of URL_RULES) if (re.test(path)) return type;
  return null;
}

export function pageTypeFromDom(doc: Document): PageType {
  const controls = [...doc.querySelectorAll(CONTROLS)].map(controlText);
  const headings = [...doc.querySelectorAll('h1, h2, h3, h4, legend')].map((h) => elementText(h));

  const hasPlaceOrder = controls.some((t) => /\b(?:place (?:your )?order|pay now|pay (?:₹|rs))/i.test(t));
  const hasPaymentStep = headings.some((t) => /\b(?:payment|delivery address|shipping address)\b/i.test(t));
  if (doc.querySelector(CHECKOUT_FIELDS) || (hasPaymentStep && hasPlaceOrder)) return 'checkout';

  const proceed = controls.some((t) => /\bproceed to (?:checkout|buy|pay)\b/i.test(t));
  const summary = headings.some((t) => /\b(?:order summary|price details|your cart|shopping cart)\b/i.test(t));
  if (proceed || summary) return 'cart';

  const addToCart = controls.filter((t) => /\badd to (?:cart|bag|basket)\b/i.test(t)).length;
  if (addToCart >= 3) return 'listing';
  if (addToCart >= 1 || controls.some((t) => /\bbuy now\b/i.test(t))) return 'product';
  return 'other';
}

export function detectPageType(doc: Document, url: string): PageType {
  return pageTypeFromUrl(url) ?? pageTypeFromDom(doc);
}
