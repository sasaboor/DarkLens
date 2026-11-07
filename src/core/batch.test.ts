// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { scan } from './batch';
import { snapshotCheckedStates } from './features';
import { emptySiteMemory } from './memory';
import { CAT } from './rules';
import { fakeLayout, fixture } from './testing';

const URL = 'https://shop.example/cart';

describe('scan (window.DarkLens.scan)', () => {
  it('finds a pre-ticked add-on, resolves its element and returns fresh memory', async () => {
    fixture(`
      <h1>Your cart</h1>
      <label><input type="checkbox" id="plan" checked> Add 1-year protection plan Rs 499</label>
      <button>Proceed to checkout</button>`);
    const site = emptySiteMemory();
    const r = await scan(document, {
      site,
      url: URL,
      layout: fakeLayout(),
      initialChecked: snapshotCheckedStates(document),
      waitMs: 0,
      loadId: 'l1',
      now: 1000,
    });

    const sneaks = r.findings.filter((f) => f.category === CAT.basket_sneaking);
    expect(sneaks).toHaveLength(1);
    expect(sneaks[0]!.hard).toBe(true);
    expect(r.elementsById.get(sneaks[0]!.candidateId)).toBe(document.getElementById('plan'));
    expect(r.score).toBeGreaterThan(0);
    expect(r.memory.site).not.toBe(site);
  });

  it('accepts no state at all', async () => {
    fixture('<p>Nothing to see</p>');
    const r = await scan(document, { url: URL, layout: fakeLayout(), waitMs: 0 });
    expect(r.findings).toEqual([]);
    expect(r.memory.site.dialogKeys).toEqual([]);
  });
});
