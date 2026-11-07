/**
 * User preferences that shape what DarkLens shows: the settings shape, its
 * defaults and normalisation, and the display filter (disabled categories and
 * the confidence threshold). Pure, so the content script, the pages and the
 * tests share one definition. Storage I/O lives in src/settings.ts.
 */
import { CATEGORIES } from './categories';
import type { Finding } from './types';

export const THRESHOLD_MIN = 0.4;
export const THRESHOLD_MAX = 0.9;
export const THRESHOLD_STEP = 0.05;

export interface Settings {
  /** Scan every page on load (otherwise only when Rescan is pressed). */
  autoScan: boolean;
  /** Draw highlights on the page. */
  highlights: boolean;
  /** Print the candidate and findings tables to the page console after each scan. */
  debug: boolean;
  /** Labelling mode for collecting training data. */
  labelling: boolean;
  /** Findings below this confidence are hidden, unless they rest on hard or confirmed evidence. */
  threshold: number;
  /** Category ids the user turned off. A list of the disabled ones, so categories added later start on. */
  disabled: number[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoScan: true,
  highlights: true,
  debug: false,
  labelling: false,
  threshold: 0.5,
  disabled: [],
};

const MAX_CATEGORY = CATEGORIES.length - 1;

/** Fills in defaults and repairs anything out of range in a stored settings object. */
export function normalizeSettings(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof Settings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_SETTINGS[k] as boolean));
  const t = typeof r.threshold === 'number' && Number.isFinite(r.threshold) ? r.threshold : DEFAULT_SETTINGS.threshold;
  const disabled = Array.isArray(r.disabled)
    ? [...new Set(r.disabled.filter((id): id is number => Number.isInteger(id) && id >= 1 && id <= MAX_CATEGORY))].sort(
        (a, b) => a - b,
      )
    : [];
  return {
    autoScan: bool('autoScan'),
    highlights: bool('highlights'),
    debug: bool('debug'),
    labelling: bool('labelling'),
    threshold: Math.round(Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, t)) * 100) / 100,
    disabled,
  };
}

/**
 * The findings to show under the user's settings. Disabled categories are
 * always dropped; low-confidence findings are dropped unless they fired on hard
 * evidence or were confirmed across visits.
 */
export function visibleFindings(
  findings: Finding[],
  settings: Pick<Settings, 'threshold' | 'disabled'>,
): { shown: Finding[]; hidden: number } {
  const off = new Set(settings.disabled);
  const shown = findings.filter(
    (f) => !off.has(f.category) && (f.hard || f.confirmed || f.confidence >= settings.threshold - 1e-9),
  );
  return { shown, hidden: findings.length - shown.length };
}
