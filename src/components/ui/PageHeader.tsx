import type { ReactNode } from 'react';

/**
 * Title, optional subtitle, and a slot on the right for in-page controls.
 * Every screen opens with this so the rhythm is identical from page to page.
 */
export function PageHeader({
  title,
  subtitle,
  right,
  below,
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="shrink-0 px-6 pt-6 pb-3 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="font-display text-[28px] leading-none">{title}</h1>
          {subtitle && <div className="mt-2 text-[14px] text-dim">{subtitle}</div>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {below && <div className="mt-4">{below}</div>}
    </div>
  );
}
