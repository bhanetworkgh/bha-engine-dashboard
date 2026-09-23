import type { ReactNode } from 'react';
import { Button } from './Button';

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
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`focus:opacity-100 ${toneClass}`}
    >
      {label}
    </Button>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return <span className="row-actions inline-flex gap-0.5 transition-opacity">{children}</span>;
}
