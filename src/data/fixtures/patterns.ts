/**
 * Phase 1 fixtures — build patterns.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { BuildPattern } from '../types';
import { slack } from './common';

export const BUILD_PATTERNS: BuildPattern[] = [
  { id: 'BP-01', code: 'BP-INFRA-001-ERROR_TAXONOMY_GRACEFUL_DEGRADATION', title: 'Error taxonomy and graceful degradation', lane: 'ENGINE_INTERNAL', references: 14, last_referenced: '2026-09-07', author: 'destiny', source: slack('1788197870658249', 'C0ATC4CA3G9') },
  { id: 'BP-02', code: 'BP-INFRA-003-UPSTREAM_QUOTA_EXHAUSTED', title: 'Upstream quota exhausted', lane: 'ENGINE_INTERNAL', references: 6, last_referenced: '2026-09-07', author: 'kaiqi', source: slack('1788244656748529', 'C0ATC4CA3G9') },
  { id: 'BP-03', code: 'BP-RAG-001-GATHER_THEN_GATE', title: 'Gather then gate before synthesising', lane: 'ENGINE_INTERNAL', references: 11, last_referenced: '2026-09-06', author: 'destiny', source: slack('1788190000000', 'C0ATC4CA3G9') },
  { id: 'BP-04', code: 'BP-NORTHSTAR-001-THREE_TRY_CAP', title: 'Three-try cap before mandatory escalation', lane: 'ENGINE_INTERNAL', references: 9, last_referenced: '2026-09-06', author: 'jason', source: slack('1788180000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-05', code: 'BP-ALERT-001-ENVELOPE_REGISTRY_RENDERERS', title: 'One envelope, a registry, and pure renderers', lane: 'VFARM_CORE', references: 7, last_referenced: '2026-09-05', author: 'jegan', source: slack('1787170000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-06', code: 'BP-COMM-001-DUAL_CONTRACT_INTAKE_SPLIT', title: 'Dual-contract intake split, commercial versus narrative', lane: 'VFARM_MEDIA', references: 4, last_referenced: '2026-09-02', author: 'hardik', source: slack('1786840000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-07', code: 'BP-COMM-002-HOST_INDEPENDENT_FUNNEL', title: 'Host-independent commercial funnel', lane: 'VFARM_MEDIA', references: 3, last_referenced: '2026-08-30', author: 'hardik', source: slack('1786020000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-08', code: 'BP-RAG-002-INGEST_CONTRACT_BEFORE_SCHEMA', title: 'Ingest contract before schema', lane: 'ENGINE_INTERNAL', references: 5, last_referenced: '2026-08-31', author: 'kaiqi', source: slack('1785970000000', 'C0ATC4CA3G9') },
  { id: 'BP-09', code: 'BP-CLIENT-001-WEEKLY_CLOCK_CONTRADICTION_STATE', title: 'Weekly clock with contradiction state', lane: 'CLIENT_CORE', references: 2, last_referenced: '2026-09-01', author: 'ahad', source: slack('1786450000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-10', code: 'BP-VFARM-001-MEASURED_NOT_GUESSED', title: 'Measured baselines, never guessed, fenced by confidence', lane: 'VFARM_CORE', references: 8, last_referenced: '2026-09-06', author: 'jegan', source: slack('1786190000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-11', code: 'BP-INFRA-002-WRITER_SERVICE_BOUNDARY', title: 'Ask-agents read, a writer service writes', lane: 'ENGINE_INTERNAL', references: 10, last_referenced: '2026-09-04', author: 'jegan', source: slack('1787050000000', 'C0ATC4CA3G9') },
  { id: 'BP-12', code: 'BP-VFARM-002-RENDER_SAFE_BOUNDARY', title: 'Render-safe versus burn-in dependent', lane: 'VFARM_MEDIA', references: 6, last_referenced: '2026-09-03', author: 'hardik', source: slack('1786690000000', 'C0A8Q2ZR4KP') },
];
