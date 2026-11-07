const OFFSCREEN_PATH = '/offscreen.html';

// The offscreen document will host model inference so pages never stutter.
async function ensureOffscreen(): Promise<void> {
  const existing = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;
  await browser.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [browser.offscreen.Reason.WORKERS],
    justification: 'Run the local ML model off the page thread',
  });
}

export default defineBackground(() => {
  console.log('[DarkLens] background service worker loaded');
  ensureOffscreen().catch((err) => console.error('[DarkLens] offscreen setup failed', err));
});
