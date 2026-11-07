import { describe, expect, it } from 'vitest';
import type { CandidateFacts, PageFacts } from './facts';
import { emptyHistory, emptySiteMemory, type SiteMemory } from './memory';
import { CAT, RULES_CONFIG, rectGap, runRules, titlesMatch, type RuleState } from './rules';
import type { Candidate, CandidateKind, Rect } from './types';

/** Neutral features: no counterpart, good contrast, nothing checked, far from the CTA, price unknown. */
const NEUTRAL = [1, 1, 7, 0.1, 0, 0, 0, 0, 0, 0, 0.5, 0];
const F = {
  font_ratio: 0,
  area_ratio: 1,
  contrast: 2,
  salience: 3,
  default_checked: 4,
  faded: 5,
  countdown: 6,
  overlay_coverage: 7,
  unclosable_modal: 8,
  decline_as_link: 9,
  cta_distance: 10,
  price_delta: 11,
} as const;
type FeatureKey = keyof typeof F;

let next = 0;
function cand(
  kind: CandidateKind,
  text: string,
  opts: { f?: Partial<Record<FeatureKey, number>>; rect?: Partial<Rect>; id?: string; counterpartId?: string } = {},
): Candidate {
  const features = [...NEUTRAL];
  for (const [k, v] of Object.entries(opts.f ?? {})) features[F[k as FeatureKey]] = v;
  return {
    id: opts.id ?? `c${next++}`,
    text,
    tag: kind === 'checkbox' ? 'input' : kind === 'control' ? 'button' : 'div',
    role: null,
    kind,
    rect: { x: 0, y: 0, w: 100, h: 20, ...opts.rect },
    counterpartId: opts.counterpartId ?? null,
    features,
    featureSource: { f03: 'css', f04: 'css' },
    context: { pageType: 'other', inDialog: false, nearbyPrice: null },
  };
}

function page(over: Partial<PageFacts> = {}): PageFacts {
  return {
    url: 'https://shop.example/p/1',
    urlKey: 'https://shop.example/p/1',
    site: 'https://shop.example',
    canonical: null,
    pageType: 'other',
    items: [],
    product: null,
    cartCount: null,
    ...over,
  };
}

function facts(over: Record<string, Partial<CandidateFacts>> = {}): Record<string, CandidateFacts> {
  const out: Record<string, CandidateFacts> = {};
  for (const [id, f] of Object.entries(over)) {
    out[id] = { fontSize: 14, grey: false, struck: false, inRepeatedList: false, lineAmount: null, radio: false, ...f };
  }
  return out;
}

function run(cands: Candidate[], state: Partial<RuleState> = {}) {
  return runRules(cands, { page: page(), facts: {}, ...state });
}

function only(cands: Candidate[], state: Partial<RuleState> = {}) {
  const out = run(cands, state);
  expect(out).toHaveLength(1);
  return out[0]!;
}

function pair(decline: Partial<Record<FeatureKey, number>>, accept: Partial<Record<FeatureKey, number>> = {}) {
  const a = cand('control', 'Accept all', { id: 'acc', counterpartId: 'dec', f: accept });
  const d = cand('control', 'Decline', { id: 'dec', counterpartId: 'acc', f: decline });
  return [a, d];
}

describe('interface_interference', () => {
  it('fires when accept is more than 2.5x the area of decline, quoting the ratio and the decline style', () => {
    const f = only(pair({ area_ratio: 1 / 3.4 }), {
      facts: facts({ dec: { fontSize: 11, grey: true }, acc: { fontSize: 16 } }),
    });
    expect(f.category).toBe(CAT.interface_interference);
    expect(f.candidateId).toBe('dec');
    expect(f.reason).toBe('"Decline" is 3.4x smaller than "Accept all", in 11px grey text');
    expect(f.source).toBe('rule');
  });

  it('fires on a font ratio above 1.5', () => {
    const f = only(pair({ font_ratio: 11 / 18 }), { facts: facts({ dec: { fontSize: 11 }, acc: { fontSize: 18 } }) });
    expect(f.reason).toContain('1.6x smaller text');
    expect(f.evidence).toContain('Decline text 11px vs 18px');
  });

  it('fires on faint decline next to a high-contrast accept', () => {
    const f = only(pair({ contrast: 2.4 }, { contrast: 7.6 }));
    expect(f.evidence).toContain('Decline contrast 2.4:1 vs 7.6:1');
  });

  it('fires on decline_as_link', () => {
    expect(only(pair({ decline_as_link: 1 })).reason).toContain('is a plain link next to the "Accept all" button');
  });

  it('stays quiet for a balanced pair and at the exact thresholds', () => {
    expect(run(pair({}))).toEqual([]);
    expect(run(pair({ area_ratio: 1 / 2.5, font_ratio: 1 / 1.5, contrast: 3 }, { contrast: 4.5 }))).toEqual([]);
    expect(run(pair({ contrast: 2.4 }, { contrast: 4.4 }))).toEqual([]);
  });

  it('only judges the decline side', () => {
    const [a, d] = pair({ area_ratio: 0.1 }, { area_ratio: 10 });
    expect(run([a!, d!]).map((f) => f.candidateId)).toEqual(['dec']);
  });
});

