/**
 * Cross-page memory, as pure data and pure updates. The background worker
 * owns the stored copy (src/storage.ts): the content script asks it for the
 * memory, passes that to runRules, then sends observe(scan) back, which the
 * background folds in with applyObservation. Playwright tools carry the same
 * objects between pages with updateMemory.
 *
 * SiteMemory lives in chrome.storage.session, one per site (product prices
 * seen, listing offers, dialogs seen, cart count). HistoryMemory lives in
 * chrome.storage.local (timer end times and stock counts per URL, kept 7 days,
 * at most 500 entries).
 */
import type { PageFacts } from './facts';
import { RULES_CONFIG, feeType, nagOverlays, overlayKey, stockObservations, timerObservations } from './rules';
import type { Candidate, Finding, PageType } from './types';

export interface ListingOffer {
  title: string;
  href: string | null;
  price: number;
  /** Offer wording on the card ("50% off"), normalised. */
  offers: string[];
  seenAt: number;
}

export interface ProductPrice {
  title: string;
  price: number;
  /** The product page's URL (origin + path). */
  url: string;
  /** Live offers on the product page. */
  offers: string[];
  seenAt: number;
}

export interface SiteMemory {
  /** Prices on listing cards, newest first. */
  listingOffers: ListingOffer[];
  /** Product page prices by product key (canonical URL, else page URL). */
  productPrices: Record<string, ProductPrice>;
  /** The most recent product page price: the "remembered product price" for f12. */
  lastProductPrice: number | null;
  /** Fee types ("delivery fee") shown on product pages this session. */
  productFeeTypes: string[];
  /** Distinct dialogs and overlays seen this session, as text hashes (overlayKey). */
  dialogKeys: string[];
  cart: {
    /** Cart badge count at the last scan. */
    count: number | null;
    countAt: number;
    /** Last click on an add-to-cart or buy-now control. */
    addClickAt: number | null;
  };
}

export interface TimerEntry {
  endAt: number;
  loadId: string;
  seenAt: number;
  /** The end time from the load before `loadId`, so rescans in one load still compare with the previous load. */
  prevEndAt: number | null;
  prevLoadId: string | null;
}

export interface StockEntry {
  count: number;
  /** When this count was first seen. */
  firstSeenAt: number;
  seenAt: number;
}

export interface HistoryMemory {
  timers: Record<string, TimerEntry>;
  stock: Record<string, StockEntry>;
}

export interface Dismissal {
  url: string;
  text: string;
  category: number;
  at: number;
}

export const MEMORY_LIMITS = {
  listingOffers: 200,
  productPrices: 200,
  dialogKeys: 100,
  historyEntries: 500,
  historyMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  dismissals: 500,
};

export function emptySiteMemory(): SiteMemory {
  return {
    listingOffers: [],
    productPrices: {},
    lastProductPrice: null,
    productFeeTypes: [],
    dialogKeys: [],
    cart: { count: null, countAt: 0, addClickAt: null },
  };
}

export function emptyHistory(): HistoryMemory {
  return { timers: {}, stock: {} };
}

/** Fills in fields missing from stored memory (older builds, partial writes). */
export function normalizeSiteMemory(raw: unknown): SiteMemory {
  const base = emptySiteMemory();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<SiteMemory>;
  const productPrices: Record<string, ProductPrice> = {};
  for (const [key, p] of Object.entries((r.productPrices ?? {}) as Record<string, Partial<ProductPrice>>)) {
    if (p && typeof p.price === 'number') {
      productPrices[key] = { title: p.title ?? '', price: p.price, url: p.url ?? key, offers: p.offers ?? [], seenAt: p.seenAt ?? 0 };
    }
  }
  return {
    ...base,
    ...r,
    listingOffers: (r.listingOffers ?? []).map((o) => ({ ...o, offers: o.offers ?? [] })),
    productPrices,
    cart: { ...base.cart, ...(r.cart ?? {}) },
  };
}

export function normalizeHistory(raw: unknown): HistoryMemory {
  if (!raw || typeof raw !== 'object') return emptyHistory();
  const r = raw as Partial<HistoryMemory>;
  return { timers: r.timers ?? {}, stock: r.stock ?? {} };
}

