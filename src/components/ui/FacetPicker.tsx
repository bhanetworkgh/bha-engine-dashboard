/**
 * One facet as a compact picker: "All builders (52)", then each value with its
 * count.
 *
 * Built on the Candidates tab (2026-09-24) and shared from 2026-10-05 so the
 * North Star, Research Twin and Genie pages can filter by who asked with the
 * same control. **The counts are the caller's**: a number beside an option has
 * to be what picking it would show, and only the page knows what its other
 * filters leave.
 */
export function FacetPicker({ label, allLabel, value, options, onChange }: { label: string; allLabel: string; value: string | null; options: [string, number][]; onChange: (v: string | null) => void }) {
  const total = options.reduce((n, [, c]) => n + c, 0);
  const missing = value && !options.some(([v]) => v === value);
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-faint">
      <span>{label}</span>
      <select className="input h-[30px] w-auto max-w-[190px] py-0 text-[12px]" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">
          {allLabel} ({total})
        </option>
        {options.map(([v, n]) => (
          <option key={v} value={v}>
            {v} ({n})
          </option>
        ))}
        {missing && <option value={value!}>{value} (0)</option>}
      </select>
    </label>
  );
}

/** A facet's options, most rows first, from the rows the other filters leave. A row with no value is counted under `none`. */
export function facetOptions<T>(rows: T[], of: (r: T) => string | null | undefined, none: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = of(r) || none;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
