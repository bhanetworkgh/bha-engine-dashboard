import type { ReactNode } from 'react';

/** Scroll container for a dense table. The table itself owns its columns. */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  );
}

/** Sticky header cell. */
export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel px-2.5 py-1.5 text-left font-medium text-faint ${className}`}
    >
      {children}
    </th>
  );
}
