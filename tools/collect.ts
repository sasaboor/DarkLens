/**
 * Collects candidates from real pages for labelling and training. For each
 * URL: open it, wait for load + 3 s, scroll once to trigger lazy content, back
 * to the top, run DarkLens.scan (f03/f04 refined from a viewport screenshot
 * with src/core/pixels.ts, as in the extension), screenshot, and write one JSON line per
 * candidate (text, kind, features, the rules' suggestion and reason, a cropped
 * PNG of the element) to <out>/<site>-<date>.jsonl, crops under <out>/crops/.
 *
 * Privacy: candidate text never includes typed values (labels and button
 * captions only, see candidateText), and text-field values are made
 * transparent before any screenshot. This tool never reads data-dp-*.
 *
 * Headed by default because some sites block headless browsers. URLs on
 * localhost:5050 start the test shop if it isn't already running.
 *
 * Run with: npm run collect -- urls.txt [--headless] [--out data/collected]
 *           npm run collect -- tools/urls.test-shop.txt
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { buildExtractor } from './build-extractor.ts';
import { exposeCapture, injectDarkLens } from './lib/inject.ts';
import { SHOP_PORT, serveShop } from './serve-shop.ts';
import { LABELS } from '../src/core/categories.ts';
import type { HistoryMemory, SiteMemory } from '../src/core/memory.ts';
import type { Candidate, Finding, PageType, Rect } from '../src/core/types.ts';

const LOAD_TIMEOUT_MS = 45_000;
const AFTER_LOAD_MS = 3000;
const AFTER_SCROLL_MS = 1000;
const VIEWPORT = { width: 1280, height: 800 };

/** Text-field values become invisible in screenshots. Checkboxes, radios, buttons and selects stay as they are. */
const HIDE_VALUES_CSS = `
input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=range]):not([type=color]),
textarea, [contenteditable]:not([contenteditable="false"]) {
  color: transparent !important; -webkit-text-fill-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important;
}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    headless: { type: 'boolean', default: false },
    out: { type: 'string', default: 'data/collected' },
  },
});
if (!positionals[0]) {
  console.error('Usage: npm run collect -- urls.txt [--headless] [--out data/collected]');
  process.exit(1);
}
const urls = readFileSync(positionals[0], 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean);
const OUT = resolve(values.out);
const CROPS = join(OUT, 'crops');
const SCREENS = join(OUT, 'screens');
mkdirSync(CROPS, { recursive: true });
mkdirSync(SCREENS, { recursive: true });

interface ScanOut {
  pageType: PageType;
  candidates: Candidate[];
  findings: Finding[];
  site: SiteMemory;
  history: HistoryMemory;
}

/** "www.example.in" → "www.example.in", "localhost:5050" → "localhost-5050". */
function siteName(url: URL): string {
  return url.host.replace(/[^a-z0-9.-]+/gi, '-');
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Crops rects out of PNGs in a blank page (createImageBitmap + OffscreenCanvas), so no image library is needed. */
async function cropAll(
  browser: Browser,
  shots: Record<'full' | 'viewport', Buffer>,
  jobs: { key: string; shot: 'full' | 'viewport'; rect: Rect }[],
): Promise<Map<string, Buffer>> {
  const page = await browser.newPage();
  try {
    const out = await page.evaluate(
      async ({ shots, jobs }) => {
        const bitmaps: Record<string, ImageBitmap> = {};
        for (const [name, b64] of Object.entries(shots)) {
          const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
          bitmaps[name] = await createImageBitmap(blob);
        }
        const res: Record<string, string> = {};
        for (const job of jobs) {
          const bmp = bitmaps[job.shot]!;
          const x = Math.max(0, Math.floor(job.rect.x));
          const y = Math.max(0, Math.floor(job.rect.y));
          const w = Math.min(bmp.width, Math.ceil(job.rect.x + job.rect.w)) - x;
          const h = Math.min(bmp.height, Math.ceil(job.rect.y + job.rect.h)) - y;
          if (w < 1 || h < 1) continue;
          const canvas = new OffscreenCanvas(w, h);
          canvas.getContext('2d')!.drawImage(bmp, x, y, w, h, 0, 0, w, h);
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          res[job.key] = btoa(bin);
        }
        return res;
      },
      { shots: { full: shots.full.toString('base64'), viewport: shots.viewport.toString('base64') }, jobs },
    );
    return new Map(Object.entries(out).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } finally {
    await page.close();
  }
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
  // Some pages never fire load (endless trackers); carry on after the timeout.
  await page.waitForLoadState('load', { timeout: LOAD_TIMEOUT_MS }).catch(() => {});
}

// The test shop, if any URL points at it and it isn't already running.
let shop: Awaited<ReturnType<typeof serveShop>>['server'] | null = null;
if (urls.some((u) => /^https?:\/\/(localhost|127\.0\.0\.1):5050\b/.test(u))) {
  try {
    shop = (await serveShop(SHOP_PORT)).server;
    console.log(`Started the test shop on http://localhost:${SHOP_PORT}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  }
}

