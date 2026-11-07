/**
 * Decides when the page changed enough to rescan: a dialog or fixed/sticky
 * overlay was added or revealed, priced content was revealed, or many elements
 * were added at once. Text-only changes (ticking timers, viewer counts) and
 * anything inside our own overlay are ignored. Also reports single-page-app
 * URL changes.
 */
import { DIALOG_SELECTOR } from '@/src/core/extractor';
import { PRICE_RE } from '@/src/core/text';

/** Added elements in one batch that count as a large DOM addition. */
const LARGE_ADDITION = 40;
/** Computed-style checks per mutation batch, to keep the callback cheap. */
const MAX_STYLE_CHECKS = 20;
const OVERLAY_HINT = /modal|popup|pop-up|overlay|dialog|banner|drawer|toast|sheet|lightbox|interstitial|notif/i;
const WATCHED_ATTRIBUTES = ['hidden', 'open', 'style', 'class', 'aria-hidden', 'aria-modal'];

function visibleNow(el: Element): boolean {
  return (el as Element & { checkVisibility?: () => boolean }).checkVisibility?.() ?? true;
}

function fixedOrSticky(el: Element): boolean {
  const p = getComputedStyle(el).position;
  return p === 'fixed' || p === 'sticky';
}

function hinted(el: Element): boolean {
  return OVERLAY_HINT.test(`${el.id} ${el.getAttribute('class') ?? ''}`);
}

export interface WatchOptions {
  isOwn: (node: Node) => boolean;
  /** The page changed enough to rescan. */
  onChange: () => void;
  /** The URL (without hash) changed: pushState, replaceState, popstate or a navigation. */
  onUrlChange: (url: string) => void;
  /** Any mutation batch outside our overlay (for the cart badge watch). Keep it cheap; the caller throttles. */
  onMutations?: () => void;
}

export function watchPage({ isOwn, onChange, onUrlChange, onMutations }: WatchOptions): () => void {
  const observer = new MutationObserver((records) => {
    let added = 0;
    let checks = 0;
    let significant = false;
    if (onMutations && records.some((m) => !isOwn(m.target))) onMutations();
    const check = (test: () => boolean) => {
      if (significant || checks >= MAX_STYLE_CHECKS) return;
      checks++;
      if (test()) significant = true;
    };

    for (const m of records) {
      if (isOwn(m.target)) continue;
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || isOwn(node)) continue;
          const el = node as Element;
          added += 1 + Math.min(el.getElementsByTagName('*').length, LARGE_ADDITION);
          check(() => el.matches(DIALOG_SELECTOR) || !!el.querySelector(DIALOG_SELECTOR) || (fixedOrSticky(el) && visibleNow(el)));
        }
      } else if (m.type === 'attributes') {
        const el = m.target as Element;
        const revealed = m.attributeName === 'hidden' || m.attributeName === 'open' || m.attributeName === 'aria-hidden';
        if (!revealed && !el.matches(DIALOG_SELECTOR) && !hinted(el)) continue;
        check(() => {
          if (!visibleNow(el)) return false;
          if (el.matches(DIALOG_SELECTOR) || fixedOrSticky(el)) return true;
          // A revealed block with a price (an item that appears in the cart on its own).
          return revealed && PRICE_RE.test(el.textContent ?? '');
        });
      }
      if (significant) break;
    }
    if (significant || added >= LARGE_ADDITION) onChange();
    checkUrl();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });

  // SPA navigation. The Navigation API's navigate events cover pushState, replaceState and
  // back/forward without patching the page's history object; popstate and a 1 s check are fallbacks.
  const strip = (u: string) => u.split('#')[0]!;
  let last = strip(location.href);
  const checkUrl = () => {
    const now = strip(location.href);
    if (now === last) return;
    last = now;
    onUrlChange(now);
  };
  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', checkUrl);
  window.addEventListener('popstate', checkUrl);
  const poll = setInterval(checkUrl, 1000);

  return () => {
    observer.disconnect();
    nav?.removeEventListener('navigatesuccess', checkUrl);
    window.removeEventListener('popstate', checkUrl);
    clearInterval(poll);
  };
}
