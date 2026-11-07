/**
 * The deterministic rule engine, following "Rules" in CLAUDE.md. It always
 * runs, gives every finding a short plain-English reason that quotes the
 * evidence, and is the whole detector when no model file exists.
 *
 * Every threshold, confidence and phrase list lives in RULES_CONFIG. Tune
 * them only on the test shop and practice sites, never on the held-out
 * evaluation sites.
 *
 * One finding per candidate: when several rules fire on the same element,
 * hard evidence wins, then the higher confidence; the others are listed in
 * the winner's evidence ("Also looks like: …").
 */
import { categoryById } from './categories';
import { isAcceptText, isDeclineText } from './extractor';
import type { CandidateFacts, PageFacts, PricedItem } from './facts';
import type { HistoryMemory, SiteMemory } from './memory';
import { FEE_RE, SUBSCRIPTION_RE, allRupees, collapse, parseTimer, textHash, truncate } from './text';
import type { Candidate, Finding, Rect } from './types';

/** Category ids (fixed order, see categories.ts). */
export const CAT = {
  benign: 0,
  false_urgency: 1,
  basket_sneaking: 2,
  confirm_shaming: 3,
  forced_action: 4,
  subscription_trap: 5,
  interface_interference: 6,
  bait_and_switch: 7,
  drip_pricing: 8,
  disguised_ads: 9,
  nagging: 10,
  trick_wording: 11,
} as const;

