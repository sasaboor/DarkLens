export type PageType = 'product' | 'cart' | 'checkout' | 'listing' | 'other';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CandidateKind =
  | 'control'
  | 'checkbox'
  | 'dialog'
  | 'banner'
  | 'price'
  | 'timer'
  | 'stock'
  | 'fee'
  | 'ad_label'
  | 'subscription'
  | 'text';

export interface Candidate {
  id: string;
  text: string;
  tag: string;
  role: string | null;
  kind: CandidateKind;
  rect: Rect;
  counterpartId: string | null;
  /** The 12 structural features, in FEATURE_NAMES order. */
  features: number[];
  featureSource: { f03: 'css' | 'pixels'; f04: 'css' | 'pixels' };
  context: { pageType: PageType; inDialog: boolean; nearbyPrice: string | null };
}

export interface Finding {
  candidateId: string;
  category: number;
  confidence: number;
  source: 'rule' | 'model' | 'both';
  reason: string;
  evidence: string[];
  confirmed?: boolean;
  /** Set when the rule fired on hard evidence: default_checked, price_delta, a confirmed timer reset or an unclosable modal. */
  hard?: boolean;
}
