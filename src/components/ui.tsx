import type { ReactNode } from 'react';
import type { Health, Source, Spine, Tags } from '../data';

/* ------------------------------------------------------------- primitives */

/** Healthy states get no colour. Only degraded and failing do. */
export function healthText(h: Health): string {
  return h === 'failing' ? 'text-failing' : h === 'degraded' ? 'text-degraded' : 'text-dim';
}

export function Dot({ health, title }: { health: Health; title?: string }) {
  const bg =
    health === 'failing' ? 'bg-failing' : health === 'degraded' ? 'bg-degraded' : 'bg-faint';
  return (
    <span
      title={title ?? health}
      aria-label={title ?? health}
      className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${bg}`}
    />
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line px-5 py-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[15px] font-medium">{title}</h1>
        {subtitle && <span className="text-faint">{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}

/**
 * Empty states name what is missing and why. Never a shrug, never filler rows.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[62ch] px-5 py-8 text-dim">
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

export function Loading() {
  return <div className="px-5 py-8 text-faint">Loading…</div>;
}

export function LoadFailed({ error }: { error: string }) {
  return (
    <div className="px-5 py-8 text-failing">
      Could not load this section. {error}
    </div>
  );
}

/* ------------------------------------------------------------------ tags */

const TAG_LABEL: Record<keyof Tags, string> = {
  pay_eligible: 'pay eligible',
  is_incident: 'incident',
  self_healed: 'self healed',
};

export function TagRow({ tags }: { tags: Tags }) {
  const on = (Object.keys(TAG_LABEL) as (keyof Tags)[]).filter((k) => tags[k]);
  if (!on.length) return null;
  return (
    <span className="inline-flex gap-1.5 align-middle">
      {on.map((k) => (
        <span
          key={k}
          className="border border-line px-1 text-[10px] leading-[15px] text-faint"
        >
          {TAG_LABEL[k]}
        </span>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- spine */

/** The four-field spine, rendered the same way everywhere it appears. */
export function SpineCells({ spine }: { spine: Spine }) {
  return (
    <>
      <td className="td text-faint tabular">{spine.session_id}</td>
      <td className="td text-dim">{spine.builder_id}</td>
      <td className="td text-faint">{spine.subsystem.toLowerCase()}</td>
      <td className="td text-faint">{spine.lane.toLowerCase()}</td>
    </>
  );
}

export const SPINE_HEADERS = ['session', 'builder', 'subsystem', 'lane'];

/* --------------------------------------------------------------- source */

const SOURCE_LABEL = { slack: 'Slack', airtable: 'Airtable', n8n: 'n8n' } as const;

export function SourceLink({ source }: { source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={`${SOURCE_LABEL[source.kind]} · ${source.ref}`}
      className="text-faint underline decoration-line underline-offset-2 hover:text-gold hover:decoration-gold-dim"
    >
      {SOURCE_LABEL[source.kind]}
    </a>
  );
}

/* --------------------------------------------------------- row actions */

/**
 * Row actions. Revealed on hover or keyboard focus, never buried in a menu.
 * Phase 1 handlers log; the interaction design is the point.
 */
export function RowAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="border border-line px-1.5 py-[1px] text-[11px] text-dim hover:border-gold-dim hover:text-gold focus:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-dim"
    >
      {label}
    </button>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="row-actions inline-flex gap-1 transition-opacity">{children}</span>
  );
}

/** Phase 1 action handler. Every row action routes through here. */
export function act(action: string, id: string, extra?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[action] ${action}`, { id, ...extra });
}

/* ---------------------------------------------------------------- table */

export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel px-2.5 py-1.5 text-left font-medium text-faint ${className}`}
    >
      {children}
    </th>
  );
}

export function Metric({
  label,
  value,
  health = 'ok',
  accent = false,
}: {
  label: string;
  value: string;
  health?: Health;
  accent?: boolean;
}) {
  const tone = accent ? 'text-gold' : health === 'ok' ? 'text-ink' : healthText(health);
  return (
    <div className="border-r border-line px-4 py-2 last:border-r-0">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={`tabular text-[17px] leading-tight ${tone}`}>{value}</div>
    </div>
  );
}
