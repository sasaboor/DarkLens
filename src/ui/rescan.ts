/** Rescan from the popup or side panel, with plain explanations when the tab has no content script. */
import { browser } from 'wxt/browser';
import { RESCAN, type RescanReply } from '../messages';
import { resolveTab, type TabInfo } from './useTabReport';

const BUILD = __DARKLENS_BUILD__;

/** Why a tab may have no content script. Browsers never run extensions on their own error pages. */
export function noContentScriptHelp(url: string): string {
  const where = url ? ` on ${url}` : '';
  if (url && !/^https?:/i.test(url)) return `No DarkLens content script${where}: DarkLens only runs on http(s) pages.`;
  return (
    `No DarkLens content script${where}. Is this a browser error page (HTTP 404, can't connect)? ` +
    'Check the address and port (the test shop needs …/product.html). ' +
    'If the page loads fine, reload it: tabs opened before the extension was reloaded have no content script.'
  );
}

export interface RescanOutcome {
  ok: boolean;
  /** One line for the status area. */
  message: string;
  /** The tab that was scanned (the active tab at the moment of the click). */
  tab: TabInfo | null;
}

/** Asks the active (or pinned) tab's content script to scan now and waits for its reply. */
export async function rescanActiveTab(): Promise<RescanOutcome> {
  let target: TabInfo | null = null;
  try {
    target = await resolveTab();
    if (!target) throw new Error('no active tab');
    const reply = (await browser.tabs.sendMessage(target.id, { type: RESCAN })) as RescanReply | undefined;
    if (!reply) throw new Error('no reply from the content script');
    if (reply.build !== BUILD) {
      return {
        ok: false,
        tab: target,
        message: `This tab is running an older DarkLens build (${reply.build ?? 'unknown'}). Reload the page.`,
      };
    }
    if (!reply.ok) return { ok: false, tab: target, message: `Scan failed: ${reply.error}` };
    return {
      ok: true,
      tab: target,
      message: `Scanned: ${reply.count} finding${reply.count === 1 ? '' : 's'} (${reply.pageType} page)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noListener = /Receiving end does not exist|Could not establish connection/i.test(message);
    return { ok: false, tab: target, message: noListener ? noContentScriptHelp(target?.url ?? '') : `Scan failed: ${message}` };
  }
}
