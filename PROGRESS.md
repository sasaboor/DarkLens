# DarkLens progress

## Current state (2026-11-07)

**Works (verified by running it):**
- Rules-only detector for all 11 dark-pattern categories, running in the built Chrome extension (auto-scan, highlights, popup, side panel, options).
- Cross-page and repeat-visit detection, with all state owned by the background worker: drip pricing, bait and switch (price and offer text), timer reset, static stock counter, nagging, and a cart-count watch.
- Pixel refinement of f03 (contrast) and f04 (salience) from a tab capture. In the extension: captureVisibleTab, then the offscreen document. In the tools: Playwright screenshots. Both use the same `src/core/pixels.ts`.
- Test shop evaluation: **macro F1 1.000** with pixels on, and 1.000 CSS-only (127 labelled elements, 0 misses, 0 false positives).
- `npm test`: 219 passing. `npm run compile`: clean. `npm run build`: OK. `npm run e2e:debug`: all checks pass.

**Not built yet:** the text branch (MiniLM embeddings via Transformers.js), the MLP head (`src/core/head.ts`, `head.json`, `parity.json`), the model plus rules combination, word-occlusion explanations, the Colab notebook, `tools/label.html`, the privacy policy and store listing in `docs/`. The popup correctly shows "Rules only".

**Next:** the model side, meaning the head forward pass with the parity test, then MiniLM in the offscreen document.

Note on numbering: the Prompt 0 to 11 list isn't recorded in the repo, so the sections below are by feature area, not by prompt number.

---

## Done before this file existed (reconstructed from the code and git on 2026-11-07)
Git has one commit ("Scaffold DarkLens extension"); everything else is uncommitted work in the tree.
- **Scaffold:** WXT + React + TypeScript strict + Vitest. Entrypoints: content, background, offscreen, popup, side panel, options.
- **Extraction:** `src/core/extractor.ts`, `visibility.ts`, `layout.ts`, `text.ts`, `pageType.ts`. Candidates follow the spec's list, with open shadow roots walked, no iframes, a cap of 300, accept/decline pairing, and no input values read.
- **Features:** all 12, in `src/core/features.ts` and `color.ts`, plus per-candidate facts in `facts.ts`.
- **Rules and scoring:** `src/core/rules.ts` (RULES_CONFIG) and `score.ts`, plus user settings (`prefs.ts`, `src/settings.ts`).
- **UI:** a Shadow DOM overlay with tooltips and "Not a dark pattern?", the popup (dial, counts, Rescan, mode), the side panel (cards, click to scroll), and options.
- **Tools:** test shop with ground truth, `build-extractor`, `evaluate`, `walk-shop`, `collect`, `screenshots`, `e2e-extension`.

## Cross-page state, repeat visits and pixel refinement (2026-11-07)
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
- **Timer reset and stock:** the existing logic now persists through the background. There are tests through the store for a reset (confirmed and hard), a running countdown (not confirmed), and the same stock on a later day (confirmed) vs the same day (not).
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
  - `collect` uses pixels (and now hides text-field values before that first screenshot).
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

**Known issues and shortcuts**
- On the dark test-shop pages, pop-ups and forced modals cover most of the page, so pixels measure only 1 to 4 candidates per dark page. Most pixel values come from the clean pages. The F1 tie therefore says little about pixels; the agreement check is the better evidence.
- Elements under a pop-up keep CSS values, chosen by an `elementFromPoint` check at the box centre. Without that check, dimmed backdrops pushed contrast from about 8 down to about 2.
- f06 (faded) still uses the CSS contrast. The spec says pixels recompute only f03 and f04.
- Capture runs before the rules on each scan. A second scan within 2 s (any tab) is throttled and reuses the cached per-element values.
- The live 2 s cart watch runs only in the extension. `evaluate` uses the cross-page baseline check.
- Offer comparison is listing to product page only (carts rarely repeat the badge). "Free delivery" isn't treated as an offer, to avoid false positives.
- `<all_urls>` is needed for auto-scan captures. It's worth a sentence in the store listing's permission justification.
