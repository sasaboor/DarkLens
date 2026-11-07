// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, WHITE } from './color';
import { extractCandidates } from './extractor';
import {
  FEATURE_NAMES,
  compareCountdowns,
  computeFeatures,
  detectCountdowns,
  fadedScore,
  findOrderTotal,
  snapshotCheckedStates,
  snapshotCountdowns,
  type FeatureOptions,
} from './features';
import type { Candidate, Rect } from './types';
import { fakeLayout, fixture } from './testing';

const URL = 'https://shop.example/';

function scan(
  rects: Record<string, Partial<Rect>> = {},
  extra: Partial<FeatureOptions> & { url?: string } = {},
): Candidate[] {
  const layout = fakeLayout(rects);
  const ex = extractCandidates(document, { layout, url: extra.url ?? URL });
  return computeFeatures(ex, { layout, doc: document, ...extra });
}

function byText(cands: Candidate[], text: string): Candidate {
  const c = cands.find((x) => x.text === text);
  if (!c) throw new Error(`no candidate "${text}" in ${cands.map((x) => x.text).join(' | ')}`);
  return c;
}

/** Feature value by spec name, e.g. f(c, 'contrast'). */
function f(c: Candidate, name: (typeof FEATURE_NAMES)[number]): number {
  return c.features[FEATURE_NAMES.indexOf(name)]!;
}

it('has the 12 features in the spec order', () => {
  expect(FEATURE_NAMES).toEqual([
    'font_ratio',
    'area_ratio',
    'contrast',
    'salience',
    'default_checked',
    'faded',
    'countdown',
    'overlay_coverage',
    'unclosable_modal',
    'decline_as_link',
    'cta_distance',
    'price_delta',
  ]);
  fixture('<button>Buy</button>');
  const [c] = scan();
  expect(c!.features).toHaveLength(12);
  expect(c!.featureSource).toEqual({ f03: 'css', f04: 'css' });
});

describe('f01 font_ratio and f02 area_ratio', () => {
  it('compares a paired control with its counterpart', () => {
    fixture(`
      <div><button id="a" style="font-size: 16px">Allow</button>
      <a href="#" id="d" style="font-size: 10px">Not now</a></div>`);
    const cands = scan({ a: { w: 200, h: 50 }, d: { w: 50, h: 10, y: 60 } });
    const a = byText(cands, 'Allow');
    const d = byText(cands, 'Not now');
    expect(f(a, 'font_ratio')).toBeCloseTo(1.6);
    expect(f(d, 'font_ratio')).toBeCloseTo(0.625);
    expect(f(a, 'area_ratio')).toBeCloseTo(20);
    expect(f(d, 'area_ratio')).toBeCloseTo(0.05);
  });

  it('is 1 without a counterpart', () => {
    fixture('<button style="font-size: 30px">Search</button>');
    const [c] = scan({}, {});
    expect(f(c!, 'font_ratio')).toBe(1);
    expect(f(c!, 'area_ratio')).toBe(1);
  });
});

describe('f03 contrast', () => {
  it('is the WCAG ratio of text against the effective background', () => {
    fixture(`
      <button style="color: #000000">Black</button>
      <div style="background-color: #ffffff"><button style="color: #767676">Grey</button></div>`);
    const cands = scan();
    expect(f(byText(cands, 'Black'), 'contrast')).toBeCloseTo(21);
    expect(f(byText(cands, 'Grey'), 'contrast')).toBeCloseTo(4.54, 2);
  });

  it('uses non-text contrast for a control with no text and its own background', () => {
    fixture('<button role="switch" aria-checked="true" aria-label="Plus" style="background-color: #0f5e5a; color: #000"></button>');
    const [c] = scan();
    expect(f(c!, 'contrast')).toBeCloseTo(contrastRatio(parseColor('#0f5e5a')!, WHITE), 5);
  });

  it('uses text colour for a select, whose option text is never read', () => {
    fixture('<select aria-label="Quantity" style="background-color: #fff; color: #000"><option>1</option></select>');
    const [c] = scan();
    expect(f(c!, 'contrast')).toBeCloseTo(21);
    expect(f(c!, 'faded')).toBe(0);
  });
});