/** Drops entries older than 7 days, then the oldest beyond 500. */
export function pruneHistory(history: HistoryMemory, now: number): HistoryMemory {
  const cutoff = now - MEMORY_LIMITS.historyMaxAgeMs;
  const all: { kind: 'timers' | 'stock'; key: string; seenAt: number }[] = [];
  for (const [key, e] of Object.entries(history.timers)) if (e.seenAt >= cutoff) all.push({ kind: 'timers', key, seenAt: e.seenAt });
  for (const [key, e] of Object.entries(history.stock)) if (e.seenAt >= cutoff) all.push({ kind: 'stock', key, seenAt: e.seenAt });
  all.sort((a, b) => b.seenAt - a.seenAt);
  const out = emptyHistory();
  for (const { kind, key } of all.slice(0, MEMORY_LIMITS.historyEntries)) {
    if (kind === 'timers') out.timers[key] = history.timers[key]!;
    else out.stock[key] = history.stock[key]!;
  }
  return out;
}

export interface ScanForMemory {
  candidates: Candidate[];
  page: PageFacts;
}

/**
 * What one scan adds to memory, small enough to send to the background:
 * prices, offers and keys only. Dialogs are reduced to text hashes, and no
 * candidate text other than product titles, offers and fee names is kept.
 */
export interface ScanObservation {
  pageType: PageType;
  urlKey: string;
  /** Listing pages: the priced cards. */
  listing: { title: string; href: string | null; price: number; offers: string[] }[];
  /** Product pages: the main product, keyed by canonical URL or page URL. */
  product: { key: string; title: string; price: number; url: string; offers: string[] } | null;
  /** Product pages: fee types shown. */
  productFeeTypes: string[];
  /** Dialogs and overlays that count towards nagging (text hashes). */
  overlayKeys: string[];
  timers: { key: string; endAt: number }[];
  stock: { key: string; count: number }[];
  cartCount: number | null;
}

/** The memory-relevant part of a scan. Pure. */
export function observe(scan: ScanForMemory, { now }: { now: number }): ScanObservation {
  const { candidates, page } = scan;
  const isProduct = page.pageType === 'product';
  const feeTypes = new Set<string>();
  if (isProduct) {
    for (const c of candidates) {
      const type = c.kind === 'fee' ? feeType(c.text) : null;
      if (type) feeTypes.add(type);
    }
  }
  return {
    pageType: page.pageType,
    urlKey: page.urlKey,
    listing:
      page.pageType === 'listing'
        ? page.items.map((i) => ({ title: i.title, href: i.href, price: i.price, offers: i.offers }))
        : [],
    product:
      isProduct && page.product
        ? {
            key: page.product.href ?? page.urlKey,
            title: page.product.title,
            price: page.product.price,
            url: page.urlKey,
            offers: page.product.offers,
          }
        : null,
    productFeeTypes: [...feeTypes],
    overlayKeys: [...new Set(nagOverlays(candidates).map(overlayKey))],
    timers: timerObservations(candidates, page.urlKey, now).map(({ key, endAt }) => ({ key, endAt })),
    stock: stockObservations(candidates, page.urlKey).map(({ key, count }) => ({ key, count })),
    cartCount: page.cartCount?.count ?? null,
  };
}

