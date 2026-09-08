import type { Tags } from '../../data';

const TAG_LABEL: Record<keyof Tags, string> = {
  pay_eligible: 'pay eligible',
  is_incident: 'incident',
  self_healed: 'self healed',
};

/** Tags render the same way wherever they appear: small, quiet, rounded. */
export function TagRow({ tags }: { tags: Tags }) {
  const on = (Object.keys(TAG_LABEL) as (keyof Tags)[]).filter((k) => tags[k]);
  if (!on.length) return null;
  return (
    <span className="inline-flex gap-1 align-middle">
      {on.map((k) => (
        <span key={k} className="tag">
          {TAG_LABEL[k]}
        </span>
      ))}
    </span>
  );
}

/** A single status-style pill, for cells that need one word with a tone. */
export function Pill({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'degraded' | 'failing' | 'accent' | 'ok';
}) {
  return <span className={`tag ${tone === 'default' ? '' : `tag-${tone}`}`}>{children}</span>;
}
