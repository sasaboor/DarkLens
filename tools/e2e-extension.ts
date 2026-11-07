/**
 * End-to-end check of the scan pipeline through the real built extension:
 * Chromium loads .output/chrome-mv3, auto-scan runs on the test shop's
 * product page, highlights appear without blocking clicks, the background
 * stores the tab's findings, the popup's Rescan and the debug flag work,
 * settings in storage.sync apply live, and the side panel and options page
 * work. Run after `npm run build`.
 *
 * Run with: npm run e2e:debug
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type ConsoleMessage, type Page } from 'playwright';
import { serveShop } from './serve-shop.ts';

/** The extension API inside page.evaluate on an extension page (popup.html). */
declare const chrome: typeof import('wxt/browser').browser;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('No build at .output/chrome-mv3. Run npm run build first.');
  process.exit(1);
}

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

// The production build must declare the content script statically for every http(s) page.
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')) as {
  content_scripts?: { matches: string[]; js: string[]; all_frames?: boolean }[];
};
const declared = manifest.content_scripts?.[0];
console.log(`      content_scripts[0].matches: ${JSON.stringify(declared?.matches)}`);
check(
  !!declared && declared.matches.includes('http://*/*') && declared.matches.includes('https://*/*'),
  'manifest declares the content script for http://*/* and https://*/* (covers localhost and 127.0.0.1 on any port)',
);
check(declared?.all_frames !== true, 'content script runs in the top frame only');

/** A port nothing listens on, for a connection-refused browser error page. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, r));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 1;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** Collects console lines from a page, rendering console.table rows compactly. */
function recordConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'table') lines.push('[console.table]');
    lines.push(msg.text());
  });
  return lines;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

