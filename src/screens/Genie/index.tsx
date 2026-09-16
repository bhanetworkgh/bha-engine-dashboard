import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * Genie, as a placeholder (decision 2026-09-16, Destiny). Same shape and same
 * reason as vFarm and Media Twin — it is a system in the engine, it has a place
 * in the Systems group, and nothing it does writes a row here yet.
 */
export default function Genie() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Genie" subtitle="The Genie services" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="Genie is not wired to the engine yet" min={200}>
          Nothing Genie does reaches this dashboard today. Its executions are counted on the Executions page, under whichever system
          the workflow registry files them; everything else about it waits on rows that are not written yet.
        </ComingSoon>
      </div>
    </div>
  );
}