describe('f04 salience', () => {
  it('is 0 on the page background and near 1 for a saturated fill', () => {
    fixture(`
      <button>Plain</button>
      <button style="background-color: #ea580c">Orange</button>
      <button style="background-color: #808080">Grey</button>`);
    const cands = scan();
    expect(f(byText(cands, 'Plain'), 'salience')).toBe(0);
    expect(f(byText(cands, 'Orange'), 'salience')).toBeGreaterThan(0.9);
    const grey = f(byText(cands, 'Grey'), 'salience');
    expect(grey).toBeGreaterThan(0.3);
    expect(grey).toBeLessThan(0.5);
  });

  it('is measured against the body background', () => {
    fixture('<div style="background-color: #f4f6f7"><button>On grey</button></div>');
    document.body.style.backgroundColor = '#f4f6f7';
    const [c] = scan();
    document.body.style.backgroundColor = '';
    expect(f(c!, 'salience')).toBe(0);
  });
});

describe('f05 default_checked', () => {
  it('is 1 for checked boxes, radios and switches', () => {
    fixture(`
      <label><input type="checkbox" checked> Add protection</label>
      <label><input type="checkbox"> Gift wrap</label>
      <label><input type="radio" name="c" checked> Black</label>
      <button role="switch" aria-checked="true" aria-label="Plus"></button>
      <div role="checkbox" aria-checked="false" aria-label="Tip"></div>
      <button>Buy</button>`);
    const got = scan().map((c) => [c.text, f(c, 'default_checked')]);
    expect(got).toEqual([
      ['Add protection', 1],
      ['Gift wrap', 0],
      ['Black', 1],
      ['Plus', 1],
      ['Tip', 0],
      ['Buy', 0],
    ]);
  });

  it('uses the page-load snapshot, so a box the user ticked later is not a default', () => {
    fixture('<label><input type="checkbox" id="c"> Gift wrap</label>');
    const initialChecked = snapshotCheckedStates(document);
    (document.getElementById('c') as HTMLInputElement).checked = true;
    expect(f(scan({}, {})[0]!, 'default_checked')).toBe(1);
    expect(f(scan({}, { initialChecked })[0]!, 'default_checked')).toBe(0);
  });
});

describe('f06 faded', () => {
  it('scores size, opacity and contrast with partial values', () => {
    expect(fadedScore(16, 1, 21)).toBe(0);
    expect(fadedScore(10, 1, 21)).toBe(1);
    expect(fadedScore(11.5, 1, 21)).toBeCloseTo(0.5);
    expect(fadedScore(16, 0.6, 21)).toBeCloseTo(1);
    expect(fadedScore(16, 0.7, 21)).toBeCloseTo(0.5);
    expect(fadedScore(16, 1, 3)).toBe(1);
    expect(fadedScore(16, 1, 3.75)).toBeCloseTo(0.5);
  });

  it('reads tiny, see-through and low-contrast elements', () => {
    fixture(`
      <button style="font-size: 16px; color: #000">Normal</button>
      <button style="font-size: 10px; color: #000">Tiny</button>
      <div style="opacity: 0.5"><button style="font-size: 16px; color: #000">Ghost</button></div>
      <button style="font-size: 16px; color: #c8c8c8">Pale</button>`);
    const cands = scan();
    expect(f(byText(cands, 'Normal'), 'faded')).toBe(0);
    expect(f(byText(cands, 'Tiny'), 'faded')).toBe(1);
    expect(f(byText(cands, 'Ghost'), 'faded')).toBe(1);
    expect(f(byText(cands, 'Pale'), 'faded')).toBe(1);
  });
});

