/**
 * Small inline SVG charts. No library: each is a few dozen lines, draws from
 * the theme's CSS variables so it is correct in both modes, and never shows a
 * value it was not given. Every chart takes real numbers from the data module.
 */
import { useEffect, useState } from 'react';

type Tone = 'ink' | 'accent' | 'degraded' | 'failing' | 'dim';

/** True once, a frame after the signature changes, so a CSS transition can carry the bar to its size. */
function useGrow(signature: string): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no media queries */
    }
    if (reduce) {
      setGrown(true);
      return;
    }
    setGrown(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(raf);
  }, [signature]);
  return grown;
}
const GROW = 'height 640ms cubic-bezier(0.2, 0.7, 0.2, 1)';
const WIDEN = 'width 640ms cubic-bezier(0.2, 0.7, 0.2, 1)';

const STROKE: Record<Tone, string> = {
  ink: 'var(--ink)',
  accent: 'var(--accent)',
  degraded: 'var(--degraded)',
  failing: 'var(--failing)',
  dim: 'var(--dim)',
};

/** A line over time, with a soft fill beneath it and a dot on the last point. */
export function Sparkline({
  values,
  width = 160,
  height = 40,
  tone = 'ink',
  className = '',
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: Tone;
  className?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * w, pad + h - (v / max) * h] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${(pad + w).toFixed(1)},${(pad + h).toFixed(1)} L${pad},${(pad + h).toFixed(1)} Z`;
  const last = pts[pts.length - 1];
  const id = `sp-${tone}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={`Trend: ${values.join(', ')}`}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={STROKE[tone]} stopOpacity="0.18" />
          <stop offset="1" stopColor={STROKE[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={STROKE[tone]} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill={STROKE[tone]} />
    </svg>
  );
}

/** Vertical bars, one per bucket, with the last bar in the accent tone. */
export function Bars({
  values,
  labels,
  height = 64,
  tone = 'ink',
  highlightLast = true,
  replayKey,
  showLabels,
}: {
  values: number[];
  labels?: string[];
  height?: number;
  tone?: Tone;
  highlightLast?: boolean;
  /** Bars grow again from the baseline when this changes. */
  replayKey?: string | number;
  /** Print every label beneath its bar, with its value. */
  showLabels?: boolean;
}) {
  const max = Math.max(1, ...values);
  const grown = useGrow(`${replayKey ?? ''}|${values.join(',')}`);
  return (
    <div>
      <div className="flex w-full items-end gap-[3px]" style={{ height }} role="img" aria-label={`Bars: ${values.join(', ')}`}>
        {values.map((v, i) => {
          const pct = (v / max) * 100;
          const last = highlightLast && i === values.length - 1;
          return (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end self-stretch" title={`${labels?.[i] ?? ''} ${v}`.trim()}>
              <div
                className="w-full rounded-[3px]"
                style={{
                  height: grown ? `${Math.max(pct, v > 0 ? 6 : 2)}%` : '2%',
                  transition: GROW,
                  background: last ? STROKE[tone === 'ink' ? 'accent' : tone] : STROKE[tone],
                  opacity: last ? 1 : v === 0 ? 0.15 : 0.35,
                }}
              />
            </div>
          );
        })}
      </div>
      {showLabels && labels && (
        <div className="mt-1 flex w-full gap-[3px]">
          {labels.map((l, i) => (
            <div key={i} className="min-w-0 flex-1 text-center text-[10.5px] leading-tight text-faint" title={l}>
              <div className="tabular text-[11.5px] text-dim">{values[i]}</div>
              <div className="truncate">{l}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bar with a label and a value, for ranked lists. */
export function HBar({
  label,
  value,
  max,
  tone = 'ink',
  suffix = '',
  right,
  replayKey,
  valueNode,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  tone?: Tone;
  suffix?: string;
  right?: React.ReactNode;
  /** The bar widens again from zero when this changes. */
  replayKey?: string | number;
  /** Replaces the plain number, e.g. a CountUp. */
  valueNode?: React.ReactNode;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const grown = useGrow(`${replayKey ?? ''}|${value}|${max}`);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <div className="truncate text-[12.5px] text-ink">{label}</div>
      <div className="tabular flex items-center gap-2 text-[12px] text-dim">
        <span>
          {valueNode ?? value}
          {suffix}
        </span>
        {right}
      </div>
      <div className="col-span-2 h-[5px] overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full" style={{ width: grown ? `${pct}%` : '0%', transition: WIDEN, background: STROKE[tone], opacity: tone === 'ink' ? 0.55 : 0.85 }} />
      </div>
    </div>
  );
}

/** A ring showing one share of a whole, with the percentage in the middle. */
export function Ring({
  value,
  total,
  size = 72,
  tone = 'ink',
  label,
}: {
  value: number;
  total: number;
  size?: number;
  tone?: Tone;
  label?: string;
}) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? value / total : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(pct * 100)}% ${label ?? ''}`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--raised)" strokeWidth="6" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={STROKE[tone]}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
        />
      </svg>
      <div
        className="font-display tabular absolute inset-0 flex items-center justify-center text-ink"
        style={{ fontSize: size < 44 ? 10 : size < 60 ? 12 : 15 }}
      >
        {total > 0 ? `${Math.round(pct * 100)}%` : '—'}
      </div>
    </div>
  );
}

/** A stacked horizontal band: several parts of one whole, in order. */
export function Band({
  parts,
  height = 8,
}: {
  parts: { value: number; tone: Tone; label: string }[];
  height?: number;
}) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
      {total === 0 ? (
        <div className="h-full w-full bg-raised" />
      ) : (
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div
              key={p.label}
              title={`${p.label}: ${p.value}`}
              style={{ width: `${(p.value / total) * 100}%`, background: STROKE[p.tone], opacity: p.tone === 'ink' ? 0.5 : p.tone === 'dim' ? 0.35 : 0.9 }}
            />
          ))
      )}
    </div>
  );
}
