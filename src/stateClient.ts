/**
 * The content script's side of the cross-page state: thin message wrappers.
 * The background owns chrome.storage (src/store.ts); content scripts never
 * read or write it directly. When the background cannot be reached (extension
 * reloaded under the page), scans fall back to empty memory.
 */
import { browser } from 'wxt/browser';
import { emptyHistory, emptySiteMemory, normalizeHistory, normalizeSiteMemory, type ScanObservation } from './core/memory';
import {
  STATE_CLICK,
  STATE_DISMISS,
  STATE_GET,
  STATE_RECORD,
  type StateClickMessage,
  type StateDismissMessage,
  type StateGetMessage,
  type StateGetReply,
  type StateRecordMessage,
} from './messages';
import type { MemoryState } from './store';

export async function getState(): Promise<MemoryState> {
  try {
    const r = (await browser.runtime.sendMessage({ type: STATE_GET } satisfies StateGetMessage)) as StateGetReply | undefined;
    if (r) return { site: normalizeSiteMemory(r.site), history: normalizeHistory(r.history), dismissed: Array.isArray(r.dismissed) ? r.dismissed : [] };
  } catch (err) {
    console.warn('[DarkLens] could not load memory', err);
  }
  return { site: emptySiteMemory(), history: emptyHistory(), dismissed: [] };
}

export async function recordScan(observation: ScanObservation, loadId: string, now: number): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: STATE_RECORD, observation, loadId, now } satisfies StateRecordMessage);
  } catch (err) {
    console.warn('[DarkLens] could not save memory', err);
  }
}

export function noteAddClick(at: number): void {
  browser.runtime.sendMessage({ type: STATE_CLICK, at } satisfies StateClickMessage).catch(() => {});
}

export async function dismiss(text: string, category: number, at: number): Promise<void> {
  await browser.runtime.sendMessage({ type: STATE_DISMISS, text, category, at } satisfies StateDismissMessage);
}
