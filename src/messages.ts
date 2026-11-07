/** Messages and per-tab results shared by the content script, background, popup and side panel. */
import type { ScanObservation } from './core/memory';
import type { CaptureFrame } from './core/capture';
import type { PixelBox, PixelRefinement } from './core/pixels';
import type { CandidateKind, Finding, PageType } from './core/types';
import type { MemoryState } from './store';

/** Popup → content script: scan now. Reply: RescanReply. */
export const RESCAN = 'darklens:rescan';
/** Content script → background: the latest results for this tab (a TabReport). */
export const REPORT = 'darklens:report';
/** Side panel → content script: scroll to a finding's element and flash it. Reply: FocusReply. */
export const FOCUS = 'darklens:focus';

// Cross-page state. Content scripts never touch chrome.storage: the background owns it (src/store.ts)
// and takes the site and URL from the sender's tab, never from the message.

/** Content → background: memory for this tab's site before a scan. Reply: MemoryState. */
export const STATE_GET = 'darklens:state-get';
/** Content → background: fold this scan's observation into memory. Reply: { ok }. */
export const STATE_RECORD = 'darklens:state-record';
/** Content → background: the user clicked an add-to-cart or buy-now control. */
export const STATE_CLICK = 'darklens:state-click';
/** Content → background: "Not a dark pattern?" on this page. */
export const STATE_DISMISS = 'darklens:state-dismiss';

export type StateGetMessage = { type: typeof STATE_GET };
export type StateGetReply = MemoryState;
export interface StateRecordMessage {
  type: typeof STATE_RECORD;
  observation: ScanObservation;
  loadId: string;
  now: number;
}
export interface StateClickMessage {
  type: typeof STATE_CLICK;
  at: number;
}
export interface StateDismissMessage {
  type: typeof STATE_DISMISS;
  text: string;
  category: number;
  at: number;
}

// Pixel refinement of f03 and f04 (src/core/pixels.ts).

/**
 * Content → background, with our overlay hidden: capture the visible tab now.
 * Reply (as soon as the capture is taken, so the overlay can come back):
 * PixelsCaptureReply. The crops are measured in the offscreen document meanwhile.
 */
export const PIXELS_CAPTURE = 'darklens:pixels-capture';
/** Content → background: the refinement for a capture. Reply: PixelsResultReply. */
export const PIXELS_RESULT = 'darklens:pixels-result';
/** Background → offscreen document: decode, crop and measure. Reply: PixelsResultReply. */
export const OFFSCREEN_REFINE = 'darklens:offscreen-refine';

export interface PixelsCaptureMessage {
  type: typeof PIXELS_CAPTURE;
  frame: CaptureFrame;
  boxes: PixelBox[];
}
export type PixelsCaptureReply = { ok: true; captureId: string } | { ok: false; reason: string };
export interface PixelsResultMessage {
  type: typeof PIXELS_RESULT;
  captureId: string;
}
export type PixelsResultReply = { ok: true; refined: Record<string, PixelRefinement> } | { ok: false; reason: string };
export interface OffscreenRefineMessage {
  type: typeof OFFSCREEN_REFINE;
  target: 'offscreen';
  image: string;
  frame: CaptureFrame;
  boxes: PixelBox[];
}

export interface FocusMessage {
  type: typeof FOCUS;
  candidateId: string;
}

export interface FocusReply {
  /** False when the element is no longer on the page. */
  ok: boolean;
}

export interface RescanReply {
  ok: boolean;
  /** The content script's build stamp, to spot a tab still running an older build. */
  build: string;
  count?: number;
  score?: number;
  pageType?: PageType;
  error?: string;
}

export interface TabReport {
  url: string;
  pageType: PageType;
  /** 0 to 100, see src/core/score.ts. */
  score: number;
  /** The findings shown under the user's settings (enabled categories, confidence threshold). */
  findings: Finding[];
  /** How many more findings the settings hid. */
  hidden: number;
  /** The flagged elements' text and kind, by candidate id, for the side panel. */
  items: Record<string, { text: string; kind: CandidateKind }>;
  scannedAt: number;
  build: string;
  /** "rules" until a model head is bundled. */
  mode: 'rules' | 'model+rules';
}

/** chrome.storage.session key for a tab's report. */
export function tabKey(tabId: number): string {
  return `tab:${tabId}`;
}
