import type { ReactNode } from 'react';

/**
 * Row actions are revealed on hover or keyboard focus and never buried in a
 * menu. The reveal itself lives in index.css (.row-actions).
 */
export function RowAction({
  label,
  onClick,
  tone = 'default',
  disabled,
}: {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger' | 'accent';
  disabled?: boolean;
}) {
  const toneClass =
    tone === 'danger'
      ? 'hover:text-failing hover:bg-failing-soft'
      : tone === 'accent'
        ? 'hover:text-accent-ink hover:bg-accent-soft'
        : '';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`btn btn-ghost btn-sm focus:opacity-100 ${toneClass}`}
    >
      {label}
    </button>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return <span className="row-actions inline-flex gap-0.5 transition-opacity">{children}</span>;
}
