/**
 * One scan, end to end: ask the background for memory, load settings,
 * extract and compute features (handing the main thread back between
 * phases), refine f03/f04 from a tab capture, run the rules, send the scan's
 * observation back to the background, then publish: filter by the user's settings, score, report to
 * the background and draw highlights. A settings change republishes the last
 * scan without rescanning.
 *
 * Single flight: a scan requested while one runs queues exactly one more.
 */
import { categoryById } from '@/src/core/categories';
import { readCartCount, urlKey } from '@/src/core/facts';
import { snapshotCheckedStates } from '@/src/core/features';
import { cartRiseLive, detectCartRise, filterDismissed, observe } from '@/src/core/memory';
import { visibleFindings, type Settings } from '@/src/core/prefs';
import { runRules } from '@/src/core/rules';
import { FEATURE_LEGEND, debugRows, scanPage } from '@/src/core/scan';
import { riskScore } from '@/src/core/score';
import type { CandidateKind, Finding, PageType } from '@/src/core/types';
import { REPORT, type RescanReply, type TabReport } from '@/src/messages';
import { loadSettings } from '@/src/settings';
import { dismiss as saveDismissal, getState, noteAddClick, recordScan } from '@/src/stateClient';
import type { Overlay, OverlayEntry } from './overlay';
import { createPixelRefiner } from './pixels';

export type ScanTrigger = 'load' | 'rescan' | 'change' | 'dismiss';

/** Clicks that legitimately raise the cart count: add to cart, buy now, move to cart, a quantity "+". */
const ADD_TO_CART_RE = /\badd to (?:cart|bag|basket)\b|\bbuy now\b|\bmove to (?:cart|bag|basket)\b|^\s*(?:\+|add)\s*$/i;
const ADD_LABEL_RE = /\b(?:increase|increment|add one|plus|add to (?:cart|bag|basket))\b/i;
const CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

/** Hands the main thread back until the browser is idle (or 1 s passes). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 0);
  });
}

interface PageState {
  loadId: string;
  loadedAt: number;
  /** Checked states before the user touched anything (f05). */
  initialChecked: WeakMap<Element, boolean>;
  cartAtLoad: number | null;
  /** The cart count a rise is measured from, fixed on the first scan of this page. */
  baseline: { count: number | null; at: number } | null;
  /** Once seen on this page, the cart rise stays reported. */
  cartRise: { from: number; to: number } | null;
  addClickAt: number;
  /** The badge count at the last live check (watchCart). */
  lastCount: number | null;
}

/** The last scan's results before the settings filter, kept so a settings change can republish them. */
interface LastScan {
  url: string;
  pageType: PageType;
  scannedAt: number;
  /** After rules and dismissals, before the settings filter. */
  findings: Finding[];
  elements: Map<string, Element>;
  items: Map<string, { text: string; kind: CandidateKind }>;
}

function newPageState(): PageState {
  const cartAtLoad = readCartCount(document)?.count ?? null;
  return {
    loadId: crypto.randomUUID(),
    loadedAt: Date.now(),
    initialChecked: snapshotCheckedStates(document),
    cartAtLoad,
    baseline: null,
    cartRise: null,
    addClickAt: 0,
    lastCount: cartAtLoad,
  };
}

