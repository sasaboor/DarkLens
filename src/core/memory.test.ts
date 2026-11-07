import { describe, expect, it } from 'vitest';
import type { PageFacts } from './facts';
import {
  MEMORY_LIMITS,
  addDismissal,
  applyObservation,
  cartRiseLive,
  detectCartRise,
  observe,
  emptyHistory,
  emptySiteMemory,
  filterDismissed,
  normalizeSiteMemory,
  pruneHistory,
  updateMemory,
} from './memory';
import { textHash } from './text';
import type { Candidate, CandidateKind, Finding } from './types';

const NOW = Date.UTC(2026, 10, 7, 12);
const URL_KEY = 'https://shop.example/p/1';

function cand(id: string, kind: CandidateKind, text: string, countdown = false): Candidate {
  const features = new Array<number>(12).fill(0);
  if (countdown) features[6] = 1;
  return {
    id,
    text,
    tag: 'div',
    role: null,
    kind,
    rect: { x: 0, y: 0, w: 100, h: 20 },
    counterpartId: null,
    features,
    featureSource: { f03: 'css', f04: 'css' },
    context: { pageType: 'other', inDialog: false, nearbyPrice: null },
  };
}

function page(over: Partial<PageFacts>): PageFacts {
  return { url: URL_KEY, urlKey: URL_KEY, site: 'https://shop.example', canonical: null, pageType: 'other', items: [], product: null, cartCount: null, ...over };
}

describe('updateMemory', () => {
  it('remembers listing offers, newest first, replacing the same product', () => {
    const site = { ...emptySiteMemory(), listingOffers: [{ title: 'Old bottle', href: 'https://shop.example/b', price: 150, offers: [], seenAt: 1 }] };
    const items = [
      { title: 'Bottle', href: 'https://shop.example/b', price: 199, candidateId: 'c1', offers: ['60% off'] },
      { title: 'Kurta', href: null, price: 649, candidateId: 'c2', offers: [] },
    ];
    const out = updateMemory(site, emptyHistory(), { candidates: [], page: page({ pageType: 'listing', items }) }, { now: NOW, loadId: 'L' });
    expect(out.site.listingOffers.map((o) => [o.title, o.price])).toEqual([
      ['Bottle', 199],
      ['Kurta', 649],
    ]);
    expect(site.listingOffers[0]!.price).toBe(150); // input not mutated
  });

  it('remembers the product price and fee types seen on product pages', () => {
    const product = { title: 'Earbuds', href: URL_KEY, price: 1299, candidateId: 'p', offers: [] };
    const candidates = [cand('f', 'fee', 'Delivery fee ₹40')];
    const out = updateMemory(emptySiteMemory(), emptyHistory(), { candidates, page: page({ pageType: 'product', product }) }, { now: NOW, loadId: 'L' });
    expect(out.site.productPrices[URL_KEY]).toEqual({ title: 'Earbuds', price: 1299, url: URL_KEY, offers: [], seenAt: NOW });
    expect(out.site.lastProductPrice).toBe(1299);
    expect(out.site.productFeeTypes).toEqual(['delivery fee']);
  });

  it('collects distinct dialogs and the cart count', () => {
    const candidates = [cand('d', 'dialog', 'Get ₹100 off your first order'), cand('k', 'banner', 'We use cookies')];
    let out = updateMemory(emptySiteMemory(), emptyHistory(), { candidates, page: page({ cartCount: { count: 2, candidateId: null } }) }, { now: NOW, loadId: 'L' });
    out = updateMemory(out.site, out.history, { candidates, page: page({}) }, { now: NOW, loadId: 'L' });
    expect(out.site.dialogKeys).toEqual([textHash('get ₹# off your first order')]);
    expect(out.site.cart.count).toBe(2);
  });

  it('keeps the previous load’s timer end, so a rescan in the same load still sees the reset', () => {
    const timer = [cand('t', 'timer', '15:00', true)];
    const key = `${URL_KEY}|timer#0`;
    let mem = updateMemory(emptySiteMemory(), emptyHistory(), { candidates: timer, page: page({}) }, { now: NOW, loadId: 'A' });
    expect(mem.history.timers[key]).toMatchObject({ endAt: NOW + 900_000, loadId: 'A', prevEndAt: null });
    mem = updateMemory(mem.site, mem.history, { candidates: timer, page: page({}) }, { now: NOW + 30_000, loadId: 'B' });
    expect(mem.history.timers[key]).toMatchObject({ endAt: NOW + 930_000, loadId: 'B', prevEndAt: NOW + 900_000, prevLoadId: 'A' });
    mem = updateMemory(mem.site, mem.history, { candidates: timer, page: page({}) }, { now: NOW + 40_000, loadId: 'B' });
    expect(mem.history.timers[key]).toMatchObject({ endAt: NOW + 930_000, prevEndAt: NOW + 900_000, seenAt: NOW + 40_000 });
  });

  it('keeps the first-seen time of an unchanged stock count and resets it when the count changes', () => {
    const key = `${URL_KEY}|stock|only # left`;
    let mem = updateMemory(emptySiteMemory(), emptyHistory(), { candidates: [cand('s', 'stock', 'Only 2 left')], page: page({}) }, { now: NOW, loadId: 'A' });
    mem = updateMemory(mem.site, mem.history, { candidates: [cand('s', 'stock', 'Only 2 left')], page: page({}) }, { now: NOW + 86_400_000, loadId: 'B' });
    expect(mem.history.stock[key]).toEqual({ count: 2, firstSeenAt: NOW, seenAt: NOW + 86_400_000 });
    mem = updateMemory(mem.site, mem.history, { candidates: [cand('s', 'stock', 'Only 1 left')], page: page({}) }, { now: NOW + 2 * 86_400_000, loadId: 'C' });
    expect(mem.history.stock[key]!.firstSeenAt).toBe(NOW + 2 * 86_400_000);
  });
});

