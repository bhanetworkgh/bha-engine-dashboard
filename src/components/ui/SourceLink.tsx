import type { Source } from '../../data';

const SOURCE_LABEL = { slack: 'Slack', airtable: 'Airtable', n8n: 'n8n' } as const;

/** Every row links back to where it came from. */
export function SourceLink({ source }: { source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={`${SOURCE_LABEL[source.kind]} · ${source.ref}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[12px] text-faint transition-colors hover:text-accent-ink"
    >
      {SOURCE_LABEL[source.kind]}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2 8l6-6M3.5 2H8v4.5" />
      </svg>
    </a>
  );
}
