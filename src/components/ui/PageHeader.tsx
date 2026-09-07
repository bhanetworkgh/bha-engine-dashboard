import type { ReactNode } from 'react';

/** Title, optional subtitle, and a slot on the right for in-page sub-tabs. */
export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line px-5 py-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[15px] font-medium">{title}</h1>
        {subtitle && <span className="text-faint">{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}
