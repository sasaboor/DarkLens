/**
 * Shared by the Playwright tools: inject the window.DarkLens bundle and take
 * the at-load snapshots (checked states for f05, the cart badge for basket
 * sneaking) before anything on the page changes, like the content script does.
 */
import type { BrowserContext, Page } from 'playwright';

declare global {
  interface Window {
    DarkLens: typeof import('../../src/core/index.ts');
    /** At-load snapshots, read back by scanInPage. */
    __dl: { initial: WeakMap<Element, boolean>; cart: number | null };
    /** Viewport screenshot as a PNG data URL, from exposeCapture (for pixel refinement of f03/f04). */
    __dlCapture?: () => Promise<string>;
  }
}

/**
 * Lets pages in this context screenshot their own viewport (Playwright's
 * page.screenshot) for DarkLens.scan's `capture` option, the tools' stand-in
 * for chrome.tabs.captureVisibleTab. Call once per context.
 */
export async function exposeCapture(context: BrowserContext): Promise<void> {
  await context.exposeBinding('__dlCapture', async ({ page }) => `data:image/png;base64,${(await page.screenshot()).toString('base64')}`);
}

export async function injectDarkLens(page: Page, bundle: string): Promise<void> {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const DL = window.DarkLens;
    window.__dl = { initial: DL.snapshotCheckedStates(document), cart: DL.readCartCount(document)?.count ?? null };
  });
}
