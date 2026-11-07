import { createCaptureThrottle } from '@/src/core/pixels';
import {
  OFFSCREEN_REFINE,
  PIXELS_CAPTURE,
  PIXELS_RESULT,
  REPORT,
  STATE_CLICK,
  STATE_DISMISS,
  STATE_GET,
  STATE_RECORD,
  tabKey,
  type OffscreenRefineMessage,
  type PixelsCaptureMessage,
  type PixelsCaptureReply,
  type PixelsResultMessage,
  type PixelsResultReply,
  type StateClickMessage,
  type StateDismissMessage,
  type StateRecordMessage,
  type TabReport,
} from '@/src/messages';
import { extensionStore } from '@/src/storage';

const OFFSCREEN_PATH = '/offscreen.html';
/** A capture's measurement is dropped if nobody asks for it within this long. */
const JOB_TTL_MS = 10_000;

let offscreenReady: Promise<void> | null = null;

// The offscreen document measures screenshot crops (and will host model inference) so pages never stutter.
function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    const existing = await browser.runtime.getContexts({
      contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (existing.length > 0) return;
    await browser.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [browser.offscreen.Reason.WORKERS, browser.offscreen.Reason.BLOBS],
      justification: 'Measure colours in screenshot crops and run the local ML model off the page thread',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

type Sender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

/** The top frame of an http(s) tab: the only senders whose state messages count. The URL comes from the tab, not the message. */
function pageOf(sender: Sender): { tabId: number; windowId: number; url: string; active: boolean } | null {
  const tab = sender.tab;
  if (!tab?.id || sender.frameId !== 0 || !tab.url || !/^https?:/.test(tab.url)) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url, active: !!tab.active };
}

const captureAllowed = createCaptureThrottle();
const jobs = new Map<string, Promise<PixelsResultReply>>();

async function measure(image: string, msg: PixelsCaptureMessage): Promise<PixelsResultReply> {
  try {
    await ensureOffscreen();
    const req: OffscreenRefineMessage = { type: OFFSCREEN_REFINE, target: 'offscreen', image, frame: msg.frame, boxes: msg.boxes };
    const reply = (await browser.runtime.sendMessage(req)) as PixelsResultReply | undefined;
    return reply ?? { ok: false, reason: 'no reply from offscreen' };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/**
 * Captures the visible tab for pixel refinement: only the sender's own tab
 * while it is the active one, at most once per 2 s. Replies as soon as the
 * image is taken; the crops are measured in the offscreen document after.
 * The screenshot is never stored and never leaves the browser.
 */
async function capture(msg: PixelsCaptureMessage, sender: Sender): Promise<PixelsCaptureReply> {
  const page = pageOf(sender);
  if (!page) return { ok: false, reason: 'not a page' };
  if (!page.active) return { ok: false, reason: 'tab not active' };
  if (!captureAllowed(Date.now())) return { ok: false, reason: 'throttled' };
  try {
    const [active] = await browser.tabs.query({ active: true, windowId: page.windowId });
    if (active?.id !== page.tabId) return { ok: false, reason: 'tab not active' };
    const image = await browser.tabs.captureVisibleTab(page.windowId, { format: 'png' });
    const captureId = crypto.randomUUID();
    jobs.set(captureId, measure(image, msg));
    setTimeout(() => jobs.delete(captureId), JOB_TTL_MS);
    return { ok: true, captureId };
  } catch (err) {
    // No permission for this page, a devtools window, a chrome:// tab…: CSS values stay.
    return { ok: false, reason: String(err) };
  }
}

async function result(msg: PixelsResultMessage): Promise<PixelsResultReply> {
  const job = jobs.get(msg.captureId);
  if (!job) return { ok: false, reason: 'unknown capture' };
  jobs.delete(msg.captureId);
  return job;
}

export default defineBackground(() => {
  console.log('[DarkLens] background service worker loaded');
  ensureOffscreen().catch((err) => console.error('[DarkLens] offscreen setup failed', err));
  const store = extensionStore();

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: unknown) => void) => {
    const msg = message as { type?: string } | null;
    switch (msg?.type) {
      // The latest findings and score per tab, for the popup and side panel.
      case REPORT: {
        const report = (msg as { report?: TabReport }).report;
        const tabId = sender.tab?.id;
        if (!report || tabId === undefined || sender.frameId !== 0) return;
        void browser.storage.session.set({ [tabKey(tabId)]: report });
        return;
      }
      case STATE_GET: {
        const page = pageOf(sender);
        if (!page) return;
        store.getState(page.url).then(sendResponse, () => sendResponse(undefined));
        return true;
      }
      case STATE_RECORD: {
        const page = pageOf(sender);
        if (!page) return;
        const m = msg as StateRecordMessage;
        store.record(page.url, m.observation, { now: m.now, loadId: m.loadId }).then(
          () => sendResponse({ ok: true }),
          (err) => {
            console.warn('[DarkLens] could not save memory', err);
            sendResponse({ ok: false });
          },
        );
        return true;
      }
      case STATE_CLICK: {
        const page = pageOf(sender);
        if (page) void store.noteAddClick(page.url, (msg as StateClickMessage).at);
        return;
      }
      case STATE_DISMISS: {
        const page = pageOf(sender);
        if (!page) return;
        const m = msg as StateDismissMessage;
        store.dismiss({ url: page.url, text: m.text, category: m.category, at: m.at }).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
        return true;
      }
      case PIXELS_CAPTURE:
        capture(msg as PixelsCaptureMessage, sender).then(sendResponse);
        return true;
      case PIXELS_RESULT:
        result(msg as PixelsResultMessage).then(sendResponse);
        return true;
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => void browser.storage.session.remove(tabKey(tabId)));
  // A full navigation drops the old page's report until the new page scans.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void browser.storage.session.remove(tabKey(tabId));
  });
});
