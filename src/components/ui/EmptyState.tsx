import type { ReactNode } from 'react';

/**
 * Empty states name what is missing and why. Never a shrug icon, never filler
 * rows, never an invented number to make a panel look complete.
 */
export function EmptyState({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={`max-w-[64ch] text-dim ${compact ? 'px-4 py-5' : 'px-6 py-10'}`}>
      <p className="text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * The empty state for a section inside a card — where a chart or a table would
 * be if there were anything to draw. Centred in the space the content would
 * have filled, so the card keeps its height in a row of cards and the reader
 * sees a sentence rather than an axis with nothing on it.
 */
export function EmptyPanel({ children, min = 72 }: { children: ReactNode; min?: number }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-[10px] bg-raised px-4 py-3 text-center" style={{ minHeight: min }}>
      <p className="max-w-[44ch] text-[12px] leading-snug text-dim">{children}</p>
    </div>
  );
}

/**
 * A capability that does not exist yet. Distinct from an empty state: nothing
 * is missing from the data, the thing itself has not been built. Saying so
 * plainly is the rule — never an empty chart that implies it works.
 */
export function ComingSoon({ title, children, min = 140 }: { title: string; children: ReactNode; min?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[14px] bg-raised px-6 py-8 text-center" style={{ minHeight: min }}>
      <span className="tag">Coming soon</span>
      <div className="text-[14px] font-medium text-ink">{title}</div>
      <p className="max-w-[56ch] text-[12.5px] leading-relaxed text-dim">{children}</p>
    </div>
  );
}
