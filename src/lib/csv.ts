/**
 * CSV export.
 *
 * Exports exactly what the view shows — the rows already filtered by the page,
 * in the order they are on screen — so the file and the screen can never
 * disagree. Every export carries the record's natural key (`loop_id`,
 * `pattern_id`, `card_id`, the question's record id) so an exported row can be
 * traced back to Airtable.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/**
 * Quotes a cell.
 *
 * The leading apostrophe on a cell starting with `=`, `+`, `-` or `@` is
 * deliberate: a spreadsheet reads those as the start of a formula, and these
 * exports carry free text written by builders and by agents. A loop titled
 * "=cmd|..." is a real, if unlikely, way to hand somebody a hostile file, and
 * an export nobody can trust to open is not an export.
 */
function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(','));
  // CRLF, which is what the spec says and what Excel wants.
  return [head, ...body].join('\r\n');
}

/**
 * Hands the file to the browser.
 *
 * A BOM so Excel reads it as UTF-8 rather than mangling every em dash and
 * every name with an accent in it — the record titles here are full of both.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `codex-2026-09.csv`, or `codex-all-months.csv` when no month is selected. */
export function csvName(kind: string, month: string | null): string {
  return `${kind}-${month ?? 'all-months'}.csv`;
}
