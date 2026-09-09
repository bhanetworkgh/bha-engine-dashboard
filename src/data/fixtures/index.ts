/**
 * Fixture barrel. One file per domain; this re-exports them all so the data
 * module can keep importing a single namespace.
 *
 * Loops, Codex entries, build patterns and commercial cards are no longer
 * fixtures: they are read from Airtable (server/src/sync.ts). Their fixture
 * files were removed on 2026-09-09 so nothing of unknown provenance can reach
 * a screen.
 */

export * from './common';
export * from './incidents';
export * from './twins';
export * from './vfarm';
export * from './builders';
export * from './chat';
