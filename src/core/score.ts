/**
 * The page risk score, 0 to 100.
 *
 * Each finding adds  base[category] × (hard or confirmed ? 1.5 : 1) × confidence × repeat
 * where `repeat` is 1 for the first finding of a category on the page, 0.5 for
 * the second and 0.25 from the third on (findings in a category are ranked by
 * their own points first, so the strongest counts in full). The sum is rounded
 * and capped at 100.
 *
 * Base weights reflect how directly the pattern costs the shopper money or
 * consent:
 *   20  basket sneaking, drip pricing, subscription trap (money taken or added without clear consent)
 *   18  forced action, bait and switch
 *   12  interface interference, trick question
 *   10  false urgency, confirm shaming, disguised advertisement
 *    8  nagging
 *    0  benign
 */
import type { Finding } from './types';

export const SCORE_WEIGHTS = {
  base: [0, 10, 20, 10, 18, 20, 12, 18, 20, 10, 8, 12] as readonly number[],
  hardMultiplier: 1.5,
  repeat: [1, 0.5, 0.25] as readonly number[],
  max: 100,
};

function points(f: Finding): number {
  const base = SCORE_WEIGHTS.base[f.category] ?? 0;
  const hard = f.hard || f.confirmed ? SCORE_WEIGHTS.hardMultiplier : 1;
  return base * hard * Math.max(0, Math.min(1, f.confidence));
}

export function riskScore(findings: Finding[]): number {
  const byCategory = new Map<number, number[]>();
  // One finding per element: if two findings share an element, only the stronger counts.
  const perElement = new Map<string, Finding>();
  for (const f of findings) {
    const prev = perElement.get(f.candidateId);
    if (!prev || points(f) > points(prev)) perElement.set(f.candidateId, f);
  }
  for (const f of perElement.values()) {
    const list = byCategory.get(f.category) ?? [];
    list.push(points(f));
    byCategory.set(f.category, list);
  }
  let total = 0;
  for (const list of byCategory.values()) {
    list.sort((a, b) => b - a);
    list.forEach((p, i) => {
      const r = SCORE_WEIGHTS.repeat;
      total += p * (r[Math.min(i, r.length - 1)] ?? 0);
    });
  }
  return Math.min(SCORE_WEIGHTS.max, Math.round(total));
}