describe('f07 countdown', () => {
  it('is 1 only when the time went down between two reads', () => {
    fixture('<div>Ends in <span id="t">14:59</span></div><div>Opens at <span id="s">10:30</span></div>');
    const layout = fakeLayout();
    const ex = extractCandidates(document, { layout, url: URL });
    const snap = snapshotCountdowns(ex);
    expect([...snap.values()]).toEqual([899, 630]);
    document.getElementById('t')!.textContent = '14:57';
    const countdowns = compareCountdowns(ex, snap);
    const cands = computeFeatures(ex, { layout, doc: document, countdowns });
    expect(f(byText(cands, '14:59'), 'countdown')).toBe(1); // text as read at extraction
    expect(f(byText(cands, '10:30'), 'countdown')).toBe(0);
  });

  it('detectCountdowns waits between the reads', async () => {
    fixture('<span id="t">01:00:05</span>');
    const ex = extractCandidates(document, { layout: fakeLayout(), url: URL });
    const waits: number[] = [];
    const ids = await detectCountdowns(ex, {
      sleep: async (ms) => {
        waits.push(ms);
        document.getElementById('t')!.textContent = '01:00:03';
      },
    });
    expect(waits).toEqual([2000]);
    expect([...ids]).toEqual(['c0']);
  });

  it('does not wait when there is no timer', async () => {
    fixture('<button>Buy</button>');
    const ex = extractCandidates(document, { layout: fakeLayout(), url: URL });
    let waited = false;
    await detectCountdowns(ex, { sleep: async () => void (waited = true) });
    expect(waited).toBe(false);
  });
});

describe('f08 overlay_coverage', () => {
  it('is the visible share of the viewport for fixed and sticky elements only', () => {
    fixture(`
      <div id="top" style="position: fixed">Allow notifications?</div>
      <div id="low" style="position: sticky">Cookies</div>
      <button id="b">Buy</button>`);
    const cands = scan({
      top: { w: 1280, h: 80 },
      low: { y: 760, w: 1280, h: 80 },
      b: { w: 1280, h: 80 },
    });
    expect(f(byText(cands, 'Allow notifications?'), 'overlay_coverage')).toBeCloseTo(0.1);
    expect(f(byText(cands, 'Cookies'), 'overlay_coverage')).toBeCloseTo(0.05);
    expect(f(byText(cands, 'Buy'), 'overlay_coverage')).toBe(0);
  });
});

describe('f09 unclosable_modal', () => {
  const full = { o: { w: 1280, h: 800 } };

  it('is 1 inside a full-screen dialog with no close control', () => {
    fixture('<div id="o" role="dialog" style="position: fixed"><p>Enter mobile</p><button>Show price</button></div>');
    const cands = scan(full);
    expect(f(cands.find((c) => c.kind === 'dialog')!, 'unclosable_modal')).toBe(1);
    expect(f(byText(cands, 'Show price'), 'unclosable_modal')).toBe(1);
  });

  it('is 0 when a visible close control exists', () => {
    fixture('<div id="o" role="dialog"><button id="x" aria-label="Close">×</button><button>Show price</button></div>');
    expect(f(byText(scan({ ...full, x: { w: 24, h: 24 } }), 'Show price'), 'unclosable_modal')).toBe(0);
  });

  it('counts a decline link as a way out', () => {
    fixture('<div id="o" role="dialog"><button>Sign up</button><a href="#" style="color: #333">Maybe later</a></div>');
    expect(f(byText(scan(full), 'Sign up'), 'unclosable_modal')).toBe(0);
  });

  it('is 1 when the close control is tiny or faded', () => {
    fixture('<div id="o" role="dialog"><button id="x" aria-label="Close">×</button><button>Show price</button></div>');
    expect(f(byText(scan({ ...full, x: { w: 10, h: 10 } }), 'Show price'), 'unclosable_modal')).toBe(1);
    fixture('<div id="o" role="dialog"><button id="x" style="color: #eeeeee">Close</button><button>Show price</button></div>');
    expect(f(byText(scan({ ...full, x: { w: 40, h: 20 } }), 'Show price'), 'unclosable_modal')).toBe(1);
  });

  it('is 0 for a small dialog or outside any overlay', () => {
    fixture('<div id="o" role="dialog"><button>Show price</button></div><button>Buy</button>');
    const cands = scan({ o: { w: 300, h: 200 } });
    expect(f(byText(cands, 'Show price'), 'unclosable_modal')).toBe(0);
    expect(f(byText(cands, 'Buy'), 'unclosable_modal')).toBe(0);
  });
});

