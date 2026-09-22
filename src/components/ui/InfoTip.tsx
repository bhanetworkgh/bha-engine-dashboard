import { useRef, useState, type ReactNode } from 'react';

/**
 * The explanation behind a figure or a word, one hover away (2026-09-22,
 * Destiny).
 *
 * The stat strips carried every figure's whole explanation under it, each a
 * different length, so the row read as a wall. The explanations were right and
 * are kept word for word — they moved here. A caption line stays on the strip;
 * the rest is behind this mark, on hover and on keyboard focus, so it is never
 * mouse-only.
 *
 * Drawn inside its own relative box rather than portalled: the interface runs
 * under CSS `zoom`, and a fixed-position popover placed from
 * `getBoundingClientRect` lands in the wrong place under it in some browsers.
 * It opens towards whichever half of the page has room.
 */
export function InfoTip({ children, label = 'What this means' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [right, setRight] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const el = ref.current;
    if (el) {
      const page = document.documentElement.getBoundingClientRect().width;
      setRight(el.getBoundingClientRect().left > page / 2);
    }
    setOpen(true);
  };
  return (
    <span ref={ref} className="relative inline-flex align-middle" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else show();
        }}
        className="inline-flex h-[14px] w-[14px] shrink-0 cursor-help items-center justify-center rounded-full border border-line-strong text-[9px] leading-none font-semibold text-faint hover:text-dim"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className={`absolute top-[calc(100%+6px)] z-50 block w-[300px] max-w-[80vw] rounded-[12px] bg-panel px-3.5 py-2.5 text-left text-[12px] leading-snug font-normal tracking-normal whitespace-normal normal-case text-dim ${right ? 'right-0' : 'left-0'}`}
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** The caption budget: one line, the same for every figure on a strip. */
export const CAPTION_MAX = 55;

/**
 * A stat's label with its explanation behind a mark, and one caption line under
 * the figure. Used by every strip cell so the budget is enforced in one place.
 */
export function StatLabel({ label, detail }: { label: string; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="kicker truncate">{label}</div>
      {detail ? <InfoTip label={`About ${label.toLowerCase()}`}>{detail}</InfoTip> : null}
    </div>
  );
}

export function StatCaption({ children }: { children: ReactNode }) {
  if (import.meta.env.DEV && typeof children === 'string' && children.length > CAPTION_MAX) {
    console.warn(`Stat caption over ${CAPTION_MAX} characters (${children.length}): "${children}"`);
  }
  return (
    <div className="mt-1.5 truncate text-[11.5px] leading-snug text-faint" title={typeof children === 'string' ? children : undefined}>
      {children}
    </div>
  );
}

/**
 * One definition line under a tab row or a filter, for whichever is selected
 * (2026-09-22). Every status word on these pages is a value somebody else's
 * code wrote, and the reader should not have to have read that code.
 */
export function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="text-[12px] leading-snug text-dim">
      <span className="font-medium text-ink">{term}</span>
      <span className="text-faint"> — </span>
      {children}
    </div>
  );
}
