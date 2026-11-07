// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { applyCap, extractCandidates, isAcceptText, isDeclineText } from './extractor';
import type { Rect } from './types';
import { fakeLayout, fixture } from './testing';

const URL = 'https://shop.example/';

function extract(rects: Record<string, Partial<Rect>> = {}, url = URL) {
  return extractCandidates(document, { layout: fakeLayout(rects), url });
}

function texts(rects: Record<string, Partial<Rect>> = {}) {
  return extract(rects).candidates.map((c) => c.text);
}

describe('candidate kinds', () => {
  it('collects controls, checkboxes, dialogs and fixed or sticky banners', () => {
    fixture(`
      <button>Buy</button>
      <a href="#">Help</a>
      <div role="button">Menu</div>
      <input type="submit" value="Pay">
      <select aria-label="Quantity"><option>1</option></select>
      <input type="checkbox" aria-label="Gift wrap">
      <button role="switch" aria-checked="false" aria-label="Plus"></button>
      <div role="dialog" aria-label="Offer">Offer</div>
      <div style="position: fixed">Cookie notice</div>
      <div style="position: sticky">Notify me</div>
      <p>Plain paragraph</p>`);
    const kinds = extract().candidates.map((c) => [c.text, c.kind]);
    expect(kinds).toEqual([
      ['Buy', 'control'],
      ['Help', 'control'],
      ['Menu', 'control'],
      ['Pay', 'control'],
      ['Quantity', 'control'],
      ['Gift wrap', 'checkbox'],
      ['Plus', 'checkbox'],
      ['Offer', 'dialog'],
      ['Cookie notice', 'banner'],
      ['Notify me', 'banner'],
    ]);
  });

  it('collects the deepest short text block for each pattern', () => {
    fixture(`
      <span>₹1,299</span>
      <div><b>Only 2 left in stock</b>, order soon.</div>
      <div>&#128065; <b>23</b> people are viewing this right now</div>
      <div>Deal ends in <span>14:59</span></div>
      <span>Sponsored</span>
      <div>Rs 199/month after trial. Renews automatically.</div>
      <div>Platform fee <span>₹9</span></div>
      <p>${'Long text with a price Rs 99. '.repeat(12)}</p>`);
    const got = extract().candidates.map((c) => [c.text, c.kind, c.tag]);
    expect(got).toEqual([
      ['₹1,299', 'price', 'span'],
      ['Only 2 left in stock', 'stock', 'b'],
      ['👁 23 people are viewing this right now', 'stock', 'div'],
      ['14:59', 'timer', 'span'],
      ['Sponsored', 'ad_label', 'span'],
      ['Rs 199/month after trial. Renews automatically.', 'subscription', 'div'],
      ['Platform fee ₹9', 'fee', 'div'],
    ]);
  });

  it('does not repeat text that belongs to a label or a control', () => {
    fixture(`
      <label><input type="checkbox" checked> Add <span>Rs 49</span> protection</label>
      <p>Great speaker <a href="#">Shop at ₹1,199</a></p>`);
    expect(extract().candidates.map((c) => [c.text, c.kind])).toEqual([
      ['Add Rs 49 protection', 'checkbox'],
      ['Shop at ₹1,199', 'control'],
    ]);
  });
});

describe('visibility', () => {
  it('skips hidden, transparent, empty and off-document elements', () => {
    fixture(`
      <div style="display: none"><button>In hidden parent</button></div>
      <button hidden>Hidden attribute</button>
      <button style="visibility: hidden">Invisible</button>
      <div style="opacity: 0"><button>Transparent parent</button></div>
      <button id="zero">Zero size</button>
      <button id="tiny">One pixel</button>
      <button id="left">Off to the left</button>
      <button id="below">Below the fold</button>
      <button>Visible</button>`,
      '[hidden] { display: none }', // the browser's UA rule, which happy-dom lacks
    );
    const got = texts({
      zero: { w: 0, h: 0 },
      tiny: { w: 1, h: 1 },
      left: { x: -500, w: 100 },
      below: { y: 5000 },
    });
    expect(got).toEqual(['Below the fold', 'Visible']);
  });

  it('keeps a visibility:visible child of a visibility:hidden parent', () => {
    fixture('<div style="visibility: hidden"><button style="visibility: visible">Shown</button></div>');
    expect(texts()).toEqual(['Shown']);
  });
});

