/**
 * The whole extraction pipeline in one call, shared by the content script and
 * the Playwright tools so both run exactly the same code.
 */
import { extractCandidates, type Extraction } from './extractor';
import { collectFacts, type CandidateFacts, type PageFacts } from './facts';
import { FEATURE_NAMES, computeFeatures, detectCountdowns } from './features';
import { domLayout, type Layout } from './layout';
import { truncate } from './text';
import type { Candidate } from './types';

export interface ScanOptions {
  layout?: Layout;
  url?: string;
  initialChecked?: WeakMap<Element, boolean>;
  rememberedPrice?: number | null;
  /** Gap between the two countdown reads (f07). */
  waitMs?: number;
  /**
   * Called between the phases (extract, countdown wait, features) so a caller
   * can hand the main thread back, e.g. to requestIdleCallback.
   */
  yieldToMain?: () => Promise<void>;
}

export interface ScanResult extends Extraction {
  candidates: Candidate[];
  /** Per-candidate facts for the rules (font size, struck, in a grid, …). */
  facts: Record<string, CandidateFacts>;
  page: PageFacts;
}

export async function scanPage(doc: Document, opts: ScanOptions = {}): Promise<ScanResult> {
  const yieldToMain = opts.yieldToMain ?? (() => Promise.resolve());
  const url = opts.url ?? doc.location?.href ?? '';
  await yieldToMain();
  const ex = extractCandidates(doc, { layout: opts.layout ?? domLayout(doc.defaultView!), url });
  const countdowns = await detectCountdowns(ex, opts.waitMs === undefined ? {} : { waitMs: opts.waitMs });
  await yieldToMain();
  // A fresh Layout after the wait: styles may have changed (a pop-up opened) and the old one caches them.
  const layout = opts.layout ?? domLayout(doc.defaultView!);
  const candidates = computeFeatures(ex, {
    layout,
    doc,
    countdowns,
    initialChecked: opts.initialChecked,
    rememberedPrice: opts.rememberedPrice,
  });
  const withFeatures = { ...ex, candidates };
  const { byId, page } = collectFacts(withFeatures, layout, doc, url);
  return { ...withFeatures, facts: byId, page };
}

/** "f01 font_ratio, f02 area_ratio, ..." */
export const FEATURE_LEGEND = FEATURE_NAMES.map((n, i) => `f${String(i + 1).padStart(2, '0')} ${n}`).join(', ');

export type DebugRow = Record<string, string | number>;

/** One console.table row per candidate: id, kind, text, f01..f12 rounded to 2 decimals. */
export function debugRows(candidates: Candidate[]): DebugRow[] {
  return candidates.map((c) => {
    const row: DebugRow = { id: c.id, kind: c.kind, text: truncate(c.text, 40) };
    c.features.forEach((v, i) => {
      row[`f${String(i + 1).padStart(2, '0')}`] = Math.round(v * 100) / 100;
    });
    return row;
  });
}