describe('basket_sneaking', () => {
  it('fires on a pre-ticked add-on with a rupee amount, as hard evidence', () => {
    const f = only([cand('checkbox', 'Add 1-year protection plan Rs 499', { f: { default_checked: 1 } })]);
    expect(f.category).toBe(CAT.basket_sneaking);
    expect(f.reason).toBe('Checked by default, adds Rs 499 to your order');
    expect(f.hard).toBe(true);
  });

  it('fires on a keyword without an amount', () => {
    const f = only([cand('checkbox', 'Donate to the children’s fund', { f: { default_checked: 1 } })]);
    expect(f.reason).toContain('is added unless you untick it');
  });

  it('ignores unticked boxes, unrelated labels, radios and subscriptions', () => {
    expect(run([cand('checkbox', 'Add gift wrap Rs 30')])).toEqual([]);
    expect(run([cand('checkbox', 'Save this address', { f: { default_checked: 1 } })])).toEqual([]);
    const radio = cand('checkbox', 'Standard delivery, ₹40', { id: 'r', f: { default_checked: 1 } });
    expect(run([radio], { facts: facts({ r: { radio: true } }) })).toEqual([]);
    const sub = run([cand('checkbox', 'Join Plus Rs 199/month, renews automatically', { f: { default_checked: 1 } })]);
    expect(sub.map((f) => f.category)).toEqual([CAT.subscription_trap]);
  });

  it('fires on the cart badge when the count rose without an add-to-cart click', () => {
    const cart = cand('control', 'Cart 3', { id: 'cart' });
    const f = only([cart], { page: page({ cartCount: { count: 3, candidateId: 'cart' } }), cartRise: { from: 2, to: 3 } });
    expect(f.reason).toBe('Cart count went from 2 to 3 without you adding anything');
    expect(run([cart], { page: page({ cartCount: { count: 3, candidateId: 'cart' } }) })).toEqual([]);
  });

  it('fires on text admitting the shop added something', () => {
    expect(only([cand('price', 'Added for you · ₹0 today, then Rs 199/month')]).category).toBe(CAT.basket_sneaking);
  });
});

describe('false_urgency', () => {
  const NOW = Date.UTC(2026, 10, 7, 12);

  it('fires on a countdown and on a stock message', () => {
    const out = run([cand('timer', '14:57', { f: { countdown: 1 } }), cand('stock', 'Only 2 left in stock')], { now: NOW });
    expect(out.map((f) => f.category)).toEqual([CAT.false_urgency, CAT.false_urgency]);
    expect(out[0]!.reason).toBe('Countdown timer (14:57 left) pushes you to decide fast');
    expect(out[0]!.confirmed).toBeUndefined();
  });

  it('ignores a time that does not count down', () => {
    expect(run([cand('timer', '10:30')])).toEqual([]);
  });

  it('confirms a timer whose deadline moved later since an earlier load', () => {
    const t = cand('timer', '15:00', { f: { countdown: 1 } });
    const key = 'https://shop.example/p/1|timer#0';
    const history = emptyHistory();
    // The earlier load ended 60 s sooner than this one would.
    history.timers[key] = { endAt: NOW + 900_000 - 60_000, loadId: 'old', seenAt: NOW - 60_000, prevEndAt: null, prevLoadId: null };
    const f = only([t], { history, loadId: 'new', now: NOW });
    expect(f.confirmed).toBe(true);
    expect(f.hard).toBe(true);
    expect(f.reason).toBe('Timer restarted on reload: the deadline moved 60 s later');
  });

  it('does not confirm a fixed deadline or compare a load with itself', () => {
    const t = cand('timer', '15:00', { f: { countdown: 1 } });
    const key = 'https://shop.example/p/1|timer#0';
    const history = emptyHistory();
    history.timers[key] = { endAt: NOW + 900_000 + 2000, loadId: 'old', seenAt: NOW, prevEndAt: null, prevLoadId: null };
    expect(only([t], { history, loadId: 'new', now: NOW }).confirmed).toBeUndefined();
    history.timers[key] = { endAt: NOW + 840_000, loadId: 'same', seenAt: NOW, prevEndAt: null, prevLoadId: null };
    expect(only([t], { history, loadId: 'same', now: NOW }).confirmed).toBeUndefined();
  });

  it('confirms a stock number unchanged since an earlier day', () => {
    const s = cand('stock', 'Only 2 left in stock');
    const history = emptyHistory();
    history.stock['https://shop.example/p/1|stock|only # left in stock'] = { count: 2, firstSeenAt: NOW - 2 * 86_400_000, seenAt: NOW };
    const f = only([s], { history, now: NOW });
    expect(f.confirmed).toBe(true);
    expect(f.reason).toMatch(/^"Only 2 left in stock" has not changed since /);
  });
});