describe('shadow roots and iframes', () => {
  it('walks open shadow roots but not closed ones', () => {
    fixture('<div id="open"></div><div id="closed"></div>');
    document.getElementById('open')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow buy</button>';
    document.getElementById('closed')!.attachShadow({ mode: 'closed' }).innerHTML = '<button>Secret</button>';
    expect(texts()).toEqual(['Shadow buy']);
  });

  it('pairs and labels across an open shadow root', () => {
    fixture('<div id="host"></div>');
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<span id="l">Auto-renew</span><button role="switch" aria-checked="true" aria-labelledby="l"></button>';
    const c = extract().candidates.find((x) => x.kind === 'checkbox');
    expect(c?.text).toBe('Auto-renew');
  });

  it('skips iframes entirely', () => {
    fixture('<iframe srcdoc="<button>Inside frame</button>"></iframe><button>Outside</button>');
    const got = extract().candidates;
    expect(got.map((c) => c.text)).toEqual(['Outside']);
    expect(got.some((c) => c.tag === 'iframe')).toBe(false);
  });
});

describe('privacy', () => {
  it('never reads values typed into inputs', () => {
    fixture(`
      <form>
        <label for="e">Email</label><input id="e" type="email">
        <label>Address <textarea id="t"></textarea></label>
        <label><input type="checkbox" id="c"> Save details</label>
        <select id="s" aria-label="State"><option>Kerala</option><option>Goa</option></select>
        <input type="submit" value="Continue">
      </form>`);
    (document.getElementById('e') as HTMLInputElement).value = 'secret@example.com';
    (document.getElementById('t') as HTMLTextAreaElement).value = 'secret street';
    (document.getElementById('s') as HTMLSelectElement).selectedIndex = 1;
    const dump = JSON.stringify(extract().candidates);
    expect(dump).not.toContain('secret');
    expect(dump).not.toContain('Goa');
    expect(texts()).toEqual(['Save details', 'State', 'Continue']);
  });

  it('gives identical output with and without data-dp-* attributes', () => {
    const html = (dp: boolean) => `
      <div class="bar"><button ${dp ? 'data-dp-label="benign" data-dp-id="x1"' : ''}>Allow</button>
      <a href="#" ${dp ? 'data-dp-label="interface_interference" data-dp-id="x2"' : ''}>Not now</a></div>
      <span ${dp ? 'data-dp-label="false_urgency"' : ''}>Only 3 left</span>`;
    fixture(html(true));
    const withDp = JSON.stringify(extract().candidates);
    fixture(html(false));
    const withoutDp = JSON.stringify(extract().candidates);
    expect(withDp).toBe(withoutDp);
  });
});

describe('cap at 300', () => {
  it('keeps dialog controls over plain links and returns DOM order', () => {
    const links = Array.from({ length: 350 }, (_, i) => `<a href="#">Link ${i}</a>`).join('');
    fixture(`${links}<div role="dialog"><button>Accept offer</button></div>`);
    const { candidates } = extract();
    expect(candidates).toHaveLength(300);
    expect(candidates.map((c) => c.id)).toEqual(Array.from({ length: 300 }, (_, i) => `c${i}`));
    expect(candidates.at(-1)!.text).toBe('Accept offer');
    expect(candidates.at(-2)!.kind).toBe('dialog');
    expect(candidates.at(-1)!.context.inDialog).toBe(true);
    expect(candidates[0]!.text).toBe('Link 0');
  });

  it('applyCap is stable within a priority', () => {
    const items = [
      { order: 0, priority: 1 },
      { order: 1, priority: 5 },
      { order: 2, priority: 1 },
      { order: 3, priority: 5 },
    ];
    expect(applyCap(items, 3).map((i) => i.order)).toEqual([0, 1, 3]);
  });
});

