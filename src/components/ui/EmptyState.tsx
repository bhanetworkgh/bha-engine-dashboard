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
