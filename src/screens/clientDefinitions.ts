/**
 * What the Clients page's status words mean, read off the code that computes
 * or writes them (2026-09-22, Destiny's brief, rule (b)).
 *
 * Read for this file:
 *
 *   server/src/sources.ts — mapClientLane, mapClientQuestion, mapClientRequest
 *   (every field is read verbatim off the row; nothing is re-derived),
 *   questionNeedsHuman (Research Stuck, Run Count >= 3, or a Quarantined lane),
 *   requestIsOpen and REQUEST_STATUSES / OPEN_CHECKS (read off the live base on
 *   17 Sep 2026).
 *
 *   server/src/engine.ts getClients — overdue (Next Run Due before midnight UTC
 *   today; no due date is not overdue), warming_up (no Last Run At), active
 *   (questions that do not need a human), capped (Run Count >= 3).
 *
 *   server/src/stats.ts clientsSpec and server/src/monthly.ts — "moved" is any
 *   Movement Tag other than "same".
 *
 *   n8n, read only: "Watched Clients — Weekly Clock" (KOZMm2TTFTme5YkQ) —
 *   skips a question at Run Count 3, bumps Run Count by one before sending the
 *   lane to Research Twin, and stamps the lane's Last Run At and Next Run Due
 *   (run time + 7 days). "Research Twin — Tools Router" (zikfpO0wvqzPCQuz),
 *   "UWC - Merge & Compute" / "UWC - Update Row" — writes Movement Tag (the
 *   agent's own tag if it is new, refined, same or contradicted, otherwise
 *   new), Missing Research (confidence came back low), Research Stuck (Run Count
 *   is 3 or more when the answer is written) and Contradicted From. Its report
 *   builder labels the four tags "New this cycle", "Sharpened since last
 *   cycle", "Changed since last cycle" and "Unchanged since last cycle".
 *
 * **Not found in any code:** a writer for Lane Status, Run State, Quarantined,
 * Stuck Cycle Count, Consecutive Error Count or Infra Fix Required. The Weekly
 * Clock, the Tools Router and the Conversational Agent read Lane Status, Run
 * State and Quarantined at most, and write none of them; this dashboard only
 * displays them. So those words are defined by what the page does with them and
 * where they come from, not by a rule nobody has written down.
 */

const NO_WRITER =
  'No workflow in use today writes this field — the Weekly Clock and Research Twin read it at most — so it holds whatever the index row was last given.';

export const LANE_STATUS_DEF = `The index row’s own Lane Status, shown exactly as written; this dashboard computes nothing from it. ${NO_WRITER} The Weekly Clock runs every lane on the index whatever this says.`;

export const RUN_STATE_DEF = `The index row’s own Run State, shown exactly as written. ${NO_WRITER} The page marks stuck and contradicted amber and resolved green; any other value (idle) is plain. A lane’s Run State of stuck is not a question’s Research Stuck and does not count towards needs a human.`;

export const LAST_RUN_DEF = 'Last Run At on the index row. The Weekly Clock stamps it each time it walks the lane, whether or not any question was researched.';

export const OVERDUE_DEF =
  'Next Run Due is before midnight UTC today. A lane with no Next Run Due is undated, not overdue. The Weekly Clock sets Next Run Due to seven days after it last walked the lane.';

export const NEEDS_HUMAN_DEF =
  'Questions where Research Stuck is ticked, or Run Count has reached 3, or whose lane is Quarantined. Research Stuck is ticked by Research Twin when it writes an answer to a question already at 3 runs, and the Weekly Clock skips any question at 3 runs — so nothing else will move one.';

export const QUARANTINED_DEF = `The index row’s Quarantined box. Every question in a quarantined lane counts as needing a human. ${NO_WRITER}`;

export const AT_THREE_DEF = 'Questions whose Run Count is 3 or more. The Weekly Clock adds one to Run Count before each research attempt and skips a question once it reaches 3, until a person moves it.';

export const ACTIVE_DEF = 'Questions in this lane that do not need a human — the ones the weekly loop can still work.';

export const MISSING_RESEARCH_DEF = 'Questions with Missing Research ticked. Research Twin ticks it when the answer it wrote came back low confidence (an unrecognised confidence is recorded as low), and it is retried next week.';

export const WARMING_UP_DEF =
  'The lane has no Last Run At: the Weekly Clock has never walked it. This is read off the run stamp, not off Lane Status, so a lane can be warming up here whatever its Lane Status says.';

export const LAST_UPDATED_HERE_DEF = 'When this lane or any of its questions last changed in this database, and whether the engine, a resync or this page wrote it.';

export const MOVEMENT_TAG_DEFS: Record<string, string> = {
  new: 'New this cycle. Research Twin also writes new when the tag it was given is not one of the four.',
  refined: 'Sharpened since last cycle.',
  same: 'Unchanged since last cycle. The run happened but found nothing new, so it does not count as movement.',
  contradicted: 'Changed since last cycle — the research overturned the earlier answer, which is kept in Contradicted From.',
};

export const MOVEMENT_TAG_DEF = 'Movement Tag, written by Research Twin with each answer: new, refined, same or contradicted. Anything but same counts as movement.';

/** Request statuses, in the pipeline's own order (sources.ts REQUEST_STATUSES). */
export const REQUEST_STATUS_DEFS: Record<string, string> = {
  Requested: 'Still interest, not a commitment. Counted as not yet a commitment.',
  'Under Review': 'Still interest, not a commitment. Counted as not yet a commitment.',
  Confirmed: 'A commitment. Not counted as open.',
  Delivered: 'After Confirmed in the table’s own order. Not counted as open.',
  Declined: 'Settled. Not counted as open, and not coloured.',
};

export const REQUEST_STATUS_UNKNOWN = 'A status the Client Requests table did not have on 17 Sep 2026, or none at all. Counted as not yet a commitment: the unsafe direction is calling something a commitment.';

export const NOT_COMMITTED_DEF =
  'Any request whose Status is not Confirmed, Delivered or Declined — Requested, Under Review, blank, or a status this dashboard has not seen.';

export const OPEN_CHECKS_DEF =
  'The request’s Open Checks, as Airtable holds them: any of Feasibility, Licensing, Food Safety, Pricing and Ownership. Each named check is a confirmation still owed; none named is written as nothing outstanding. The table’s rule is that a request stays Requested or Under Review until every check is cleared — this dashboard shows both and enforces neither.';

export function requestStatusDef(status: string | null): string {
  return (status && REQUEST_STATUS_DEFS[status]) || REQUEST_STATUS_UNKNOWN;
}

export const VIEW_DEFS = {
  Clients: 'Every watched lane on the index, grouped under the Client ID that owns it.',
  Requests: 'The Client Requests table: what each client has asked for, and what is still unconfirmed.',
  Statistics: 'Standing questions month against month, by each question’s own Last Updated.',
} as const;
