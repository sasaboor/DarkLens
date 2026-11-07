/**
 * User settings in chrome.storage.sync, shared by the options page, popup,
 * side panel and content script. Every reader listens for changes, so a
 * setting applies live without a reload. The shape and defaults live in
 * src/core/prefs.ts.
 */
import { browser } from 'wxt/browser';
import { normalizeSettings, type Settings } from './core/prefs';

export { DEFAULT_SETTINGS, type Settings } from './core/prefs';
export const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    return normalizeSettings((await browser.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]);
  } catch {
    return normalizeSettings(undefined);
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await browser.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Calls `cb` with the new settings whenever they change. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'sync' || !(SETTINGS_KEY in changes)) return;
    cb(normalizeSettings(changes[SETTINGS_KEY]!.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
