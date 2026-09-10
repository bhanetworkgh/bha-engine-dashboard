/** In-page sub-tabs. Text with a hairline indicator, no boxes. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  counts,
  soon,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (t: T) => void;
  counts?: Partial<Record<T, { n: number; tone?: 'default' | 'degraded' | 'failing' }>>;
  /** Tabs whose capability does not exist yet. Marked before the reader clicks, not after. */
  soon?: readonly T[];
}) {
  return (
    <div role="tablist" className="flex items-center gap-5 border-b border-line">
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
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && (
            <span className="tabular ml-1.5 text-[11px] text-faint">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
