/**
 * DarkLens label set. The order is fixed: the index is the class id the model
 * head outputs, so never reorder or insert in the middle.
 *
 * Display names follow the CCPA Guidelines for Prevention and Regulation of
 * Dark Patterns (2023). Two label ids differ from the CCPA wording:
 * disguised_ads = "Disguised advertisement", trick_wording = "Trick question".
 * The CCPA's "SaaS billing" and "Rogue malware" are out of scope.
 */
export const CATEGORIES = [
  {
    id: 0,
    label: 'benign',
    name: 'Benign',
    description: 'Not a dark pattern.',
  },
  {
    id: 1,
    label: 'false_urgency',
    name: 'False urgency',
    description: 'Falsely claims or implies scarcity or urgency to rush you into buying.',
  },
  {
    id: 2,
    label: 'basket_sneaking',
    name: 'Basket sneaking',
    description: 'Adds items, services or charges to your order without your clear consent.',
  },
  {
    id: 3,
    label: 'confirm_shaming',
    name: 'Confirm shaming',
    description: 'Uses guilt, fear or shame to push you towards a choice.',
  },
  {
    id: 4,
    label: 'forced_action',
    name: 'Forced action',
    description: 'Makes you sign up, share data or do something unrelated to get what you came for.',
  },
  {
    id: 5,
    label: 'subscription_trap',
    name: 'Subscription trap',
    description: 'Makes subscribing easy but cancelling hard, or hides auto-renewal terms.',
  },
  {
    id: 6,
    label: 'interface_interference',
    name: 'Interface interference',
    description: 'Designs the page to highlight one option and hide or downplay the other.',
  },
  {
    id: 7,
    label: 'bait_and_switch',
    name: 'Bait and switch',
    description: 'Advertises one offer or price, then gives you a different one.',
  },
  {
    id: 8,
    label: 'drip_pricing',
    name: 'Drip pricing',
    description: 'Hides part of the price until late in checkout, or charges more than first shown.',
  },
  {
    id: 9,
    label: 'disguised_ads',
    name: 'Disguised advertisement',
    description: 'Makes ads look like regular content such as products, reviews or news.',
  },
  {
    id: 10,
    label: 'nagging',
    name: 'Nagging',
    description: 'Interrupts you again and again with pop-ups or requests you did not ask for.',
  },
  {
    id: 11,
    label: 'trick_wording',
    name: 'Trick question',
    description: 'Uses confusing or misleading wording, like double negatives, to steer your choice.',
  },
] as const;

export type Category = (typeof CATEGORIES)[number];
export type CategoryId = Category['id'];
export type CategoryLabel = Category['label'];

export const LABELS: readonly CategoryLabel[] = CATEGORIES.map((c) => c.label);
