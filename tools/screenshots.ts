/**
 * Screenshots of the popup, side panel and options page, in light and dark
 * mode, taken from the real built extension on the test shop. The extension
 * pages open as ordinary tabs pinned to the shop tab with ?tabId=N. Also
 * captures the shop page right after a side panel card was clicked, to show
 * the scroll-and-flash. Run after `npm run build`.
 *
 * Run with: npm run screenshots   (writes docs/screenshots/*.png)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { serveShop } from './serve-shop.ts';

declare const chrome: typeof import('wxt/browser').browser;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'docs', 'screenshots');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('No build at .output/chrome-mv3. Run npm run build first.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const SCHEMES = ['light', 'dark'] as const;

const { server, port } = await serveShop(0);
const profile = mkdtempSync(join(tmpdir(), 'darklens-shots-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

/** Switches the colour scheme and lets the 0.15 s colour transitions finish before a capture. */
async function scheme(page: Page, colorScheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string, target?: string): Promise<void> {
  const file = join(OUT, `${name}.png`);
  if (target) await page.locator(target).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${file.slice(ROOT.length + 1)}`);
}

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = (path: string) => `chrome-extension://${extId}/${path}`;
  const helper = await context.newPage();
  await helper.goto(ext('popup.html'));

  /** The shop tab's id, found through the report the background stored for it. */
  async function tabFor(url: string): Promise<number | null> {
    for (let i = 0; i < 60; i++) {
      const id = await helper.evaluate(async (u) => {
        const all = await chrome.storage.session.get(null);
        const hit = Object.entries(all).find(([k, v]) => k.startsWith('tab:') && (v as { url: string }).url === u);
        return hit ? Number(hit[0].slice(4)) : null;
      }, url);
      if (id !== null) return id;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  const shop = await context.newPage();
  // Walk the shop in order so cross-page memory (prices seen, fees) builds up as for a shopper.
  for (const name of ['index', 'product', 'cart', 'checkout']) {
    const url = `http://localhost:${port}/${name}.html`;
    await shop.goto(url, { waitUntil: 'load' });
    const tabId = await tabFor(url);
    if (tabId === null) throw new Error(`no report for ${url}`);
    await shop.waitForTimeout(600);
    if (name === 'index') continue;
    console.log(`${name}.html (tab ${tabId})`);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(ext(`popup.html?tabId=${tabId}`));
    await popup.locator('.summary').waitFor();
    for (const s of SCHEMES) {
      if (name !== 'product' && s === 'dark') continue;
      await scheme(popup, s);
      await shot(popup, `popup-${name}-${s}`, 'main.popup');
    }
    await popup.close();

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.goto(ext(`sidepanel.html?tabId=${tabId}`));
    await panel.getByTestId('finding-card').first().waitFor();
    for (const s of SCHEMES) {
      if (name !== 'product' && s === 'dark') continue;
      await scheme(panel, s);
      await shot(panel, `sidepanel-${name}-${s}`);
    }

    if (name === 'product') {
      // Dismiss the forced pop-up for this session (the test shop's own flag) and rescan, then
      // scroll to the bottom, click the bait-and-switch card and capture the flash at the price.
      const before = await helper.evaluate(async (k) => (await chrome.storage.session.get(k))[k] as { scannedAt: number }, `tab:${tabId}`);
      await shop.evaluate(() => sessionStorage.setItem('dm_forced_phone-price', '1'));
      await shop.reload({ waitUntil: 'load' });
      for (let i = 0; i < 40; i++) {
        const now = await helper.evaluate(async (k) => (await chrome.storage.session.get(k))[k] as { scannedAt: number } | undefined, `tab:${tabId}`);
        if (now && now.scannedAt !== before.scannedAt) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await shop.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await shop.waitForTimeout(300);
      const card = panel.locator('[data-category="bait_and_switch"]').first();
      await card.waitFor();
      await card.click();
      await shop.waitForTimeout(900);
      await shop.screenshot({ path: join(OUT, 'page-product-flash.png') });
      console.log('  docs/screenshots/page-product-flash.png');
    }
    await panel.close();
  }

  const options = await context.newPage();
  await options.setViewportSize({ width: 1000, height: 900 });
  await options.goto(ext('options.html'));
  await options.locator('main.options').waitFor();
  for (const s of SCHEMES) {
    await scheme(options, s);
    await shot(options, `options-${s}`);
  }
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