describe('drip_pricing', () => {
  const site = (over: Partial<SiteMemory> = {}): SiteMemory => ({ ...emptySiteMemory(), lastProductPrice: 1299, ...over });

  it('fires on a fee not shown on the product page when the total is more than 2% above', () => {
    const fee = cand('fee', 'Platform fee', { id: 'fee', f: { price_delta: 0.89 } });
    const f = only([fee], { site: site(), facts: facts({ fee: { lineAmount: 9 } }) });
    expect(f.category).toBe(CAT.drip_pricing);
    expect(f.hard).toBe(true);
    expect(f.reason).toBe('Platform fee Rs 9 was not shown on the product page; total is 89% above the Rs 1,299 product price');
  });

  it('lists every fee that was not on the product page in each finding’s evidence', () => {
    const fees = [
      cand('fee', 'Platform fee', { id: 'pf', f: { price_delta: 0.1 } }),
      cand('fee', 'Delivery fee', { id: 'df', f: { price_delta: 0.1 } }),
      cand('fee', 'Handling fee', { id: 'hf', f: { price_delta: 0.1 } }),
    ];
    const out = run(fees, {
      site: site({ productFeeTypes: ['delivery fee'] }),
      page: page({ pageType: 'checkout' }),
      facts: facts({ pf: { lineAmount: 49 }, df: { lineAmount: 40 }, hf: { lineAmount: 15 } }),
    });
    expect(out.map((f) => f.candidateId)).toEqual(['pf', 'hf']);
    expect(out[0]!.evidence.slice(0, 2)).toEqual(['Platform fee Rs 49 appeared at checkout', 'Handling fee Rs 15 appeared at checkout']);
    expect(out[1]!.evidence.slice(0, 2)).toEqual(['Handling fee Rs 15 appeared at checkout', 'Platform fee Rs 49 appeared at checkout']);
    const cart = run([fees[0]!], { site: site(), page: page({ pageType: 'cart' }), facts: facts({ pf: { lineAmount: 49 } }) });
    expect(cart[0]!.evidence[0]).toBe('Platform fee Rs 49 appeared in the cart');
  });

  it('stays quiet when the fee was on the product page or the delta is small', () => {
    expect(run([cand('fee', 'Delivery fee', { f: { price_delta: 0.03 } })], { site: site({ productFeeTypes: ['delivery fee'] }) })).toEqual([]);
    expect(run([cand('fee', 'Platform fee', { f: { price_delta: 0.02 } })], { site: site() })).toEqual([]);
  });
});

describe('forced_action', () => {
  const wall = (text: string, f: Partial<Record<FeatureKey, number>> = {}) =>
    cand('dialog', text, { f: { overlay_coverage: 1, unclosable_modal: 1, ...f } });

  it('fires on a full-screen unclosable dialog demanding a phone number or an account', () => {
    const f = only([wall('Enter your mobile number to see the price')]);
    expect(f.category).toBe(CAT.forced_action);
    expect(f.hard).toBe(true);
    expect(f.reason).toBe('Full-screen pop-up with no close button demands your phone number');
    expect(only([wall('Create an account to continue. Email and mobile number')]).reason).toContain('demands an account');
  });

  it('needs coverage above 0.6, no close control and demand wording', () => {
    expect(run([wall('Sign up to continue', { overlay_coverage: 0.6 })])).toEqual([]);
    expect(run([wall('Sign up to continue', { unclosable_modal: 0 })])).toEqual([]);
    expect(run([wall('Our Diwali sale is live!')])).toEqual([]);
  });
});

