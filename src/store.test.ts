import { describe, expect, it } from 'vitest';
import type { PageFacts } from './core/facts';
import { MEMORY_LIMITS, observe, type ScanObservation } from './core/memory';
import { CAT, runRules } from './core/rules';
import type { Candidate, CandidateKind } from './core/types';
import { DISMISSED_KEY, HISTORY_KEY, createStore, siteStorageKey, type StorageAreaLike } from './store';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12);
const PRODUCT_URL = 'https://shop.example/p/1?ref=home';
const KEY = 'https://shop.example/p/1';

/** An in-memory chrome.storage area that yields between calls, like the real async API. */
function fakeArea(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    async get(keys) {
      await tick();
      if (keys === null) return structuredClone(data);
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      await tick();
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

function setup() {
  const session = fakeArea();
  const local = fakeArea();
  return { session, local, store: createStore({ session, local }) };
}

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

function page(over: Partial<PageFacts> = {}): PageFacts {
  return { url: PRODUCT_URL, urlKey: KEY, site: 'https://shop.example', canonical: null, pageType: 'other', items: [], product: null, cartCount: null, ...over };
}

function obs(over: Partial<ScanObservation> = {}): ScanObservation {
  return { pageType: 'other', urlKey: KEY, listing: [], product: null, productFeeTypes: [], overlayKeys: [], timers: [], stock: [], cartCount: null, ...over };
}

describe('state store', () => {
  it('keeps session memory per site and history in local storage', async () => {
    const { store, session, local } = setup();
    const product = { key: KEY, title: 'Earbuds', price: 1299, url: KEY, offers: [] };
    await store.record(PRODUCT_URL, obs({ pageType: 'product', product }), { now: NOW, loadId: 'A' });
    expect(Object.keys(session.data)).toEqual([siteStorageKey('https://shop.example')]);
    expect(Object.keys(local.data)).toEqual([HISTORY_KEY]);

    const same = await store.getState('https://shop.example/cart', NOW);
    expect(same.site.lastProductPrice).toBe(1299);
    const other = await store.getState('https://other.example/cart', NOW);
    expect(other.site.lastProductPrice).toBeNull();
  });

  it('serialises concurrent records so neither tab overwrites the other', async () => {
    const { store } = setup();
    const p = (n: number) => obs({ pageType: 'product', product: { key: `${KEY}${n}`, title: `P${n}`, price: n, url: `${KEY}${n}`, offers: [] } });
    await Promise.all([1, 2, 3, 4].map((n) => store.record(PRODUCT_URL, p(n), { now: NOW + n, loadId: `L${n}` })));
    const { site } = await store.getState(PRODUCT_URL, NOW);
    expect(Object.keys(site.productPrices).sort()).toEqual([`${KEY}1`, `${KEY}2`, `${KEY}3`, `${KEY}4`]);
  });

  it('prunes the history to 7 days and 500 entries on every write and read', async () => {
    const { store, local } = setup();
    const stock = Array.from({ length: 520 }, (_, i) => ({ key: `${KEY}|stock|${i}`, count: 2 }));
    await store.record(PRODUCT_URL, obs({ stock }), { now: NOW, loadId: 'A' });
    const saved = local.data[HISTORY_KEY] as { stock: Record<string, unknown> };
    expect(Object.keys(saved.stock)).toHaveLength(MEMORY_LIMITS.historyEntries);

    const later = await store.getState(PRODUCT_URL, NOW + 8 * DAY);
    expect(Object.keys(later.history.stock)).toHaveLength(0);
  });

  it('records add-to-cart clicks and dismissals with the URL the background supplies', async () => {
    const { store, local } = setup();
    await store.noteAddClick(PRODUCT_URL, NOW);
    await store.dismiss({ url: PRODUCT_URL, text: 'Only 2 left', category: 1, at: NOW });
    const state = await store.getState(PRODUCT_URL, NOW);
    expect(state.site.cart.addClickAt).toBe(NOW);
    expect(state.dismissed).toEqual([{ url: PRODUCT_URL, text: 'Only 2 left', category: 1, at: NOW }]);
    expect(local.data[DISMISSED_KEY]).toHaveLength(1);
  });

  it('clear forgets history, dismissals and site memory but nothing else', async () => {
    const { store, session, local } = setup();
    session.data['tab:7'] = { score: 10 };
    local.data.settings = { autoScan: true };
    await store.record(PRODUCT_URL, obs({ stock: [{ key: 'k', count: 1 }] }), { now: NOW, loadId: 'A' });
    await store.dismiss({ url: PRODUCT_URL, text: 't', category: 1, at: NOW });
    await store.clear();
    expect(Object.keys(session.data)).toEqual(['tab:7']);
    expect(Object.keys(local.data)).toEqual(['settings']);
  });
});

describe('repeat visits through the store', () => {
  it('a timer whose end time moved later after a reload is a confirmed, hard false_urgency', async () => {
    const { store } = setup();
    const timer = [cand('t', 'timer', '15:00', true)];
    const p = page();
    // First load: 15:00 left. Reload 30 s later: 15:00 left again, so the deadline moved 30 s later.
    await store.record(PRODUCT_URL, observe({ candidates: timer, page: p }, { now: NOW }), { now: NOW, loadId: 'A' });
    const second = await store.getState(PRODUCT_URL, NOW + 30_000);
    const [f] = runRules(timer, { page: p, facts: {}, history: second.history, site: second.site, loadId: 'B', now: NOW + 30_000 });
    expect(f).toMatchObject({ category: CAT.false_urgency, confirmed: true, hard: true });
  });

  it('a countdown that keeps running across loads is not confirmed', async () => {
    const { store } = setup();
    const p = page();
    await store.record(PRODUCT_URL, observe({ candidates: [cand('t', 'timer', '15:00', true)], page: p }, { now: NOW }), { now: NOW, loadId: 'A' });
    const later = [cand('t', 'timer', '14:30', true)];
    const state = await store.getState(PRODUCT_URL, NOW + 30_000);
    const [f] = runRules(later, { page: p, facts: {}, history: state.history, loadId: 'B', now: NOW + 30_000 });
    expect(f!.confirmed).toBeUndefined();
  });

  it('the same stock number on a later day is confirmed; on the same day it is not', async () => {
    const { store } = setup();
    const stock = [cand('s', 'stock', 'Only 2 left in stock')];
    const p = page();
    await store.record(PRODUCT_URL, observe({ candidates: stock, page: p }, { now: NOW }), { now: NOW, loadId: 'A' });

    const sameDay = await store.getState(PRODUCT_URL, NOW + 3_600_000);
    expect(runRules(stock, { page: p, facts: {}, history: sameDay.history, now: NOW + 3_600_000 })[0]!.confirmed).toBeUndefined();

    const nextDay = await store.getState(PRODUCT_URL, NOW + DAY);
    const [f] = runRules(stock, { page: p, facts: {}, history: nextDay.history, now: NOW + DAY });
    expect(f).toMatchObject({ category: CAT.false_urgency, confirmed: true });
  });

  it('nagging fires at the third distinct pop-up of the session, and repeats of one pop-up count once', async () => {
    const { store } = setup();
    const visit = async (text: string, n: number) => {
      const c = [cand(`d${n}`, 'dialog', text)];
      const state = await store.getState(PRODUCT_URL, NOW + n);
      const findings = runRules(c, { page: page(), facts: {}, site: state.site, now: NOW + n });
      await store.record(PRODUCT_URL, observe({ candidates: c, page: page() }, { now: NOW + n }), { now: NOW + n, loadId: `L${n}` });
      return findings.filter((f) => f.category === CAT.nagging).length;
    };
    expect(await visit('Get ₹100 off your first order', 1)).toBe(0);
    expect(await visit('Get ₹150 off your first order', 2)).toBe(0); // same pop-up, digits differ
    expect(await visit('Allow notifications for deals', 3)).toBe(0);
    expect(await visit('Download our app for 10% off', 4)).toBe(1);
    expect((await store.getState(PRODUCT_URL, NOW)).site.dialogKeys).toHaveLength(3);
  });
});