const bundle = readFileSync(await buildExtractor(), 'utf8');
const browser = await chromium.launch({ headless: values.headless });
// bypassCSP: real shops' CSPs would otherwise block the injected script tag.
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, bypassCSP: true });
await exposeCapture(context);
const page = await context.newPage();
const siteMemory = new Map<string, SiteMemory>();
let history: HistoryMemory | null = null;
const date = today();
const summary = { ok: 0, failed: 0, candidates: 0, findings: 0 };

try {
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      console.error(`skip  ${raw}: not a URL`);
      summary.failed++;
      continue;
    }
    const site = siteName(url);
    const base = `${site}-${date}-${createHash('sha1').update(url.href).digest('hex').slice(0, 8)}`;
    try {
      await open(page, url.href);
      await injectDarkLens(page, bundle);
      await page.waitForTimeout(AFTER_LOAD_MS);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(AFTER_SCROLL_MS);
      // Back to the top: at scrollY = 0 candidate rects are page coordinates, which the crops rely on.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      // Text-field values are hidden before the first screenshot (the pixel-refinement capture inside scan).
      await page.addStyleTag({ content: HIDE_VALUES_CSS });

      const r: ScanOut = await page.evaluate(
        async ({ site, history, loadId }) => {
          const scan = await window.DarkLens.scan(document, {
            site,
            history,
            initialChecked: window.__dl.initial,
            cartAtLoad: window.__dl.cart,
            loadId,
            capture: window.__dlCapture,
          });
          return {
            pageType: scan.pageType,
            candidates: scan.candidates,
            findings: scan.findings,
            site: scan.memory.site,
            history: scan.memory.history,
          };
        },
        { site: siteMemory.get(url.origin) ?? null, history, loadId: `${base}-${Date.now()}` },
      );
      siteMemory.set(url.origin, r.site);
      history = r.history;

      await page.evaluate(() => window.scrollTo(0, 0));
      const shots = {
        viewport: await page.screenshot(),
        full: await page.screenshot({ fullPage: true }),
      };
      writeFileSync(join(SCREENS, `${base}.png`), shots.full);

      // Inside the first viewport (fixed bars, pop-ups and their buttons included): crop what the shopper sees.
      // Below the fold: crop from the full-page shot.
      const inViewport = (b: Rect) => b.x >= 0 && b.y >= 0 && b.x + b.w <= VIEWPORT.width && b.y + b.h <= VIEWPORT.height;
      const jobs = r.candidates.map((c) => ({ key: c.id, shot: inViewport(c.rect) ? ('viewport' as const) : ('full' as const), rect: c.rect }));
      const crops = await cropAll(browser, shots, jobs);

      const byCandidate = new Map(r.findings.map((f) => [f.candidateId, f]));
      const collectedAt = new Date().toISOString();
      const lines = r.candidates.map((c, i) => {
        const f = byCandidate.get(c.id);
        const crop = crops.get(c.id);
        const cropFile = crop ? `crops/${base}-${c.id}.png` : null;
        if (crop && cropFile) writeFileSync(join(OUT, cropFile), crop);
        return JSON.stringify({
          url: url.href,
          collectedAt,
          pageType: r.pageType,
          candidateId: c.id,
          text: c.text,
          tag: c.tag,
          role: c.role,
          kind: c.kind,
          rect: c.rect,
          counterpartId: c.counterpartId,
          features: c.features,
          featureSource: c.featureSource,
          context: c.context,
          suggested: f
            ? {
                category: f.category,
                label: LABELS[f.category],
                confidence: f.confidence,
                source: f.source,
                hard: !!f.hard,
                confirmed: !!f.confirmed,
                reason: f.reason,
                evidence: f.evidence,
              }
            : null,
          crop: cropFile,
          cropSource: crop ? jobs[i]!.shot : null,
        });
      });
      const jsonl = join(OUT, `${site}-${date}.jsonl`);
      if (lines.length) appendFileSync(jsonl, lines.join('\n') + '\n');
      summary.ok++;
      summary.candidates += r.candidates.length;
      summary.findings += r.findings.length;
      console.log(
        `ok    ${url.href}  ${r.pageType}, ${r.candidates.length} candidates, ${r.findings.length} findings, ${crops.size} crops → ${jsonl}`,
      );
    } catch (err) {
      summary.failed++;
      console.error(`fail  ${url.href}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
  shop?.close();
}

console.log(
  `\n${summary.ok} pages ok, ${summary.failed} failed; ${summary.candidates} candidates, ${summary.findings} findings. Output in ${OUT}`,
);
if (summary.ok === 0) process.exit(1);