export function createScanner(overlay: Overlay, build: string) {
  let page = newPageState();
  let last: LastScan | null = null;
  const pixels = createPixelRefiner(overlay);

  /** Applies the settings to the last scan, then reports to the background and draws highlights. */
  function publish(settings: Settings): { count: number; score: number; hidden: number } {
    if (!last) return { count: 0, score: 0, hidden: 0 };
    const { shown, hidden } = visibleFindings(last.findings, settings);
    const score = riskScore(shown);
    const report: TabReport = {
      url: last.url,
      pageType: last.pageType,
      score,
      findings: shown,
      hidden,
      items: Object.fromEntries(shown.map((f) => [f.candidateId, last!.items.get(f.candidateId)!])),
      scannedAt: last.scannedAt,
      build,
      mode: 'rules',
    };
    browser.runtime.sendMessage({ type: REPORT, report }).catch(() => {});
    const entries: OverlayEntry[] = shown.map((f) => ({
      finding: f,
      element: last!.elements.get(f.candidateId)!,
      text: last!.items.get(f.candidateId)!.text,
    }));
    overlay.setVisible(settings.highlights);
    overlay.render(entries);
    return { count: shown.length, score, hidden };
  }
  let running: Promise<RescanReply> | null = null;
  let queued: Promise<RescanReply> | null = null;

  async function run(trigger: ScanTrigger): Promise<RescanReply> {
    try {
      const settings = await loadSettings();
      const url = location.href;
      const { site: siteMem, history, dismissed } = await getState();
      const t0 = performance.now();

      const scanned = await scanPage(document, {
        url,
        initialChecked: page.initialChecked,
        rememberedPrice: siteMem.lastProductPrice,
        yieldToMain: idle,
      });
      const refined = await pixels.refine(scanned.candidates, scanned.elements);
      const scan = { ...scanned, candidates: refined.candidates };
      const now = Date.now();

      // Basket sneaking: the cart badge went up with no add-to-cart click since the baseline.
      page.baseline ??=
        siteMem.cart.count !== null
          ? { count: siteMem.cart.count, at: siteMem.cart.countAt }
          : { count: page.cartAtLoad, at: page.loadedAt };
      const current = scan.page.cartCount?.count ?? null;
      const addClicked = Math.max(siteMem.cart.addClickAt ?? 0, page.addClickAt) > page.baseline.at;
      page.cartRise ??= detectCartRise(page.baseline.count, current, addClicked);
      if (addClicked) page.baseline = { count: current, at: now };

      const findings = filterDismissed(
        runRules(scan.candidates, {
          page: scan.page,
          facts: scan.facts,
          site: siteMem,
          history,
          cartRise: page.cartRise,
          loadId: page.loadId,
          now,
        }),
        scan.candidates,
        dismissed,
        urlKey,
        scan.page.urlKey,
      );

      await recordScan(observe(scan, { now }), page.loadId, now);

      const byId = new Map(scan.candidates.map((c) => [c.id, c]));
      last = {
        url,
        pageType: scan.pageType,
        scannedAt: now,
        findings,
        elements: scan.elements,
        items: new Map(findings.map((f) => [f.candidateId, { text: byId.get(f.candidateId)!.text, kind: byId.get(f.candidateId)!.kind }])),
      };
      const { count, score, hidden } = publish(settings);

      if (settings.debug) {
        const ms = Math.round(performance.now() - t0);
        console.log(
          `[DarkLens] scan (${trigger}): ${scan.pageType} page, ${scan.candidates.length} candidates, ` +
            `${count} findings shown (${hidden} hidden by settings), risk ${score}, ${ms} ms incl. the 2 s countdown wait`,
        );
        console.log(`[DarkLens] ${FEATURE_LEGEND}`);
      const fromPixels = scan.candidates.filter((c) => c.featureSource.f03 === 'pixels').length;
      console.log(`[DarkLens] f03/f04 from pixels for ${fromPixels} of ${scan.candidates.length} candidates (capture: ${refined.status})`);
        console.table(debugRows(scan.candidates));
        console.table(
          findings.map((f) => ({
            id: f.candidateId,
            category: categoryById(f.category).name,
            confidence: f.confidence,
            hard: !!f.hard,
            confirmed: !!f.confirmed,
            shown: visibleFindings([f], settings).shown.length === 1,
            reason: f.reason,
          })),
        );
      }
      return { ok: true, build, count, score, pageType: scan.pageType };
    } catch (err) {
      console.error('[DarkLens] scan failed', err);
      return { ok: false, build, error: String(err) };
    }
  }

  function scan(trigger: ScanTrigger): Promise<RescanReply> {
    if (!running) {
      running = run(trigger).finally(() => {
        running = null;
      });
      return running;
    }
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return scan(trigger);
      });
    return queued;
  }

  return {
    scan,

    /** True once this page has been scanned. */
    get scanned(): boolean {
      return last !== null;
    },

    /** Settings changed: republish the last scan under them, without rescanning. */
    refresh(settings: Settings): void {
      if (last) publish(settings);
      else overlay.setVisible(settings.highlights);
    },

    /** Scrolls a finding's element into view and flashes its highlight. False if the element is gone. */
    focus(candidateId: string): boolean {
      const el = last?.elements.get(candidateId);
      if (!el?.isConnected) return false;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      overlay.flash(candidateId);
      return true;
    },

    /** A new page in the same document (SPA navigation): forget per-page state and highlights. */
    newPage(): void {
      page = newPageState();
      last = null;
      pixels.reset();
      overlay.clear();
    },

    /**
     * Live basket-sneaking watch, called on DOM changes: true when the cart
     * badge just went up with no add-to-cart click in the previous 2 s (the
     * caller then rescans so the finding shows).
     */
    checkCart(): boolean {
      const count = readCartCount(document)?.count ?? null;
      const rise = cartRiseLive(page.lastCount, count, page.addClickAt || null, Date.now());
      if (count !== null) page.lastCount = count;
      if (!rise) return false;
      page.cartRise ??= rise;
      return true;
    },

    /** Records add-to-cart and buy-now clicks, reading only the control's text. */
    noteClick(target: EventTarget | null): void {
      const control = target instanceof Element ? target.closest(CLICKABLE) : null;
      if (!control) return;
      // The button's caption (a submit input's value is its caption, not typed text) or its aria-label.
      const text = control.tagName === 'INPUT' ? control.getAttribute('value') : control.textContent;
      const label = control.getAttribute('aria-label') ?? '';
      if (!(text && ADD_TO_CART_RE.test(text)) && !ADD_LABEL_RE.test(label)) return;
      const at = Date.now();
      page.addClickAt = at;
      noteAddClick(at);
    },

    /** "Not a dark pattern?": remember it locally, then rescan so the report drops it. */
    async dismiss(entry: OverlayEntry): Promise<void> {
      await saveDismissal(entry.text, entry.finding.category, Date.now());
      await scan('dismiss');
    },
  };
}
