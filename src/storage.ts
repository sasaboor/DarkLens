/**
 * The store (src/store.ts) bound to chrome.storage. Imported only by
 * trusted extension contexts: the background worker and the Options page.
 * Content scripts go through messages instead (src/stateClient.ts).
 */
import { browser } from 'wxt/browser';
import { createStore, type Store } from './store';

let store: Store | null = null;

export function extensionStore(): Store {
  store ??= createStore({ session: browser.storage.session, local: browser.storage.local });
  return store;
}

/** "Clear stored data" in Options. */
export function clearStoredData(): Promise<void> {
  return extensionStore().clear();
}
