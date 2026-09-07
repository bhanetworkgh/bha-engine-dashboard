import type { OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { EmptyState, RowAction, RowActions, SourceLink } from '../../components/ui';
import { act, ageTone } from '../../lib';

/** Proposed closes for stale loops. Nothing ever closes automatically. */
export function ReviewQueue({ data }: { data: OpenLoopsData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-line px-4 py-1.5 text-[11px] text-faint">
        Proposed closes for stale loops. Each carries its supporting citation. Nothing
        closes automatically — approve or reject each one.
      </p>
      {data.review_queue.length === 0 ? (
        <EmptyState>Nothing is currently proposed for closing.</EmptyState>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {data.review_queue.map((p) => (
            <div key={p.id} className="rowlike border-b border-line px-4 py-2">
              <div className="flex items-baseline gap-3">
                <span className={`tabular ${ageTone(p.age_days)}`}>{p.age_days}d</span>
                <span className="tabular text-faint">{p.loop_id}</span>
                <span className="min-w-0 flex-1">{p.title}</span>
                <span className="text-dim">{BUILDER_NAMES[p.owner] ?? p.owner}</span>
                <RowActions>
                  <RowAction label="approve close" onClick={() => act('review.approve', p.id)} />
                  <RowAction label="reject" onClick={() => act('review.reject', p.id)} />
                </RowActions>
              </div>
              <div className="mt-0.5 max-w-[92ch] text-dim">{p.reason}</div>
              <blockquote className="mt-1 max-w-[92ch] border-l border-line pl-2 text-faint italic">
                “{p.citation.text}” <SourceLink source={p.citation.source} />
              </blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
