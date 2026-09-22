import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * Customer Service Twin, as a placeholder (2026-09-22, Destiny). The same shape
 * and the same reason as Media Twin and Genie: it is a system in the engine, it
 * has a place in the Systems group, and nothing it does writes a row here yet —
 * so the page says that, and draws no figure that would imply otherwise.
 */
export default function CsTwin() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Customer Service Twin" subtitle="The customer service twin" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="Customer Service Twin is not wired to the engine yet" min={200}>
          Nothing the Customer Service Twin does reaches this dashboard today. When its workflows run, their executions are counted on
          the Executions page under whichever system the workflow registry files them; everything else about it waits on rows that are
          not written yet.
        </ComingSoon>
      </div>
    </div>
  );
}
