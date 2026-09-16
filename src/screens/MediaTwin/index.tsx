import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * Media Twin, as a placeholder (decision 2026-09-16, Destiny).
 *
 * It is a system in the engine and it belongs in the Systems group, but nothing
 * it does writes a row to this dashboard yet, so the page says that rather than
 * drawing anything. The same shape vFarm has, for the same reason: a page that
 * looks like instrumentation and is not one is what the no-invented-data rule
 * exists to stop.
 */
export default function MediaTwin() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Media Twin" subtitle="The media and funnel system" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="Media Twin is not wired to the engine yet" min={200}>
          Nothing Media Twin does reaches this dashboard today. When its intakes, segments and funnel state start arriving, they will
          be shown here as they are recorded rather than reconstructed.
        </ComingSoon>
      </div>
    </div>
  );
}
