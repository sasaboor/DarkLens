import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, THRESHOLD_MAX, THRESHOLD_MIN, normalizeSettings, visibleFindings } from './prefs';
import type { Finding } from './types';

function finding(category: number, confidence: number, extra: Partial<Finding> = {}): Finding {
  return { candidateId: `c${category}-${confidence}`, category, confidence, source: 'rule', reason: '', evidence: [], ...extra };
}

describe('normalizeSettings', () => {
  it('returns the defaults for missing or broken input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ autoScan: 'yes', threshold: 'high' })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values', () => {
    const s = normalizeSettings({ autoScan: false, debug: true, labelling: true, threshold: 0.75, disabled: [3, 1] });
    expect(s).toMatchObject({ autoScan: false, debug: true, labelling: true, threshold: 0.75, disabled: [1, 3] });
  });

  it('clamps the threshold to the slider range', () => {
    expect(normalizeSettings({ threshold: 0.1 }).threshold).toBe(THRESHOLD_MIN);
    expect(normalizeSettings({ threshold: 2 }).threshold).toBe(THRESHOLD_MAX);
    expect(normalizeSettings({ threshold: Number.NaN }).threshold).toBe(DEFAULT_SETTINGS.threshold);
  });

  it('drops unknown and duplicate category ids, and never disables benign', () => {
    expect(normalizeSettings({ disabled: [0, 2, 2, 12, -1, 1.5, '4', 11] }).disabled).toEqual([2, 11]);
  });
});

describe('visibleFindings', () => {
  const all = [finding(1, 0.7), finding(2, 0.9), finding(6, 0.55)];

  it('shows everything at the default settings', () => {
    expect(visibleFindings(all, DEFAULT_SETTINGS)).toEqual({ shown: all, hidden: 0 });
  });

  it('drops disabled categories', () => {
    const { shown, hidden } = visibleFindings(all, { threshold: 0.5, disabled: [1] });
    expect(shown.map((f) => f.category)).toEqual([2, 6]);
    expect(hidden).toBe(1);
  });

  it('drops findings below the threshold, keeping ones exactly at it', () => {
    const { shown } = visibleFindings([...all, finding(8, 0.7)], { threshold: 0.7, disabled: [] });
    expect(shown.map((f) => f.category)).toEqual([1, 2, 8]);
  });

  it('keeps hard and confirmed findings whatever the threshold', () => {
    const hard = finding(2, 0.6, { hard: true });
    const confirmed = finding(1, 0.6, { confirmed: true });
    expect(visibleFindings([hard, confirmed, finding(6, 0.6)], { threshold: 0.9, disabled: [] }).shown).toEqual([
      hard,
      confirmed,
    ]);
  });

  it('drops hard findings in a disabled category', () => {
    expect(visibleFindings([finding(2, 0.9, { hard: true })], { threshold: 0.5, disabled: [2] }).shown).toEqual([]);
  });
});
