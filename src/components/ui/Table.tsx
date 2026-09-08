import type { ReactNode } from 'react';

/**
 * Scroll container for a dense table, framed as a card. The table itself owns
 * its columns. Pass `flat` to drop the card frame when the table sits inside
 * another card already.
 */
export function TableFrame({ children, flat }: { children: ReactNode; flat?: boolean }) {
  return (
    <div
      className={`scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto md:overflow-auto ${
        flat ? '' : 'card mx-6 mb-6 md:mx-8'
      }`}
    >
      <table className="table-cards w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  );
}

/** Sticky header cell. */
export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium text-faint ${className}`}
    >
      {children}
    </th>
  );
}
