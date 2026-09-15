/**
 * The downloadable execution report.
 *
 * A report is an artifact somebody keeps after the page has moved on, so
 * everything the screen qualifies has to be qualified inside the file as well:
 * the coverage of the period, the comparison in the same words the page used,
 * and the refusal where there is nothing honest to compare against. A file that
 * carried the figures and left the caveats on a web page somebody closed would
 * be the same lie by omission the charts are built to avoid.
 *
 * It is built from exactly the data on screen, never re-queried, so the file and
 * the page cannot disagree.
 */
import { csvRow } from './csv';
import type { ExecutionGrain, ExecutionSystem, ExecutionsData } from '../data';

const NOUN: Record<ExecutionGrain, string> = { week: 'week', month: 'month', year: 'year' };

function pct(n: number | null): string {
  return n === null ? '' : `${Math.round(n * 1000) / 10}%`;
}

function ms(n: number | null): string {
  return n === null ? '' : String(n);
}

/** `executions-bays-2026-W38.csv` — the tab and the period it describes. */
export function reportName(system: ExecutionSystem, period: string): string {
  const slug = system.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `executions-${slug}-${period}.csv`;
}

export function buildReport(data: ExecutionsData, system: ExecutionSystem): string {
  const p = system.period;
  const noun = NOUN[data.grain];
  const lines: string[] = [];

  lines.push(csvRow(['BHA engine dashboard — executions']));
  lines.push(csvRow([`${system.label}, by ${noun}`]));
  lines.push(csvRow(['period', p.label, p.start, p.end]));
  lines.push(csvRow(['generated', new Date().toISOString()]));
  lines.push(csvRow(['rows read at', data.source.at ?? 'never']));
  lines.push(
    csvRow([
      'history held',
      data.source.held,
      data.source.oldest ? `from ${data.source.oldest}` : 'nothing held',
      data.source.newest ? `to ${data.source.newest}` : '',
    ]),
  );
  lines.push(csvRow(['source', data.source.note]));
  // Every qualification the page makes, carried into the file.
  if (p.coverage !== 'full') lines.push(csvRow([`coverage: ${p.coverage}`, p.note ?? '']));
  if (data.boundary) lines.push(csvRow(['boundary', data.boundary.note]));
  if (data.source.warning) lines.push(csvRow(['warning', data.source.warning]));
  lines.push('');

  lines.push(csvRow(['comparison', system.comparison.prose]));
  lines.push(csvRow(['against', system.comparison.against_label, system.comparison.note]));
  if (!system.comparison.covered) lines.push(csvRow(['note', 'No figure is given for the previous period, because it is not held. A blank here is an absence, not a zero.']));
  lines.push('');

  lines.push(csvRow(['figure', 'this period', 'previous period', 'change']));
  const c = system.comparison;
  lines.push(csvRow(['executions', p.executions, c.executions?.from ?? '', c.executions?.pct === null || c.executions === null ? '' : `${c.executions.pct}%`]));
  lines.push(csvRow(['succeeded', p.succeeded, c.successes?.from ?? '', c.successes?.pct === null || c.successes === null ? '' : `${c.successes.pct}%`]));
  lines.push(csvRow(['failed', p.failed, c.failures?.from ?? '', c.failures?.pct === null || c.failures === null ? '' : `${c.failures.pct}%`]));
  lines.push(csvRow(['canceled', p.canceled, '', '']));
  lines.push(csvRow(['still running', p.unfinished, '', '']));
  lines.push(csvRow(['failure rate', pct(p.failure_rate), c.failure_rate ? `${c.failure_rate.from}%` : '', c.failure_rate ? `${Math.round((c.failure_rate.to - c.failure_rate.from) * 10) / 10} points` : '']));
  lines.push(csvRow(['average run time (ms)', ms(p.avg_ms), c.avg_ms ? c.avg_ms.from : '', c.avg_ms?.pct === null || !c.avg_ms ? '' : `${c.avg_ms.pct}%`]));
  lines.push(csvRow(['runs timed', p.timed, '', 'the average is over these, not over every execution']));
  lines.push('');

  lines.push(csvRow(['workflow', 'workflow id', 'system', 'executions', 'succeeded', 'failed', 'canceled', 'still running', 'failure rate', 'average run time (ms)', 'runs timed', 'failing execution ids']));
  for (const w of system.workflows) {
    lines.push(
      csvRow([
        w.workflow_name,
        w.workflow_id,
        w.system ?? 'unregistered — no workflow registry row names a system for it',
        w.executions,
        w.succeeded,
        w.failed,
        w.canceled,
        w.unfinished,
        pct(w.failure_rate),
        ms(w.avg_ms),
        w.timed,
        w.failed_ids.join(' '),
      ]),
    );
  }
  lines.push('');

  lines.push(csvRow([`every ${noun} held`, '', '', '', '', '']));
  lines.push(csvRow([noun, 'from', 'to', 'executions', 'succeeded', 'failed', 'failure rate', 'average run time (ms)', 'coverage', 'note']));
  for (const period of system.periods) {
    // A period with no coverage carries no figures at all — blank, never nought,
    // for the same reason the chart draws no bar for it.
    const none = period.coverage === 'none';
    lines.push(
      csvRow([
        period.label,
        period.start,
        period.end,
        none ? '' : period.executions,
        none ? '' : period.succeeded,
        none ? '' : period.failed,
        none ? '' : pct(period.failure_rate),
        none ? '' : ms(period.avg_ms),
        period.coverage,
        period.note ?? '',
      ]),
    );
  }

  return lines.join('\r\n');
}
