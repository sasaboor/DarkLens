/**
 * Scores DarkLens against the test shop's ground truth: per-category
 * precision, recall and F1, macro F1 over the 11 dark-pattern categories, a
 * confusion matrix (ground truth vs predicted, benign included), and lists of
 * misses and false positives with their reasons.
 *
 * Protocol (fixed, so runs are comparable):
 *   Session A, one browser context, DarkLens memory carried between pages:
 *     index → product → product again ~8 s later (timer-reset check) → cart → checkout → index (return visit)
 *   Session B, a fresh context: clean/product → clean/cart → clean/checkout
 *   Each page: load, inject the bundle, let the page settle 2.5 s (pop-ups at 2 s,
 *   auto-added cart row at 1 s), then DarkLens.scan, which does its own 2 s
 *   countdown double-read and then refines f03/f04 from a viewport screenshot
 *   (src/core/pixels.ts, as the extension does with captureVisibleTab).
 *   Forced modals are left up. Every page is scored on its last visit.
 *   --css-only skips the screenshot (the ablation: CSS-only f03/f04).
 *
 * Matching: a finding belongs to the labelled element closest('[data-dp-id]')
 * of its candidate element. Each labelled element gets one prediction: the
 * finding with the ground-truth category if any, else the strongest (hard
 * first, then confidence), else benign. Findings with no labelled ancestor are
 * listed but not scored (unlabelled elements are not scored, see
 * ground-truth.json). Labelled elements not visible at scan time are listed as
 * "not shown" and left out of the metrics.
 *
 * Only this tool (and tools/walk-shop) may read data-dp-* attributes.
 *
 * Run with: npm run evaluate [-- --css-only]   → results/eval-<timestamp>.json, results/eval-latest.md
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { buildExtractor } from './build-extractor.ts';
import { exposeCapture, injectDarkLens } from './lib/inject.ts';
import { serveShop } from './serve-shop.ts';
import { LABELS } from '../src/core/categories.ts';
import type { HistoryMemory, SiteMemory } from '../src/core/memory.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');
const GROUND_TRUTH = join(ROOT, 'test-shop', 'ground-truth.json');
const SETTLE_MS = 2500;
const RELOAD_GAP_MS = 8000;
const { values: args } = parseArgs({ options: { 'css-only': { type: 'boolean', default: false } } });
const PIXELS = !args['css-only'];
const MODE = `rules only, f03/f04 from ${PIXELS ? 'pixels where measurable' : 'CSS only'}`;

/** Short column codes for the confusion matrix, in label id order (as in the test shop ids). */
const CODES = ['BEN', 'FU', 'BS', 'CS', 'FA', 'ST', 'II', 'BAS', 'DP', 'DA', 'NAG', 'TW'];

interface Visit {
  path: string;
  label?: string;
  /** Wait this long before the visit (timer-reset check). */
  waitBeforeMs?: number;
}

const SESSIONS: { name: string; visits: Visit[] }[] = [
  {
    name: 'A (dark shop)',
    visits: [
      { path: 'index.html' },
      { path: 'product.html' },
      { path: 'product.html', label: `product.html (again, ~${RELOAD_GAP_MS / 1000} s later)`, waitBeforeMs: RELOAD_GAP_MS },
      { path: 'cart.html' },
      { path: 'checkout.html' },
      { path: 'index.html', label: 'index.html (return visit)' },
    ],
  },
  { name: 'B (clean shop)', visits: [{ path: 'clean/product.html' }, { path: 'clean/cart.html' }, { path: 'clean/checkout.html' }] },
];

interface Pred {
  category: number;
  confidence: number;
  hard: boolean;
  confirmed: boolean;
  source: string;
  reason: string;
  evidence: string[];
  text: string;
}

interface Labelled {
  id: string;
  label: string;
  shown: boolean;
  preds: Pred[];
}

interface PageScan {
  path: string;
  visit: string;
  pageType: string;
  score: number;
  candidates: number;
  labelled: Labelled[];
  unlabelled: Pred[];
  site: SiteMemory;
  history: HistoryMemory;
  /** How many candidates got f03 / f04 from pixels vs CSS. */
  sources: { f03: { pixels: number; css: number }; f04: { pixels: number; css: number } };
}

