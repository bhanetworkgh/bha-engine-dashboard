const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09` → `Sep 2026`. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1] ?? month} ${y}`;
}

/** The current month, as the pages spell one. */
export function thisMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Every month from the earliest date in `dates` to this one, newest first and
 * with no gaps — a month nothing happened in is a fact, and a picker that skips
 * it makes the quiet month invisible rather than empty.
 */
export function monthsFrom(dates: (string | null | undefined)[]): string[] {
  const seen = dates.filter((d): d is string => Boolean(d) && /^\d{4}-\d{2}/.test(d!)).map((d) => d.slice(0, 7));
  const current = thisMonth();
  const earliest = seen.length ? [...seen].sort()[0] : current;
  const out: string[] = [];
  let [y, m] = earliest.split('-').map(Number);
  const [ey, em] = current.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out.reverse();
}

/**
 * The month a working tab is showing (2026-09-16, Destiny).
 *
 * The record pages opened on an all-time view, so "submissions" was every
 * submission BHA has ever logged and the figure never moved. They open on the
 * current month now and this is how you leave it. `null` is "All time", kept
 * as the last option because that view is still worth having — it is just no
 * longer what the page assumes you wanted.
 *
 * The statistics tab has its own picker and its own selection: that one chooses
 * which month to *compare*, this one chooses which month to *show*, and tying
 * them together would mean changing one silently changed the other.
 */
export function MonthPicker({
  months,
  value,
  onChange,
  counts,
  allowAll = true,
}: {
  months: string[];
  value: string | null;
  onChange: (m: string | null) => void;
  /** How many rows each month holds, printed beside it. */
  counts?: Record<string, number>;
  /**
   * Whether "All time" is offered. It is not everywhere: the Executions page
   * always shows exactly one month, so an option that quietly means "the
   * current one" would be a lie in a dropdown.
   */
  allowAll?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-faint">
      <span>Month</span>
      <select
        className="input h-[30px] w-auto py-0 text-[12px]"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label="Month to show"
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
            {counts && counts[m] !== undefined ? ` · ${counts[m]}` : ''}
          </option>
        ))}
        {allowAll && <option value="">All time</option>}
      </select>
    </label>
  );
}
