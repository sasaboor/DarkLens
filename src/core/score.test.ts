import { describe, expect, it } from 'vitest';
import { SCORE_WEIGHTS, riskScore } from './score';
import type { Finding } from './types';

let n = 0;
function f(category: number, confidence = 1, extra: Partial<Finding> = {}): Finding {
  return { candidateId: `c${n++}`, category, confidence, source: 'rule', reason: '', evidence: [], ...extra };
}

describe('riskScore', () => {
  it('is 0 with no findings or only benign ones', () => {
    expect(riskScore([])).toBe(0);
    expect(riskScore([f(0), f(0)])).toBe(0);
  });

  it('adds base weight × confidence', () => {
    expect(riskScore([f(2)])).toBe(20); // basket sneaking
    expect(riskScore([f(1, 0.7)])).toBe(7); // false urgency
    expect(riskScore([f(2), f(10)])).toBe(28);
  });

  it('weighs hard and confirmed findings 1.5x', () => {
    expect(riskScore([f(2, 1, { hard: true })])).toBe(30);
    expect(riskScore([f(1, 1, { confirmed: true })])).toBe(15);
    expect(riskScore([f(6, 0.8, { hard: true })])).toBeGreaterThan(riskScore([f(6, 0.8)]));
  });

  it('gives diminishing returns to repeats within a category, strongest first', () => {
    // 10 + 5 + 2.5 + 2.5
    expect(riskScore([f(1), f(1), f(1), f(1)])).toBe(20);
    // The confirmed one (15) counts in full, the plain one (10) at half.
    expect(riskScore([f(1), f(1, 1, { confirmed: true })])).toBe(20);
  });

  it('counts one finding per element', () => {
    expect(riskScore([f(2, 1, { candidateId: 'x' }), f(11, 1, { candidateId: 'x' })])).toBe(20);
  });

  it('caps at 100', () => {
    const many = Array.from({ length: 12 }, (_, i) => f((i % 11) + 1, 1, { hard: true }));
    expect(riskScore(many)).toBe(100);
    expect(SCORE_WEIGHTS.max).toBe(100);
  });

  it('documents a weight for every category in label order', () => {
    expect(SCORE_WEIGHTS.base).toHaveLength(12);
    expect(SCORE_WEIGHTS.base[0]).toBe(0);
  });
});
