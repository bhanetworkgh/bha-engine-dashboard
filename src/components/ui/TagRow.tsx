import type { Tags } from '../../data';

const TAG_LABEL: Record<keyof Tags, string> = {
  pay_eligible: 'pay eligible',
  is_incident: 'incident',
  self_healed: 'self healed',
};

/** Tags render the same way wherever they appear: small, quiet, bordered. */
export function TagRow({ tags }: { tags: Tags }) {
  const on = (Object.keys(TAG_LABEL) as (keyof Tags)[]).filter((k) => tags[k]);
  if (!on.length) return null;
  return (
    <span className="inline-flex gap-1.5 align-middle">
      {on.map((k) => (
        <span key={k} className="border border-line px-1 text-[10px] leading-[15px] text-faint">
          {TAG_LABEL[k]}
        </span>
      ))}
    </span>
  );
}