describe('nagging', () => {
  it('fires on the current overlays once 3 distinct ones were seen this session', () => {
    const site = { ...emptySiteMemory(), dialogKeys: ['newsletter', 'app download'] };
    const banner = cand('banner', 'Allow notifications about price drops', { rect: { w: 1280, h: 40 } });
    const f = only([banner], { site });
    expect(f.category).toBe(CAT.nagging);
    expect(f.reason).toBe('One of 3 pop-ups and banners on this site this session');
  });

  it('stays quiet under 3, for cookie banners, and for a sticky header with a nav', () => {
    const site = { ...emptySiteMemory(), dialogKeys: ['newsletter'] };
    expect(run([cand('dialog', 'Get ₹100 off')], { site })).toEqual([]);
    const busy = { ...emptySiteMemory(), dialogKeys: ['a', 'b', 'c'] };
    expect(run([cand('banner', 'We use cookies to personalise offers', { rect: { w: 1280, h: 40 } })], { site: busy })).toEqual([]);
    const header = cand('banner', 'Demo Mart Sign in Orders Cart', { rect: { w: 1280, h: 60 } });
    const links = Array.from({ length: 7 }, (_, i) => cand('control', `Link ${i}`, { rect: { x: i * 100, y: 10, w: 80, h: 20 } }));
    expect(run([header, ...links], { site: busy })).toEqual([]);
  });
});

describe('subscription_trap', () => {
  it('fires on a pre-checked option with subscription wording in its label', () => {
    const f = only([cand('checkbox', 'Join Plus Rs 199/month, renews automatically', { f: { default_checked: 1 } })]);
    expect(f.category).toBe(CAT.subscription_trap);
    expect(f.hard).toBe(true);
    expect(f.reason).toBe('Subscription on by default and renews automatically at Rs 199');
  });

  it('fires on a pre-checked switch whose terms sit next to it, and reports the terms once', () => {
    const sw = cand('checkbox', 'Free 1-day delivery with Demo Mart Plus', { f: { default_checked: 1 }, rect: { x: 0, w: 40 } });
    const terms = cand('subscription', 'Rs 199/month after trial. Renews automatically.', { f: { faded: 1 }, rect: { x: 60, w: 400 } });
    const buy = cand('control', 'Buy now', { rect: { y: 40 } });
    const f = only([sw, terms, buy]);
    expect(f.candidateId).toBe(sw.id);
    expect(f.evidence.some((e) => e.startsWith('Terms: "Rs 199/month'))).toBe(true);
  });

  it('does not tie terms to a pre-selected radio', () => {
    const radio = cand('checkbox', 'Midnight Black', { id: 'radio', f: { default_checked: 1 } });
    const terms = cand('subscription', 'Rs 199/month, renews monthly', { rect: { y: 30 } });
    expect(run([radio, terms], { facts: facts({ radio: { radio: true } }) })).toEqual([]);
  });

  it('fires on faded renewal terms near a buy button', () => {
    const terms = cand('subscription', 'Renews automatically at Rs 499/year', { id: 't', f: { faded: 1 } });
    const buy = cand('control', 'Subscribe', { rect: { y: 100 } });
    const f = only([terms, buy], { facts: facts({ t: { fontSize: 10 } }) });
    expect(f.reason).toBe('Renewal terms in faded 10px text next to "Subscribe"');
    expect(f.hard).toBeUndefined();
  });

  it('ignores readable terms and terms far from any buy button', () => {
    expect(run([cand('subscription', 'Renews monthly', { f: { faded: 0.5 } }), cand('control', 'Buy now')])).toEqual([]);
    expect(run([cand('subscription', 'Renews monthly', { f: { faded: 1 } }), cand('control', 'Buy now', { rect: { y: 600 } })])).toEqual([]);
  });
});

