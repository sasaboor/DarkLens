/**
 * The cross-page state store, owned by the background worker (see "Cross-page
 * state" in CLAUDE.md). Content scripts never touch chrome.storage; they ask
 * the background through messages (src/messages.ts), which calls this.
 *
 * - storage.session, one key per site: SiteMemory (product prices, listing
 *   offers, dialog hashes, cart count). Gone when the browser closes.
 * - storage.local: HistoryMemory (timer end times and stock counts per URL,
 *   kept 7 days, at most 500 entries) and the "Not a dark pattern?" list.
 *
 * Every read and write runs through one queue, so two tabs scanning at once
 * cannot overwrite each other's updates. Never anything typed by the user.
 *
 * The storage areas are passed in, so tests use in-memory fakes.
 */
import {
  addDismissal,
  applyObservation,
  normalizeHistory,
  normalizeSiteMemory,
  pruneHistory,
  type Dismissal,
  type HistoryMemory,
  type ScanObservation,
  type SiteMemory,
} from './core/memory';
import { siteKey } from './core/facts';

/** The subset of chrome.storage.StorageArea the store uses. */
export interface StorageAreaLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** What a content script gets before a scan. */
export interface MemoryState {
  site: SiteMemory;
  history: HistoryMemory;
  dismissed: Dismissal[];
}

export const HISTORY_KEY = 'history';
export const DISMISSED_KEY = 'dismissed';
const SITE_PREFIX = 'site:';
export const siteStorageKey = (site: string) => `${SITE_PREFIX}${site}`;

export function createStore(areas: { session: StorageAreaLike; local: StorageAreaLike }) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `fn` after everything queued before it. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  }

  async function readSite(site: string): Promise<SiteMemory> {
    const key = siteStorageKey(site);
    return normalizeSiteMemory((await areas.session.get(key))[key]);
  }
  async function readHistory(now: number): Promise<HistoryMemory> {
    return pruneHistory(normalizeHistory((await areas.local.get(HISTORY_KEY))[HISTORY_KEY]), now);
  }
  async function readDismissed(): Promise<Dismissal[]> {
    const raw = (await areas.local.get(DISMISSED_KEY))[DISMISSED_KEY];
    return Array.isArray(raw) ? (raw as Dismissal[]) : [];
  }

  return {
    /** Memory for the site of `url`, the history and the dismissals. */
    getState(url: string, now = Date.now()): Promise<MemoryState> {
      return serial(async () => {
        const [site, history, dismissed] = await Promise.all([readSite(siteKey(url)), readHistory(now), readDismissed()]);
        return { site, history, dismissed };
      });
    },

    /** Folds one scan's observation into the site memory and the history, pruning the history (7 days, 500 entries). */
    record(url: string, obs: ScanObservation, at: { now: number; loadId: string }): Promise<void> {
      return serial(async () => {
        const site = siteKey(url);
        const next = applyObservation(await readSite(site), await readHistory(at.now), obs, at);
        await Promise.all([areas.session.set({ [siteStorageKey(site)]: next.site }), areas.local.set({ [HISTORY_KEY]: next.history })]);
      });
    },

    /** An add-to-cart or buy-now click on a page of this site. */
    noteAddClick(url: string, at: number): Promise<void> {
      return serial(async () => {
        const site = siteKey(url);
        const mem = await readSite(site);
        await areas.session.set({ [siteStorageKey(site)]: { ...mem, cart: { ...mem.cart, addClickAt: at } } });
      });
    },

    /** Saves a "Not a dark pattern?" click: {url, text, category}, locally only. */
    dismiss(d: Dismissal): Promise<void> {
      return serial(async () => {
        await areas.local.set({ [DISMISSED_KEY]: addDismissal(await readDismissed(), d) });
      });
    },

    /**
     * "Clear stored data" in Options: forgets the timer and stock history, the
     * "Not a dark pattern?" list and this session's per-site memory. Settings
     * and the current tabs' reports stay.
     */
    clear(): Promise<void> {
      return serial(async () => {
        await areas.local.remove([HISTORY_KEY, DISMISSED_KEY]);
        const siteKeys = Object.keys(await areas.session.get(null)).filter((k) => k.startsWith(SITE_PREFIX));
        if (siteKeys.length) await areas.session.remove(siteKeys);
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
