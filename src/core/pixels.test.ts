import { describe, expect, it } from 'vitest';
import { contrastRatio, salience, type RGBA } from './color';
import {
  applyPixelRefinement,
  colorClusters,
  createCaptureThrottle,
  imageMatchesFrame,
  cropBox,
  featureSourceCounts,
  pageBackground,
  pixelBoxes,
  pixelContrast,
  refineFromPixels,
  type RgbaImage,
} from './pixels';
import type { Candidate, CandidateKind, Rect } from './types';

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const GREY: RGB = [0x99, 0x99, 0x99];
const ORANGE: RGB = [0xf9, 0x73, 0x16];

const rgba = ([r, g, b]: RGB): RGBA => ({ r, g, b, a: 1 });

function image(w: number, h: number, fill: RGB): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  return { width: w, height: h, data };
}

function paint(img: RgbaImage, x: number, y: number, w: number, h: number, c: RGB): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) img.data.set([...c, 255], (yy * img.width + xx) * 4);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as RGB;
}

/** Fake "text": vertical 1px strokes every 3px across the middle band, optionally with anti-aliased neighbours. */
function strokes(img: RgbaImage, box: Rect, ink: RGB, bg: RGB, antialias = false): void {
  const y0 = box.y + Math.floor(box.h * 0.25);
  const h = Math.ceil(box.h * 0.5);
  for (let x = box.x + 3; x < box.x + box.w - 3; x += 4) {
    paint(img, x, y0, 1, h, ink);
    if (antialias) {
      paint(img, x - 1, y0, 1, h, mix(bg, ink, 0.35));
      paint(img, x + 1, y0, 1, h, mix(bg, ink, 0.6));
    }
  }
}

function cand(id: string, kind: CandidateKind, text = 'Some text'): Candidate {
  return {
    id,
    text,
    tag: 'span',
    role: null,
    kind,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    counterpartId: null,
    features: [1, 1, 7, 0.1, 0, 0, 0, 0, 0, 0, 0.5, 0],
    featureSource: { f03: 'css', f04: 'css' },
    context: { pageType: 'other', inDialog: false, nearbyPrice: null },
  };
}

describe('colorClusters and pixelContrast', () => {
  it('black text on white is about 21:1', () => {
    const img = image(60, 20, WHITE);
    strokes(img, { x: 0, y: 0, w: 60, h: 20 }, BLACK, WHITE);
    const c = colorClusters(img)!;
    expect(c.background).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(pixelContrast(c)).toBeCloseTo(21, 0);
  });

  it('#999 grey on white matches the CSS contrast (about 2.85:1)', () => {
    const img = image(60, 20, WHITE);
    strokes(img, { x: 0, y: 0, w: 60, h: 20 }, GREY, WHITE);
    const expected = contrastRatio(rgba(GREY), rgba(WHITE));
    expect(pixelContrast(colorClusters(img)!)).toBeCloseTo(expected, 1);
  });

  it('anti-aliased edges do not wash out the text colour', () => {
    const img = image(80, 24, WHITE);
    strokes(img, { x: 0, y: 0, w: 80, h: 24 }, BLACK, WHITE, true);
    expect(pixelContrast(colorClusters(img)!)).toBeGreaterThan(18);
  });

  it('white text on an orange button: background is the fill', () => {
    const img = image(120, 40, ORANGE);
    strokes(img, { x: 0, y: 0, w: 120, h: 40 }, WHITE, ORANGE);
    const c = colorClusters(img)!;
    expect(c.background).toMatchObject({ r: ORANGE[0], g: ORANGE[1], b: ORANGE[2] });
    expect(pixelContrast(c)).toBeCloseTo(contrastRatio(rgba(WHITE), rgba(ORANGE)), 1);
  });

  it('a uniform crop has no text cluster, and a tiny crop is not measured', () => {
    const c = colorClusters(image(40, 20, WHITE))!;
    expect(c.foreground).toBeNull();
    expect(pixelContrast(c)).toBeNull();
    expect(colorClusters(image(3, 3, WHITE))).toBeNull();
  });

  it('ignores faint noise below the text-cluster distance', () => {
    const img = image(40, 20, WHITE);
    for (let x = 0; x < 40; x += 2) paint(img, x, 5, 1, 10, [250, 250, 250]);
    expect(colorClusters(img)!.foreground).toBeNull();
  });
});