describe('accept/decline pairing', () => {
  it('classifies choice text, decline first', () => {
    expect(isAcceptText('Allow notifications')).toBe(true);
    expect(isAcceptText('Add to cart')).toBe(true);
    expect(isDeclineText('Not now')).toBe(true);
    expect(isDeclineText('No thanks, I like paying full price')).toBe(true);
    expect(isDeclineText("No, I don't want to add protection")).toBe(true);
    expect(isAcceptText("No, I don't want to add protection")).toBe(false);
    expect(isDeclineText('Know more')).toBe(false);
    expect(isAcceptText('Get it by Tuesday, free delivery on orders above Rs 499 with Plus membership')).toBe(false);
  });

  it('treats an upsell as a choice: upgrade vs continue with standard', () => {
    expect(isAcceptText('Upgrade for ₹99')).toBe(true);
    expect(isDeclineText('Continue with standard delivery')).toBe(true);
    expect(isDeclineText('Continue without protection')).toBe(true);
    expect(isAcceptText('Continue with standard delivery')).toBe(false);
    expect(isDeclineText('Continue to payment')).toBe(false);
    fixture('<div><button id="d">Continue with standard delivery</button><button id="a">Upgrade for ₹99</button></div>');
    const [d, a] = extract({ d: { x: 0 }, a: { x: 260 } }).candidates;
    expect(d!.counterpartId).toBe(a!.id);
  });

  it('pairs within the same form even when far apart', () => {
    fixture('<form><button id="a">Subscribe</button><a href="#" id="d">No thanks</a></form>');
    const [a, d] = extract({ a: { y: 0 }, d: { y: 700 } }).candidates;
    expect(a!.counterpartId).toBe(d!.id);
    expect(d!.counterpartId).toBe(a!.id);
  });

  it('pairs outside a form only under 400px apart', () => {
    fixture('<div><button id="a">Allow</button></div><div><a href="#" id="d">Not now</a></div>');
    let [a, d] = extract({ a: { y: 0 }, d: { y: 100 } }).candidates;
    expect(a!.counterpartId).toBe(d!.id);
    [a, d] = extract({ a: { y: 0 }, d: { y: 600 } }).candidates;
    expect(a!.counterpartId).toBeNull();
    expect(d!.counterpartId).toBeNull();
  });

  it('matches each decline to the nearest accept, one counterpart each', () => {
    fixture(`
      <button id="a1">Accept</button>
      <button id="a2">Continue</button>
      <a href="#" id="d">Maybe later</a>`);
    const [a1, a2, d] = extract({ a1: { y: 300 }, a2: { y: 40 }, d: { y: 0 } }).candidates;
    expect(d!.counterpartId).toBe(a2!.id);
    expect(a2!.counterpartId).toBe(d!.id);
    expect(a1!.counterpartId).toBeNull();
  });
});

describe('context', () => {
  it('records page type, dialog membership and a nearby price', () => {
    fixture(`
      <div class="card"><span>₹999</span><button>Add to cart</button></div>
      <div role="dialog"><button>Claim offer</button></div>`);
    const { pageType, candidates } = extract({}, 'https://shop.example/cart');
    expect(pageType).toBe('cart');
    const add = candidates.find((c) => c.text === 'Add to cart')!;
    expect(add.context).toEqual({ pageType: 'cart', inDialog: false, nearbyPrice: '₹999' });
    expect(candidates.find((c) => c.text === 'Claim offer')!.context.inDialog).toBe(true);
  });

  it('treats a fixed overlay covering most of the viewport as a dialog context', () => {
    fixture('<div id="o" style="position: fixed"><button>Show price</button></div>');
    const { candidates } = extract({ o: { w: 1280, h: 800 } });
    expect(candidates.find((c) => c.text === 'Show price')!.context.inDialog).toBe(true);
  });
});
