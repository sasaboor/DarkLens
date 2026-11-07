import { FOCUS, RESCAN, type FocusMessage, type FocusReply, type RescanReply } from '@/src/messages';
import { loadSettings, onSettingsChanged } from '@/src/settings';
import { Overlay } from './overlay';
import { createScanner } from './scanner';
import { watchPage } from './watch';

const BUILD = __DARKLENS_BUILD__;
/** Quiet time after a DOM change or SPA navigation before rescanning. */
const RESCAN_DEBOUNCE_MS = 800;
/** The cart badge is re-read at most this often while the page changes. */
const CART_CHECK_MS = 250;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // Top frame only: DarkLens skips iframes entirely.
  allFrames: false,
  async main() {
    // Created first, so the checked-state and cart snapshots happen before the user can interact.
    const overlay: Overlay = new Overlay((entry) => void scanner.dismiss(entry));
    const scanner = createScanner(overlay, BUILD);

    const settings = await loadSettings();
    overlay.setVisible(settings.highlights);

    // Automatic rescans run when auto-scan is on, or after the user pressed Rescan on this page.
    let active = settings.autoScan;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!active) return;
      clearTimeout(timer);
      timer = setTimeout(() => void scanner.scan('change'), RESCAN_DEBOUNCE_MS);
    };

    // Settings apply live: highlights, categories and the threshold republish the last scan;
    // turning auto-scan on scans a page that has not been scanned yet.
    onSettingsChanged((s) => {
      scanner.refresh(s);
      if (s.autoScan && !active) {
        active = true;
        if (!scanner.scanned) void scanner.scan('load');
      }
    });

    document.addEventListener('click', (e) => scanner.noteClick(e.target), { capture: true, passive: true });

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: RescanReply | FocusReply) => void) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === FOCUS) {
        sendResponse({ ok: scanner.focus((message as FocusMessage).candidateId) });
        return;
      }
      if (type !== RESCAN) return;
      active = true;
      clearTimeout(timer);
      scanner.scan('rescan').then(sendResponse);
      return true; // keeps the channel open for the async reply
    });

    // Basket sneaking watch: a cart badge rise with no add-to-cart click in the previous 2 s.
    let cartCheck: ReturnType<typeof setTimeout> | undefined;
    const checkCart = () => {
      cartCheck ??= setTimeout(() => {
        cartCheck = undefined;
        if (scanner.checkCart()) schedule();
      }, CART_CHECK_MS);
    };

    watchPage({
      isOwn: (node) => overlay.isOwn(node),
      onChange: schedule,
      onMutations: checkCart,
      onUrlChange: () => {
        scanner.newPage();
        schedule();
      },
    });

    console.log(`[DarkLens] content script ready (build ${BUILD}), auto-scan: ${active ? 'on' : 'off'}`);
    if (active) {
      const start = () => requestIdleCallback(() => void scanner.scan('load'), { timeout: 2000 });
      if (document.readyState === 'complete') start();
      else window.addEventListener('load', start, { once: true });
    }
  },
});
