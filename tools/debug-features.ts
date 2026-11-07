/**
 * Prints the same candidate table as the extension's debug logging, then the
 * rule findings (with empty cross-page memory, so no nagging, drip pricing or
 * bait and switch), using Playwright's own Chromium at a fixed viewport so the
 * numbers are reproducible. For findings across pages, use npm run walk.
 *
 * Run with: npm run debug:features -- test-shop/product.html [--width 1280 --height 800] [--after-modal]
 *   --after-modal  pretends the forced modals were already dismissed this session
 *                  (sets the test shop's own sessionStorage keys, then reloads).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { buildExtractor } from './build-extractor.ts';

interface Row {
  [key: string]: string | number;
}

declare global {
  interface Window {
    DarkLens: typeof import('../src/core/index.ts');
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    'after-modal': { type: 'boolean', default: false },
  },
});

const target = positionals[0] ?? 'test-shop/product.html';
const url = /^https?:/.test(target) ? target : pathToFileURL(resolve(target)).href;
const bundle = readFileSync(await buildExtractor(), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: Number(values.width), height: Number(values.height) },
    deviceScaleFactor: 1,
  });
  await page.goto(url, { waitUntil: 'load' });
  if (values['after-modal']) {
    await page.evaluate(() => {
      sessionStorage.setItem('dm_forced_phone-price', '1');
      sessionStorage.setItem('dm_forced_signup', '1');
    });
    await page.reload({ waitUntil: 'load' });
  }
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const DL = window.DarkLens;
    const initialChecked = DL.snapshotCheckedStates(document);
    const scan = await DL.scanPage(document, { initialChecked });
    const findings = DL.runRules(scan.candidates, { page: scan.page, facts: scan.facts });
    const findingRows: Row[] = findings.map((f) => ({
      id: f.candidateId,
      category: DL.CATEGORIES[f.category]!.name,
      confidence: f.confidence,
      reason: f.reason,
    }));
    return {
      pageType: scan.pageType,
      legend: DL.FEATURE_LEGEND,
      rows: DL.debugRows(scan.candidates) as Row[],
      findingRows,
      score: DL.riskScore(findings),
    };
  });
  console.log(`[DarkLens] debug scan: ${result.pageType} page, ${result.rows.length} candidates`);
  console.log(`[DarkLens] ${result.legend}`);
  console.table(result.rows);
  console.log(`[DarkLens] ${result.findingRows.length} findings, risk ${result.score} (empty cross-page memory)`);
  console.table(result.findingRows);
} finally {
  await browser.close();
}
