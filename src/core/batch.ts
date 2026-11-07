/**
 * One call for the Playwright tools (window.DarkLens.scan): extract, compute
 * features, refine f03/f04 from a screenshot when a capture function is
 * given, run the rules, score, and return the memory to carry to the next
 * page. The content script does the same steps itself because it also tracks
 * add-to-cart clicks and dismissals.
 */
import { refineWithCapture } from './capture';
import type { CandidateFacts, PageFacts } from './facts';
import { detectCartRise, normalizeHistory, normalizeSiteMemory, updateMemory, type HistoryMemory, type SiteMemory } from './memory';
import { runRules } from './rules';
import { scanPage } from './scan';
import { riskScore } from './score';
import type { Layout } from './layout';
import type { Candidate, Finding, PageType } from './types';

export interface BatchState {
  /** Session memory for this site from the previous page (null on the first page). */
  site?: SiteMemory | null;
  /** Local memory (timer end times, stock counts) from earlier loads. */
  history?: HistoryMemory | null;
  /** Checked states at load, from snapshotCheckedStates (f05). */
  initialChecked?: WeakMap<Element, boolean>;
  /** Cart badge at load, from readCartCount: the baseline when the site memory has none. */
  cartAtLoad?: number | null;
  loadId?: string;
  now?: number;
  url?: string;
  /** Gap between the two countdown reads (f07). */
  waitMs?: number;
  layout?: Layout;
  /**
   * Screenshot of the viewport as a PNG data URL (Playwright's page.screenshot
   * through exposeFunction). When given, f03 and f04 are refined from pixels
   * before the rules run, as in the extension. Null or a throw keeps CSS values.
   */
  capture?: () => Promise<string | null>;
}

export interface BatchResult {
  pageType: PageType;
  candidates: Candidate[];
  findings: Finding[];
  elementsById: Map<string, Element>;
  page: PageFacts;
  facts: Record<string, CandidateFacts>;
  score: number;
  /** Memory after this page, to pass as state on the next one. */
  memory: { site: SiteMemory; history: HistoryMemory };
}

export async function scan(doc: Document, state: BatchState = {}): Promise<BatchResult> {
  const site = normalizeSiteMemory(state.site);
  const history = normalizeHistory(state.history);
  const loadId = state.loadId ?? `load-${Date.now()}`;
  const result = await scanPage(doc, {
    url: state.url,
    layout: state.layout,
    initialChecked: state.initialChecked,
    rememberedPrice: site.lastProductPrice,
    waitMs: state.waitMs,
  });
  if (state.capture && doc.defaultView) {
    result.candidates = await refineWithCapture(result.candidates, result.elements, doc.defaultView, state.capture);
  }
  const now = state.now ?? Date.now();
  const cartRise = detectCartRise(site.cart.count ?? state.cartAtLoad ?? null, result.page.cartCount?.count ?? null, false);
  const findings = runRules(result.candidates, {
    page: result.page,
    facts: result.facts,
    site,
    history,
    cartRise,
    loadId,
    now,
  });
  return {
    pageType: result.pageType,
    candidates: result.candidates,
    findings,
    elementsById: result.elements,
    page: result.page,
    facts: result.facts,
    score: riskScore(findings),
    memory: updateMemory(site, history, result, { now, loadId }),
  };
}