/** Memory after one observation. Pure: returns new objects. */
export function applyObservation(
  site: SiteMemory,
  history: HistoryMemory,
  obs: ScanObservation,
  { now, loadId }: { now: number; loadId: string },
): { site: SiteMemory; history: HistoryMemory } {
  const next: SiteMemory = {
    ...site,
    listingOffers: [...site.listingOffers],
    productPrices: { ...site.productPrices },
    productFeeTypes: [...site.productFeeTypes],
    dialogKeys: [...site.dialogKeys],
    cart: { ...site.cart },
  };

  if (obs.listing.length) {
    const fresh: ListingOffer[] = obs.listing.map((i) => ({ ...i, seenAt: now }));
    const same = (a: ListingOffer, b: ListingOffer) => (a.href && b.href ? a.href === b.href : a.title === b.title);
    next.listingOffers = [...fresh, ...next.listingOffers.filter((o) => !fresh.some((f) => same(f, o)))].slice(
      0,
      MEMORY_LIMITS.listingOffers,
    );
  }

  if (obs.product) {
    const { key, ...p } = obs.product;
    next.productPrices[key] = { ...p, seenAt: now };
    const keys = Object.keys(next.productPrices);
    if (keys.length > MEMORY_LIMITS.productPrices) {
      const oldest = keys.sort((a, b) => next.productPrices[a]!.seenAt - next.productPrices[b]!.seenAt);
      for (const k of oldest.slice(0, keys.length - MEMORY_LIMITS.productPrices)) delete next.productPrices[k];
    }
    next.lastProductPrice = p.price;
  }
  for (const type of obs.productFeeTypes) if (!next.productFeeTypes.includes(type)) next.productFeeTypes.push(type);

  for (const key of obs.overlayKeys) if (!next.dialogKeys.includes(key)) next.dialogKeys.push(key);
  next.dialogKeys = next.dialogKeys.slice(-MEMORY_LIMITS.dialogKeys);

  if (obs.cartCount !== null) next.cart = { ...next.cart, count: obs.cartCount, countAt: now };

  const timers = { ...history.timers };
  for (const t of obs.timers) {
    const e = timers[t.key];
    if (!e) timers[t.key] = { endAt: t.endAt, loadId, seenAt: now, prevEndAt: null, prevLoadId: null };
    else if (e.loadId === loadId) timers[t.key] = { ...e, seenAt: now };
    else timers[t.key] = { endAt: t.endAt, loadId, seenAt: now, prevEndAt: e.endAt, prevLoadId: e.loadId };
  }
  const stock = { ...history.stock };
  for (const s of obs.stock) {
    const e = stock[s.key];
    stock[s.key] = e && e.count === s.count ? { ...e, seenAt: now } : { count: s.count, firstSeenAt: now, seenAt: now };
  }

  return { site: next, history: pruneHistory({ timers, stock }, now) };
}

/** Memory after this scan: applyObservation(observe(scan)). Pure. */
export function updateMemory(
  site: SiteMemory,
  history: HistoryMemory,
  scan: ScanForMemory,
  { now, loadId }: { now: number; loadId: string },
): { site: SiteMemory; history: HistoryMemory } {
  return applyObservation(site, history, observe(scan, { now }), { now, loadId });
}

/**
 * Live cart watch on one page: the badge went up and the user clicked no
 * add-to-cart control in the previous 2 s (RULES_CONFIG.basketSneaking.addClickWindowMs).
 */
export function cartRiseLive(
  prev: number | null,
  next: number | null,
  lastAddClickAt: number | null,
  now: number,
): { from: number; to: number } | null {
  if (prev === null || next === null || next <= prev) return null;
  if (lastAddClickAt !== null && now - lastAddClickAt <= RULES_CONFIG.basketSneaking.addClickWindowMs) return null;
  return { from: prev, to: next };
}

/** Across pages: the cart badge is higher than the stored count and the user clicked no add-to-cart control since it was stored. */
export function detectCartRise(
  baseline: number | null,
  current: number | null,
  addClickedSince: boolean,
): { from: number; to: number } | null {
  if (baseline === null || current === null || addClickedSince || current <= baseline) return null;
  return { from: baseline, to: current };
}

/** Drops findings the user marked "Not a dark pattern" on this URL. */
export function filterDismissed(
  findings: Finding[],
  candidates: Candidate[],
  dismissed: Dismissal[],
  urlKeyOf: (url: string) => string,
  pageUrlKey: string,
): Finding[] {
  if (!dismissed.length) return findings;
  const text = new Map(candidates.map((c) => [c.id, c.text]));
  return findings.filter(
    (f) =>
      !dismissed.some(
        (d) => d.category === f.category && d.text === text.get(f.candidateId) && urlKeyOf(d.url) === pageUrlKey,
      ),
  );
}

export function addDismissal(list: Dismissal[], d: Dismissal): Dismissal[] {
  return [...list.filter((x) => !(x.url === d.url && x.text === d.text && x.category === d.category)), d].slice(
    -MEMORY_LIMITS.dismissals,
  );
}
