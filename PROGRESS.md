# DarkLens progress

## Current state (2026-11-07)

**Done: P0 to P6.** Next: **P7 labelling tool.** Left: P7 to P11.

**Works (verified by running it):**
- Rules-only detector for all 11 dark-pattern categories, running in the built Chrome extension (auto-scan, highlights, popup, side panel, options).
- Cross-page and repeat-visit detection, with all state owned by the background worker: drip pricing, bait and switch (price and offer text), timer reset, static stock counter, nagging, and a cart-count watch.
- Pixel refinement of f03 (contrast) and f04 (salience) from a tab capture. In the extension: captureVisibleTab, then the offscreen document. In the tools: Playwright screenshots. Both use the same `src/core/pixels.ts`.
- Test shop evaluation: **macro F1 1.000** with pixels on, and 1.000 CSS-only (127 labelled elements, 0 misses, 0 false positives).
- `npm test`: 14 files, 219 passing. `npm run compile`: clean. `npm run build`: OK (353 kB). `npm run e2e:debug`: all checks pass.

**Not built yet:** the text branch (MiniLM embeddings via Transformers.js), the MLP head (`src/core/head.ts`, `head.json`, `parity.json`), the model plus rules combination, word-occlusion explanations, the Colab notebook, `tools/label.html`, the privacy policy and store listing in `docs/`. The popup correctly shows "Rules only".

---

## P0 Setup (2026-11-07), done
**Done:** WXT + React + TypeScript (strict) + Vitest scaffold. Entrypoints: content, background, offscreen, popup, side panel, options. MV3 manifest with a CSP allowing `'wasm-unsafe-eval'` and no remote sources. Commit fb732c6.
**Results:** builds and loads in Chrome.
**Known issues:** none.

## P1 Test shop (2026-11-07), done
**Done:**
- `test-shop/` is a static "Demo Mart" with dark pages (index, product, cart, checkout) and clean twins (`clean/`).
- Dark behaviour lives in `assets/dark.js`: resetting countdowns, a wandering viewer count, a newsletter popup that returns, forced modals, an auto-added cart row, and banners that come back.
- Ground truth is in `data-dp-*` attributes and `test-shop/ground-truth.json` (`npm run ground-truth`). `npm run shop` / `tools/serve-shop.ts` serves it.
**Results:** 127 labelled elements (34 dark, 93 benign) across 7 pages.
**Known issues:** the shop is small and hand-built, so test-shop scores overstate real-site accuracy. The held-out evaluation sites (P10) are the real test.

## P2 Extraction and features (2026-11-07), done
**Done:**
- Extraction: `src/core/extractor.ts`, `visibility.ts`, `layout.ts`, `text.ts`, `pageType.ts`.
  - Candidates follow the spec's list. Open shadow roots are walked, iframes skipped, and the cap is 300 with interactive and checkout elements first.
  - Accept/decline pairing.
  - Input values are never read.
- All 12 features in `features.ts` and `color.ts` (WCAG contrast, effective background, salience, faded, countdown double-read, overlay coverage, unclosable modal, decline-as-link, CTA distance, price delta).
- Per-candidate facts for the rules in `facts.ts`. A one-call pipeline in `scan.ts`. `npm run debug:features`.
**Results:** unit tests on happy-dom fixtures (extractor, features, color, facts, pageType).
**Known issues:** happy-dom has no layout, so rect-dependent logic is tested with fake rects (`testing.ts`) and in Playwright.

## P3 Rules, score and highlights (2026-11-07), done
**Done:**
- `src/core/rules.ts`: all categories, with every threshold in RULES_CONFIG, one finding per element (hard evidence first, then confidence), and short plain reasons.
- `score.ts`: the 0 to 100 risk score, with hard findings weighted higher.
- Content script (`entrypoints/content/`): scanner with single-flight rescans, page watch (dialogs, SPA navigation), and a Shadow DOM overlay that follows scroll and resize, with a badge, a tooltip and "Not a dark pattern?" (stored locally).
**Results:** rules, score and hard-rule unit tests pass. Highlights don't block page clicks (e2e).
**Known issues:** confirm_shaming and trick_wording rely on small phrase lists until the text model lands (P9).

