/**
 * Colour maths for f03 (contrast) and f04 (salience): parsing computed style
 * colours, alpha compositing, WCAG relative luminance and contrast, and the
 * effective background found by walking up the ancestors.
 */
import { ancestors, type Layout } from './layout';

/** sRGB channels 0 to 255, alpha 0 to 1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  olive: [128, 128, 0],
};

const clamp255 = (x: number) => Math.min(255, Math.max(0, x));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A number or percentage; a percentage is scaled by `pctOf`. */
function num(token: string | undefined, pctOf: number): number {
  if (token === undefined || token === 'none') return 0;
  const n = parseFloat(token);
  if (!Number.isFinite(n)) return NaN;
  return token.trim().endsWith('%') ? (n / 100) * pctOf : n;
}

/** Splits "a, b, c / d" or "a b c / d" into channel tokens and an alpha token. */
function splitArgs(inner: string): { parts: string[]; alpha: string | undefined } {
  const [main = '', alpha] = inner.split('/');
  return { parts: main.trim().split(/[\s,]+/).filter(Boolean), alpha: alpha?.trim() };
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp255(Math.round(v * 255 * 1000) / 1000);
}

function srgbToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * Parses the colour formats computed styles produce: rgb()/rgba() (comma or
 * space syntax), hex, a few names, color(srgb ...), oklab() and oklch().
 * Returns null for anything else (lab(), lch(), system colours, currentcolor).
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[s];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const v = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: v(0), g: v(2), b: v(4), a: full.length === 8 ? v(6) / 255 : 1 };
  }

  const fn = /^([a-z]+)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const [, name, inner = ''] = fn;
  const { parts, alpha } = splitArgs(inner);
  // Legacy rgba(r, g, b, a) puts alpha fourth instead of after a slash.
  const alphaToken = alpha ?? ((name === 'rgb' || name === 'rgba') && parts.length === 4 ? parts[3] : undefined);
  const a = alphaToken === undefined ? 1 : clamp01(num(alphaToken, 1));
  let rgb: [number, number, number];

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) return null;
    rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
  } else if (name === 'color') {
    if (parts[0] !== 'srgb' || parts.length < 4) return null;
    rgb = [num(parts[1], 1) * 255, num(parts[2], 1) * 255, num(parts[3], 1) * 255];
  } else if (name === 'oklab') {
    if (parts.length < 3) return null;
    rgb = oklabToRgb(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4));
  } else if (name === 'oklch') {
    if (parts.length < 3) return null;
    const L = num(parts[0], 1);
    const C = num(parts[1], 0.4);
    const h = (parseFloat(parts[2] ?? '0') * Math.PI) / 180;
    rgb = oklabToRgb(L, C * Math.cos(h || 0), C * Math.sin(h || 0));
  } else {
    return null;
  }
  if (rgb.some((c) => !Number.isFinite(c)) || !Number.isFinite(a)) return null;
  return { r: clamp255(rgb[0]), g: clamp255(rgb[1]), b: clamp255(rgb[2]), a };
}

/** Source-over: `top` painted on `bottom`. */
export function composite(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(c: RGBA): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG 2.x contrast ratio, 1 to 21. Both colours are treated as opaque. */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE L*a*b* (D65) of an sRGB colour. */
export function toLab(c: RGBA): [number, number, number] {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. About 2.3 is just noticeable; 50+ is a different colour. */
export function deltaE76(a: RGBA, b: RGBA): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** HSV saturation, 0 for greys, 1 for pure hues. */
export function hsvSaturation(c: RGBA): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max === 0 ? 0 : (max - min) / max;
}

const GRADIENT_STOP = /(?:rgba?|oklch|oklab|color)\([^()]*\)|#[0-9a-f]{3,8}\b/i;

/** An element's own background colour, or the first stop of a gradient background. Null if none. */
export function ownBackground(style: CSSStyleDeclaration): RGBA | null {
  const bg = parseColor(style.backgroundColor);
  if (bg && bg.a > 0) return bg;
  const img = style.backgroundImage || '';
  if (img.includes('gradient(')) {
    const stop = GRADIENT_STOP.exec(img);
    const c = stop ? parseColor(stop[0]) : null;
    if (c && c.a > 0) return c;
  }
  return null;
}

/**
 * The colour behind `el`: walks up the ancestors (across shadow roots)
 * collecting backgrounds until an opaque one, then composites them over white.
 */
export function effectiveBackground(el: Element, layout: Layout): RGBA {
  const layers: RGBA[] = [];
  for (const a of ancestors(el)) {
    const bg = ownBackground(layout.style(a));
    if (!bg) continue;
    layers.push(bg);
    if (bg.a >= 1) break;
  }
  let out = WHITE;
  for (let i = layers.length - 1; i >= 0; i--) out = composite(layers[i]!, out);
  return { ...out, a: 1 };
}

/** `el`'s text colour composited over its background. */
export function textColor(el: Element, layout: Layout, background: RGBA): RGBA {
  const c = parseColor(layout.style(el).color) ?? BLACK;
  return { ...composite(c, background), a: 1 };
}

/** Salience reaches 1 at this CIE76 distance from the page background. */
export const SALIENCE_DELTA_E = 60;

/** f04: 0 to 1, how much `background` stands out from the page background (colour distance, boosted by saturation). Shared by the CSS and pixel paths. */
export function salience(background: RGBA, pageBg: RGBA): number {
  const distanceScore = Math.min(1, deltaE76(background, pageBg) / SALIENCE_DELTA_E);
  return Math.min(1, Math.max(0, distanceScore * (0.5 + 0.5 * hsvSaturation(background))));
}
