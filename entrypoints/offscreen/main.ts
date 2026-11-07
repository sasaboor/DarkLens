/**
 * The offscreen document: measures screenshot crops for pixel refinement of
 * f03 and f04 (and will host model inference), off the page's thread. The
 * screenshot is decoded in memory, cropped to the candidate boxes, measured
 * and dropped; nothing is stored or sent anywhere.
 */
import { decodeImage } from '@/src/core/capture';
import { imageMatchesFrame, refineFromPixels } from '@/src/core/pixels';
import { OFFSCREEN_REFINE, type OffscreenRefineMessage, type PixelsResultReply } from '@/src/messages';

async function refine(msg: OffscreenRefineMessage): Promise<PixelsResultReply> {
  try {
    const img = await decodeImage(msg.image);
    // A zoomed devtools layout or a resize mid-capture: the boxes would not line up, so keep CSS values.
    if (!imageMatchesFrame(img, msg.frame)) return { ok: false, reason: 'screenshot size does not match the page' };
    return { ok: true, refined: refineFromPixels(img, msg.frame.dpr, msg.boxes) };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: PixelsResultReply) => void) => {
  const msg = message as Partial<OffscreenRefineMessage> | null;
  if (msg?.target !== 'offscreen' || msg.type !== OFFSCREEN_REFINE) return;
  refine(msg as OffscreenRefineMessage).then(sendResponse);
  return true;
});

console.log('[DarkLens] offscreen document loaded');