describe('pruneHistory', () => {
  it('drops entries older than 7 days', () => {
    const h = emptyHistory();
    h.stock.old = { count: 1, firstSeenAt: 0, seenAt: NOW - 8 * 86_400_000 };
    h.stock.fresh = { count: 1, firstSeenAt: 0, seenAt: NOW - 86_400_000 };
    expect(Object.keys(pruneHistory(h, NOW).stock)).toEqual(['fresh']);
  });

  it('keeps at most 500 entries, newest first', () => {
    const h = emptyHistory();
    for (let i = 0; i < 520; i++) h.timers[`t${i}`] = { endAt: 0, loadId: 'x', seenAt: NOW - i, prevEndAt: null, prevLoadId: null };
    const out = pruneHistory(h, NOW);
    expect(Object.keys(out.timers)).toHaveLength(MEMORY_LIMITS.historyEntries);
    expect(out.timers.t0).toBeDefined();
    expect(out.timers.t519).toBeUndefined();
  });
});

describe('detectCartRise', () => {
  it('reports a rise with no add-to-cart click', () => {
    expect(detectCartRise(2, 3, false)).toEqual({ from: 2, to: 3 });
    expect(detectCartRise(2, 3, true)).toBeNull();
    expect(detectCartRise(3, 3, false)).toBeNull();
    expect(detectCartRise(null, 3, false)).toBeNull();
  });
});

describe('dismissals', () => {
  const finding: Finding = { candidateId: 'c1', category: 1, confidence: 0.7, source: 'rule', reason: '', evidence: [] };
  const candidates = [cand('c1', 'stock', 'Only 2 left')];
  const key = (u: string) => u.split('?')[0]!;

  it('drops a finding the user dismissed on this URL only', () => {
    const d = [{ url: `${URL_KEY}?ref=x`, text: 'Only 2 left', category: 1, at: NOW }];
    expect(filterDismissed([finding], candidates, d, key, URL_KEY)).toEqual([]);
    expect(filterDismissed([finding], candidates, d, key, 'https://shop.example/p/2')).toHaveLength(1);
    expect(filterDismissed([finding], candidates, [{ ...d[0]!, category: 2 }], key, URL_KEY)).toHaveLength(1);
  });

  it('stores each dismissal once and caps the list', () => {
    let list = addDismissal([], { url: 'u', text: 't', category: 1, at: 1 });
    list = addDismissal(list, { url: 'u', text: 't', category: 1, at: 2 });
    expect(list).toEqual([{ url: 'u', text: 't', category: 1, at: 2 }]);
    for (let i = 0; i < 600; i++) list = addDismissal(list, { url: 'u', text: `t${i}`, category: 1, at: i });
    expect(list).toHaveLength(MEMORY_LIMITS.dismissals);
  });
});

describe('normalizeSiteMemory', () => {
  it('fills in missing fields from stored data', () => {
    expect(normalizeSiteMemory(undefined)).toEqual(emptySiteMemory());
    expect(normalizeSiteMemory({ dialogKeys: ['a'], cart: { count: 2 } })).toMatchObject({ dialogKeys: ['a'], listingOffers: [], cart: { count: 2, addClickAt: null } });
  });
});

