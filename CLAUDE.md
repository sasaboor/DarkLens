# DarkLens: dark pattern detector for Indian e-commerce

## Purpose
DarkLens is a Chrome extension (Manifest V3) that finds dark patterns on e-commerce pages, classifies each one into the categories of India's CCPA Guidelines for Prevention and Regulation of Dark Patterns (notified 30 Nov 2023), highlights it on the page with a plain-English reason, and gives the page a 0 to 100 risk score. It is a B.Tech minor project, so the research claims below must stay true in the code. It will also be published on the Chrome Web Store.

## Hard rules
- All analysis runs locally in the browser. No backend, no remote API, no analytics, no telemetry. All model files are bundled. No network requests at runtime.
- Never read or store values typed into inputs (text, email, password, card, address, phone). Read only labels, button text, checked states and styles.
- Skip iframes entirely.
- The test shop marks ground truth with data-dp-* attributes. Detection code must NEVER read data-dp-* attributes. Only tools/evaluate may.
- Keep dependencies minimal. TypeScript strict mode. Pure logic lives in src/core with no chrome.* calls so it can be unit tested and reused by Playwright.
- User-facing reason strings are short and plain, e.g. "Checked by default, adds Rs 499 to your order".

## Categories (label ids, fixed order)
0 benign, 1 false_urgency, 2 basket_sneaking, 3 confirm_shaming, 4 forced_action, 5 subscription_trap, 6 interface_interference, 7 bait_and_switch, 8 drip_pricing, 9 disguised_ads, 10 nagging, 11 trick_wording.
Out of scope (say so in the About page): SaaS billing, rogue malware.

## Research design (the report claims this; the code must support it)
- Text branch: frozen all-MiniLM-L6-v2 sentence embedding (mean pooling, L2-normalised, 384 numbers), run in the browser with Transformers.js. A fine-tuned MiniLM may replace it later with no other code change.
- Visual-structural branch: 12 features per element (below), from the DOM, computed styles and screenshot pixels.
- Fusion: concat(embedding 384, standardised features 12) = 396 inputs, then a small MLP head (Linear, BatchNorm, ReLU, Dropout, Linear, softmax) trained in Colab and exported as JSON weights.
- Rule engine: deterministic rules over the same features. Always runs. Produces the human-readable reason. Used alone when no model file exists.
- Ablation: the head may be trained with or without the 12 features; the extension must work with either (head.json says which).
- Explanations: in the extension, word occlusion (drop each word, re-run, report the words that moved the score most) plus the top structural features. LIME runs offline in Colab only.

## The 12 features (fixed order; the model depends on it)
For an element E. "Counterpart" = the competing control in the same choice (accept vs decline), if one exists.
- f01 font_ratio: E font size / counterpart font size. 1 if no counterpart.
- f02 area_ratio: E rendered area / counterpart area (getBoundingClientRect). 1 if no counterpart.
- f03 contrast: WCAG contrast ratio of E's text colour against its effective background (walk up ancestors to the first non-transparent background). Refined from screenshot pixels when available.
- f04 salience: 0 to 1, how much E's background stands out from the page background (saturation and colour distance). Refined from pixels when available.
- f05 default_checked: 1 if a checkbox, radio or switch is checked at page load before any user interaction (defaultChecked, checked, aria-checked="true"). Else 0.
- f06 faded: 0 to 1. 1 if font size < 11px, or effective opacity (product over ancestors) < 0.6, or contrast < 3. Partial values allowed.
- f07 countdown: 1 if E's text contains a time pattern whose digits decrease between two reads 2 seconds apart. Else 0.
- f08 overlay_coverage: 0 to 1. For fixed or sticky elements, visible area / viewport area. 0 otherwise.
- f09 unclosable_modal: 1 if E is or is inside a dialog or overlay covering > 50% of the viewport with no visible close control (an x, "close", aria-label close), or whose close control is tiny (< 16px) or faded. Else 0.
- f10 decline_as_link: 1 if E is the decline side of a choice and is styled as plain text or a link while the accept side is a filled button. Else 0.
- f11 cta_distance: distance from E's centre to the most prominent call-to-action on the page, divided by the viewport diagonal, clamped 0 to 1.
- f12 price_delta: (checkout total - remembered product price) / remembered product price, on cart and checkout pages only. 0 when unknown.
Pixel refinement: the background worker captures the visible tab (chrome.tabs.captureVisibleTab), crops each candidate's box (scaled by devicePixelRatio), and recomputes f03 and f04 from the actual pixels (dominant background colour vs text colour). If capture fails, the CSS values stay. Record which source was used.

