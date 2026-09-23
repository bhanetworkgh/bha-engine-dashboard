/**
 * What the Build patterns and Commercial status words mean, read off the code
 * that puts a row there (2026-09-22, Destiny's brief, rule (b)).
 *
 * Code read:
 *
 *   server/src/store.ts — `patternMetrics` (`reuseKey`: blank is "(not set)",
 *   longer than 24 characters or containing whitespace is "(written out in
 *   prose)", anything else is its own word) and `commercialMetrics` (`clear`,
 *   `media_ready`, the confidence and media-readiness mixes, `incomplete`).
 *
 *   server/src/sources.ts — `mapPattern`, `mapOpportunity` (readiness_state is
 *   kept only when it is one of READINESS_STATES = INCUBATE, Research-First,
 *   Media-Ready; anything else reads as null) and COMMERCIAL_REQUIRED /
 *   `incompleteFields`.
 *
 *   n8n "Bays — Commercial & Pattern Extractors" (ftonmTVMzpeTL7AS), read only:
 *   the prompts in "Pat Prep Build Patterns" and "Comm Prep Commercial Opps",
 *   "Comm Parse Opps Response" (which hardcodes routing_state and media_gate),
 *   and "Comm Write Card to Sheet" / "Pat Write Pattern to Sheet", which post
 *   the fields to /api/engine/{commercial,patterns} unchanged.
 *
 * Every word below except "(written out in prose)", "(not set)", "no
 * readiness", "incomplete" and "Nothing left to answer" is a value an LLM step
 * in that workflow writes; nothing in this dashboard computes it. Where the
 * prompt gives no rule for a word beyond naming it, the definition says so
 * rather than inventing one.
 */

const PAT_EXTRACTOR = 'Written by the pattern extractor (n8n "Bays — Commercial & Pattern Extractors") as the model answered it';
const COMM_EXTRACTOR = 'Written by the commercial extractor (n8n "Bays — Commercial & Pattern Extractors") as the model answered it';

/** Build patterns — the reusability buckets, keyed as `reuseKey` spells them. */
export const REUSE_DEFS: Record<string, string> = {
  Broad: `reusability is exactly "Broad". ${PAT_EXTRACTOR}: the prompt asks "how broadly this pattern can be reused (Narrow, Moderate, or Broad)" and gives no further rule for any of the three.`,
  Moderate: `reusability is exactly "Moderate". ${PAT_EXTRACTOR}: the prompt asks "how broadly this pattern can be reused (Narrow, Moderate, or Broad)" and gives no further rule for any of the three.`,
  Narrow: `reusability is exactly "Narrow". ${PAT_EXTRACTOR}: the prompt asks "how broadly this pattern can be reused (Narrow, Moderate, or Broad)" and gives no further rule for any of the three.`,
  '(written out in prose)':
    'reusability is longer than 24 characters or contains a space, so it is a sentence rather than one of Narrow, Moderate or Broad. This dashboard groups every such answer here rather than drawing a bar per sentence; open the pattern to read it.',
  '(not set)': 'The row carries no reusability at all.',
};

/** Commercial — confidence, as the commercial extractor's prompt (section 5) defines it. */
export const CONFIDENCE_DEFS: Record<string, string> = {
  High: `${COMM_EXTRACTOR}. Its rule: a working system or strong prototype, a named user type, and a clear sale path.`,
  Medium: `${COMM_EXTRACTOR}. Its rule: a strong internal capability with the buyer or packaging somewhat inferred. The prompt says to prefer Medium when in doubt.`,
  Low: `${COMM_EXTRACTOR}. Its rule: a pain point hinted at but the path to product is fuzzy.`,
  '(not set)': 'The card carries no confidence at all.',
};

/** Commercial — media_readiness. The prompt defines High only; Medium and Low have no rule of their own. */
export const MEDIA_DEFS: Record<string, string> = {
  High: `${COMM_EXTRACTOR}, asked "honest and safe to market today?". Its rule: only High if infra and data readiness are both at least Medium and the offer can be put in front of a buyer today without hand-waving.`,
  Medium: `${COMM_EXTRACTOR}, asked "honest and safe to market today?". The prompt gives no rule for Medium beyond "not High".`,
  Low: `${COMM_EXTRACTOR}, asked "honest and safe to market today?". The prompt gives no rule for Low beyond "not High".`,
  '(not set)': 'The card carries no media_readiness at all — one of the fields a complete extractor run writes.',
};

/** Commercial — readiness_state, as `mapOpportunity` keeps it. */
export const READINESS_DEFS: Record<string, string> = {
  'Research-First': `readiness_state is "Research-First". ${COMM_EXTRACTOR}. The prompt says it is "derived mechanically" from infra, data and media readiness but gives no rule for the derivation, so the model decides it.`,
  'Media-Ready': `readiness_state is "Media-Ready". ${COMM_EXTRACTOR}, or set here with "Set media-ready". The prompt says it is "derived mechanically" from infra, data and media readiness but gives no rule for the derivation, so the model decides it.`,
  INCUBATE: 'readiness_state is "INCUBATE". An option of the field that this page can set; the extractor never writes it (its prompt offers Research-First, Media-Ready and Outbound-Ready).',
  none: 'readiness_state is blank, or holds a value this page does not know — anything other than INCUBATE, Research-First or Media-Ready, which includes the extractor’s own Outbound-Ready.',
};

/** Commercial — the pipeline fields on the card view. Hardcoded or defaulted by the extractor, advanced by nothing yet. */
export const PIPELINE_DEFS: Record<string, string> = {
  pilot_state: `${COMM_EXTRACTOR}: research_only (the default — no named external pilot has completed), pilot_validated (a named external pilot completed with a documented before/after metric) or offer_ready (a named external client has committed to or is paying for the offer).`,
  routing_state: 'Hardcoded to research_loop by the extractor ("Comm Parse Opps Response"), never asked of the model. Process Twin is the only system that would advance it.',
  media_gate: 'Hardcoded to CLOSED by the extractor ("Comm Parse Opps Response"), never asked of the model. It opens only once Process Twin confirms real pilot proof exists.',
  lane_state: 'Not written by the extractor workflow as it stands; the value is whatever an earlier writer left on the card. Nothing in this dashboard or the extractor defines it.',
};

/** Commercial — the two words this dashboard computes itself. */
export const INCOMPLETE_DEF =
  'The card is missing at least one of created_at, readiness_state, media_readiness or pilot_state — the fields a complete extractor run writes (COMMERCIAL_REQUIRED in the server). A malformed record, not a readiness of its own.';

export const CLEAR_DEF =
  'The card’s missing_research_count is 0 and it lists no question in missing_research_questions. A 0 beside listed questions is not believed: the extractor (“Comm Write Card to Sheet”) posts missing_research_count as a literal 0 on every new card, so there the listed questions are counted instead. A card stating neither is not counted as clear.';
