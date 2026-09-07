import type { ReactNode } from 'react';

/**
 * Empty states name what is missing and why. Never a shrug icon, never filler
 * rows, never an invented number to make a panel look complete.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[62ch] px-5 py-8 text-dim">
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
