/** In-page sub-tabs. Text with a hairline indicator, no boxes. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  counts,
  soon,
  titles,
}: {
  tabs: readonly T[];
  /** What each tab is, as a tooltip (2026-09-22). */
  titles?: Partial<Record<T, string>>;
  value: T;
  onChange: (t: T) => void;
  counts?: Partial<Record<T, { n: number; tone?: 'default' | 'degraded' | 'failing' }>>;
  /** Tabs whose capability does not exist yet. Marked before the reader clicks, not after. */
  soon?: readonly T[];
}) {
  return (
    // Scrolls inside itself rather than clipping: five tabs do not fit across a
    // phone, and a tab whose label is cut in half is a tab nobody can read.
    <div role="tablist" className="scroll-thin flex items-center gap-5 overflow-x-auto border-b border-line">
      {tabs.map((t) => {
        const c = counts?.[t];
        return (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={value === t}
            onClick={() => onChange(t)}
            className="tab"
            title={titles?.[t]}
          >
            {t}
            {soon?.includes(t) && <span className="ml-1.5 text-[10.5px] text-faint">soon</span>}
            {c && c.n > 0 && (
              <span
                className={`tabular ml-1.5 text-[11px] ${
                  c.tone === 'failing'
                    ? 'text-failing'
                    : c.tone === 'degraded'
                      ? 'text-degraded'
                      : 'text-faint'
                }`}
              >
                {c.n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control for a small set of mutually exclusive filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string; count?: number; /** What the word means, as a tooltip. */ title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
          {o.count !== undefined && (
            <span className="tabular ml-1.5 text-[11px] text-faint">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