describe('disguised_ads', () => {
  it('fires on a tiny or faint ad label among products or reviews', () => {
    const ad = cand('ad_label', 'Sponsored', { id: 'ad', f: { contrast: 1.7 } });
    const f = only([ad], { facts: facts({ ad: { fontSize: 9, inRepeatedList: true } }) });
    expect(f.category).toBe(CAT.disguised_ads);
    expect(f.reason).toBe('Ad marked only by a 9px faint "Sponsored" label, so it looks like regular content');
  });

  it('ignores a clear label, or a label outside a grid or review list', () => {
    const ad = cand('ad_label', 'Sponsored', { id: 'ad', f: { contrast: 9 } });
    expect(run([ad], { facts: facts({ ad: { fontSize: 13, inRepeatedList: true } }) })).toEqual([]);
    expect(run([ad], { facts: facts({ ad: { fontSize: 9, inRepeatedList: false } }) })).toEqual([]);
  });
});

describe('bait_and_switch', () => {
  const offers = {
    ...emptySiteMemory(),
    listingOffers: [
      { title: 'Aarav Wireless Earbuds Pro, 40h playback, ENC mic', href: 'https://shop.example/p/1', price: 999, offers: [], seenAt: 0 },
      { title: 'Kaveri Stainless Steel Water Bottle 1L, leak-proof', href: null, price: 199, offers: [], seenAt: 0 },
    ],
  };

  it('fires on a product page priced above its listing card', () => {
    const price = cand('price', '₹1,299', { id: 'p' });
    const product = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/1', price: 1299, candidateId: 'p', offers: [] };
    const f = only([price], { site: offers, page: page({ pageType: 'product', product, items: [product] }) });
    expect(f.category).toBe(CAT.bait_and_switch);
    expect(f.reason).toBe('Listing showed Rs 999, this page shows Rs 1,299');
  });

  it('matches cart rows by title when the listing had no link', () => {
    const price = cand('price', '₹349', { id: 'p' });
    const item = { title: 'Kaveri Stainless Steel Water Bottle 1L', href: null, price: 349, candidateId: 'p', offers: [] };
    const f = only([price], { site: offers, page: page({ pageType: 'cart', items: [item] }) });
    expect(f.reason).toBe('Listing showed Rs 199, now charged Rs 349');
  });

  it('on the cart, prefers the product page price the shopper already saw', () => {
    const price = cand('price', '₹1,299', { id: 'p' });
    const item = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/1', price: 1299, candidateId: 'p', offers: [] };
    const site = { ...offers, productPrices: { 'https://shop.example/p/1': { title: 'Aarav Wireless Earbuds Pro', price: 1299, url: 'https://shop.example/p/1', offers: [], seenAt: 0 } } };
    expect(run([price], { site, page: page({ pageType: 'cart', items: [item] }) })).toEqual([]);
  });

  it('ignores a different link, a lower price and listing pages', () => {
    const price = cand('price', '₹1,299', { id: 'p' });
    const other = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/clean/p/1', price: 1299, candidateId: 'p', offers: [] };
    expect(run([price], { site: offers, page: page({ pageType: 'product', product: other }) })).toEqual([]);
    const cheaper = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/1', price: 899, candidateId: 'p', offers: [] };
    expect(run([price], { site: offers, page: page({ pageType: 'product', product: cheaper }) })).toEqual([]);
    expect(run([price], { site: offers, page: page({ pageType: 'listing', items: [cheaper] }) })).toEqual([]);
  });

  it('names a listing offer that is missing on the product page in the evidence', () => {
    const price = cand('price', '₹1,299', { id: 'p' });
    const site = { ...offers, listingOffers: [{ ...offers.listingOffers[0]!, offers: ['50% off'] }] };
    const product = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/1', price: 1299, candidateId: 'p', offers: [] };
    const f = only([price], { site, page: page({ pageType: 'product', product }) });
    expect(f.confidence).toBe(RULES_CONFIG.baitAndSwitch.confidence);
    expect(f.evidence).toContain('Listing offered "50% off"; not on this page');
  });

  it('fires at lower confidence when the price matches but the listing offer is gone', () => {
    const price = cand('price', '₹999', { id: 'p' });
    const site = { ...offers, listingOffers: [{ ...offers.listingOffers[0]!, offers: ['50% off', 'buy 1 get 1'] }] };
    const product = { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/1', price: 999, candidateId: 'p', offers: ['50% off'] };
    const f = only([price], { site, page: page({ pageType: 'product', product }) });
    expect(f).toMatchObject({ category: CAT.bait_and_switch, confidence: RULES_CONFIG.baitAndSwitch.offerOnlyConfidence });
    expect(f.hard).toBeFalsy();
    expect(f.reason).toBe('Listing offered "buy 1 get 1", but this page does not');
    const kept = { ...product, offers: ['50% off', 'buy 1 get 1'] };
    expect(run([price], { site, page: page({ pageType: 'product', product: kept }) })).toEqual([]);
  });

  it('matches titles by shared tokens', () => {
    expect(titlesMatch('Kaveri Stainless Steel Water Bottle 1L', 'Kaveri Stainless Steel Water Bottle 1L, leak-proof')).toBe(true);
    expect(titlesMatch('Kaveri Water Bottle', 'Rasoi Pressure Cooker 5L')).toBe(false);
    expect(titlesMatch('Pro Max', 'Pro Max')).toBe(false); // under 3 shared tokens
  });
});

describe('confirm_shaming and trick_wording phrase fallbacks', () => {
  it('flags shaming decline wording but not a plain "No thanks"', () => {
    expect(only([cand('control', "No thanks, I don't like saving money")]).category).toBe(CAT.confirm_shaming);
    expect(only([cand('control', "I'll pay full price")]).reason).toBe('Guilt-trip wording on the decline option: "I\'ll pay full price"');
    expect(run([cand('control', 'No thanks')])).toEqual([]);
  });

  it('flags double negatives in a checkbox label', () => {
    const f = only([cand('checkbox', "Uncheck this box if you don't want to not receive offers")]);
    expect(f.category).toBe(CAT.trick_wording);
    expect(f.reason).toBe('Double negative ("uncheck … n\'t … not") makes it unclear what ticking does');
    expect(run([cand('checkbox', 'Do not save my card')])).toEqual([]);
  });
});

describe('combining rules on one element', () => {
  it('keeps one finding per element: the more specific shaming phrase beats layout, noted in evidence', () => {
    const a = cand('control', 'Subscribe and get ₹100 off', { id: 'acc', counterpartId: 'dec' });
    const d = cand('control', "No thanks, I don't like saving money", { id: 'dec', counterpartId: 'acc', f: { area_ratio: 0.31, decline_as_link: 1 } });
    const f = only([a, d]);
    expect(f.category).toBe(CAT.confirm_shaming);
    expect(f.evidence).toContain('Also looks like: Interface interference');
  });

  it('lets hard evidence win over a higher-confidence soft rule', () => {
    // Pre-ticked (hard basket sneaking) and a double negative (soft trick wording) on one box,
    // with the soft rule made more confident than the hard one.
    const saved = RULES_CONFIG.trickWording.confidence;
    RULES_CONFIG.trickWording.confidence = 0.99;
    try {
      const box = cand('checkbox', "Don't untick to skip the Rs 49 tip", { f: { default_checked: 1 } });
      const f = only([box]);
      expect(f.category).toBe(CAT.basket_sneaking);
      expect(f.evidence).toContain('Also looks like: Trick question');
    } finally {
      RULES_CONFIG.trickWording.confidence = saved;
    }
  });

  it('returns findings in candidate order', () => {
    const out = run([cand('stock', 'Only 1 left'), cand('control', "I'll pay full price")]);
    expect(out.map((f) => f.category)).toEqual([CAT.false_urgency, CAT.confirm_shaming]);
  });
});

describe('config and helpers', () => {
  it('keeps the spec thresholds in RULES_CONFIG', () => {
    expect(RULES_CONFIG.interfaceInterference).toMatchObject({ areaRatio: 2.5, fontRatio: 1.5, declineMaxContrast: 3, acceptMinContrast: 4.5 });
    expect(RULES_CONFIG.dripPricing.minPriceDelta).toBe(0.02);
    expect(RULES_CONFIG.forcedAction.minCoverage).toBe(0.6);
    expect(RULES_CONFIG.nagging.minDistinct).toBe(3);
    expect(RULES_CONFIG.disguisedAds).toMatchObject({ maxFontPx: 10, maxContrast: 3 });
  });

  it('measures the edge-to-edge gap between boxes', () => {
    expect(rectGap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(0);
    expect(rectGap({ x: 0, y: 0, w: 10, h: 10 }, { x: 13, y: 14, w: 10, h: 10 })).toBe(5);
  });
});
