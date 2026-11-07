/**
 * Small building blocks shared by the popup, side panel and options page.
 * Styles live in assets/shared.css. Category colours come from
 * src/core/categories.ts and only ever fill dots, stripes and bars, never text,
 * so contrast holds in light and dark mode.
 */
import type { ReactNode } from 'react';
import type { Category } from '../core/categories';
import type { Finding, PageType } from '../core/types';

export type Tone = 'good' | 'warn' | 'bad';

/** Risk bands for the score dial: green below 25, amber 25 to 59, red from 60. */
export function riskLevel(score: number): { label: string; tone: Tone } {
  if (score >= 60) return { label: 'High risk', tone: 'bad' };
  if (score >= 25) return { label: 'Some risk', tone: 'warn' };
  if (score > 0) return { label: 'Low risk', tone: 'good' };
  return { label: 'No risk found', tone: 'good' };
}

export function verdict(count: number): string {
  if (count === 0) return 'No dark patterns found';
  return `${count} dark pattern${count === 1 ? '' : 's'} found`;
}

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  product: 'Product page',
  cart: 'Cart',
  checkout: 'Checkout',
  listing: 'Listing',
  other: 'Other page',
};

export const SOURCE_LABEL: Record<Finding['source'], string> = { rule: 'Rule', model: 'Model', both: 'Rule + model' };

/* ---------- Score dial ---------- */

const DIAL_SWEEP = 270;
const ZONES: { from: number; to: number; tone: Tone }[] = [
  { from: 0, to: 25, tone: 'good' },
  { from: 25, to: 60, tone: 'warn' },
  { from: 60, to: 100, tone: 'bad' },
];

/** Angle in degrees, clockwise from 12 o'clock, for a score on the dial. */
function angleFor(score: number): number {
  return -DIAL_SWEEP / 2 + (DIAL_SWEEP * Math.max(0, Math.min(100, score))) / 100;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number) => {
    const rad = (a * Math.PI) / 180;
    return `${(cx + r * Math.sin(rad)).toFixed(2)} ${(cy - r * Math.cos(rad)).toFixed(2)}`;
  };
  return `M ${pt(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`;
}

/**
 * A 270° red-amber-green dial. Each zone shows as a muted track and fills in
 * its own colour up to the score, so a high score reads green → amber → red.
 */
export function ScoreDial({ score, size = 120 }: { score: number; size?: number }) {
  const { label, tone } = riskLevel(score);
  const c = 60;
  const r = 50;
  const gap = 2; // degrees between zones
  const zoneArc = (from: number, to: number) =>
    arc(c, c, r, angleFor(from) + (from ? gap / 2 : 0), angleFor(to) - (to < 100 ? gap / 2 : 0));
  return (
    <svg
      className="dial"
      width={size}
      height={(size * 104) / 120}
      viewBox="0 0 120 104"
      role="img"
      aria-label={`Risk score ${score} of 100, ${label.toLowerCase()}`}
      data-tone={tone}
    >
      {ZONES.map((z) => (
        <path key={z.tone} className={`dial-zone tone-${z.tone}`} d={zoneArc(z.from, z.to)} />
      ))}
      {ZONES.filter((z) => score > z.from).map((z) => (
        <path key={`v-${z.tone}`} className={`dial-value tone-${z.tone}`} d={zoneArc(z.from, Math.min(score, z.to))} />
      ))}
      <text className="dial-score" x={c} y={c + 6} textAnchor="middle" data-testid="score">
        {score}
      </text>
      <text className="dial-max" x={c} y={c + 24} textAnchor="middle">
        of 100
      </text>
    </svg>
  );
}

/* ---------- Category bits ---------- */

export function CategoryDot({ category }: { category: Category }) {
  return <span className="cat-dot" aria-hidden style={{ background: category.color }} />;
}

export function CategoryChip({ category, count }: { category: Category; count: number }) {
  return (
    <li className="chip" title={category.description}>
      <CategoryDot category={category} />
      <span className="chip-name">{category.name}</span>
      <span className="chip-count">{count}</span>
    </li>
  );
}

/* ---------- Controls ---------- */

/** A checkbox styled as a switch, with its label and optional help text. */
export function Switch({
  checked,
  onChange,
  label,
  help,
  leading,
  testId,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  leading?: ReactNode;
  testId?: string;
}) {
  return (
    <label className="switch-row">
      {leading}
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {help && <span className="switch-help">{help}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

/* ---------- Badges and bars ---------- */

export function Badge({ kind = 'neutral', children }: { kind?: 'neutral' | 'good' | 'warn'; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function ConfidenceBar({ value, color }: { value: number; color: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="conf">
      <span className="conf-label">Confidence</span>
      <span className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Confidence">
        <span className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="conf-value">{pct}%</span>
    </div>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <img src="/icon/32.png" width={20} height={20} alt="" />
      <span>DarkLens</span>
    </span>
  );
}