describe('cropBox', () => {
  it('scales the CSS box by devicePixelRatio and clamps to the image', () => {
    const img = image(100, 100, WHITE);
    paint(img, 20, 20, 10, 10, BLACK); // CSS box (10,10,5,5) at dpr 2
    const crop = cropBox(img, { x: 10, y: 10, w: 5, h: 5 }, 2);
    expect([crop.width, crop.height]).toEqual([10, 10]);
    expect([...crop.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    const edge = cropBox(img, { x: 90, y: 90, w: 30, h: 30 }, 1);
    expect([edge.width, edge.height]).toEqual([8, 8]); // inset 2px, clamped at 100
  });

  it('insets larger boxes so a 1px border does not become the text colour', () => {
    const img = image(100, 40, WHITE);
    paint(img, 0, 0, 100, 1, BLACK);
    paint(img, 0, 39, 100, 1, BLACK);
    paint(img, 0, 0, 1, 40, BLACK);
    paint(img, 99, 0, 1, 40, BLACK);
    strokes(img, { x: 0, y: 0, w: 100, h: 40 }, GREY, WHITE);
    const c = colorClusters(cropBox(img, { x: 0, y: 0, w: 100, h: 40 }, 1))!;
    expect(pixelContrast(c)).toBeCloseTo(contrastRatio(rgba(GREY), rgba(WHITE)), 1);
  });
});

describe('pageBackground', () => {
  it('is the most common colour of the frame', () => {
    const img = image(200, 100, [245, 245, 245]);
    paint(img, 10, 10, 50, 30, ORANGE);
    expect(pageBackground(img)).toMatchObject({ r: 245, g: 245, b: 245 });
  });
});

describe('pixelBoxes', () => {
  const vp = { w: 1000, h: 800 };
  const rects = new Map<string, Rect>([
    ['ok', { x: 10, y: 10, w: 80, h: 20 }],
    ['off', { x: 10, y: 790, w: 80, h: 20 }],
    ['left', { x: -5, y: 10, w: 80, h: 20 }],
    ['tiny', { x: 10, y: 10, w: 4, h: 20 }],
    ['huge', { x: 0, y: 0, w: 1000, h: 400 }],
    ['dlg', { x: 10, y: 10, w: 80, h: 20 }],
    ['box', { x: 10, y: 10, w: 16, h: 16 }],
    ['icon', { x: 10, y: 10, w: 24, h: 24 }],
  ]);
  const cands = [
    cand('ok', 'control'),
    cand('off', 'price'),
    cand('left', 'price'),
    cand('tiny', 'control'),
    cand('huge', 'text'),
    cand('dlg', 'dialog'),
    cand('box', 'checkbox'),
    cand('icon', 'control', ''),
    cand('gone', 'control'),
  ];

  it('keeps only fully on-screen, reasonably sized, non-dialog, non-checkbox candidates', () => {
    const boxes = pixelBoxes(cands, rects, vp);
    expect(boxes.map((b) => b.id)).toEqual(['ok', 'icon']);
    expect(boxes.find((b) => b.id === 'icon')!.text).toBe(false);
  });
});

describe('refineFromPixels and applyPixelRefinement', () => {
  it('measures each box against the page background and updates featureSource', () => {
    const img = image(400, 200, WHITE);
    paint(img, 20, 20, 120, 40, ORANGE);
    strokes(img, { x: 20, y: 20, w: 120, h: 40 }, WHITE, ORANGE);
    strokes(img, { x: 200, y: 20, w: 60, h: 20 }, GREY, WHITE);
    const boxes = [
      { id: 'accept', rect: { x: 20, y: 20, w: 120, h: 40 }, text: true },
      { id: 'decline', rect: { x: 200, y: 20, w: 60, h: 20 }, text: true },
      { id: 'icon', rect: { x: 300, y: 20, w: 20, h: 20 }, text: false },
    ];
    const r = refineFromPixels(img, 1, boxes);
    expect(r.accept!.salience).toBeCloseTo(salience(rgba(ORANGE), rgba(WHITE)), 2);
    expect(r.decline!.salience).toBe(0);
    expect(r.decline!.contrast).toBeCloseTo(contrastRatio(rgba(GREY), rgba(WHITE)), 1);
    expect(r.icon!.contrast).toBeUndefined();

    const cands = [cand('accept', 'control'), cand('decline', 'control'), cand('icon', 'control', ''), cand('other', 'price')];
    const out = applyPixelRefinement(cands, r);
    expect(out[1]!.features[2]).toBeCloseTo(r.decline!.contrast!, 5);
    expect(out[1]!.featureSource).toEqual({ f03: 'pixels', f04: 'pixels' });
    expect(out[2]!.featureSource).toEqual({ f03: 'css', f04: 'pixels' });
    expect(out[2]!.features[2]).toBe(7);
    expect(out[3]).toBe(cands[3]);
    expect(cands[1]!.featureSource.f03).toBe('css'); // inputs not mutated
    expect(featureSourceCounts(out)).toEqual({ f03: { pixels: 2, css: 2 }, f04: { pixels: 3, css: 1 } });
  });

  it('a 2x screenshot gives the same answer as 1x', () => {
    const img = image(800, 400, WHITE);
    strokes(img, { x: 400, y: 40, w: 120, h: 40 }, GREY, WHITE);
    const r = refineFromPixels(img, 2, [{ id: 'd', rect: { x: 200, y: 20, w: 60, h: 20 }, text: true }]);
    expect(r.d!.contrast).toBeCloseTo(contrastRatio(rgba(GREY), rgba(WHITE)), 1);
  });
});

describe('capture guards', () => {
  it('allows at most one capture per 2 s', () => {
    const allowed = createCaptureThrottle();
    expect(allowed(10_000)).toBe(true);
    expect(allowed(11_999)).toBe(false);
    expect(allowed(12_000)).toBe(true);
  });

  it('accepts a screenshot only when its size matches the window at its devicePixelRatio', () => {
    expect(imageMatchesFrame({ width: 2560, height: 1600 }, { dpr: 2, width: 1280, height: 800 })).toBe(true);
    expect(imageMatchesFrame({ width: 1280, height: 800 }, { dpr: 2, width: 1280, height: 800 })).toBe(false);
    expect(imageMatchesFrame({ width: 1281, height: 799 }, { dpr: 1, width: 1280, height: 800 })).toBe(true);
  });
});