interface Scored {
  page: string;
  id: string;
  description: string;
  gt: number;
  pred: number;
  finding: Pred | null;
  /** Other categories that also fired on this element. */
  extra: Pred[];
}

const bundle = readFileSync(await buildExtractor(), 'utf8');
const gtFile = JSON.parse(readFileSync(GROUND_TRUTH, 'utf8')) as {
  items: { page: string; id: string; label: string; description: string }[];
};
const descriptions = new Map(gtFile.items.map((i) => [`${i.page}#${i.id}`, i.description]));

async function scanVisit(
  context: BrowserContext,
  base: string,
  visit: Visit,
  memory: { site: SiteMemory | null; history: HistoryMemory | null },
): Promise<PageScan> {
  if (visit.waitBeforeMs) await new Promise((r) => setTimeout(r, visit.waitBeforeMs));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${base}/${visit.path}`, { waitUntil: 'load' });
  await injectDarkLens(page, bundle);
  await page.waitForTimeout(SETTLE_MS);
  const r = await page.evaluate(
    async ({ site, history, loadId, pixels }) => {
      const scan = await window.DarkLens.scan(document, {
        site,
        history,
        initialChecked: window.__dl.initial,
        cartAtLoad: window.__dl.cart,
        loadId,
        capture: pixels ? window.__dlCapture : undefined,
      });
      const textOf = new Map(scan.candidates.map((c) => [c.id, c.text]));
      const byLabelled = new Map<Element, Pred[]>();
      const unlabelled: Pred[] = [];
      for (const f of scan.findings) {
        const pred: Pred = {
          category: f.category,
          confidence: f.confidence,
          hard: !!f.hard,
          confirmed: !!f.confirmed,
          source: f.source,
          reason: f.reason,
          evidence: f.evidence,
          text: textOf.get(f.candidateId) ?? '',
        };
        const owner = scan.elementsById.get(f.candidateId)?.closest('[data-dp-id]');
        if (!owner) unlabelled.push(pred);
        else byLabelled.set(owner, [...(byLabelled.get(owner) ?? []), pred]);
      }
      const labelled = [...document.querySelectorAll('[data-dp-id]')].map((el) => ({
        id: el.getAttribute('data-dp-id')!,
        label: el.getAttribute('data-dp-label')!,
        shown: el.checkVisibility(),
        preds: byLabelled.get(el) ?? [],
      }));
      return {
        pageType: scan.pageType,
        score: scan.score,
        candidates: scan.candidates.length,
        labelled,
        unlabelled,
        site: scan.memory.site,
        history: scan.memory.history,
        sources: window.DarkLens.featureSourceCounts(scan.candidates),
      };
    },
    { site: memory.site, history: memory.history, loadId: `${visit.path}-${Date.now()}`, pixels: PIXELS },
  );
  memory.site = r.site;
  memory.history = r.history;
  return { path: visit.path, visit: visit.label ?? visit.path, ...r };
}

/** The one prediction for a labelled element: the ground-truth category if it fired, else the strongest finding. */
function choose(gt: number, preds: Pred[]): Pred | null {
  const exact = preds.find((p) => p.category === gt);
  if (exact) return exact;
  return [...preds].sort((a, b) => Number(b.hard) - Number(a.hard) || b.confidence - a.confidence)[0] ?? null;
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function fmt(x: number): string {
  return x.toFixed(3);
}

function short(s: string, n = 50): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Plain aligned table for the console. */
function textTable(head: string[], rows: (string | number)[][]): string {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  // Numbers right-aligned, text left-aligned.
  const numeric = head.map((_, i) => cells.slice(1).every((r) => /^-?[\d.]+$|^-$/.test(r[i]!)));
  const line = (r: string[]) => r.map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ');
  return [line(cells[0]!), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

function mdTable(head: string[], rows: (string | number)[][]): string {
  const esc = (c: string | number) => String(c).replace(/\|/g, '\\|');
  return [
    `| ${head.map(esc).join(' | ')} |`,
    `|${head.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

const { server, port } = await serveShop(0);
const base = `http://localhost:${port}`;
const browser = await chromium.launch();
const finalScans = new Map<string, PageScan>();
const visitLog: {
  session: string;
  visit: string;
  pageType: string;
  score: number;
  candidates: number;
  findings: number;
  f03Pixels: number;
  f04Pixels: number;
}[] = [];

try {
  for (const session of SESSIONS) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await exposeCapture(context);
    const memory: { site: SiteMemory | null; history: HistoryMemory | null } = { site: null, history: null };
    for (const visit of session.visits) {
      const s = await scanVisit(context, base, visit, memory);
      const findings = s.labelled.reduce((n, l) => n + l.preds.length, 0) + s.unlabelled.length;
      visitLog.push({
        session: session.name,
        visit: s.visit,
        pageType: s.pageType,
        score: s.score,
        candidates: s.candidates,
        findings,
        f03Pixels: s.sources.f03.pixels,
        f04Pixels: s.sources.f04.pixels,
      });
      console.log(
        `scanned ${s.visit.padEnd(36)} ${s.pageType.padEnd(9)} risk ${String(s.score).padStart(3)}  ${findings} findings  ` +
          `f03 from pixels ${s.sources.f03.pixels}/${s.candidates}`,
      );
      finalScans.set(s.path, s);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

// ---------- scoring ----------

const K = LABELS.length;
const matrix = Array.from({ length: K }, () => new Array<number>(K).fill(0));
const scored: Scored[] = [];
const notShown: { page: string; id: string; label: string; description: string }[] = [];
const unlabelled: (Pred & { page: string })[] = [];
const warnings: string[] = [];

for (const [path, s] of finalScans) {
  const seen = new Set<string>();
  for (const l of s.labelled) {
    seen.add(l.id);
    const gt = LABELS.indexOf(l.label as (typeof LABELS)[number]);
    const description = descriptions.get(`${path}#${l.id}`) ?? '';
    if (gt < 0) {
      warnings.push(`${path}#${l.id}: unknown label "${l.label}"`);
      continue;
    }
    if (!l.shown) {
      notShown.push({ page: path, id: l.id, label: l.label, description });
      continue;
    }
    const finding = choose(gt, l.preds);
    const pred = finding?.category ?? 0;
    matrix[gt]![pred]!++;
    scored.push({ page: path, id: l.id, description, gt, pred, finding, extra: l.preds.filter((p) => p !== finding) });
  }
  for (const item of gtFile.items) {
    if (item.page === path && !seen.has(item.id)) warnings.push(`${path}#${item.id} is in ground-truth.json but not on the page`);
  }
  for (const u of s.unlabelled) unlabelled.push({ ...u, page: path });
}

const perCategory = LABELS.map((label, c) => {
  const tp = matrix[c]![c]!;
  const support = matrix[c]!.reduce((a, b) => a + b, 0);
  const predicted = matrix.reduce((a, row) => a + row[c]!, 0);
  const precision = ratio(tp, predicted);
  const recall = ratio(tp, support);
  const f1 = ratio(2 * precision * recall, precision + recall);
  // How far above the line the hits are: mean confidence of the true-positive findings.
  const hits = scored.filter((s) => s.gt === c && s.pred === c && s.finding);
  const tpConfidence = ratio(hits.reduce((a, s) => a + s.finding!.confidence, 0), hits.length);
  return { id: c, label, tp, fp: predicted - tp, fn: support - tp, support, precision, recall, f1, tpConfidence };
});
const dark = perCategory.filter((c) => c.id !== 0);
const macroF1 = dark.reduce((a, c) => a + c.f1, 0) / dark.length;
const macroP = dark.reduce((a, c) => a + c.precision, 0) / dark.length;
const macroR = dark.reduce((a, c) => a + c.recall, 0) / dark.length;
const misses = scored.filter((s) => s.gt !== 0 && s.pred !== s.gt);
const falsePositives = scored.filter((s) => s.pred !== 0 && s.pred !== s.gt);
// Lowest F1 first; ties broken by the weaker (lower-confidence) hits, then the smaller support.
const weakest = [...dark].sort((a, b) => a.f1 - b.f1 || a.tpConfidence - b.tpConfidence || a.support - b.support).slice(0, 3);

// ---------- output ----------

const catHead = ['category', 'support', 'TP', 'FP', 'FN', 'precision', 'recall', 'F1', 'TP conf'];
const catRows = perCategory.map((c) => [`${c.id} ${c.label}`, c.support, c.tp, c.fp, c.fn, fmt(c.precision), fmt(c.recall), fmt(c.f1), c.id === 0 ? '-' : fmt(c.tpConfidence)]);
const matHead = ['gt \\ pred', ...CODES];
const matRows = matrix.map((row, i) => [`${CODES[i]} ${LABELS[i]}`, ...row]);
const missRows = misses.map((m) => [
  m.page,
  m.id,
  LABELS[m.gt]!,
  LABELS[m.pred]!,
  short(m.description, 60),
  m.finding ? short(m.finding.reason, 80) : '(no finding)',
]);
const fpRows = falsePositives.map((f) => [
  f.page,
  f.id,
  LABELS[f.pred]!,
  LABELS[f.gt]!,
  short(f.finding!.text, 40),
  short(f.finding!.reason, 80),
  short(f.finding!.evidence.join('; '), 80),
]);
const unlabelledRows = unlabelled.map((u) => [
  u.page,
  LABELS[u.category]!,
  short(u.text, 40),
  short(u.reason, 80),
  u.page.startsWith('clean/') ? 'CLEAN PAGE' : '',
]);
const visitRows = visitLog.map((v) => [v.session, v.visit, v.pageType, v.score, v.candidates, v.findings, v.f03Pixels, v.f04Pixels]);
const totalCandidates = visitLog.reduce((a, v) => a + v.candidates, 0);
const totalF03 = visitLog.reduce((a, v) => a + v.f03Pixels, 0);
const totalF04 = visitLog.reduce((a, v) => a + v.f04Pixels, 0);
const summary =
  `Macro F1 (11 dark-pattern categories): ${fmt(macroF1)}   macro precision ${fmt(macroP)}   macro recall ${fmt(macroR)}\n` +
  `Scored ${scored.length} labelled elements on ${finalScans.size} pages (${scored.filter((s) => s.gt !== 0).length} dark, ` +
  `${scored.filter((s) => s.gt === 0).length} benign); ${misses.length} misses, ${falsePositives.length} false positives, ` +
  `${unlabelled.length} findings on unlabelled elements, ${notShown.length} labelled elements not shown.\n` +
  `f03 from pixels for ${totalF03} of ${totalCandidates} candidate scans, f04 for ${totalF04} (${MODE}).\n` +
  `Weakest: ${weakest.map((c) => `${c.label} (F1 ${fmt(c.f1)}, TP conf ${fmt(c.tpConfidence)}, n=${c.support})`).join(', ')}`;

console.log('\nPer category');
console.log(textTable(catHead, catRows));
console.log('\nConfusion matrix (rows: ground truth, columns: predicted)');
console.log(textTable(matHead, matRows));
console.log(`\nMisses (${misses.length})`);
console.log(missRows.length ? textTable(['page', 'id', 'truth', 'predicted', 'element', 'reason'], missRows) : '  none');
console.log(`\nFalse positives (${falsePositives.length})`);
console.log(fpRows.length ? textTable(['page', 'id', 'predicted', 'truth', 'text', 'reason', 'evidence'], fpRows) : '  none');
console.log(`\nFindings on unlabelled elements, not scored (${unlabelled.length})`);
console.log(unlabelledRows.length ? textTable(['page', 'predicted', 'text', 'reason', ''], unlabelledRows) : '  none');
if (notShown.length) console.log(`\nNot shown at scan time, not scored: ${notShown.map((n) => `${n.page}#${n.id} (${n.label})`).join(', ')}`);
for (const w of warnings) console.warn(`WARNING ${w}`);
console.log(`\n${summary}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const protocol = {
  sessions: SESSIONS.map((s) => ({ name: s.name, visits: s.visits.map((v) => v.label ?? v.path) })),
  settleMs: SETTLE_MS,
  reloadGapMs: RELOAD_GAP_MS,
  scoredOn: 'last visit of each page',
  mode: MODE,
  viewport: '1280x800 @1x, headless Chromium',
};
mkdirSync(RESULTS, { recursive: true });
const jsonPath = join(RESULTS, `eval-${stamp}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      protocol,
      labels: LABELS,
      macro: { f1: macroF1, precision: macroP, recall: macroR },
      perCategory,
      confusionMatrix: matrix,
      visits: visitLog,
      scored: scored.map((s) => ({ ...s, gt: LABELS[s.gt], pred: LABELS[s.pred] })),
      misses: misses.map((m) => ({ page: m.page, id: m.id, truth: LABELS[m.gt], predicted: LABELS[m.pred], finding: m.finding })),
      falsePositives: falsePositives.map((f) => ({ page: f.page, id: f.id, truth: LABELS[f.gt], predicted: LABELS[f.pred], finding: f.finding })),
      unlabelled: unlabelled.map((u) => ({ ...u, category: LABELS[u.category] })),
      notShown,
      warnings,
    },
    null,
    2,
  ),
);

const md = [
  `# DarkLens evaluation on the test shop`,
  ``,
  `Generated ${new Date().toISOString()} by \`npm run evaluate${PIXELS ? '' : ' -- --css-only'}\` (${MODE}). Full data: \`results/${`eval-${stamp}.json`}\`.`,
  ``,
  '```',
  summary,
  '```',
  ``,
  `## Protocol`,
  ``,
  ...protocol.sessions.map((s) => `- Session ${s.name}: ${s.visits.join(' → ')}`),
  `- Each page: load, settle ${SETTLE_MS / 1000} s, then scan (includes the 2 s countdown double-read${PIXELS ? ', then a viewport screenshot for pixel refinement of f03/f04' : ''}). Forced modals left up. Scored on the last visit of each page.`,
  `- A finding counts for the labelled element \`closest('[data-dp-id]')\` of its candidate. One prediction per labelled element: the ground-truth category if it fired, else the strongest finding, else benign.`,
  ``,
  `## Visits`,
  ``,
  mdTable(['session', 'visit', 'page type', 'risk', 'candidates', 'findings', 'f03 pixels', 'f04 pixels'], visitRows),
  ``,
  `## Per category`,
  ``,
  mdTable(catHead, catRows),
  ``,
  `Macro F1 is over the 11 dark-pattern categories (benign excluded). TP conf = mean confidence of the true-positive findings (how far above the threshold the hits are).`,
  ``,
  `## Confusion matrix`,
  ``,
  `Rows: ground truth. Columns: predicted. Codes: ${CODES.map((c, i) => `${c} = ${LABELS[i]}`).join(', ')}.`,
  ``,
  mdTable(matHead, matRows),
  ``,
  `## Misses (${misses.length})`,
  ``,
  missRows.length ? mdTable(['page', 'id', 'truth', 'predicted', 'element', 'reason'], missRows) : 'None.',
  ``,
  `## False positives (${falsePositives.length})`,
  ``,
  fpRows.length ? mdTable(['page', 'id', 'predicted', 'truth', 'text', 'reason', 'evidence'], fpRows) : 'None.',
  ``,
  `## Findings on unlabelled elements (not scored, ${unlabelled.length})`,
  ``,
  unlabelledRows.length ? mdTable(['page', 'predicted', 'text', 'reason', 'note'], unlabelledRows) : 'None.',
  ``,
  `## Not shown at scan time (not scored, ${notShown.length})`,
  ``,
  notShown.length ? notShown.map((n) => `- ${n.page}#${n.id} (${n.label}): ${n.description}`).join('\n') : 'None.',
  ...(warnings.length ? ['', '## Warnings', '', ...warnings.map((w) => `- ${w}`)] : []),
  '',
].join('\n');
writeFileSync(join(RESULTS, 'eval-latest.md'), md);
console.log(`\nWrote ${jsonPath} and ${join(RESULTS, 'eval-latest.md')}`);
