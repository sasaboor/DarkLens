import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DarkLens',
    description: 'Finds dark patterns on Indian e-commerce pages, locally in your browser.',
    permissions: ['offscreen', 'sidePanel'],
    content_security_policy: {
      // 'wasm-unsafe-eval' lets the bundled onnxruntime wasm run. No remote sources.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
