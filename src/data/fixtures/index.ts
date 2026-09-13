/**
 * Fixture barrel. One file per domain; this re-exports them all so the data
 * module can keep importing a single namespace.
 *
 * Loops, Codex entries, build patterns, commercial cards and the three
 * telemetry kinds are no longer fixtures: the engine writes them into this
 * server's own tables and the pages read those (server/src/store.ts). Their
 * fixture files were removed on 2026-09-09 so nothing of unknown provenance
 * can reach a screen.
 */

export * from './common';
export * from './incidents';
export * from './twins';
export * from './vfarm';
export * from './builders';
export * from './chat';
