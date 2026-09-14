import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * Engine health, as a placeholder (decision 2026-09-14, Destiny).
 *
 * The page held an incident list, a state track and a metrics row — self-heal
 * rate, retries, mean time to resolve — every figure of it computed from phase
 * 1 fixtures. Nothing upstream records an incident into this dashboard, so the
 * numbers were a drawing of a system rather than a reading of one, and the red
 * count badge in the sidebar was counting fixtures.
 *
 * It keeps its place in the sidebar, without the badge. The removed code is in
 * git history.
 */
export default function EngineHealth() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Engine health" subtitle="Incidents and self-healing" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="No incident reaches this dashboard yet" min={200}>
          Nothing upstream records an incident here, so there is no self-heal rate, no retry count and no time to resolve to
          report. When the engine starts writing incidents, this page shows them and the figures that come from them.
        </ComingSoon>
      </div>
    </div>
  );
}
