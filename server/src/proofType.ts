/**
 * Test or real, on every "does now" claim (8 Nov 2026, Destiny — Jason on the 7 Nov log,
 * C0AFPJ5S1C1 1794079823.258049: "formalizing a simple proof_type distinction (test_forced vs
 * live_natural) anywhere we're claiming 'does now', so we never overstate what's been proven under
 * real conditions"). The SOP "SOP -- Proof Type: Test Forced vs Live Natural" is the written rule.
 *
 *   test_forced   proven by something we made happen on purpose: a forced failure, a test call, a
 *                 dry run that wrote, a test button, a fixture, a staged event.
 *   live_natural  proven by something that happened on its own, in real use, with nobody setting it off.
 *
 * A claim that carries neither is `not_stated`, and is never read as live: an agent that has only a
 * test_forced or not_stated proof says the thing was tested, never that it works in real use.
 */
export const PROOF_TYPES = ['test_forced', 'live_natural'] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export const PROOF_RULE =
  'A "works now" claim says how it was proven: test_forced (we made it happen: a forced failure, a test call, a test button, a fixture) or live_natural (it happened on its own in real use). Neither stated reads as not proven live. Only live_natural may be described as working in real use; test_forced is "tested", never "live".';

export class ProofTypeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Pure: a given proof_type, checked; null when none was given. An unknown value is refused, never guessed. */
export function parseProofType(v: unknown, where = 'proof_type'): ProofType | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if ((PROOF_TYPES as readonly string[]).includes(s)) return s as ProofType;
  throw new ProofTypeError(`${where} is test_forced (we made it happen) or live_natural (it happened on its own in real use); got "${String(v)}".`);
}

/** Pure: what to call a proof in words, for a reader. */
export function proofLabel(p: ProofType | null | undefined): string {
  return p === 'live_natural' ? 'proven in real use' : p === 'test_forced' ? 'proven by a forced test only' : 'how it was proven is not stated';
}
