import type { OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { EmptyState, RowAction, RowActions, SourceLink } from '../../components/ui';
import { act, ageTone } from '../../lib';

/** Proposed closes for stale loops. Nothing ever closes automatically. */
export function ReviewQueue({ data }: { data: OpenLoopsData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-6 pb-3 text-[11.5px] text-faint md:px-8">
        Proposed closes for stale loops. Each carries its supporting citation. Nothing closes
        automatically — approve or reject each one.
      </p>
      {data.review_queue.length === 0 ? (
        <EmptyState>Nothing is currently proposed for closing.</EmptyState>
      ) : (
        <div className="scroll-thin mx-6 mb-6 min-h-0 flex-1 space-y-3 overflow-y-auto md:mx-8">
          {data.review_queue.map((p) => (
            <div key={p.id} className="card rowlike px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`tabular text-[12px] ${ageTone(p.age_days)}`}>{p.age_days}d</span>
                <span className="min-w-0 flex-1 text-[13.5px] font-medium">{p.title}</span>
                <span className="text-[12px] text-dim">{BUILDER_NAMES[p.owner] ?? p.owner}</span>
                <RowActions>
                  <RowAction label="Approve close" tone="accent" onClick={() => act('review.approve', p.id)} />
                  <RowAction label="Reject" onClick={() => act('review.reject', p.id)} />
                </RowActions>
              </div>
              <div className="mt-1.5 max-w-[92ch] text-[12.5px] text-dim">{p.reason}</div>
              <blockquote className="mt-2 max-w-[92ch] border-l-2 border-line pl-3 text-[12px] leading-relaxed text-faint italic">
                “{p.citation.text}” <SourceLink source={p.citation.source} />
              </blockquote>
              <div className="tabular mt-2 text-[11px] text-faint">{p.loop_id}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
