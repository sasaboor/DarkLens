/**
 * Walks the test shop like a shopper (index → product → cart → checkout,
 * a reload of the product page, then the pages again with the forced modals
 * already dismissed), carrying DarkLens's cross-page memory between pages
 * exactly as the extension does, and prints each page's findings and risk
 * score next to the ground truth. The clean pages run in a fresh session.
 *
 * Only this tool (and tools/evaluate) may read data-dp-* ground truth.
 *
 * Run with: npm run walk
 */
import { readFileSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { buildExtractor } from './build-extractor.ts';
import { injectDarkLens } from './lib/inject.ts';
import { serveShop } from './serve-shop.ts';
import type { HistoryMemory, SiteMemory } from '../src/core/memory.ts';

interface Row {
  cat: string;
  text: string;
  reason: string;
  gt: string;
  hard: boolean;
  confirmed: boolean;
}

interface PageResult {
  pageType: string;
  score: number;
  rows: Row[];
  missed: string[];
  site: SiteMemory;
  history: HistoryMemory;
  cartCount: number | null;
}

const bundle = readFileSync(await buildExtractor(), 'utf8');
const { server, port } = await serveShop(0);
const base = `http://localhost:${port}`;
const browser = await chromium.launch();

let failures = 0;

async function visit(
  context: BrowserContext,
  path: string,
  memory: { site: SiteMemory | null; history: HistoryMemory | null },
  opts: { reload?: boolean; label?: string; settleMs?: number } = {},
): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${base}/${path}`, { waitUntil: 'load' });
  if (opts.reload) await page.reload({ waitUntil: 'load' });
  await injectDarkLens(page, bundle);
  await page.waitForTimeout(opts.settleMs ?? 2500);
  const r: PageResult = await page.evaluate(
    async ({ site, history, loadId }) => {
      const DL = window.DarkLens;
      const scan = await DL.scan(document, {
        site,
        history,
        initialChecked: window.__dl.initial,
        cartAtLoad: window.__dl.cart,
        loadId,
      });
      const { findings } = scan;
      const flagged = findings.map((f) => scan.elementsById.get(f.candidateId)!);
      const rows = findings.map((f) => {
        const c = scan.candidates.find((x) => x.id === f.candidateId)!;
        const gt = scan.elementsById.get(f.candidateId)!.closest('[data-dp-label]')?.getAttribute('data-dp-label') ?? '-';
        return {
          cat: DL.CATEGORIES[f.category]!.label,
          text: c.text.slice(0, 40),
          reason: f.reason,
          gt,
          hard: !!f.hard,
          confirmed: !!f.confirmed,
        };
      });
      const missed: string[] = [];
      for (const el of document.querySelectorAll('[data-dp-label]')) {
        const label = el.getAttribute('data-dp-label')!;
        if (label === 'benign') continue;
        const hit = flagged.some((f) => el === f || el.contains(f) || f.contains(el));
        if (!hit) {
          const shown = el.checkVisibility();
          missed.push(`${el.getAttribute('data-dp-id')} ${label}${shown ? '' : ' (not shown)'}`);
        }
      }
      return {
        pageType: scan.pageType,
        score: scan.score,
        rows,
        missed,
        site: scan.memory.site,
        history: scan.memory.history,
        cartCount: scan.page.cartCount?.count ?? null,
      };
    },
    { site: memory.site, history: memory.history, loadId: `${path}-${Date.now()}` },
  );
  memory.site = r.site;
  memory.history = r.history;

  console.log(`\n=== ${opts.label ?? path}  (${r.pageType} page, risk ${r.score}, cart badge ${r.cartCount})`);
  for (const row of r.rows) {
    const ok = row.gt === row.cat ? 'OK ' : row.gt === '-' ? '   ' : 'GT≠';
    const flags = `${row.hard ? 'hard ' : ''}${row.confirmed ? 'confirmed ' : ''}`;
    console.log(`  ${ok} ${row.cat.padEnd(22)} ${JSON.stringify(row.text).padEnd(44)} ${flags}${row.reason}  [gt: ${row.gt}]`);
    if (path.startsWith('clean/')) failures++;
  }
  if (!r.rows.length) console.log('  (no findings)');
  for (const m of r.missed) console.log(`  MISSED ${m}`);
}

try {
  console.log('Session 1: dark shop');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const mem: { site: SiteMemory | null; history: HistoryMemory | null } = { site: null, history: null };
  await visit(ctx, 'index.html', mem, { settleMs: 3000 });
  await visit(ctx, 'product.html', mem);
  await new Promise((r) => setTimeout(r, 8000));
  await visit(ctx, 'product.html', mem, { label: 'product.html (reloaded ~10 s later)' });
  await visit(ctx, 'cart.html', mem);
  await visit(ctx, 'checkout.html', mem);
  const page = ctx.pages()[0]!;
  await page.evaluate(() => {
    sessionStorage.setItem('dm_forced_phone-price', '1');
    sessionStorage.setItem('dm_forced_signup', '1');
  });
  await visit(ctx, 'product.html', mem, { label: 'product.html (forced modal already submitted)' });
  await visit(ctx, 'checkout.html', mem, { label: 'checkout.html (forced modal already submitted)' });
  await visit(ctx, 'index.html', mem, { label: 'index.html (second visit)', settleMs: 3000 });
  await ctx.close();

  console.log('\nSession 2: clean shop (must have no findings)');
  const clean = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const mem2: { site: SiteMemory | null; history: HistoryMemory | null } = { site: null, history: null };
  for (const p of ['clean/product.html', 'clean/cart.html', 'clean/checkout.html']) await visit(clean, p, mem2);
  await clean.close();
} finally {
  await browser.close();
  server.close();
}

if (failures) {
  console.error(`\n${failures} finding(s) on clean pages`);
  process.exit(1);
}
