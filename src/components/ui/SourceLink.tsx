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
      className="text-faint underline decoration-line underline-offset-2 hover:text-gold hover:decoration-gold-dim"
    >
      {SOURCE_LABEL[source.kind]}
    </a>
  );
}
