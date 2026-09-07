/**
 * Row actions all route through here. In phase 1 they log; when the engine
 * accepts writes this is the one place that changes.
 */
export function act(action: string, id: string, extra?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[action] ${action}`, { id, ...extra });
}