describe('f10 decline_as_link', () => {
  it('is 1 for a plain-text decline next to a filled accept button', () => {
    fixture(`
      <div><button id="a" style="background-color: #0f5e5a; color: #fff">Allow notifications</button>
      <a href="#" id="d">Not now</a></div>`);
    const cands = scan({ d: { y: 30 } });
    expect(f(byText(cands, 'Not now'), 'decline_as_link')).toBe(1);
    expect(f(byText(cands, 'Allow notifications'), 'decline_as_link')).toBe(0);
  });

  it('is 0 when the decline is an outlined or filled button too', () => {
    fixture(`
      <div><button style="background-color: #0f5e5a; color: #fff">Allow</button>
      <button style="background-color: transparent; border: 2px solid #0f5e5a">Not now</button></div>`);
    expect(f(byText(scan(), 'Not now'), 'decline_as_link')).toBe(0);
    fixture(`
      <div><button style="background-color: #0f5e5a; color: #fff">Allow</button>
      <button style="background-color: #e5e7eb">Not now</button></div>`);
    expect(f(byText(scan(), 'Not now'), 'decline_as_link')).toBe(0);
  });

  it('is 0 when the accept side is not filled', () => {
    fixture('<div><a href="#">Allow</a> <a href="#">Not now</a></div>');
    expect(f(byText(scan(), 'Not now'), 'decline_as_link')).toBe(0);
  });
});

describe('f11 cta_distance', () => {
  it('is the distance to the primary CTA over the viewport diagonal', () => {
    fixture(`
      <a href="#" id="l">Help</a>
      <button id="cta" style="background-color: #ea580c; color: #fff">Buy now</button>
      <button id="small" style="background-color: #ea580c">Go</button>`);
    const cands = scan({
      l: { x: 0, y: 0, w: 100, h: 20 },
      cta: { x: 490, y: 375, w: 300, h: 50 },
      small: { x: 0, y: 700, w: 40, h: 20 },
    });
    expect(f(byText(cands, 'Buy now'), 'cta_distance')).toBe(0);
    expect(f(byText(cands, 'Help'), 'cta_distance')).toBeCloseTo(Math.hypot(590, 390) / Math.hypot(1280, 800), 5);
  });

  it('ignores huge elements and is 1 when there is no CTA', () => {
    fixture('<a href="#" id="big" style="background-color: #ea580c">Banner</a><span>₹99</span>');
    const cands = scan({ big: { w: 1280, h: 800 } });
    expect(f(byText(cands, '₹99'), 'cta_distance')).toBe(1);
  });
});

describe('f12 price_delta', () => {
  const summary = `
    <h2>Payment</h2>
    <aside><h2>Order summary</h2>
      <div><span>Subtotal (incl. add-ons)</span><span>₹2,356</span></div>
      <div><span>Platform fee</span><span>₹9</span></div>
      <div><span>Total payable</span><span>₹2,453</span></div>
      <p>You save ₹500 on this order</p>
    </aside>
    <button>Place order</button>`;

  it('finds the order total, not the subtotal or savings', () => {
    fixture(summary);
    expect(findOrderTotal(document)).toBe(2453);
    fixture('<div><span>Subtotal</span><span>₹2,147</span></div><div><span>Total</span><span>₹2,147</span></div>');
    expect(findOrderTotal(document)).toBe(2147);
    fixture('<p>No totals here</p>');
    expect(findOrderTotal(document)).toBeNull();
  });

  it('is (total − remembered price) / remembered price on cart and checkout pages', () => {
    fixture(summary);
    const cands = scan({}, { url: 'https://shop.example/checkout', rememberedPrice: 1299 });
    for (const c of cands) expect(f(c, 'price_delta')).toBeCloseTo((2453 - 1299) / 1299, 6);
  });

  it('is 0 elsewhere or when the remembered price is unknown', () => {
    fixture(summary);
    expect(f(scan({}, { url: 'https://shop.example/product/1', rememberedPrice: 1299 })[0]!, 'price_delta')).toBe(0);
    expect(f(scan({}, { url: 'https://shop.example/checkout' })[0]!, 'price_delta')).toBe(0);
  });
});
