import { ComingSoon, PageHeader } from '../../components/ui';

/**
 * Engine health, as a placeholder (decision 2026-09-16, Destiny).
 *
 * **Incidents were already a placeholder** (2026-09-14): nothing upstream
 * records an incident into this dashboard, so there is no self-heal rate, no
 * retry count and no time to resolve.
 *
 * **The execution roll-up that sat above it has come off too.** It was one
 * figure per system for the current week, each linking through to the
 * Executions page — real, but a second drawing of counts the Executions page
 * already draws, and that page answers the same question with the month, the
 * year, the per-workflow breakdown and the failing ids behind it. Two drawings
 * of the same counts drift, and the one a person happens to open first becomes
 * the one they trust. The workflows-in-no-system card went with it: those
 * workflows are the **Archived** tab on Executions, where they are counted
 * rather than only listed.
 *
 * What this page should show when incidents start arriving is the spec that
 * stood in CLAUDE.md before the 14 Sep entry — read it out of git. The removed
 * code is in git history rather than commented out here.
 */
export default function EngineHealth() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Engine health" subtitle="Incidents, retries and self-healing" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
        <ComingSoon title="No incident reaches this dashboard yet" min={200}>
          Nothing upstream records an incident here, so there is no self-heal rate, no retry count and no time to resolve to report.
          What is real today is workflow executions, and those are on the Executions page — which is a different thing: an execution
          that failed and was retried successfully is one failure there and would be one self-healed incident here.
        </ComingSoon>
      </div>
    </div>
  );
}
