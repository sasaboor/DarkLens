# DarkLens evaluation on the test shop

Generated 2026-11-07T14:45:05.936Z by `npm run evaluate` (rules only). Full data: `results/eval-2026-11-07T14-45-05-936Z.json`.

```
Macro F1 (11 dark-pattern categories): 1.000   macro precision 1.000   macro recall 1.000
Scored 127 labelled elements on 7 pages (34 dark, 93 benign); 0 misses, 0 false positives, 1 findings on unlabelled elements, 2 labelled elements not shown.
Weakest: nagging (F1 1.000, TP conf 0.700, n=4), false_urgency (F1 1.000, TP conf 0.714, n=7), trick_wording (F1 1.000, TP conf 0.750, n=2)
```

## Protocol

- Session A (dark shop): index.html → product.html → product.html (again, ~8 s later) → cart.html → checkout.html → index.html (return visit)
- Session B (clean shop): clean/product.html → clean/cart.html → clean/checkout.html
- Each page: load, settle 2.5 s, then scan (includes the 2 s countdown double-read). Forced modals left up. Scored on the last visit of each page.
- A finding counts for the labelled element `closest('[data-dp-id]')` of its candidate. One prediction per labelled element: the ground-truth category if it fired, else the strongest finding, else benign.

## Visits

| session | visit | page type | risk | candidates | findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| A (dark shop) | index.html | listing | 36 | 73 | 5 |
| A (dark shop) | product.html | product | 99 | 39 | 9 |
| A (dark shop) | product.html (again, ~8 s later) | product | 100 | 39 | 9 |
| A (dark shop) | cart.html | cart | 99 | 45 | 11 |
| A (dark shop) | checkout.html | checkout | 100 | 39 | 9 |
| A (dark shop) | index.html (return visit) | listing | 49 | 73 | 6 |
| B (clean shop) | clean/product.html | product | 0 | 38 | 0 |
| B (clean shop) | clean/cart.html | cart | 0 | 30 | 0 |
| B (clean shop) | clean/checkout.html | checkout | 0 | 26 | 0 |

## Per category

| category | support | TP | FP | FN | precision | recall | F1 | TP conf |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 benign | 93 | 93 | 0 | 0 | 1.000 | 1.000 | 1.000 | - |
| 1 false_urgency | 7 | 7 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.714 |
| 2 basket_sneaking | 3 | 3 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.833 |
| 3 confirm_shaming | 3 | 3 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.850 |
| 4 forced_action | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.900 |
| 5 subscription_trap | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.850 |
| 6 interface_interference | 4 | 4 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.800 |
| 7 bait_and_switch | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.800 |
| 8 drip_pricing | 3 | 3 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.850 |
| 9 disguised_ads | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.800 |
| 10 nagging | 4 | 4 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.700 |
| 11 trick_wording | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.750 |

Macro F1 is over the 11 dark-pattern categories (benign excluded). TP conf = mean confidence of the true-positive findings (how far above the threshold the hits are).

## Confusion matrix

Rows: ground truth. Columns: predicted. Codes: BEN = benign, FU = false_urgency, BS = basket_sneaking, CS = confirm_shaming, FA = forced_action, ST = subscription_trap, II = interface_interference, BAS = bait_and_switch, DP = drip_pricing, DA = disguised_ads, NAG = nagging, TW = trick_wording.

| gt \ pred | BEN | FU | BS | CS | FA | ST | II | BAS | DP | DA | NAG | TW |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BEN benign | 93 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| FU false_urgency | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| BS basket_sneaking | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| CS confirm_shaming | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| FA forced_action | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| ST subscription_trap | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| II interface_interference | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| BAS bait_and_switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| DP drip_pricing | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 |
| DA disguised_ads | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| NAG nagging | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 |
| TW trick_wording | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |

## Misses (0)

None.

## False positives (0)

None.

## Findings on unlabelled elements (not scored, 1)

| page | predicted | text | reason | note |
| --- | ---: | ---: | ---: | ---: |
| cart.html | basket_sneaking | Cart 3 | Cart count went from 2 to 3 without you adding anything |  |

## Not shown at scan time (not scored, 2)

- clean/product.html#cprod-bn-19 (benign): User-opened pincode dialog with a visible close button
- clean/product.html#cprod-bn-20 (benign): Check
