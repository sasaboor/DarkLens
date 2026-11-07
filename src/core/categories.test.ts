import { describe, expect, it } from 'vitest';
import { CATEGORIES, LABELS } from './categories';

describe('categories', () => {
  it('has the 12 labels in the fixed spec order', () => {
    expect(LABELS).toEqual([
      'benign',
      'false_urgency',
      'basket_sneaking',
      'confirm_shaming',
      'forced_action',
      'subscription_trap',
      'interface_interference',
      'bait_and_switch',
      'drip_pricing',
      'disguised_ads',
      'nagging',
      'trick_wording',
    ]);
  });

  it('uses the array index as the id', () => {
    CATEGORIES.forEach((c, i) => expect(c.id).toBe(i));
  });

  it('gives every category a name and a one-line description', () => {
    for (const c of CATEGORIES) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description).not.toContain('\n');
    }
  });
});
