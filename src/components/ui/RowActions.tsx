import type { ReactNode } from 'react';

/**
 * Row actions are revealed on hover or keyboard focus and never buried in a
 * menu. The reveal itself lives in index.css (.row-actions).
 */
export function RowAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="border border-line px-1.5 py-[1px] text-[11px] text-dim hover:border-gold-dim hover:text-gold focus:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-dim"
    >
      {label}
    </button>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return <span className="row-actions inline-flex gap-1 transition-opacity">{children}</span>;
}
