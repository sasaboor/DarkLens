// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  composite,
  contrastRatio,
  deltaE76,
  effectiveBackground,
  hsvSaturation,
  parseColor,
  relativeLuminance,
  textColor,
} from './color';
import { fakeLayout, fixture } from './testing';

const hex = (s: string) => parseColor(s)!;

describe('parseColor', () => {
  it('reads rgb() and rgba() in comma and space syntax', () => {
    expect(parseColor('rgb(15, 94, 90)')).toEqual({ r: 15, g: 94, b: 90, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgba(0, 0, 0, .5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(255 128 0 / 25%)')).toEqual({ r: 255, g: 128, b: 0, a: 0.25 });
  });

  it('reads hex, names and transparent', () => {
    expect(parseColor('#fff')).toEqual(WHITE);
    expect(parseColor('#0f5e5a')).toEqual({ r: 15, g: 94, b: 90, a: 1 });
    expect(parseColor('#00000080')!.a).toBeCloseTo(0.5, 2);
    expect(parseColor('black')).toEqual(BLACK);
    expect(parseColor('transparent')!.a).toBe(0);
  });

  it('reads color(srgb), oklab() and oklch()', () => {
    expect(parseColor('color(srgb 1 0 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    const white = parseColor('oklch(1 0 0)')!;
    expect(white.r).toBeCloseTo(255, 0);
    expect(white.b).toBeCloseTo(255, 0);
    const red = parseColor('oklab(0.628 0.2249 0.1258)')!;
    expect(red.r).toBeGreaterThan(250);
    expect(red.g).toBeLessThan(5);
    expect(parseColor('oklch(62.8% 0.2577 29.23 / 0.5)')!.a).toBe(0.5);
  });

  it('returns null for what it cannot read', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('currentcolor')).toBeNull();
    expect(parseColor('lab(50 20 30)')).toBeNull();
    expect(parseColor('#12')).toBeNull();
  });
});

describe('WCAG contrast', () => {
  it('has luminance 0 for black and 1 for white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });

  it('matches known pairs', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(hex('#767676'), WHITE)).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hex('#777777'), WHITE)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hex('#595959'), WHITE)).toBeCloseTo(7.0, 1);
    expect(contrastRatio(WHITE, hex('#ff0000'))).toBeCloseTo(4.0, 1);
  });

  it('is symmetric', () => {
    expect(contrastRatio(hex('#0f5e5a'), WHITE)).toBeCloseTo(contrastRatio(WHITE, hex('#0f5e5a')), 10);
  });
});

describe('compositing and colour distance', () => {
  it('composites half black over white to mid grey', () => {
    const c = composite({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
    expect(c).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });

  it('leaves the bottom colour under a transparent top', () => {
    expect(composite({ r: 9, g: 9, b: 9, a: 0 }, hex('#0f5e5a'))).toEqual(hex('#0f5e5a'));
  });

  it('measures saturation and distance', () => {
    expect(hsvSaturation(hex('#808080'))).toBe(0);
    expect(hsvSaturation(hex('#ff0000'))).toBe(1);
    expect(deltaE76(WHITE, WHITE)).toBe(0);
    expect(deltaE76(BLACK, WHITE)).toBeCloseTo(100, 0);
  });
});

describe('effectiveBackground', () => {
  it('walks up to the first opaque ancestor', () => {
    fixture('<div style="background-color: #0f5e5a"><p><span id="t">x</span></p></div>');
    expect(effectiveBackground(document.getElementById('t')!, fakeLayout())).toEqual(hex('#0f5e5a'));
  });

  it('composites semi-transparent layers down to white', () => {
    fixture(
      '<div style="background-color: rgb(0, 0, 255)"><div style="background-color: rgba(255, 0, 0, 0.5)"><span id="t">x</span></div></div>',
    );
    const bg = effectiveBackground(document.getElementById('t')!, fakeLayout());
    expect(bg.r).toBeCloseTo(127.5, 5);
    expect(bg.g).toBe(0);
    expect(bg.b).toBeCloseTo(127.5, 5);
  });

  it('is white when nothing has a background', () => {
    fixture('<span id="t">x</span>');
    expect(effectiveBackground(document.getElementById('t')!, fakeLayout())).toEqual(WHITE);
  });

  it('uses the first stop of a gradient', () => {
    fixture('<div style="background-image: linear-gradient(90deg, rgb(124, 45, 18), rgb(194, 65, 12))"><b id="t">x</b></div>');
    expect(effectiveBackground(document.getElementById('t')!, fakeLayout())).toEqual({ r: 124, g: 45, b: 18, a: 1 });
  });

  it('composites a translucent text colour over the background', () => {
    fixture('<span id="t" style="color: rgba(0, 0, 0, 0.5)">x</span>');
    const el = document.getElementById('t')!;
    expect(textColor(el, fakeLayout(), WHITE)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });
});
