/**
 * Shared fixture scaffolding — the reference date, builder names, and the
 * source-link builders every domain file uses.
 */

import type { Source } from '../types';

export const BUILDER_NAMES: Record<string, string> = {
  destiny: 'Destiny',
  jason: 'Jason',
  jegan: 'Jegan',
  kaiqi: 'Kaiqi',
  ahad: 'Ahad',
  hardik: 'Hardik',
  kavin: 'Kavin',
};

export const slack = (ref: string, channel: string): Source => ({
  kind: 'slack',
  ref,
  url: `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ref}`,
});

export const airtable = (ref: string, table: string): Source => ({
  kind: 'airtable',
  ref,
  url: `https://airtable.com/appUVlBSGGPHw6DGh/${table}/${ref}`,
});

/**
 * The n8n instance these links point at. Read here, not hardcoded, because the
 * last host change went unnoticed until the old instance was already dead.
 *
 * Server-side only: this module is imported by server/src/engine.ts and by
 * nothing in the browser, so `process.env` is Node's and is read at run time.
 * If a client module ever imports these fixtures this line breaks the page
 * with "process is not defined" — Vite does not shim process.env, and the
 * replacement would be an import.meta.env.VITE_ variable read at build time.
 */
const N8N_BASE_URL = process.env.N8N_BASE_URL?.trim() || 'https://bayshorizonnetwork.app.n8n.cloud';

/**
 * An execution link.
 *
 * KNOWN AND ACCEPTED: every execution id in fixture data predates the move to
 * the company instance and will 404 on it. The old instance was numbering in
 * the 90,000s; the company instance restarted at 1, so the ids do not carry
 * over and there is nothing to remap them to. Executions recorded after the
 * move resolve correctly. This is expected — do not re-debug it, and do not
 * "fix" it by pointing the host back at n8n.arupiautomates.cloud, which is
 * retired: a link that looks right and fails is worse than one that is
 * visibly stale.
 */
export const n8n = (ref: string): Source => ({
  kind: 'n8n',
  ref,
  url: `${N8N_BASE_URL}/workflow/executions/${ref}`,
});
