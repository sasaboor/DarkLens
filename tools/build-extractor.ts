/**
 * Bundles src/core into one IIFE file that sets window.DarkLens, so Playwright
 * tools can inject the exact detection code the extension runs.
 *
 * Entry point for tools: window.DarkLens.scan(document, state) → {candidates,
 * findings, elementsById, …} (src/core/batch.ts).
 *
 * Run with: npm run build:extractor   → dist-tools/darklens-core.js
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE = join(ROOT, 'dist-tools', 'darklens-core.js');

export async function buildExtractor(): Promise<string> {
  await build({
    entryPoints: [join(ROOT, 'src', 'core', 'index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'DarkLens',
    target: 'chrome120',
    outfile: BUNDLE,
    logLevel: 'warning',
  });
  return BUNDLE;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Wrote ${await buildExtractor()}`);
}
