import type { VFarmData } from '../../data';
import { EmptyState } from '../../components/ui';

/**
 * Readiness is not computed anywhere yet — the endpoint is specced, not built.
 * Rather than guess, this names what is missing.
 */
export function Readiness({ data }: { data: VFarmData }) {
  return (
    <div className="min-h-0 flex-1">
      <EmptyState>{data.readiness_note}</EmptyState>
    </div>
  );
}