## P4 Evaluator and collector (2026-11-07), done
**Done:**
- `tools/build-extractor.ts` bundles src/core as `window.DarkLens`. `src/core/batch.ts` provides `scan` for the tools.
- `npm run evaluate`: fixed two-session protocol, per-category P/R/F1, macro F1, confusion matrix, misses and false positives, written to `results/`.
- `npm run collect`: JSONL plus crops from real sites for labelling and training. Text-field values are hidden before screenshots.
- `npm run walk` and `npm run screenshots`.
**Results:** macro F1 1.000 on the test shop (rules only).
**Known issues:** the evaluator scores only labelled elements; findings on unlabelled elements are listed but not scored.

## P5 Popup, side panel and options (2026-11-07), done
**Done:**
- Popup: risk dial, counts per category, Rescan, highlights toggle, open details, and model status ("Rules only").
- Side panel: cards grouped by category; clicking one scrolls to the element and flashes it.
- Options: categories, sensitivity, auto-scan, clear stored data, labelling mode, and About (scope and privacy).
- Settings in storage.sync apply live (`src/core/prefs.ts`, `src/settings.ts`). `npm run e2e:debug` drives the built extension end to end.
**Results:** all e2e checks pass.
**Known issues:** the labelling-mode toggle has nothing to drive until P7.

## P6 Cross-page state and pixel refinement (2026-11-07), done
**Done**
- **The background owns the state.**
  - `src/store.ts` (`createStore`) is a queue-serialised store over chrome.storage. Session holds one entry per site. Local holds timer/stock history (7 days, 500 entries) and dismissals.
  - `src/storage.ts` binds the store for the background and options. `src/stateClient.ts` is the content script's message client.
  - New messages in `src/messages.ts`. The background takes the URL and site from the sender's tab, never from the message.
  - Content scripts no longer get storage.session access. The e2e test confirms the content bundle never references storage.session or storage.local.
- **Memory split** (`src/core/memory.ts`): `observe(scan)` produces a compact observation, then `applyObservation` folds it in. Dialogs are stored only as FNV-1a text hashes (`textHash` in `text.ts`).
- **Drip pricing:** each finding lists every fee not seen on a product page, e.g. "Platform fee Rs 49 appeared at checkout" ("in the cart" on cart pages).
- **Bait and switch:**
  - Products are keyed by `link[rel=canonical]`, else the page URL.
  - Listing cards remember their price and live offers ("50% off", "flat Rs N off", "buy N get N").
  - The product page names any missing offer in the evidence. A missing offer at an unchanged price fires a soft finding (0.65).
  - Offers marked "ended/expired/no longer/sold out" don't count as live.
- **Timer reset and stock:** persisted through the background. There are tests through the store for a reset (confirmed and hard), a running countdown (not confirmed), and the same stock on a later day (confirmed) vs the same day (not).
- **Nagging:** distinct dialog hashes per site per session; flagged at the third. Repeats with different digits count once.
- **Cart watch:** the badge is re-read on DOM changes (at most every 250 ms). It flags a rise with no add-to-cart click in the previous 2 s (`cartRiseLive`, `RULES_CONFIG.basketSneaking.addClickWindowMs`). The cross-page check (count higher than at the last page, with no add click since) is kept. Clicks counted as the user's own: add to cart/bag/basket, buy now, move to cart, a quantity "+", aria-label increase.
- **Pixels:**
  - `src/core/pixels.ts` has pure functions over RGBA arrays: crop (scaled by dpr, 2px inset), a two-cluster colour estimate (background = most common bin; text = the core 25% of pixels farthest from it), contrast, salience (shared formula, moved to `color.ts`), box selection, refinement, and a capture throttle.
  - `src/core/capture.ts` has the browser side: decoding, current boxes, and skipping covered elements.
  - In the extension: the content script hides its overlay, the background checks the tab is active and the throttle allows it (1 per 2 s), then calls `captureVisibleTab`. The offscreen document decodes, checks the image size matches the frame, and measures. Results are cached per element for the page. Any failure keeps CSS values.
  - `featureSource` records which source each value came from.