const { server, port } = await serveShop(0);
const profile = mkdtempSync(join(tmpdir(), 'darklens-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const productUrl = `http://localhost:${port}/product.html`;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  interface StoredReport {
    tabId: number;
    score: number;
    hidden: number;
    scannedAt: number;
    findings: { candidateId: string; category: number; confidence: number; hard?: boolean; confirmed?: boolean }[];
  }
  /** The background's newest stored report for a tab showing `url`, read from an extension page. */
  async function reportFor(url: string): Promise<StoredReport | null> {
    return popup.evaluate(async (u) => {
      const all = await chrome.storage.session.get(null);
      let best: StoredReport | null = null;
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('tab:') || (v as { url: string }).url !== u) continue;
        const r = { ...(v as StoredReport), tabId: Number(k.slice(4)) };
        if (!best || r.scannedAt > best.scannedAt) best = r;
      }
      return best;
    }, url);
  }
  /** Polls the stored report until `pred` holds. */
  async function reportWhen(url: string, pred: (r: StoredReport) => boolean, timeoutMs = 4000): Promise<StoredReport | null> {
    const end = Date.now() + timeoutMs;
    let r: StoredReport | null = null;
    while (Date.now() < end) {
      r = await reportFor(url);
      if (r && pred(r)) return r;
      await new Promise((res) => setTimeout(res, 150));
    }
    return r && pred(r) ? r : null;
  }
  const setSettings = (patch: Record<string, unknown>) =>
    popup.evaluate((p) => chrome.storage.sync.set({ settings: p }), patch);

  // ---------- 1. Auto-scan on load (on by default) ----------
  const page = await context.newPage();
  const lines = recordConsole(page);
  await page.goto(productUrl, { waitUntil: 'load' });
  check(
    await waitFor(() => lines.some((l) => l.includes('content script ready (build')), 5000),
    'content script logs "ready" with a build stamp on load',
  );
  check(lines.some((l) => l.includes('auto-scan: on')), 'auto-scan is on by default');
  const hostShown = await page
    .waitForFunction(() => document.querySelector('darklens-overlay') !== null, null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check(hostShown, 'auto-scan draws the <darklens-overlay> host without a click');
  check(
    await page.evaluate(() => document.querySelector('darklens-overlay')!.parentElement === document.documentElement),
    'the overlay host sits on <html>, outside <body>',
  );
  let report: Awaited<ReturnType<typeof reportFor>> = null;
  await waitFor(() => false, 500);
  for (let i = 0; i < 20 && !report; i++) {
    report = await reportFor(productUrl);
    if (!report) await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`      stored report: risk ${report?.score}, ${report?.findings.length} findings`);
  check(!!report && report.findings.length >= 5 && report.score > 0, 'the background stores the tab\'s findings and score');
  check(!lines.includes('[console.table]'), 'no console tables while debug logging is off');

  // ---------- 2. Clicks pass through the overlay ----------
  await page.evaluate(() => sessionStorage.setItem('dm_forced_phone-price', '1')); // no forced modal on reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('darklens-overlay') !== null, null, { timeout: 10000 });
  await page.waitForTimeout(3000); // let the scan finish and the highlights settle
  let clicked = true;
  try {
    // Playwright's click checks the real hit target and fails if anything intercepts it.
    await page.getByRole('button', { name: 'Allow notifications' }).click({ timeout: 3000 });
  } catch (err) {
    clicked = false;
    console.log(`      ${String(err).split('\n')[0]}`);
  }
  check(clicked, 'a page button under the highlights is still clickable');
  check(await page.locator('.notif-bar').isHidden(), 'the click reached the page (the banner closed)');

  // ---------- 3. Rescan via the real popup ----------
  await popup.bringToFront();
  await popup.reload();
  await page.bringToFront();
  await popup.getByRole('button', { name: 'Rescan' }).click();
  const status = popup.getByTestId('status');
  await status.filter({ hasNotText: 'Scanning' }).waitFor({ timeout: 10000 });
  const statusText = (await status.textContent()) ?? '';
  console.log(`      popup status: "${statusText}"`);
  check(/^Scanned: \d+ findings? \(product page\)/.test(statusText), 'popup Rescan reaches the content script');
  check((await popup.getByTestId('mode').textContent()) === 'Rules only', 'popup shows "Rules only" without a model');

  // ---------- 4. Debug logging behind the options flag ----------
  await setSettings({ debug: true });
  lines.length = 0;
  await popup.getByRole('button', { name: 'Rescan' }).click();
  check(
    await waitFor(() => lines.some((l) => l.startsWith('[DarkLens] scan (rescan): product page')), 10000),
    'with debug logging on, a scan logs its summary',
  );
  check(await waitFor(() => lines.includes('[console.table]'), 3000), 'with debug logging on, a scan logs console tables');
  await setSettings({});

  // ---------- 5. Settings in storage.sync apply live (no rescan, no reload) ----------
  const base = await reportFor(productUrl);
  if (!base || !base.findings.length) {
    check(false, 'a stored report with findings exists before the settings checks');
  } else {
    const target = base.findings.find((f) => !f.hard)?.category ?? base.findings[0]!.category;
    await setSettings({ disabled: [target] });
    const filtered = await reportWhen(productUrl, (r) => !r.findings.some((f) => f.category === target));
    check(!!filtered, `disabling category ${target} in storage.sync drops it from the report live`);
    check(!!filtered && filtered.scannedAt === base.scannedAt, 'the settings change republished the last scan instead of rescanning');
    check(!!filtered && filtered.hidden > 0 && filtered.score <= base.score, 'the report counts hidden findings and the score does not rise');

    await setSettings({ threshold: 0.9 });
    const strict = await reportWhen(productUrl, (r) => r.findings.every((f) => f.hard || f.confirmed || f.confidence >= 0.9));
    const hardBefore = base.findings.filter((f) => f.hard || f.confirmed).length;
    check(!!strict, 'at threshold 0.9 only findings with confidence >= 0.9 or hard/confirmed evidence remain');
    check(!!strict && strict.findings.filter((f) => f.hard || f.confirmed).length === hardBefore, 'hard and confirmed findings survive any threshold');

    await setSettings({});
    check(!!(await reportWhen(productUrl, (r) => r.findings.length === base.findings.length)), 'restoring the defaults restores every finding');
  }

  // ---------- 6. Side panel: grouped cards; a click scrolls to the element ----------
  const live = await reportFor(productUrl);
  if (live) {
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${live.tabId}`);
    const cards = panel.getByTestId('finding-card');
    await cards.first().waitFor({ timeout: 5000 });
    const groups = await panel.getByTestId('finding-group').count();
    const categories = new Set(live.findings.map((f) => f.category)).size;
    check((await cards.count()) === live.findings.length, `side panel shows one card per finding (${live.findings.length})`);
    check(groups === categories, `side panel groups the cards by category (${categories} groups)`);

    // Click cards from the bottom of the list up until one has to scroll the page.
    await page.setViewportSize({ width: 1280, height: 500 });
    let scrolled = false;
    for (let i = (await cards.count()) - 1; i >= 0 && !scrolled; i--) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await cards.nth(i).click();
      scrolled = await page
        .waitForFunction(() => window.scrollY > 0, null, { timeout: 1500 })
        .then(() => true)
        .catch(() => false);
    }
    check(scrolled, 'clicking a side panel card scrolls the page to its element');
    check((await panel.getByText('No longer on the page').count()) === 0, 'focused elements are still on the page');
    await page.setViewportSize({ width: 1280, height: 800 });
    await panel.close();
  }

  // ---------- 7. Options page writes to storage.sync ----------
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.locator('#threshold').fill('0.7');
  await options.getByTestId('category-nagging').click();
  await options.getByTestId('labelling').click();
  await options.waitForTimeout(300);
  const saved = (await options.evaluate(async () => (await chrome.storage.sync.get('settings')).settings)) as
    | { threshold: number; disabled: number[]; labelling: boolean }
    | undefined;
  console.log(`      saved settings: ${JSON.stringify(saved)}`);
  check(saved?.threshold === 0.7, 'the sensitivity slider saves the threshold to storage.sync');
  check(!!saved?.disabled.includes(10), 'a category switch saves to storage.sync');
  check(saved?.labelling === true, 'the labelling mode switch saves to storage.sync');
  check((await options.getByText('SaaS billing and rogue malware').count()) > 0, 'About states what is out of scope');
  check((await options.getByText('Nothing is sent anywhere').count()) > 0, 'About states the privacy promise');
  await setSettings({});
  await options.close();

  // ---------- 8. 127.0.0.1 and a clean URL ----------
  const ipPage = await context.newPage();
  const ipLines = recordConsole(ipPage);
  await ipPage.goto(`http://127.0.0.1:${port}/product`, { waitUntil: 'load' });
  check(
    await waitFor(() => ipLines.some((l) => l.includes('content script ready (build')), 5000),
    `content script injects on http://127.0.0.1:${port}/product`,
  );
  await ipPage.close();

  // ---------- 9. Cross-page state lives in the background; pixel refinement on the active tab ----------
  const contentJs = readFileSync(join(EXT, 'content-scripts', 'content.js'), 'utf8');
  check(
    !/storage\.(?:session|local)\b/.test(contentJs),
    'the content script never touches storage.session or storage.local (state goes through the background)',
  );
  // Listing first, then the product page in a fresh tab: bait and switch needs the listing price, which only the
  // background can hand over.
  const shopTab = await context.newPage();
  await shopTab.bringToFront();
  await shopTab.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
  await reportWhen(`http://localhost:${port}/index.html`, (r) => r.findings.length > 0, 15000);
  const productTab = await context.newPage();
  await productTab.bringToFront();
  await productTab.goto(productUrl, { waitUntil: 'load' });
  const crossPage = await reportWhen(productUrl, (r) => r.findings.some((f) => f.category === 7), 15000);
  check(!!crossPage, 'a listing price seen in one tab reaches the product page in another (bait and switch fires)');
  const siteKeys = await popup.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('site:')));
  check(siteKeys.includes(`site:http://localhost:${port}`), 'the background keeps one session memory entry per site');
  await shopTab.close();
  await productTab.close();

  // A clean page (no pop-ups covering it), in the active tab, with debug logging to read the pixel count.
  // Captures are throttled to one per 2 s across all tabs (headless gives every tab its own window, so each
  // counts as active): park the busy dark-shop tab and let the throttle window pass first.
  await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, 2500));
  await setSettings({ debug: true });
  const cleanTab = await context.newPage();
  const cleanLines = recordConsole(cleanTab);
  await cleanTab.bringToFront();
  await cleanTab.goto(`http://localhost:${port}/clean/product.html`, { waitUntil: 'load' });
  const pixelRe = /f03\/f04 from pixels for (\d+) of (\d+) candidates/;
  await waitFor(() => cleanLines.some((l) => pixelRe.test(l)), 15000);
  const pixelLine = cleanLines.find((l) => pixelRe.test(l)) ?? '';
  console.log(`      ${pixelLine || 'no pixel log line'}`);
  check(Number(pixelRe.exec(pixelLine)?.[1] ?? 0) > 0, 'an auto-scan on the active tab refines f03/f04 from a tab capture');
  await setSettings({});
  await cleanTab.close();

  // ---------- 10. Browser error page: no content script, popup explains ----------
  const deadUrl = `http://localhost:${await closedPort()}/product.html`;
  await page.goto(deadUrl).catch(() => {}); // ERR_CONNECTION_REFUSED → the browser's own error page
  await page.bringToFront();
  await popup.getByRole('button', { name: 'Rescan' }).click();
  await status.filter({ hasNotText: 'Scanning' }).waitFor({ timeout: 10000 });
  const errText = (await status.textContent()) ?? '';
  console.log(`      popup status on ${deadUrl}: "${errText}"`);
  check(
    errText.includes('No DarkLens content script') && errText.includes('browser error page'),
    'popup explains a browser error page has no content script',
  );
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