export const RULES_CONFIG = {
  interfaceInterference: {
    /** Fires when accept area / decline area is above this… */
    areaRatio: 2.5,
    /** …or accept font / decline font is above this… */
    fontRatio: 1.5,
    /** …or the decline contrast is below this while the accept contrast is at least acceptMinContrast… */
    declineMaxContrast: 3,
    acceptMinContrast: 4.5,
    /** …or decline_as_link = 1. */
    confidence: 0.8,
  },
  basketSneaking: {
    keywords: /\b(?:protection|protect|insurance|insure|warranty|donat\w*|tip|add|priority|gift ?wrap\w*)\b/i,
    /** Text that admits the shop put something in the cart. */
    addedForYou:
      /\b(?:added for you|added automatically|auto-?added|we(?:'ve| have) added|added to your (?:cart|order|bag) for you)\b/i,
    confidence: 0.9,
    addedConfidence: 0.7,
    cartRiseConfidence: 0.8,
    /** On one page, a cart badge rise within this long after an add-to-cart click is the user's own. */
    addClickWindowMs: 2000,
    /** Radios are left out: one option of a group is always selected. */
    includeRadios: false,
  },
  falseUrgency: {
    countdownConfidence: 0.7,
    stockConfidence: 0.6,
    confirmedConfidence: 0.95,
    /** A timer counts as reset when its end time moved more than this many seconds later since an earlier load. */
    timerResetSec: 5,
  },
  dripPricing: {
    /** price_delta must be above this (2%). */
    minPriceDelta: 0.02,
    confidence: 0.85,
  },
  forcedAction: {
    /** overlay_coverage must be above this. */
    minCoverage: 0.6,
    /** What the wall demands; the first match names it in the reason. */
    demands: [
      [/\b(?:sign ?up|register|create (?:an |your )?account)\b/i, 'an account'],
      [/\b(?:log ?in|sign ?in)\b/i, 'that you log in'],
      [/\b(?:mobile|phone) (?:number|no)\b|\botp\b/i, 'your phone number'],
      [/\be-?mail\b/i, 'your email'],
      [/\b(?:download|install) (?:the |our )?(?:\w+ )?app\b|\bapp download\b/i, 'an app download'],
    ] as [RegExp, string][],
    confidence: 0.9,
  },
  nagging: {
    /** Distinct dialogs or overlays on one site in one session. */
    minDistinct: 3,
    /** A fixed or sticky banner counts as an overlay when it asks for something… */
    prompt: /notif|subscribe|newsletter|sign ?(?:up|in)|log ?in|download|\bapp\b|offer|discount|% off|coupon|allow|join/i,
    /** …and has at most this many controls (a sticky header with a nav is not an overlay). */
    maxBannerControls: 6,
    /** Cookie consent banners are often legally required, so they never count. */
    exclude: /\bcookies?\b/i,
    confidence: 0.7,
  },
  subscriptionTrap: {
    words: SUBSCRIPTION_RE,
    renewal: /\brenew\w*|\bauto-?renew\w*|\bper month\b|\/\s?month\b|\bmonthly\b/i,
    /** Subscription wording within this gap (px, edge to edge) of a checked option belongs to it. */
    nearOptionPx: 150,
    /** Faded renewal terms within this gap (px, edge to edge) of a subscribe or buy control. */
    nearBuyPx: 250,
    buy: /\b(?:buy|subscribe|place (?:your )?order|pay|checkout|add to (?:cart|bag|basket)|join|start (?:free )?trial)\b/i,
    /** faded must be at least this (the spec says faded = 1). */
    faded: 1,
    confidence: 0.85,
    finePrintConfidence: 0.7,
  },
  disguisedAds: {
    /** Ad label font below this many px… */
    maxFontPx: 10,
    /** …or contrast below this, inside a product grid or among reviews. */
    maxContrast: 3,
    confidence: 0.8,
  },
  baitAndSwitch: {
    /** The price must be higher than the remembered one by more than this share. */
    minRelativeDiff: 0.01,
    /** Title match without a shared link: shared tokens / tokens of the shorter title… */
    titleOverlap: 0.8,
    /** …and at least this many shared tokens. */
    minCommonTokens: 3,
    confidence: 0.8,
    /** Same price, but an offer from the listing card ("50% off") is missing or ended on the product page. */
    offerOnlyConfidence: 0.65,
  },
  confirmShaming: {
    maxLength: 80,
    phrases: [
      /\bi (?:don'?t|do not) (?:like|want|care about|need) (?:saving|savings|discounts?|deals?|offers?|money|free)/i,
      /\bi(?:'ll| will)? (?:pay|prefer paying|like paying) (?:the )?full price\b/i,
      /\bi(?:'d| would) rather (?:pay more|miss out)/i,
      /\bi(?:'m| am) (?:not interested in|fine with(?:out)?) (?:saving|savings|discounts?|deals?|being)/i,
      /\bi (?:prefer|like) (?:to )?(?:miss(?:ing)? out|pay(?:ing)? more|being (?:unprotected|uninformed))/i,
      /\bi(?:'ll| will) (?:stay|remain) (?:unprotected|uninformed)|\btake my chances\b/i,
    ],
    confidence: 0.85,
  },
  trickWording: {
    negations: /\bnot\b|n['’]t\b|\bnever\b|\bno\b|\bskip\b|\bopt(?:[- ])?out\b|\buncheck\b|\buntick\b|\bunsubscribe\b/gi,
    /** Double negatives: at least this many negations in one checkbox label. */
    minNegations: 2,
    maxLength: 250,
    confidence: 0.75,
  },
};

export interface RuleState {
  page: PageFacts;
  facts: Record<string, CandidateFacts>;
  /** Session memory for this site (listing offers, product prices, dialogs seen). */
  site?: SiteMemory;
  /** Local memory (timer end times, stock counts) from earlier loads. */
  history?: HistoryMemory;
  /** Cart badge went up with no add-to-cart click (from the content script). */
  cartRise?: { from: number; to: number } | null;
  /** Identifies this page load, so a rescan never compares a timer with itself. */
  loadId?: string;
  now?: number;
}

const DEFAULT_FACTS: CandidateFacts = {
  fontSize: 16,
  grey: false,
  struck: false,
  inRepeatedList: false,
  lineAmount: null,
  radio: false,
};

/** Gap between two boxes (0 when they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

// ---------- formatting ----------

export function formatRupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString('en-IN')}`;
}

function q(text: string, max = 30): string {
  return `"${truncate(collapse(text), max)}"`;
}

function times(x: number): string {
  return x >= 10 ? `${Math.round(x)}x` : `${(Math.round(x * 10) / 10).toFixed(1)}x`;
}

function px(n: number): string {
  return `${Math.round(n * 10) / 10}px`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function day(ts: number): string {
  return new Date(ts).toDateString();
}

// ---------- observations shared with memory.ts ----------

/** Countdown timers (f07 = 1) with a key per URL and their computed end time. */
export function timerObservations(
  candidates: Candidate[],
  urlKey: string,
  now: number,
): { candidateId: string; key: string; endAt: number }[] {
  const out: { candidateId: string; key: string; endAt: number }[] = [];
  for (const c of candidates) {
    if (c.features[6] !== 1) continue;
    const secs = parseTimer(c.text);
    if (secs === null) continue;
    out.push({ candidateId: c.id, key: `${urlKey}|timer#${out.length}`, endAt: now + secs * 1000 });
  }
  return out;
}

/** Stock messages with a number, keyed by URL and the message with its digits masked. */
export function stockObservations(
  candidates: Candidate[],
  urlKey: string,
): { candidateId: string; key: string; count: number }[] {
  const out: { candidateId: string; key: string; count: number }[] = [];
  for (const c of candidates) {
    if (c.kind !== 'stock') continue;
    const m = /\d+/.exec(c.text);
    if (!m) continue;
    const masked = c.text.toLowerCase().replace(/\d+/g, '#').slice(0, 60);
    out.push({ candidateId: c.id, key: `${urlKey}|stock|${masked}`, count: Number(m[0]) });
  }
  return out;
}

/** "platform fee" from "Platform fee ₹9". Null if no fee wording. */
export function feeType(text: string): string | null {
  const m = FEE_RE.exec(text);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

function inside(inner: Candidate, outer: Candidate): boolean {
  const a = inner.rect;
  const b = outer.rect;
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
}

/** Dialogs and prompt-like fixed or sticky banners that count towards nagging. */
export function nagOverlays(candidates: Candidate[]): Candidate[] {
  const cfg = RULES_CONFIG.nagging;
  return candidates.filter((c) => {
    if (c.kind !== 'dialog' && c.kind !== 'banner') return false;
    if (cfg.exclude.test(c.text)) return false;
    if (c.kind === 'dialog') return true;
    const controls = candidates.filter((o) => o !== c && o.kind === 'control' && inside(o, c));
    if (controls.length > cfg.maxBannerControls) return false;
    return cfg.prompt.test(c.text) || controls.some((o) => o.counterpartId !== null);
  });
}

/** A stable key for "the same pop-up" across pages: a hash of its text, lower-cased, digits masked. The text itself is not stored. */
export function overlayKey(c: Candidate): string {
  return textHash(collapse(c.text.toLowerCase().replace(/\d+/g, '#')).slice(0, 200));
}

// ---------- the rules ----------

type Raw = Finding;

interface Ctx {
  state: RuleState;
  byId: Map<string, Candidate>;
  facts: (c: Candidate) => CandidateFacts;
  now: number;
  loadId: string;
}

function finding(
  c: Candidate,
  category: number,
  confidence: number,
  reason: string,
  evidence: string[],
  extra: { hard?: boolean; confirmed?: boolean } = {},
): Raw {
  const f: Raw = { candidateId: c.id, category, confidence, source: 'rule', reason, evidence };
  if (extra.hard) f.hard = true;
  if (extra.confirmed) f.confirmed = true;
  return f;
}

function interfaceInterference(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.interfaceInterference;
  const out: Raw[] = [];
  for (const c of cands) {
    const accept = c.counterpartId ? ctx.byId.get(c.counterpartId) : undefined;
    if (!accept || !isDeclineText(c.text) || !isAcceptText(accept.text)) continue;
    const [f01 = 1, f02 = 1, f03 = 21] = c.features;
    const f10 = c.features[9] ?? 0;
    const areaX = f02 > 0 ? 1 / f02 : Infinity;
    const fontX = f01 > 0 ? 1 / f01 : 1;
    const acceptContrast = accept.features[2] ?? 21;
    const bigger = areaX > cfg.areaRatio;
    const larger = fontX > cfg.fontRatio;
    const fainter = f03 < cfg.declineMaxContrast && acceptContrast >= cfg.acceptMinContrast;
    const link = f10 === 1;
    if (!bigger && !larger && !fainter && !link) continue;

    const d = ctx.facts(c);
    const a = ctx.facts(accept);
    const evidence: string[] = [];
    if (bigger) evidence.push(`${q(accept.text)} is ${times(areaX)} the area of ${q(c.text)}`);
    if (larger) evidence.push(`Decline text ${px(d.fontSize)} vs ${px(a.fontSize)}`);
    if (fainter) evidence.push(`Decline contrast ${f03.toFixed(1)}:1 vs ${acceptContrast.toFixed(1)}:1`);
    if (link) evidence.push('Decline is styled as a plain link, accept is a filled button');

    let reason: string;
    if (bigger) reason = `${q(c.text)} is ${times(areaX)} smaller than ${q(accept.text)}`;
    else if (larger) reason = `${q(c.text)} has ${times(fontX)} smaller text than ${q(accept.text)}`;
    else if (link) reason = `${q(c.text)} is a plain link next to the ${q(accept.text)} button`;
    else reason = `${q(c.text)} is much fainter than ${q(accept.text)}`;
    const small = d.fontSize <= 12 || larger;
    if (small || fainter || d.grey) {
      const look = [small ? px(d.fontSize) : '', d.grey ? 'grey' : fainter ? 'faint' : ''].filter(Boolean).join(' ');
      reason += `, in ${look} text`;
    }
    if (link && (bigger || larger)) reason += ', styled as a plain link';
    out.push(finding(c, CAT.interface_interference, cfg.confidence, reason, evidence));
  }
  return out;
}

function basketSneaking(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.basketSneaking;
  const out: Raw[] = [];
  for (const c of cands) {
    const radio = ctx.facts(c).radio && !cfg.includeRadios;
    if (c.kind === 'checkbox' && c.features[4] === 1 && !radio && !RULES_CONFIG.subscriptionTrap.words.test(c.text)) {
      const amount = allRupees(c.text)[0] ?? null;
      const keyword = cfg.keywords.exec(c.text);
      if (amount === null && !keyword) continue;
      const reason =
        amount !== null
          ? `Checked by default, adds ${formatRupees(amount)} to your order`
          : `Checked by default: ${q(c.text, 40)} is added unless you untick it`;
      const evidence = ['Ticked before you touched it', amount !== null ? `Amount: ${formatRupees(amount)}` : `Mentions "${keyword![0]}"`];
      out.push(finding(c, CAT.basket_sneaking, cfg.confidence, reason, evidence, { hard: true }));
    } else if (c.kind !== 'control' && c.kind !== 'checkbox' && cfg.addedForYou.test(c.text)) {
      out.push(
        finding(c, CAT.basket_sneaking, cfg.addedConfidence, 'Added to your cart by the shop, not by you', [
          `Says ${q(c.text, 60)}`,
        ]),
      );
    }
  }
  const rise = ctx.state.cartRise;
  const badge = ctx.state.page.cartCount;
  const cartCand = badge?.candidateId ? ctx.byId.get(badge.candidateId) : undefined;
  if (rise && cartCand) {
    out.push(
      finding(
        cartCand,
        CAT.basket_sneaking,
        cfg.cartRiseConfidence,
        `Cart count went from ${rise.from} to ${rise.to} without you adding anything`,
        ['No add-to-cart click since the last count'],
      ),
    );
  }
  return out;
}

function falseUrgency(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.falseUrgency;
  const out: Raw[] = [];
  const { urlKey } = ctx.state.page;
  const timers = new Map(timerObservations(cands, urlKey, ctx.now).map((t) => [t.candidateId, t]));
  const stock = new Map(stockObservations(cands, urlKey).map((s) => [s.candidateId, s]));
  for (const c of cands) {
    const timer = timers.get(c.id);
    if (timer) {
      const entry = ctx.state.history?.timers[timer.key];
      const ref = entry ? (entry.loadId === ctx.loadId ? entry.prevEndAt : entry.endAt) : null;
      const moved = ref !== null ? timer.endAt - ref : 0;
      if (moved > cfg.timerResetSec * 1000) {
        out.push(
          finding(
            c,
            CAT.false_urgency,
            cfg.confirmedConfidence,
            `Timer restarted on reload: the deadline moved ${duration(moved)} later`,
            [`Shows ${q(c.text)}`, 'Countdown reset confirmed across page loads'],
            { hard: true, confirmed: true },
          ),
        );
      } else {
        out.push(
          finding(c, CAT.false_urgency, cfg.countdownConfidence, `Countdown timer (${collapse(c.text)} left) pushes you to decide fast`, [
            'Counts down between two reads 2 s apart',
          ]),
        );
      }
      continue;
    }
    if (c.kind !== 'stock') continue;
    const obs = stock.get(c.id);
    const entry = obs ? ctx.state.history?.stock[obs.key] : undefined;
    if (obs && entry && entry.count === obs.count && day(entry.firstSeenAt) !== day(ctx.now)) {
      out.push(
        finding(
          c,
          CAT.false_urgency,
          cfg.confirmedConfidence,
          `${q(c.text, 40)} has not changed since ${new Date(entry.firstSeenAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
          ['Same stock number on visits on different days'],
          { confirmed: true },
        ),
      );
    } else {
      out.push(finding(c, CAT.false_urgency, cfg.stockConfidence, `Scarcity or demand claim with no proof: ${q(c.text, 50)}`, ['Stock or high-demand message']));
    }
  }
  return out;
}

function dripPricing(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.dripPricing;
  const seen = new Set(ctx.state.site?.productFeeTypes ?? []);
  const remembered = ctx.state.site?.lastProductPrice ?? null;
  const where = ctx.state.page.pageType === 'cart' ? 'in the cart' : 'at checkout';
  // Every fee line not shown on a product page this session, so each finding can list them all.
  const fresh: { c: Candidate; delta: number; label: string }[] = [];
  const names = new Set<string>();
  for (const c of cands) {
    if (c.kind !== 'fee') continue;
    const delta = c.features[11] ?? 0;
    const type = feeType(c.text);
    if (delta <= cfg.minPriceDelta || !type || seen.has(type) || names.has(type)) continue;
    names.add(type);
    const amount = ctx.facts(c).lineAmount;
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    fresh.push({ c, delta, label: `${name}${amount !== null ? ` ${formatRupees(amount)}` : ''}` });
  }
  return fresh.map(({ c, delta, label }) => {
    const pct = Math.round(delta * 100);
    let reason = `${label} was not shown on the product page`;
    reason += remembered ? `; total is ${pct}% above the ${formatRupees(remembered)} product price` : `; total is ${pct}% above the product price`;
    const lines = [label, ...fresh.map((f) => f.label).filter((l) => l !== label)].map((l) => `${l} appeared ${where}`);
    return finding(c, CAT.drip_pricing, cfg.confidence, reason, [...lines, `Total ${pct}% above the product price`], { hard: true });
  });
}

function forcedAction(cands: Candidate[]): Raw[] {
  const cfg = RULES_CONFIG.forcedAction;
  const out: Raw[] = [];
  for (const c of cands) {
    if (c.kind !== 'dialog' && c.kind !== 'banner') continue;
    if ((c.features[7] ?? 0) <= cfg.minCoverage || c.features[8] !== 1) continue;
    const demand = cfg.demands.find(([re]) => re.test(c.text));
    if (!demand) continue;
    const pct = Math.round((c.features[7] ?? 0) * 100);
    out.push(
      finding(c, CAT.forced_action, cfg.confidence, `Full-screen pop-up with no close button demands ${demand[1]}`, [
        `Covers ${pct}% of the screen`,
        'No visible close button',
      ], { hard: true }),
    );
  }
  return out;
}

function nagging(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.nagging;
  const overlays = nagOverlays(cands);
  const keys = new Set(ctx.state.site?.dialogKeys ?? []);
  for (const o of overlays) keys.add(overlayKey(o));
  if (overlays.length === 0 || keys.size < cfg.minDistinct) return [];
  return overlays.map((o) =>
    finding(o, CAT.nagging, cfg.confidence, `One of ${keys.size} pop-ups and banners on this site this session`, [
      `${keys.size} distinct pop-ups or banners this session`,
    ]),
  );
}

function subscriptionTrap(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.subscriptionTrap;
  const out: Raw[] = [];
  // Each block of subscription terms belongs to the nearest checked option within reach (radios
  // excluded: a pre-selected colour or delivery choice is not a subscription). Terms that belong to
  // an option are reported on the option, not again on their own.
  const options = cands.filter((c) => c.kind === 'checkbox' && c.features[4] === 1 && !ctx.facts(c).radio);
  const owner = new Map<string, Candidate>();
  for (const s of cands) {
    if (s.kind !== 'subscription') continue;
    let best: { c: Candidate; gap: number } | null = null;
    for (const o of options) {
      const gap = rectGap(s.rect, o.rect);
      if (gap <= cfg.nearOptionPx && (!best || gap < best.gap)) best = { c: o, gap };
    }
    if (best) owner.set(s.id, best.c);
  }
  for (const c of cands) {
    if (c.kind === 'checkbox' && c.features[4] === 1) {
      const near = cands.find((s) => owner.get(s.id) === c);
      const own = cfg.words.test(c.text);
      if (!own && !near) continue;
      const terms = `${c.text} ${near?.text ?? ''}`;
      const amount = allRupees(terms)[0];
      const renews = cfg.renewal.test(terms);
      const reason = renews
        ? `Subscription on by default and renews automatically${amount !== undefined ? ` at ${formatRupees(amount)}` : ''}`
        : `Subscription switched on by default: ${q(c.text, 40)}`;
      const evidence = ['On before you touched it', `Option: ${q(c.text, 60)}`];
      if (near) evidence.push(`Terms: ${q(near.text, 80)}`);
      out.push(finding(c, CAT.subscription_trap, cfg.confidence, reason, evidence, { hard: true }));
    } else if (c.kind === 'subscription' && (c.features[5] ?? 0) >= cfg.faded && !owner.has(c.id)) {
      const buy = cands.find(
        (o) => o.kind === 'control' && cfg.buy.test(o.text) && rectGap(o.rect, c.rect) <= cfg.nearBuyPx,
      );
      if (!buy) continue;
      const f = ctx.facts(c);
      out.push(
        finding(c, CAT.subscription_trap, cfg.finePrintConfidence, `Renewal terms in faded ${px(f.fontSize)} text next to ${q(buy.text)}`, [
          `Says ${q(c.text, 80)}`,
        ]),
      );
    }
  }
  return out;
}

function disguisedAds(cands: Candidate[], ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.disguisedAds;
  const out: Raw[] = [];
  for (const c of cands) {
    if (c.kind !== 'ad_label') continue;
    const f = ctx.facts(c);
    const contrast = c.features[2] ?? 21;
    if (!f.inRepeatedList || (f.fontSize >= cfg.maxFontPx && contrast >= cfg.maxContrast)) continue;
    out.push(
      finding(c, CAT.disguised_ads, cfg.confidence, `Ad marked only by a ${px(f.fontSize)} faint ${q(c.text)} label, so it looks like regular content`, [
        `Label ${px(f.fontSize)}, contrast ${contrast.toFixed(1)}:1`,
        'Sits among products or reviews',
      ]),
    );
  }
  return out;
}

function tokens(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2));
}

export function titlesMatch(a: string, b: string): boolean {
  const cfg = RULES_CONFIG.baitAndSwitch;
  const ta = tokens(a);
  const tb = tokens(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const smaller = Math.min(ta.size, tb.size);
  return smaller > 0 && common >= cfg.minCommonTokens && common / smaller >= cfg.titleOverlap;
}

function sameItem(a: { title: string; href: string | null }, b: { title: string; href: string | null }): boolean {
  return a.href && b.href ? a.href === b.href : titlesMatch(a.title, b.title);
}

function baitAndSwitch(ctx: Ctx): Raw[] {
  const cfg = RULES_CONFIG.baitAndSwitch;
  const { page } = ctx.state;
  const site = ctx.state.site;
  if (!site) return [];
  let items: PricedItem[];
  if (page.pageType === 'product') items = page.product ? [page.product] : [];
  else if (page.pageType === 'cart' || page.pageType === 'checkout') items = page.items;
  else return [];

  const out: Raw[] = [];
  for (const item of items) {
    const c = ctx.byId.get(item.candidateId);
    if (!c) continue;
    let ref: { price: number; offers: string[]; where: string } | null = null;
    if (page.pageType !== 'product') {
      const seen = Object.entries(site.productPrices).find(
        ([key, p]) => sameItem({ title: p.title, href: key }, item) || (!!item.href && item.href === p.url),
      );
      if (seen) ref = { price: seen[1].price, offers: seen[1].offers, where: 'Product page' };
    }
    if (!ref) {
      const offer = site.listingOffers.find((o) => sameItem(o, item));
      if (offer) ref = { price: offer.price, offers: offer.offers, where: 'Listing' };
    }
    if (!ref || ref.price <= 0) continue;
    const pricier = (item.price - ref.price) / ref.price > cfg.minRelativeDiff;
    // Offers only compare listing card → product page: carts rarely repeat the badge.
    const lost = page.pageType === 'product' ? ref.offers.filter((o) => !item.offers.includes(o)) : [];
    if (!pricier && !lost.length) continue;
    const evidence = [`Item: ${q(item.title, 60)}`, `${ref.where} price ${formatRupees(ref.price)}`];
    for (const o of lost) evidence.push(`${ref.where} offered "${o}"; not on this page`);
    if (pricier) {
      const here = page.pageType === 'product' ? 'this page shows' : 'now charged';
      out.push(finding(c, CAT.bait_and_switch, cfg.confidence, `${ref.where} showed ${formatRupees(ref.price)}, ${here} ${formatRupees(item.price)}`, evidence));
    } else {
      out.push(finding(c, CAT.bait_and_switch, cfg.offerOnlyConfidence, `${ref.where} offered "${lost[0]}", but this page does not`, evidence));
    }
  }
  return out;
}

function confirmShaming(cands: Candidate[]): Raw[] {
  const cfg = RULES_CONFIG.confirmShaming;
  const out: Raw[] = [];
  for (const c of cands) {
    if (c.kind !== 'control' || c.text.length > cfg.maxLength) continue;
    if (!cfg.phrases.some((re) => re.test(c.text))) continue;
    out.push(finding(c, CAT.confirm_shaming, cfg.confidence, `Guilt-trip wording on the decline option: ${q(c.text, 50)}`, ['Matches a shaming phrase']));
  }
  return out;
}

function trickWording(cands: Candidate[]): Raw[] {
  const cfg = RULES_CONFIG.trickWording;
  const out: Raw[] = [];
  for (const c of cands) {
    if (c.kind !== 'checkbox' || c.text.length > cfg.maxLength) continue;
    const negs = c.text.match(new RegExp(cfg.negations.source, 'gi')) ?? [];
    if (negs.length < cfg.minNegations) continue;
    const shown = negs.slice(0, 3).map((n) => n.toLowerCase()).join(' … ');
    out.push(
      finding(c, CAT.trick_wording, cfg.confidence, `Double negative ("${shown}") makes it unclear what ticking does`, [
        `${negs.length} negations in one sentence`,
      ]),
    );
  }
  return out;
}

/** One finding per candidate: hard first, then confidence. The others become evidence. */
function resolve(raw: Raw[], order: Map<string, number>): Finding[] {
  const groups = new Map<string, Raw[]>();
  for (const f of raw) {
    const g = groups.get(f.candidateId) ?? [];
    g.push(f);
    groups.set(f.candidateId, g);
  }
  const out: Finding[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Number(!!b.hard) - Number(!!a.hard) || b.confidence - a.confidence);
    const [best, ...rest] = group;
    const others = [...new Set(rest.filter((r) => r.category !== best!.category).map((r) => categoryById(r.category).name))];
    out.push(others.length ? { ...best!, evidence: [...best!.evidence, `Also looks like: ${others.join(', ')}`] } : best!);
  }
  return out.sort((a, b) => (order.get(a.candidateId) ?? 0) - (order.get(b.candidateId) ?? 0));
}

export function runRules(candidates: Candidate[], state: RuleState): Finding[] {
  const ctx: Ctx = {
    state,
    byId: new Map(candidates.map((c) => [c.id, c])),
    facts: (c) => state.facts[c.id] ?? DEFAULT_FACTS,
    now: state.now ?? Date.now(),
    loadId: state.loadId ?? '',
  };
  const raw = [
    ...interfaceInterference(candidates, ctx),
    ...basketSneaking(candidates, ctx),
    ...falseUrgency(candidates, ctx),
    ...dripPricing(candidates, ctx),
    ...forcedAction(candidates),
    ...nagging(candidates, ctx),
    ...subscriptionTrap(candidates, ctx),
    ...disguisedAds(candidates, ctx),
    ...baitAndSwitch(ctx),
    ...confirmShaming(candidates),
    ...trickWording(candidates),
  ];
  return resolve(raw, new Map(candidates.map((c, i) => [c.id, i])));
}
