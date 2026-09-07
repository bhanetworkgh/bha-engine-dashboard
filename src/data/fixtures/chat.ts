/**
 * Phase 1 fixtures — Ask Bays stored conversations.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { ChatThread } from '../types';

export const CHAT_THREADS: ChatThread[] = [
  {
    id: 'CH-04',
    title: 'Which loops block telemetry v1',
    updated_at: '2026-09-07 11:20',
    messages: [
      { id: 'm1', role: 'user', text: 'Which of my open loops actually block the telemetry v1 wiring?', at: '2026-09-07 11:18' },
      { id: 'm2', role: 'bays', text: 'Four of the ninety-six. LOOP-1785851330871-T2OC is the wiring itself. LOOP-1787058744219-WNEM blocks it because the envelope is not signed off, so anything emitted now is emitted against a shape that may change. LOOP-1786540233107-GC8B blocks it because the per-builder migration is still producing rows in the wrong tables, and telemetry over an inconsistent source records the inconsistency. LOOP-1787318033411-M2XA blocks the proof rather than the build — without a generalised checklist there is no bar to say it worked.\n\nThe other ninety-two do not block it.', at: '2026-09-07 11:20' },
    ],
  },
  {
    id: 'CH-03',
    title: 'Why did the digest post empty',
    updated_at: '2026-09-06 08:22',
    messages: [
      { id: 'm1', role: 'user', text: 'The Codex digest posted an empty message this morning. Why?', at: '2026-09-06 08:19' },
      { id: 'm2', role: 'bays', text: 'The render node returned a 200 with no blocks, and until Sept 1 nothing checked the body — only the status code. Assert Digest Slack OK now catches that case, which is why this one opened as INC-4B8D15 rather than passing silently. It self-healed on the retry at 08:17.\n\nThe six days before Sept 1 are not recoverable. Nothing recorded what those digests should have contained.', at: '2026-09-06 08:22' },
    ],
  },
  {
    id: 'CH-02',
    title: 'vFarm readiness for Halloween',
    updated_at: '2026-09-05 19:40',
    messages: [
      { id: 'm1', role: 'user', text: 'Is vFarm on track for Halloween?', at: '2026-09-05 19:38' },
      { id: 'm2', role: 'bays', text: 'I cannot answer that honestly yet. The readiness endpoint that would carry the answer is not built — it is named in the contract as /clusters/:id/readiness and specced, not shipped.\n\nWhat I can tell you is what is live: sensor rollups are current across four places, two alerts are open, and the mechanical spec landed Aug 31 against the measured rig rather than guessed numbers. Burn-in cycles are not emitting events, so there is no burn-in record to read.', at: '2026-09-05 19:40' },
    ],
  },
  {
    id: 'CH-01',
    title: 'Error classes and what retries',
    updated_at: '2026-09-02 15:04',
    messages: [
      { id: 'm1', role: 'user', text: 'Remind me which error classes auto-retry.', at: '2026-09-02 15:03' },
      { id: 'm2', role: 'bays', text: 'One of the five. NETWORK_TIMEOUT retries, up to three times at five-minute intervals.\n\nBILLING_QUOTA, CONFIG_AUTH and SCHEMA_VALIDATION never retry — retrying a dead credential or a rejected schema fails identically. UNKNOWN does not retry either, because nothing has established that it is safe to.', at: '2026-09-02 15:04' },
    ],
  },
];
