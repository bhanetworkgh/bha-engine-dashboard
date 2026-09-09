/**
 * The two vocabularies the browser needs before any request comes back: who
 * the builders are, and what the lanes are.
 *
 * They live here rather than in the fixtures so the client bundle stays free
 * of fixture data — the fixtures are the server's, per CLAUDE.md section 4.
 * Both lists are small and fixed, and both are also held server-side: the
 * builder ids must stay in step with `server/src/store.ts`, which rejects a
 * new loop whose owner is not one of them, and the lanes are the `Lane` union
 * in types.ts, taken from the engine's own vocabulary.
 */

import type { Lane } from './types';

/** Builder id to display name. Ids are what every record's `builder_id` holds. */
export const BUILDER_NAMES: Record<string, string> = {
  destiny: 'Destiny',
  jason: 'Jason',
  jegan: 'Jegan',
  kaiqi: 'Kaiqi',
  ahad: 'Ahad',
  hardik: 'Hardik',
  kavin: 'Kavin',
};

/** Every lane, in the order they are offered in a picker. */
export const LANE_LIST: readonly Lane[] = ['VFARM_CORE', 'VFARM_MEDIA', 'CLIENT_CORE', 'ENGINE_INTERNAL'];
