/**
 * Pixel vs CSS agreement for f03 (contrast) on the test shop, at
 * devicePixelRatio 1 and 2: how many candidates pixels could measure (on
 * screen, not covered by a pop-up), the mean |log(pixel / CSS)| contrast
 * ratio, and the candidates that differ by more than 1.5x. A sanity check
 * for src/core/pixels.ts for the report; it never reads data-dp-*.
 *
 * Run with: npm run pixels:check
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { buildExtractor } from './build-extractor.ts';
import { exposeCapture, injectDarkLens } from './lib/inject.ts';
import { serveShop } from './serve-shop.ts';
const bundle = readFileSync(await buildExtractor(), 'utf8');
const { server, port } = await serveShop(0);
const browser = await chromium.launch();
for (const dpr of [1, 2]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
  await exposeCapture(ctx);
  const page = await ctx.newPage();
  let n = 0, sum = 0, big = 0; const rows: string[] = [];
  for (const p of ['index.html', 'product.html', 'cart.html', 'checkout.html', 'clean/product.html', 'clean/cart.html', 'clean/checkout.html']) {
    await page.goto(`http://localhost:${port}/${p}`);
    await injectDarkLens(page, bundle);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(async () => {
      const DL = window.DarkLens;
      const s = await DL.scan(document, { initialChecked: window.__dl.initial, waitMs: 10 });
      const refined = await DL.refineWithCapture(s.candidates, s.elementsById, window, window.__dlCapture!);
      return { c: s.candidates.map((c, i) => ({ text: c.text.slice(0, 30), kind: c.kind, css: c.features[2]!, px: refined[i]!.features[2]!, src: refined[i]!.featureSource.f03 })) };
    });
    for (const c of r.c) if (c.src === 'pixels') {
      n++; const d = Math.abs(Math.log(c.px / c.css)); sum += d;
      if (d > Math.log(1.5)) { big++; rows.push(`${p}  ${c.kind.padEnd(8)} css ${c.css.toFixed(2).padStart(5)} px ${c.px.toFixed(2).padStart(5)}  ${c.text}`); }
    }
  }
  console.log(`dpr ${dpr}: ${n} pixel-measured; mean |log ratio| ${(sum / n).toFixed(3)}; ${big} differ by >1.5x`);
  console.log(rows.join('\n'));
  await ctx.close();
}
await browser.close(); server.close();
