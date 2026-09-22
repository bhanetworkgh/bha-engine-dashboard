import type { CodexTab } from '../data';

/**
 * What the Codex page's status words mean, read off the code that computes them
 * (2026-09-22, Destiny's brief, rule (b)).
 *
 * Read from, and to be kept in step with:
 *
 *   server/src/sources.ts  mapCodex — `stage`:
 *     needsInput ? 'needs_input'
 *       : approval === 'approved' || approval === 'input added' ? 'approved'
 *       : 'awaiting'
 *   where `needsInput` is the row's `Submission ID` being in the set
 *   store.layer0PendingIds() returns — engine_layer0_holds rows whose
 *   `Status`, lower-cased, is exactly `pending_builder_input` (LAYER0_PENDING)
 *   — and `approval` is codexApproval(`Jason Status`): Approved / Pending /
 *   Input Added, trimmed and case-folded, anything else (empty included) →
 *   'unset'.
 *
 *   sources.ts mapCodex — `has_entry` is `Orchestrator Layer2 Review` being
 *   non-empty; `layer0_flagged` is `Layer0 Flagged` === true; `layer0_missing`
 *   is `Layer0 Missing` parsed as a JSON array.
 *
 *   sources.ts paidState — `Paid` "Yes" → paid, "No" → unpaid, anything else
 *   or absent → null ("not recorded").
 *
 *   `Narration Quality` is read verbatim (str(f['Narration Quality'])). Nothing
 *   in this repository says what earns Excellent, Great or Good — the review
 *   step upstream writes it — so no definition of the tiers is given here.
 *
 * The stage rules are deliberately not printed as a paragraph on the page
 * (decision 2026-09-14, Destiny): they are tooltips on the stage tabs and pills.
 */

export const STAGE_DEFS: Record<CodexTab, string> = {
  approved:
    'Jason Status is Approved or Input Added, and the log’s Submission ID has no row in the Layer 0 parking table whose Status is pending_builder_input.',
  awaiting:
    'Jason Status is Pending, empty, or anything other than Approved or Input Added, and the log’s Submission ID has no row in the Layer 0 parking table whose Status is pending_builder_input.',
  needs_input:
    'The log’s Submission ID has a row in the Layer 0 parking table whose Status is pending_builder_input — whatever Jason Status says. Layer0 Flagged does not place a log here.',
};

/** Jason Status, as codexApproval reads it. Only "input added" is shown as a word of its own. */
export const JASON_STATUS_DEFS = {
  'input added': 'Jason Status is Input Added: Jason has read the log and responded. Counted as approved.',
} as const;

export const COMPLETENESS_DEFS = {
  flagged:
    'Layer0 Flagged is ticked on the row. Nothing clears it when the builder answers, so it means flagged once, ever — it does not place the log at Needs input.',
  missing: 'Named in the row’s Layer0 Missing, the list of what the completeness check found absent.',
} as const;

export const ENTRY_DEFS = {
  none: 'Orchestrator Layer2 Review is empty on this row: no builder codex has been written.',
} as const;

export const PAID_DEFS = {
  paid: 'Paid is Yes on the row.',
  unpaid: 'Paid is No on the row.',
  'not recorded': 'Paid is empty or neither Yes nor No. The field was added after most of the history and nothing backfills it, so this is not read as unpaid.',
} as const;

export const QUALITY_DEF =
  'Narration Quality exactly as the review step wrote it (best first: Excellent, Great, Good). This dashboard does not grade it, and nothing in its code defines the tiers.';