## Candidate elements
Collect: button, a, [role=button], input[type=checkbox|radio|submit|button], [role=switch], [role=checkbox], select, dialog, [role=dialog], [aria-modal=true], fixed or sticky elements, and short text blocks (<= 300 chars) matching: prices (Rs, Rs. or the rupee sign followed by digits), timers (\d{1,2}:\d{2}(:\d{2})?), stock ("only N left", "N left in stock", "selling fast"), fees ("convenience fee", "platform fee", "handling fee", "delivery fee", "packaging fee"), sponsored or ad labels, subscription words ("auto-renew", "renews", "subscription", "membership").
Skip invisible elements (display none, visibility hidden, zero size, fully off-screen, opacity 0). Walk open shadow roots. Cap at 300 candidates per page, prioritising interactive elements and those in dialogs, forms and checkout areas.
Pairing: within the same dialog or form, or a nearest common ancestor with the two under 400px apart, pair an accept-like control (accept, continue, yes, add, buy, subscribe, allow, ok, get, claim, upgrade) with a decline-like one (no, no thanks, skip, later, decline, cancel, not now, maybe later, I don't want, continue with standard/basic/free, continue without).

## Types (src/core/types.ts)
type PageType = 'product' | 'cart' | 'checkout' | 'listing' | 'other'
interface Candidate { id: string; text: string; tag: string; role: string | null; kind: 'control' | 'checkbox' | 'dialog' | 'banner' | 'price' | 'timer' | 'stock' | 'fee' | 'ad_label' | 'subscription' | 'text'; rect: {x: number; y: number; w: number; h: number}; counterpartId: string | null; features: number[] /* length 12 */; featureSource: {f03: 'css' | 'pixels'; f04: 'css' | 'pixels'}; context: {pageType: PageType; inDialog: boolean; nearbyPrice: string | null} }
interface Finding { candidateId: string; category: number; confidence: number; source: 'rule' | 'model' | 'both'; reason: string; evidence: string[]; confirmed?: boolean; hard?: boolean /* fired on hard evidence */ }

## Rules (starting thresholds; tune only on the test shop and practice sites, never on the held-out evaluation sites)
- interface_interference: the decline side has accept/decline area_ratio > 2.5, or font_ratio > 1.5, or decline contrast < 3 while accept >= 4.5, or decline_as_link = 1.
- basket_sneaking: default_checked = 1 and the label mentions a rupee amount or protection, insurance, warranty, donate, tip, add, priority, gift wrap. Also: the cart count rises with no add-to-cart click by the user.
- false_urgency: countdown = 1, or a stock or high-demand message. confirmed = true when the timer's computed end time moves later after a reload (stored per URL), or the stock number is unchanged across visits on different days.
- drip_pricing: price_delta > 0.02 and at least one fee line not shown on the product page.
- forced_action: a dialog with overlay_coverage > 0.6, unclosable_modal = 1, and login, sign-up, phone, email or app-download wording.
- nagging: 3 or more distinct dialogs or overlays on the same site in one browser session. Cookie consent banners do not count.
- subscription_trap: an auto-renew or subscription option with default_checked = 1, or renewal terms with faded = 1 near a subscribe or buy button.
- disguised_ads: a sponsored or ad label with font < 10px or contrast < 3, inside a product grid or among reviews.
- bait_and_switch: the offer or price on a listing card differs from the product page (stored per product in the session).
- confirm_shaming and trick_wording: mainly the text model. The rule engine keeps a small phrase list as a fallback.
- One finding per element: when several rules fire on the same element, hard evidence wins, then the higher confidence; the others are noted in the evidence. All thresholds live in RULES_CONFIG (src/core/rules.ts).
- Combining: if a rule fires with hard evidence (default_checked, price_delta, a confirmed timer reset, an unclosable modal), use the rule's category even if the model disagrees; source = 'both' when they agree. Otherwise use the model's category when confidence >= 0.6.

## Risk score
0 to 100: weighted sum over distinct findings (hard-evidence findings weigh more), capped at 100. Weights documented in src/core/score.ts.

## Cross-page state
chrome.storage.session for the current session (product prices seen, listing offers, dialog counts, cart counts). chrome.storage.local for timer end times and stock counts per URL with timestamps (keep 7 days, max 500 entries). Page type from URL patterns and DOM cues (add-to-cart button = product; order summary or proceed-to-checkout = cart; address or payment step = checkout).

## Model files (public/models/)
- MiniLM: Xenova/all-MiniLM-L6-v2 quantized ONNX + tokenizer files, bundled. Transformers.js with allowRemoteModels = false and a local model path; onnxruntime wasm files bundled locally. The extension CSP allows 'wasm-unsafe-eval'.
- head.json: {version, labels[12], use_structural, feature_mean[12], feature_std[12], layers: [{type:'linear', W:[out][in], b:[out]}, {type:'batchnorm', mean, var, gamma, beta, eps}, {type:'relu'}, {type:'linear', ...}]}. Input = embedding (384), then standardised features (12) when use_structural.
- parity.json: 20 samples {text, features, embedding, probs} exported from Colab. A unit test checks the JS head reproduces probs within 1e-3 from the stored embedding; an integration check confirms the browser embedding + head lands within 2e-2.
- No head.json: rules only, and the popup shows "Rules only".
- Inference runs in an offscreen document so pages never stutter. Batch candidates; cache embeddings by text hash.

## Stack
WXT + React + TypeScript (strict), Vitest; Playwright (Node + TypeScript) for batch collection and evaluation; a Colab notebook (PyTorch, sentence-transformers, scikit-learn, LIME) for training.

## Folder layout
- src/core/ : pure TS, no chrome.* calls: types, categories, extractor, features, pixels, rules, score, head (MLP forward pass), explain
- entrypoints/ : content, background, offscreen, popup, sidepanel, options (WXT conventions)
- public/models/ : model files
- test-shop/ : static demo store with ground truth
- tools/ : build-extractor (bundles src/core into one IIFE file, window.DarkLens, for Playwright), evaluate, collect, label.html (keyboard labelling tool)
- notebooks/ : darklens_training.ipynb
- docs/ : report notes, privacy policy, store listing

## UI
- Highlights: an outline colour per category, drawn in a Shadow DOM overlay that follows the element on scroll and resize; a small badge; a hover tooltip with category, reason, confidence and a "Not a dark pattern?" button (stored locally only).
- Popup: risk score dial, counts per category, Rescan, highlights toggle, Open details (side panel), model status ("Model + rules" or "Rules only").
- Side panel: one card per finding: category, CCPA description, reason, evidence, confidence, source, element text; clicking scrolls to the element and flashes it.
- Options: enable or disable categories, sensitivity (confidence threshold), auto-scan or manual, clear stored data, labelling mode toggle, About (scope and privacy).


## Progress reporting (after every task)
When you finish any task, update PROGRESS.md and end your reply with these four headings, in plain words:
1. Done: what you built or changed in this task (features and main files).
2. What it does now: what DarkLens can do at this point from a user's view, and how to try it.
3. Checks: results of npm test, npm run build and npm run evaluate (when it exists), with numbers.
4. Left: what remains of Prompts 0 to 11, plus known issues and any shortcuts you took.
PROGRESS.md has a "Current state" summary at the top (what works, what doesn't, next prompt), then one section per prompt with the date, what was done, test results and known issues. Keep it accurate; never claim something works unless you ran it.

Then create PROGRESS.md now. Read the code and git log to work out which prompts are already done, run npm test and npm run build, and fill it in honestly. Finish with the four-heading report.

## Commands
npm run dev, npm run build, npm test, npm run build:extractor, npm run evaluate, npm run walk (test shop walk-through with findings per page), npm run e2e:debug (built extension end to end)
