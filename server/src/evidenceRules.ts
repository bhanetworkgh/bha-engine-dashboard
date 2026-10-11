/**
 * Evidence boundaries: what a class of evidence may and may not be used to
 * claim (LOOP-1790871612769-IMFX, Jason's locking message of 4 Oct 2026).
 *
 * These are held in code, not in a prompt, and are returned by both reads an
 * agent uses before saying anything about vFarm: `read_media_doctrine` (what
 * may be claimed) and `read_monitoring_twin` (what the cabinet is doing). A
 * rule here is Jason's, quoted; adding or changing one is a new Architect
 * Answer and a BUILD_LOG line, never a setting.
 */
export const EVIDENCE_CLASSES = {
  cabinet_telemetry: 'Readings and incidents from a real, enrolled vFarm cabinet. The only class that can prove what a cabinet did.',
  agronomy_reference: 'Field or supplier agronomy data and published guidance (Coimbatore PKM 1 ground truth, the crop profile\'s ranges and timings). It says what to expect; it never proves a cabinet did it.',
  simulated: 'A simulated farm (synthetic: true). It proves the twin\'s logic and nothing about a real cabinet.',
} as const;
export type EvidenceClass = keyof typeof EVIDENCE_CLASSES;

export const EVIDENCE_RULES = [
  {
    id: 'COIMBATORE_REFERENCE_ONLY',
    rule: 'Coimbatore data is an agronomy reference only, never cabinet proof.',
    means:
      'Yield, timing, stage or health figures from the Coimbatore field plot, from the supplier\'s nursery, or from the crop profile may be quoted as what is expected. They may not be used to say a vFarm cabinet grew, yielded, reached a stage or met a gate. A claim about a cabinet needs cabinet_telemetry.',
    applies_to: ['agronomy_reference'],
    set_by: 'Jason Bays, 4 Oct 2026 (LOOP-1790871612769-IMFX)',
  },
  {
    id: 'CABINET_CYCLE_STARTS_AT_FIRST_FLOWER',
    rule: 'Cabinet cycle 1 starts at first-flower entry, not at sowing.',
    means:
      'Nursery and vegetative stages happen at the supplier this cycle. They are reference only for cabinet telemetry until a full seed-to-harvest cabinet cycle runs: never infer or report them as stages the cabinet ran.',
    applies_to: ['cabinet_telemetry', 'agronomy_reference'],
    set_by: 'Jason Bays, 4 Oct 2026 (LOOP-1790871612769-IMFX)',
  },
  {
    id: 'SIMULATED_IS_NOT_THE_RACK',
    rule: 'A simulated farm is never described as the real rack.',
    means: 'Its readings, incidents and uptime prove the twin\'s logic only.',
    applies_to: ['simulated'],
    set_by: 'Jason Bays, tomato-first memo, 1 Oct 2026',
  },
  {
    id: 'UPTIME_FROM_INCIDENTS_ONLY',
    rule: 'Uptime is the share of time with no enrolled device OFFLINE, at 90 s STALE and 900 s OFFLINE, counted from the twin\'s incidents and nothing else.',
    means: 'No parallel counter is a source for uptime or for the critical-incident envelope. A figure from anywhere else is not the gate\'s figure.',
    applies_to: ['cabinet_telemetry'],
    set_by: 'Jason Bays, 1 Oct 2026, reconfirmed 4 Oct (LOOP-1790871612769-IMFX)',
  },
] as const;

/** The block both reads return, whole. */
export function evidenceBlock() {
  return {
    classes: EVIDENCE_CLASSES,
    rules: EVIDENCE_RULES,
    note: 'Held in code and returned by read_media_doctrine and read_monitoring_twin. When a rule here and a source disagree, the rule stands. An agent that cannot tell which class a figure belongs to treats it as agronomy_reference: it fails closed.',
  };
}
