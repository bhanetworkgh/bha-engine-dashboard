/**
 * Phase 1 fixtures — builders.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { Builder } from '../types';
import { airtable } from './common';

export const BUILDERS: Builder[] = [
  { id: 'destiny', name: 'Destiny', lane: 'ENGINE_INTERNAL', open_loops: 96, oldest_loop_days: 34, last_activity: '2026-09-07 14:02', contract_status: 'signed', entries_this_week: 3, health: 'degraded', source: airtable('destiny', 'tblBJekl3ROpNZxQW') },
  { id: 'jason', name: 'Jason', lane: 'ENGINE_INTERNAL', open_loops: 18, oldest_loop_days: 21, last_activity: '2026-09-07 10:31', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('jason', 'tblVOLhWULskNiIUt') },
  { id: 'jegan', name: 'Jegan', lane: 'VFARM_CORE', open_loops: 47, oldest_loop_days: 33, last_activity: '2026-09-07 10:07', contract_status: 'signed', entries_this_week: 2, health: 'degraded', source: airtable('jegan', 'tblqMepD3XGZY4tZz') },
  { id: 'kaiqi', name: 'Kaiqi', lane: 'ENGINE_INTERNAL', open_loops: 31, oldest_loop_days: 23, last_activity: '2026-09-07 13:00', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('kaiqi', 'tblOhjIS8t0dtCQmt') },
  { id: 'ahad', name: 'Ahad', lane: 'CLIENT_CORE', open_loops: 22, oldest_loop_days: 19, last_activity: '2026-09-06 16:44', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('ahad', 'tbl3bTRcuUcbYXgDc') },
  { id: 'hardik', name: 'Hardik', lane: 'VFARM_MEDIA', open_loops: 38, oldest_loop_days: 31, last_activity: '2026-09-06 17:51', contract_status: 'pending', entries_this_week: 2, health: 'degraded', source: airtable('hardik', 'tblaloC4JIRdBq5EM') },
  { id: 'kavin', name: 'Kavin', lane: 'VFARM_CORE', open_loops: 16, oldest_loop_days: 24, last_activity: '2026-09-06 20:18', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('kavin', 'tbltm7QUmWAZpzTKz') },
];
