/**
 * Who is calling, for the length of one MCP request (2026-09-28, Destiny —
 * Agent Upgrade Plan step 1.4).
 *
 * The transport resolves the caller from the token it came in on and runs the
 * request inside this store, so the audit writers (writeTools.auditOpen, the
 * write gate) can stamp the agent's name without every tool having to pass it
 * along. Node's own AsyncLocalStorage: no dependency.
 *
 * `agent` is null for the shared MCP_SECRET / MCP_WRITE_TOKEN — Claude's
 * connector — and that null is the truth: the shared secret says nothing about
 * who holds it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Caller {
  agent: string | null;
}

export const callerStore = new AsyncLocalStorage<Caller>();

export function currentAgent(): string | null {
  return callerStore.getStore()?.agent ?? null;
}
