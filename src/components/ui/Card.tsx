import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** A white (or warm-dark) surface with rounded corners and a hairline. */
export function Card({
  children,
  className = '',
  to,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  to?: string;
  onClick?: () => void;
}) {
  if (to) {
    return (
      <Link to={to} className={`card card-hover block ${className}`}>
        {children}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`card card-hover block text-left ${className}`}>
        {children}
      </button>
    );
  }
  return <div className={`card ${className}`}>{children}</div>;
}

/** Card header: a quiet title on the left, an optional control on the right. */
export function CardHeader({
  title,
  right,
  className = '',
}: {
  title: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 px-5 pt-4 pb-2 ${className}`}>
      <h2 className="text-[13px] font-medium text-ink">{title}</h2>
      {right}
    </div>
  );
}

/**
 * A headline number with its label. The value is set in the display face at a
 * size that reads from across a desk; the label stays small and quiet.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  size = 'md',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'degraded' | 'failing' | 'dim';
  size?: 'md' | 'lg';
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent-ink'
      : tone === 'degraded'
        ? 'text-degraded'
        : tone === 'failing'
          ? 'text-failing'
          : tone === 'dim'
            ? 'text-dim'
            : 'text-ink';
  return (
    <div className="min-w-0">
      <div className="kicker truncate">{label}</div>
      <div
        className={`font-display tabular mt-1 leading-none ${toneClass} ${
          size === 'lg' ? 'text-[34px]' : 'text-[24px]'
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 truncate text-[11.5px] text-faint">{hint}</div>}
    </div>
  );
}

const COLS: Record<number, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
  5: 'md:grid-cols-5',
  6: 'md:grid-cols-6',
};

/** A row of stats inside one card, separated by hairlines. Two columns on a phone. */
export function StatStrip({ children, cols, className = '' }: { children: ReactNode; cols: number; className?: string }) {
  return (
    <div className={`card mx-6 mb-4 grid grid-cols-2 md:mx-8 ${COLS[cols] ?? 'md:grid-cols-4'} ${className}`}>
      {children}
    </div>
  );
}

export function StatCell({ children }: { children: ReactNode }) {
  return <div className="border-b border-line px-5 py-4 md:border-r md:border-b-0 md:last:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 md:[&:nth-last-child(-n+2)]:border-b-0">{children}</div>;
}
