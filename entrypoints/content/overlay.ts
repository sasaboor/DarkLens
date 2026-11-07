/**
 * On-page highlights. One <darklens-overlay> host on <html> (outside <body>,
 * so the extractor never sees it), with a closed shadow root: page CSS cannot
 * reach in and ours cannot leak out. Per finding: an outline box in the
 * category colour and a small badge; hovering or focusing the badge shows a
 * tooltip with the category, reason, confidence, source and a "Not a dark
 * pattern?" button.
 *
 * The overlay never blocks the page: everything has pointer-events: none
 * except the badges (and their tooltips, which only exist while a badge is
 * hovered). flash() pulses one highlight when the side panel asks to show it,
 * even while highlights are switched off. Boxes follow their elements on scroll and resize, batched in one
 * requestAnimationFrame that reads every rect first and then writes.
 */
import { categoryById } from '@/src/core/categories';
import type { Finding } from '@/src/core/types';

export interface OverlayEntry {
  finding: Finding;
  element: Element;
  /** The candidate text (labels and button text only), stored with a dismissal. */
  text: string;
}

const HOST_TAG = 'darklens-overlay';
const PAD = 3;
const BADGE_H = 15;
/** Rough badge width per character at the badge font size, plus padding (no layout read needed). */
const BADGE_CHAR_W = 6;
const BADGE_PAD_W = 10;
const TIP_W = 270;
const TIP_H = 190;
const FLASH_MS = 1600;

const SOURCE_LABEL: Record<Finding['source'], string> = { rule: 'Rule', model: 'Model', both: 'Rule + model' };

