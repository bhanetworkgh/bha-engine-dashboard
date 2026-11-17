/**
 * How a Decision Watch field grows when something is added to it (17 Nov 2026).
 *
 * DW-1793021830042-3ZQV: Jason asked for one line to be added to the next step, changing
 * nothing else. The 3,000-character limit sent Bays to a rewrite instead, and the intent
 * check rightly refused the rewrite twice (INC-BAYS.AGENT-105, -106). The limit is now
 * 6,000, and a full field says to ask Destiny or Jason, never to rewrite it shorter.
 * An added line that already starts with its own "Update <date>" gets no second label
 * (3ZQV carries "Update 2026-11-13: Update 2026-11-14 (...)" from before this).
 */
export const NEXT_STEP_LIMIT = 6000;
export const REF_LIMIT = 1200;

const DATED = /^update \d{4}-\d{2}-\d{2}\b/i;

/** The field's text after `to` is added to `from`. Text already held is not added twice. */
export function addedField(field: 'sop_refs' | 'ns_refs' | 'next_step', from: string, to: string, now: Date): string {
  if (from.toLowerCase().includes(to.toLowerCase())) return from;
  if (field !== 'next_step') return `${from}; ${to}`;
  return DATED.test(to) ? `${from}\n${to}` : `${from}\nUpdate ${now.toISOString().slice(0, 10)}: ${to}`;
}

export function fieldLimit(field: 'sop_refs' | 'ns_refs' | 'next_step'): number {
  return field === 'next_step' ? NEXT_STEP_LIMIT : REF_LIMIT;
}

/** What a refusal over the limit says. A full next step is never to be rewritten shorter by an agent. */
export function tooLongMessage(field: 'sop_refs' | 'ns_refs' | 'next_step', length: number, adding: boolean): string {
  const limit = fieldLimit(field);
  if (field === 'next_step' && adding) {
    return `next_step would be ${length} characters; the limit is ${limit}. Nothing was written. Do not rewrite the held text shorter to make room: say in the thread that the watch is full and ask Destiny or Jason to trim it.`;
  }
  return `${field} would be ${length} characters; the limit is ${limit}. Send it with replace: true and a shorter text that keeps every part still owed.`;
}
