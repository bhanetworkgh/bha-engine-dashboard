import type { ReactNode } from 'react';

/**
 * Scroll container for a dense table, framed as a card. The table itself owns
 * its columns. Pass `flat` to drop the card frame when the table sits inside
 * another card already.
 */
export function TableFrame({
  children,
  flat,
  grow = true,
  tableClass = '',
  label,
}: {
  children: ReactNode;
  flat?: boolean;
  grow?: boolean;
  /** Extra classes on the table itself — RecordTable passes the row height here. */
  tableClass?: string;
  label?: string;
}) {
  // `grow` makes the frame the page's own scroll region (fills the column).
  // A page that already scrolls as a whole passes grow={false}: the frame
  // then takes its content height and the sticky header sticks to the page.
  return (
    <div
      className={`scroll-thin ${grow ? 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto md:overflow-auto' : 'shrink-0 overflow-x-auto'} ${
        flat ? '' : 'card mx-6 mb-6 md:mx-8'
      }`}
    >
      <table className={`table-cards w-full border-collapse text-[12.5px] ${tableClass}`} aria-label={label}>
        {children}
      </table>
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
