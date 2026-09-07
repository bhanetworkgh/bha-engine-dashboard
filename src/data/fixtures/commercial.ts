/**
 * Phase 1 fixtures — commercial opportunities.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { Opportunity } from '../types';
import { airtable } from './common';

export const OPPORTUNITIES: Opportunity[] = [
  { id: 'CARD-1786722433911-8S9I', title: 'vFarm founding-buyer early access', readiness: 'blocked', health: 'failing', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-09-06', blocker: 'No authorised payment account — cannot accept money.', spine: { session_id: 'SES-20260906-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1786722433911-8S9I', 'tblCommercial') },
  { id: 'CARD-1786808833004-4K2M', title: 'Managed monitoring as a paid contract', readiness: 'researching', health: 'ok', owner: 'kaiqi', lane: 'ENGINE_INTERNAL', last_touched: '2026-09-05', blocker: null, spine: { session_id: 'SES-20260905-KQ-01', builder_id: 'kaiqi', subsystem: 'COMMERCIALOPPS', lane: 'ENGINE_INTERNAL' }, source: airtable('CARD-1786808833004-4K2M', 'tblCommercial') },
  { id: 'CARD-1786895241887-9WQP', title: 'vFarm cabinet pre-orders for the October render', readiness: 'evidence thin', health: 'degraded', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-09-04', blocker: 'Burn-in numbers not yet real; cannot promise performance.', spine: { session_id: 'SES-20260904-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1786895241887-9WQP', 'tblCommercial') },
  { id: 'CARD-1786981644120-1TZB', title: 'Client 2 retained advisory extension', readiness: 'ready to pitch', health: 'ok', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-06', blocker: null, spine: { session_id: 'SES-20260906-AH-01', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1786981644120-1TZB', 'tblCommercial') },
  { id: 'CARD-1787068050339-6JHC', title: 'Client 12 monitoring pilot', readiness: 'researching', health: 'ok', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-01', blocker: null, spine: { session_id: 'SES-20260901-AH-02', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1787068050339-6JHC', 'tblCommercial') },
  { id: 'CARD-1787154466702-3XKD', title: 'Media Twin explainer series as lead generation', readiness: 'idea', health: 'ok', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-08-30', blocker: null, spine: { session_id: 'SES-20260830-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1787154466702-3XKD', 'tblCommercial') },
  { id: 'CARD-1787240871055-8NVG', title: 'Client 9 contradiction audit as a paid engagement', readiness: 'evidence thin', health: 'degraded', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-01', blocker: 'Contradiction state unresolved for two clock runs.', spine: { session_id: 'SES-20260901-AH-01', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1787240871055-8NVG', 'tblCommercial') },
  { id: 'CARD-1787327277418-5FBQ', title: 'Kiosk build for a partner site', readiness: 'idea', health: 'ok', owner: 'kavin', lane: 'VFARM_CORE', last_touched: '2026-08-28', blocker: null, spine: { session_id: 'SES-20260828-KV-01', builder_id: 'kavin', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_CORE' }, source: airtable('CARD-1787327277418-5FBQ', 'tblCommercial') },
];
