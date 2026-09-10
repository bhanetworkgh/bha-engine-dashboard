import type { VFarmData } from '../../data';
import { ComingSoon } from '../../components/ui';

/**
 * "Is vFarm on track for Halloween." Readiness is not computed anywhere yet —
 * the endpoint that would answer it is specced and not built — so the panel
 * says so rather than assembling a number out of the readings that would look
 * like an answer and be a guess.
 */
export function Readiness({ data }: { data: VFarmData }) {
  return (
    <div className="min-h-0 flex-1 px-6 pb-6 md:px-8">
      <ComingSoon title={`Readiness for Halloween — ${data.days_to_halloween} days out`} min={200}>
        {data.readiness_note} What is real today is on the Live tab: the places reporting, the last measurement from each, and the alerts still open.
      </ComingSoon>
    </div>
  );
}
