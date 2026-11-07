/**
 * Guards the hard rules in CLAUDE.md that the report relies on: detection code
 * never reads data-dp-* ground truth or input values, makes no network
 * requests, and stays free of chrome.* so it runs in tests and Playwright.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = dirname(fileURLToPath(import.meta.url));
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** Drops comments so documentation may mention what the code must not do. */
function code(file: string): string {
  return readFileSync(join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN: [string, RegExp][] = [
  ['data-dp-* ground truth', /data-dp|dataset\.dp/],
  ['input values', /\.value\b|\.valueAsNumber\b|\.selectedOptions\b/],
  ['chrome.* / browser.* APIs', /\bchrome\.|\bbrowser\./],
  ['network requests', /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/],
];

describe('src/core hard rules', () => {
  it('has source files to check', () => {
    expect(SOURCES).toContain('extractor.ts');
    expect(SOURCES).toContain('features.ts');
  });

  for (const file of SOURCES) {
    it(`${file} reads no ground truth or input values, calls no chrome.* and makes no requests`, () => {
      const src = code(file);
      for (const [what, re] of FORBIDDEN) expect(re.test(src), `${file} touches ${what}`).toBe(false);
    });
  }
});
