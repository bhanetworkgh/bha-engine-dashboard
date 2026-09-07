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

export const n8n = (ref: string): Source => ({
  kind: 'n8n',
  ref,
  url: `https://n8n.arupiautomates.cloud/workflow/executions/${ref}`,
});
