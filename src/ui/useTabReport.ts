/**
 * The tab a page is about and that tab's latest report (stored per tab by the
 * background in storage.session). The popup reads the active tab once; the
 * side panel follows the active tab of its window as the user switches tabs.
 *
 * `?tabId=N` in the page URL pins the page to tab N (used by the Playwright
 * screenshot and end-to-end tools, which open these pages as ordinary tabs).
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { tabKey, type TabReport } from '../messages';

export interface TabInfo {
  id: number;
  url: string;
  windowId: number;
}

function pinnedTabId(): number | null {
  const raw = new URLSearchParams(location.search).get('tabId');
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) ? id : null;
}

function toInfo(t: { id?: number; url?: string; windowId?: number } | undefined): TabInfo | null {
  return t?.id !== undefined ? { id: t.id, url: t.url ?? '', windowId: t.windowId ?? -1 } : null;
}

/** The pinned tab, else the active tab of the current window. */
export async function resolveTab(): Promise<TabInfo | null> {
  const pinned = pinnedTabId();
  if (pinned !== null) return toInfo(await browser.tabs.get(pinned).catch(() => undefined));
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  return toInfo(t);
}

/** True for pages DarkLens can scan. An unknown URL ('') counts as scannable. */
export function isWebPage(url: string): boolean {
  return !url || /^https?:/i.test(url);
}

export function useTabReport({ followActive }: { followActive: boolean }) {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [report, setReport] = useState<TabReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void resolveTab().then((t) => {
      setTab(t);
      if (!t) setLoaded(true);
    });
  }, []);

  // Follow tab switches and navigations in this window (side panel only, and never when pinned).
  useEffect(() => {
    if (!followActive || pinnedTabId() !== null || !tab) return;
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId !== tab.windowId) return;
      void browser.tabs.get(info.tabId).then((t) => setTab(toInfo(t)));
    };
    const onUpdated = (tabId: number, change: { url?: string }) => {
      if (tabId === tab.id && change.url !== undefined) setTab({ ...tab, url: change.url });
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [followActive, tab]);

  // The background replaces the tab's report after every scan or settings change; follow it.
  const tabId = tab?.id;
  useEffect(() => {
    if (tabId === undefined) return;
    const key = tabKey(tabId);
    let live = true;
    void browser.storage.session.get(key).then((s) => {
      if (!live) return;
      setReport((s[key] as TabReport | undefined) ?? null);
      setLoaded(true);
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && key in changes) setReport((changes[key]!.newValue as TabReport | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, [tabId]);

  return { tab, setTab, report, loaded };
}