describe('observe and applyObservation', () => {
  const product = { title: 'Earbuds', href: 'https://shop.example/earbuds', price: 1299, candidateId: 'p', offers: ['10% off'] };

  it('updateMemory is applyObservation(observe(scan))', () => {
    const scan = {
      candidates: [cand('t', 'timer', '15:00', true), cand('s', 'stock', 'Only 2 left'), cand('d', 'dialog', 'Join for ₹99'), cand('f', 'fee', 'Delivery fee ₹40')],
      page: page({ pageType: 'product', product, cartCount: { count: 1, candidateId: null } }),
    };
    const at = { now: NOW, loadId: 'L' };
    const a = updateMemory(emptySiteMemory(), emptyHistory(), scan, at);
    const b = applyObservation(emptySiteMemory(), emptyHistory(), observe(scan, { now: NOW }), at);
    expect(b).toEqual(a);
  });

  it('keys the product by its canonical URL (facts put it in product.href) and keeps the page URL and offers', () => {
    const o = observe({ candidates: [], page: page({ pageType: 'product', product, canonical: 'https://shop.example/earbuds' }) }, { now: NOW });
    expect(o.product).toEqual({ key: 'https://shop.example/earbuds', title: 'Earbuds', price: 1299, url: URL_KEY, offers: ['10% off'] });
    const out = applyObservation(emptySiteMemory(), emptyHistory(), o, { now: NOW, loadId: 'L' });
    expect(out.site.productPrices['https://shop.example/earbuds']).toMatchObject({ price: 1299, url: URL_KEY, offers: ['10% off'] });
  });

  it('stores listing cards with their offers, and nothing about dialogs but a hash', () => {
    const items = [{ title: 'Bottle', href: 'https://shop.example/b', price: 199, candidateId: 'c1', offers: ['60% off'] }];
    const o = observe({ candidates: [cand('d', 'dialog', 'Enter your email for ₹100 off')], page: page({ pageType: 'listing', items }) }, { now: NOW });
    expect(o.listing).toEqual([{ title: 'Bottle', href: 'https://shop.example/b', price: 199, offers: ['60% off'] }]);
    expect(o.overlayKeys).toHaveLength(1);
    expect(o.overlayKeys[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(o)).not.toContain('email');
  });

  it('deduplicates a pop-up whose numbers change between pages', () => {
    const a = observe({ candidates: [cand('d', 'dialog', 'Only 2 hours left: ₹100 off')], page: page({}) }, { now: NOW });
    const b = observe({ candidates: [cand('d', 'dialog', 'Only 1 hours left: ₹150 off')], page: page({}) }, { now: NOW });
    let mem = applyObservation(emptySiteMemory(), emptyHistory(), a, { now: NOW, loadId: 'A' });
    mem = applyObservation(mem.site, mem.history, b, { now: NOW, loadId: 'B' });
    expect(mem.site.dialogKeys).toHaveLength(1);
  });

  it('caps the remembered product prices, dropping the oldest', () => {
    let site = emptySiteMemory();
    for (let i = 0; i < MEMORY_LIMITS.productPrices + 5; i++) {
      const o = observe({ candidates: [], page: page({ pageType: 'product', product: { ...product, href: `k${i}` } }) }, { now: NOW + i });
      site = applyObservation(site, emptyHistory(), o, { now: NOW + i, loadId: `L${i}` }).site;
    }
    expect(Object.keys(site.productPrices)).toHaveLength(MEMORY_LIMITS.productPrices);
    expect(site.productPrices.k0).toBeUndefined();
  });
});

describe('cartRiseLive', () => {
  it('flags a rise with no add-to-cart click in the previous 2 s', () => {
    expect(cartRiseLive(1, 2, null, NOW)).toEqual({ from: 1, to: 2 });
    expect(cartRiseLive(1, 2, NOW - 2100, NOW)).toEqual({ from: 1, to: 2 });
    expect(cartRiseLive(1, 2, NOW - 1900, NOW)).toBeNull();
    expect(cartRiseLive(2, 2, null, NOW)).toBeNull();
    expect(cartRiseLive(2, 1, null, NOW)).toBeNull();
    expect(cartRiseLive(null, 1, null, NOW)).toBeNull();
  });
});

describe('normalizeSiteMemory with older stored shapes', () => {
  it('fills in url and offers for product prices and offers for listing cards', () => {
    const out = normalizeSiteMemory({
      productPrices: { [URL_KEY]: { title: 'Earbuds', price: 1299, seenAt: 1 }, broken: null },
      listingOffers: [{ title: 'Bottle', href: null, price: 199, seenAt: 1 }],
    });
    expect(out.productPrices).toEqual({ [URL_KEY]: { title: 'Earbuds', price: 1299, url: URL_KEY, offers: [], seenAt: 1 } });
    expect(out.listingOffers[0]!.offers).toEqual([]);
  });
});
