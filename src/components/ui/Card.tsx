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

/**
 * A metric card that fills its own height. Cards in one grid row are already
 * the same height (grid stretches them); this makes their *content* fill that
 * height rather than leaving a card of 100px holding 10px of text — the title
 * at the top, the body growing into whatever is left, and the footnote sitting
 * on the floor of the card.
 */
export function MetricCard({
  title,
  right,
  note,
  children,
  className = '',
  align = 'center',
  noteMinLines,
}: {
  title: ReactNode;
  right?: ReactNode;
  /** The caveat or definition, pinned to the bottom edge so every card in a row lines up. */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Where the body sits when the card is taller than its content. Centred
   * suits a single headline figure. A row of cards that are all bar stacks
   * wants `top`: centring makes a three-bar card start lower than a four-bar
   * one beside it, and they stop reading as one set.
   */
  align?: 'center' | 'top';
  /**
   * A floor under the footnote, in lines, so a row of cards shares one body
   * height. The cards in a row are already the same height; their *bodies* are
   * not, because a footnote that wraps to two lines where its neighbour takes
   * three leaves the charts above them on different baselines. Set it to the
   * longest footnote in the row.
   */
  noteMinLines?: number;
}) {
  return (
    <div className={`card flex h-full min-w-0 flex-col px-5 py-4 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {right && <div className="shrink-0 text-[10.5px] text-faint">{right}</div>}
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${align === 'top' ? 'justify-start' : 'justify-center'}`}>{children}</div>
      {note && (
        // 1.375 is leading-snug; the floor is that many lines of it.
        <div className="mt-3 text-[11.5px] leading-snug text-faint" style={noteMinLines ? { minHeight: `${noteMinLines * 1.375}em` } : undefined}>
          {note}
        </div>
      )}
    </div>
  );
}
