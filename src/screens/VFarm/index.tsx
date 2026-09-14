import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * vFarm, as a placeholder (decision 2026-09-14, Destiny).
 *
 * The page held a live-readings table, a lifecycle timeline and a readiness
 * panel, all drawn from phase 1 fixtures — no rack has ever written a row to
 * this dashboard. A page that looks like instrumentation and is not one is the
 * thing the no-invented-data rule exists to stop, so it says so plainly instead
 * and the fetch behind it is gone rather than left running under a hidden page.
 *
 * It keeps its place in the sidebar. The removed code is in git history.
 */
export default function VFarm() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="vFarm" subtitle="The vertical-farm product" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="vFarm is not wired to the engine yet" min={200}>
          Nothing on the rack writes to this dashboard today. When burn-in cycles, anomalies, growth cycles and measurements start
          arriving, they will be shown here as they are recorded rather than reconstructed.
        </ComingSoon>
      </div>
    </div>
  );
}