const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'inset: 0',
  'width: 100vw',
  'height: 100vh',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'overflow: visible',
  'display: block',
  'pointer-events: none',
  'z-index: 2147483647',
  'contain: layout style',
]
  .map((d) => `${d} !important;`)
  .join(' ');

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: absolute; inset: 0; pointer-events: none; }
.layer.off > :not(.flash) { display: none; }
.box {
  position: absolute; left: 0; top: 0; pointer-events: none;
  border: 2px solid var(--c); border-radius: 5px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.75), inset 0 0 0 1px rgba(255,255,255,.4);
}
.box.hidden, .badge.hidden { display: none; }
.box.flash { animation: dl-flash .4s ease-in-out 4 alternate; }
@keyframes dl-flash {
  from { box-shadow: 0 0 0 1px rgba(255,255,255,.75), 0 0 0 0 var(--c); }
  to { box-shadow: 0 0 0 1px rgba(255,255,255,.75), 0 0 0 6px color-mix(in srgb, var(--c) 45%, transparent); border-width: 3px; }
}
@media (prefers-reduced-motion: reduce) {
  .box.flash { animation: none; border-width: 3px; box-shadow: 0 0 0 1px #fff, 0 0 0 5px color-mix(in srgb, var(--c) 45%, transparent); }
}
.badge {
  position: absolute; left: 0; top: 0; pointer-events: auto; cursor: default;
  height: ${BADGE_H}px; padding: 0 5px; border-radius: 3px; background: var(--c); color: #fff;
  font: 600 10px/${BADGE_H}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,.3); outline: none; opacity: .92;
}
.badge:hover, .badge:focus-within { opacity: 1; z-index: 2; }
.badge:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--c); }
.tipwrap { display: none; position: absolute; left: 0; top: 100%; padding-top: 4px; }
.tipwrap.up { top: auto; bottom: 100%; padding-top: 0; padding-bottom: 4px; }
.tipwrap.right { left: auto; right: 0; }
.badge:hover .tipwrap, .badge:focus-within .tipwrap { display: block; }
.tip {
  width: ${TIP_W}px; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5e7eb; border-top: 3px solid var(--c);
  background: #fff; color: #111827; box-shadow: 0 10px 28px rgba(0,0,0,.2);
  font: 400 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: normal; text-align: left;
}
.cat { font-weight: 700; font-size: 13px; color: var(--c); margin: 0 0 4px; }
.reason { margin: 0 0 6px; color: #111827; }
.meta { margin: 0 0 8px; color: #4b5563; font-size: 11px; }
.chip { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; background: #fef3c7; color: #92400e; font-weight: 600; }
.dismiss {
  all: unset; cursor: pointer; font: 500 11px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1d4ed8; text-decoration: underline;
}
.dismiss:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
`;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

interface Drawn {
  entry: OverlayEntry;
  box: HTMLDivElement;
  badge: HTMLDivElement;
  tipwrap: HTMLDivElement;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private layer: HTMLDivElement | null = null;
  private drawn: Drawn[] = [];
  private raf = 0;
  private visible = true;
  private resizeObserver = new ResizeObserver(() => this.schedule());
  private tick: ReturnType<typeof setInterval> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onScroll = () => this.schedule();

  constructor(private readonly onDismiss: (entry: OverlayEntry) => void) {}

  /** True for our host (and so anything inside it), for the MutationObserver to ignore. */
  isOwn(node: Node): boolean {
    return !!this.host && (node === this.host || this.host.contains(node));
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.layer?.classList.toggle('off', !on);
  }

  /** Hides every highlight, tooltip and badge while the tab is captured for pixel refinement, so they are not measured. */
  hideForCapture(hide: boolean): void {
    if (!this.host) return;
    if (hide) this.host.style.setProperty('visibility', 'hidden', 'important');
    else this.host.style.removeProperty('visibility');
  }

  render(entries: OverlayEntry[]): void {
    this.clear();
    if (!entries.length) return;
    const layer = this.mount();
    for (const entry of entries) this.drawn.push(this.draw(layer, entry));
    for (const d of this.drawn) this.resizeObserver.observe(d.entry.element);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this.onScroll, { passive: true });
    // Layout can shift without a scroll or resize (a banner closes, content loads).
    this.tick ??= setInterval(() => this.schedule(), 1000);
    this.promote();
    this.layout();
  }

  /** Pulses the highlight of one finding for FLASH_MS, shown even when highlights are off. */
  flash(candidateId: string): void {
    const d = this.drawn.find((x) => x.entry.finding.candidateId === candidateId);
    if (!d) return;
    for (const other of this.drawn) {
      other.box.classList.remove('flash');
      other.badge.classList.remove('flash');
    }
    void d.box.offsetWidth; // restart the animation when the same card is clicked twice
    d.box.classList.add('flash');
    d.badge.classList.add('flash');
    this.promote();
    // Smooth scrolling moves the element after this call; keep the box on it while it settles.
    this.schedule();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      d.box.classList.remove('flash');
      d.badge.classList.remove('flash');
    }, FLASH_MS);
  }

  clear(): void {
    for (const d of this.drawn) {
      this.resizeObserver.unobserve(d.entry.element);
      d.box.remove();
      d.badge.remove();
    }
    this.drawn = [];
    window.removeEventListener('scroll', this.onScroll, { capture: true });
    window.removeEventListener('resize', this.onScroll);
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private mount(): HTMLDivElement {
    if (this.host?.isConnected && this.layer) return this.layer;
    const host = document.createElement(HOST_TAG);
    host.setAttribute('style', HOST_STYLE);
    // In the top layer (when supported) the overlay also sits above modal <dialog>s.
    if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const layer = document.createElement('div');
    layer.className = this.visible ? 'layer' : 'layer off';
    shadow.append(style, layer);
    document.documentElement.append(host);
    this.host = host;
    this.layer = layer;
    return layer;
  }

  /** Re-enters the top layer so the overlay stays above pop-ups opened since the last render. */
  private promote(): void {
    const host = this.host as (HTMLElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!host?.showPopover) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover?.();
      host.showPopover();
    } catch {
      // Not connected or popovers unsupported: the fixed host with a max z-index still works.
    }
  }

  private draw(layer: HTMLDivElement, entry: OverlayEntry): Drawn {
    const cat = categoryById(entry.finding.category);
    const box = document.createElement('div');
    box.className = 'box hidden';
    box.style.setProperty('--c', cat.color);

    const badge = document.createElement('div');
    badge.className = 'badge hidden';
    badge.tabIndex = 0;
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-label', `DarkLens: ${cat.name}`);
    badge.style.setProperty('--c', cat.color);
    badge.textContent = cat.short;

    const tipwrap = document.createElement('div');
    tipwrap.className = 'tipwrap';
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');

    const title = document.createElement('p');
    title.className = 'cat';
    title.textContent = cat.name;
    const reason = document.createElement('p');
    reason.className = 'reason';
    reason.textContent = entry.finding.reason;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `Confidence ${Math.round(entry.finding.confidence * 100)}% · ${SOURCE_LABEL[entry.finding.source]}`;
    if (entry.finding.confirmed) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'Confirmed';
      meta.append(chip);
    }
    const dismiss = document.createElement('button');
    dismiss.className = 'dismiss';
    dismiss.type = 'button';
    dismiss.textContent = 'Not a dark pattern?';
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove(entry);
      this.onDismiss(entry);
    });

    tip.append(title, reason, meta, dismiss);
    tipwrap.append(tip);
    badge.append(tipwrap);
    // Flip the tooltip when it would run off the bottom or right of the viewport.
    const place = () => {
      const r = badge.getBoundingClientRect();
      tipwrap.classList.toggle('up', r.bottom + TIP_H > window.innerHeight && r.top > TIP_H);
      tipwrap.classList.toggle('right', r.left + TIP_W > window.innerWidth);
    };
    badge.addEventListener('mouseenter', place);
    badge.addEventListener('focus', place);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') badge.blur();
    });

    layer.append(box, badge);
    return { entry, box, badge, tipwrap };
  }

  private remove(entry: OverlayEntry): void {
    const i = this.drawn.findIndex((d) => d.entry === entry);
    if (i < 0) return;
    const [d] = this.drawn.splice(i, 1);
    this.resizeObserver.unobserve(d!.entry.element);
    d!.box.remove();
    d!.badge.remove();
  }

  private schedule(): void {
    if (this.raf || !this.drawn.length) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.layout();
    });
  }

  private layout(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Read every rect first, then write, so the browser lays out once.
    const rects = this.drawn.map(({ entry: { element } }) => {
      if (!element.isConnected) return null;
      const r = element.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return null;
      if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return null;
      const shown = (element as Element & { checkVisibility?: () => boolean }).checkVisibility?.() ?? true;
      return shown ? r : null;
    });
    const boxes = rects.map((r) => r && { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 });
    // Badge spots, best first: above the top-left corner, right of the box, inside its top-left.
    // A spot is skipped when it would cover another highlighted element or an earlier badge.
    const placed: Box[] = [];
    this.drawn.forEach((d, i) => {
      const box = boxes[i];
      d.box.classList.toggle('hidden', !box);
      d.badge.classList.toggle('hidden', !box);
      if (!box) return;
      d.box.style.transform = `translate(${box.x}px, ${box.y}px)`;
      d.box.style.width = `${box.w}px`;
      d.box.style.height = `${box.h}px`;

      const w = categoryById(d.entry.finding.category).short.length * BADGE_CHAR_W + BADGE_PAD_W;
      const spots: Box[] = [
        { x: box.x, y: box.y - BADGE_H - 1 },
        { x: box.x + box.w + 3, y: box.y + box.h / 2 - BADGE_H / 2 },
        { x: box.x + PAD, y: box.y + PAD },
      ].map((p) => ({ x: Math.max(0, Math.min(p.x, vw - w)), y: Math.max(0, Math.min(p.y, vh - BADGE_H)), w, h: BADGE_H }));
      const free = (s: Box) => !placed.some((p) => overlaps(s, p)) && !boxes.some((o, j) => j !== i && o && overlaps(s, o));
      const spot = spots.find(free) ?? spots[0]!;
      placed.push(spot);
      d.badge.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
    });
  }
}
