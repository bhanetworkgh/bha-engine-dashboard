/**
 * What the twins' status words mean, read off the code that writes them
 * (2026-09-22, Destiny's brief, rule (b)).
 *
 * None of these values is computed by this dashboard. Each is set by the agent
 * at the end of its run and posted to /api/engine/{ns-asks,rt-asks}; the
 * wording here is derived from those nodes, not from guesswork:
 *
 *   North Star — Conversational Agent, "Build Search Log + Job Record" and
 *   "NS - Build Ask Row": Failed if the research step failed or the answer is
 *   empty; else Thin if the answer has no `/\[S\d+\]/` marker; else Refused
 *   (not its lane) if the answer matches the "not my lane / that's a Bays or
 *   Research Twin question" pattern; else Answered. Thin is tested before
 *   Refused, so an uncited refusal is recorded as Thin.
 *
 *   Research Twin — Conversational Agent, "RT - Build Ask Row": Failed if the
 *   answer is empty; else Needs human if the answer says it "needs a
 *   person/human", was "capped after", "requires_human" or was "flagged for
 *   human"; else Thin with no [S#] marker; else Refused if it says the
 *   question should go to North Star or belongs to Bays; else Answered.
 *
 *   Delivered: "Delivered" when the callback node or the Slack post (and its
 *   ok check) ran; "No target" when the run had nowhere to reply;
 *   "Self-delivered" (Research Twin only) when the caller is the weekly
 *   Watched Clients clock, which posts its own file. **Neither agent writes
 *   "Not delivered"**: a Slack post that is refused throws in "Assert Slack
 *   OK", and the run ends before the ask row is written — so a failed delivery
 *   currently leaves no row at all rather than a "Not delivered" one.
 *
 *   Research jobs — Research Twin — Tools Router, "QFR - Build Job Rows" and
 *   "WRF - Gate And Build Append": a job opens Pending; each finding adds one
 *   attempt; a medium or high confidence finding resolves it; a low one leaves
 *   it In Progress, and at the third attempt makes it Capped (needs human).
 */

export const NS_OUTCOME_DEFS: Record<string, string> = {
  Answered: 'An answer carrying at least one [S#] source marker, that does not say the question belongs to another system.',
  Thin: 'An answer came back but carried no [S#] source marker — nothing in it is cited. An uncited refusal is also recorded as Thin.',
  'Refused (not its lane)': 'A cited answer saying the question is Bays’ or Research Twin’s rather than North Star’s.',
  Failed: 'No answer text came back, or the research step itself failed.',
};

export const RT_OUTCOME_DEFS: Record<string, string> = {
  Answered: 'An answer carrying at least one [S#] source marker, that neither escalates nor says the question is another system’s.',
  Thin: 'An answer came back but carried no [S#] source marker — nothing in it is cited.',
  'Needs human': 'The answer itself says it needs a person — it was capped, flagged for a human, or could not be settled without one. Escalating is a correct outcome, not a failure.',
  'Refused (not its lane)': 'A cited answer saying the question should go to North Star or belongs to Bays.',
  Failed: 'No answer text came back.',
};

export const DELIVERY_DEFS: Record<string, string> = {
  Delivered: 'The answer was posted — to the caller’s callback, or to Slack and Slack confirmed it.',
  'No target': 'The ask arrived with nowhere to reply to. Not a failure.',
  'Self-delivered': 'The weekly Watched Clients clock posts its own file during the run, so there was nothing left to send. Not a failure.',
  'Not delivered':
    'Neither agent writes this today. A refused Slack post stops the run before the ask is logged, so a failed delivery leaves no row here — look for the failed run on Executions instead.',
};

export const JOB_STATUS_DEFS: Record<string, string> = {
  Pending: 'Opened by Research Twin and not yet worked. The weekly sweep picks it up.',
  'In Progress': 'Worked at least once; the last finding was low confidence, so it is tried again (up to three attempts).',
  Resolved: 'A finding came back with medium or high confidence, with sources.',
  'Capped (needs human)': 'Three attempts, the last still low confidence. Nothing in the engine will try again — a person has to.',
};
