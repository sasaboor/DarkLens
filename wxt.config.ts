import { defineConfig } from 'wxt';

/** Local build time, e.g. "2026-11-07 18:40:12". Shown by the popup and the content script so a stale build is obvious. */
function buildStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Computed once: WXT runs a separate Vite build for the content script, and every part must carry the same stamp. */
const BUILD_STAMP = buildStamp();

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Keep `npm run dev` off port 3000 so `npx serve test-shop` gets it. strictPort: fail loudly
  // instead of quietly moving to another port (and baking that port into the dev build).
  dev: { server: { port: 3100, strictPort: true } },
  vite: () => ({
    define: { __DARKLENS_BUILD__: JSON.stringify(BUILD_STAMP) },
  }),
  manifest: {
    name: 'DarkLens',
    description: 'Finds dark patterns on Indian e-commerce pages, locally in your browser.',
    // chrome.tabs.captureVisibleTab (pixel refinement of f03/f04) needs <all_urls> or an activeTab grant; host
    // patterns for http/https are not enough, and activeTab only follows a click, so auto-scans need <all_urls>.
    // Same install warning as the content script's http/https matches. The screenshot is measured in memory and
    // never stored or sent.
    permissions: ['offscreen', 'sidePanel', 'storage', 'activeTab'],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      // 'wasm-unsafe-eval' lets the bundled onnxruntime wasm run. No remote sources.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