- **Tools:**
  - `batch.scan` takes a `capture` hook. `tools/lib/inject.ts` adds `exposeCapture`.
  - `evaluate` uses pixels by default; `--css-only` gives the ablation. Reports show pixel and CSS counts.
  - `collect` uses pixels (text-field values are hidden before the first screenshot).
  - New `npm run pixels:check` reports pixel vs CSS agreement.
- **Manifest:** `host_permissions: ['<all_urls>']` and `activeTab`. Chrome rejects captureVisibleTab with only http/https host patterns.
- **Fixes along the way:**
  - The build stamp is computed once. Before, the content script's separate Vite build could get a different second, and the popup then said "older build".
  - The e2e `reportFor` now picks the newest report.
- **Options About** now explains the screenshot use.

**Results**
- `npm test`: 14 files, 219 tests pass (183 before; new tests in `pixels.test.ts`, `store.test.ts`, and additions to the memory, rules and facts tests).
- `npm run evaluate` macro F1: **before 1.000 → after 1.000** with pixels. CSS-only ablation: 1.000. f03 came from pixels for 74 of 402 candidate scans. See `results/eval-before-pixels.md`, `results/eval-css-only.md`, `results/eval-latest.md`.
- `npm run pixels:check` (on-screen, uncovered elements only): mean |log(pixel/CSS contrast)| 0.048 at dpr 1 and 0.037 at dpr 2. 3 elements differ by more than 1.5x: the logo link, whose coloured badge pixels see but CSS doesn't.
- `npm run e2e:debug`: all checks pass, including:
  - no storage access from the content script;
  - a listing price from one tab reaching the product page in another;
  - an auto-scan on the active tab measuring 20 of 38 candidates from a real tab capture.

**Known issues**
- On the dark test-shop pages, pop-ups and forced modals cover most of the page, so pixels measure only 1 to 4 candidates per dark page. Most pixel values come from the clean pages. The F1 tie therefore says little about pixels; the agreement check is the better evidence.
- Elements under a pop-up keep CSS values, chosen by an `elementFromPoint` check at the box centre. Without that check, dimmed backdrops pushed contrast from about 8 down to about 2.
- f06 (faded) still uses the CSS contrast. The spec says pixels recompute only f03 and f04.
- Capture runs before the rules on each scan. A second scan within 2 s (any tab) is throttled and reuses the cached per-element values.
- The live 2 s cart watch runs only in the extension. `evaluate` uses the cross-page baseline check.
- Offer comparison is listing to product page only (carts rarely repeat the badge). "Free delivery" isn't treated as an offer, to avoid false positives.

---

## Left
- **P7 Labelling tool:** `tools/label.html`, keyboard labelling of collected JSONL and crops, wired to the Options labelling mode.
- **P8 Colab notebook:** `notebooks/darklens_training.ipynb`. Frozen MiniLM embeddings plus the 12 standardised features, an MLP head (with and without features for the ablation), LIME, and export of `head.json` and `parity.json`.
- **P9 Model in the extension:**
  - Transformers.js with bundled MiniLM (no remote models).
  - The head forward pass in `src/core/head.ts`, with the parity test (1e-3) and the browser integration check (2e-2).
  - Inference in the offscreen document with an embedding cache, the model plus rules combination, word-occlusion explanations, and "Model + rules" in the popup.
- **P10 Results, report and demo:** held-out evaluation sites, final metrics and ablations (features on/off, pixels vs CSS), report write-up, demo.
- **P11 Web Store:** privacy policy and store listing in `docs/`, screenshots, packaging (`npm run zip`). Permission justification for `<all_urls>` (needed for screenshot capture):
  > "DarkLens needs access to all sites to read the shopping pages you visit and to take a screenshot of the visible tab (chrome.tabs.captureVisibleTab). The screenshot is analysed on your device only to measure the colour contrast of buttons, labels and prices, and is never saved or sent."
