/**
 * The System Registry over MCP (30 Oct 2026, Destiny: "when we're talking about new tools, we can
 * immediately tell it from Slack to register it in the dashboard"). The registry and its rules are
 * ../registry.ts; these tools call its create, update and setDeleted, the same functions the page's
 * Add, Edit and Delete call, so nothing here is a second write path.
 *
 *   `read_registry`   read, both connections; in Bays' scope. The services (what BHA uses and pays
 *                     for), the endpoints and the workflow registry, searched by name or words.
 *   `write_registry`  write connection; in Bays' scope. Adds, edits, removes (soft) or restores one
 *                     row of services, endpoints or workflows. Audited on engine_mcp_writes, kind
 *                     registry, refused and dry-run calls included.
 *
 * Two rules held here and not in a prompt: no secret is ever written (a value shaped like a key,
 * token or password is refused, never stored redacted, because a redacted key is still a sign the
 * real one was pasted somewhere), and the credentials registry is not served or written (CLAUDE.md
 * section 4: there is no credentials registry). Remove and restore are Destiny's or Jason's.
 */
import * as registry from '../registry';
import * as mirror from '../mirror';
import { query } from '../pg';
import { redactSecrets } from '../dataGovernance';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';

/** The kinds these tools touch. Credentials, Airtable bases (history) and people are left to the page. */
export const MCP_KINDS = ['services', 'endpoints', 'workflows'] as const;
type McpKind = (typeof MCP_KINDS)[number];
const isMcpKind = (v: string): v is McpKind => (MCP_KINDS as readonly string[]).includes(v);

const ACTIONS = ['create', 'update', 'remove', 'restore'] as const;
type Action = (typeof ACTIONS)[number];

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

async function profileName(id: string): Promise<string | null> {
  if (id === DESTINY) return 'Destiny Arupi';
  if (id === JASON) return 'Jason Bays';
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]).catch(() => ({ rows: [] as Array<{ name: string | null }> }));
  return r.rows[0]?.name ?? null;
}

/** Field names a kind accepts, read from the registry's own spec so the two cannot drift. */
export function fieldNames(kind: McpKind): string[] {
  return registry.KINDS[kind].fields.map((f) => f.name);
}

/**
 * Every string value checked against the secret shapes the BHARAG write guard redacts. Pure, so the
 * test can pin it. Returns the field names that carried one, and which shape.
 */
/** Shapes the BHARAG guard does not know, for the services this registry names (Stripe, ElevenLabs, Twilio). */
const EXTRA: Array<{ name: string; re: RegExp }> = [
  { name: 'stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { name: 'elevenlabs key', re: /\bsk_[a-f0-9]{40,}\b/ },
  { name: 'twilio api key', re: /\bSK[0-9a-f]{32}\b/ },
];

export function secretsIn(values: Record<string, unknown>): Array<{ field: string; shapes: string[] }> {
  const hits: Array<{ field: string; shapes: string[] }> = [];
  for (const [field, v] of Object.entries(values)) {
    const texts = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
    const shapes = new Set<string>();
    for (const t of texts) {
      for (const name of Object.keys(redactSecrets(t).found)) shapes.add(name);
      for (const x of EXTRA) if (x.re.test(t)) shapes.add(x.name);
    }
    if (shapes.size) hits.push({ field, shapes: [...shapes] });
  }
  return hits;
}

class Refusal extends Error {
  constructor(public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const brief = (kind: McpKind, r: registry.RegistryRow) => {
  const keep = fieldNames(kind);
  const out: Record<string, unknown> = { id: r.id };
  for (const k of keep) if (r[k] !== null && r[k] !== undefined && r[k] !== '') out[k] = r[k];
  if (r.deleted_at) out.removed_at = r.deleted_at;
  out.updated_at = r.updated_at;
  return out;
};

const PAGE = 'https://dashboard.bhanetwork.org/registry';

export const readRegistry: ToolDefinition = {
  name: 'read_registry',
  description: `The System Registry: what BHA uses and pays for (kind services: name, category, what it is for, url, who manages it, plan, who pays, cost, billing cycle, renewal, status active / trial / retired), the endpoints the engine calls (kind endpoints) and the n8n workflow registry (kind workflows). Without kind, services. search narrows by words in the name, id, purpose or notes. A cost nobody has filled in is null and is said as "not recorded", never as nought. Use it before write_registry to see whether a tool is already held. Read only.`,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...MCP_KINDS], description: 'Default services.' },
      search: { type: 'string', description: 'Words in the name, id, purpose or notes.' },
      include_removed: { type: 'boolean', description: 'Also list rows removed from the registry.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the System Registry' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const kind = str(args, 'kind') || 'services';
    if (!isMcpKind(kind)) return { ok: false, reason: 'unknown_kind', message: `kind is one of ${MCP_KINDS.join(', ')}. The credentials registry is not served, and holds no secrets.` };
    const rows = await registry.list(kind, args.include_removed === true);
    const words = str(args, 'search').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const hay = (r: registry.RegistryRow) => [r.id, r.name, r.what_it_is_for, r.purpose, r.notes, r.url].filter(Boolean).join(' ').toLowerCase();
    const hit = words.length ? rows.filter((r) => words.every((w) => hay(r).includes(w))) : rows;
    const answer: Record<string, unknown> = { ok: true, kind, count: hit.length, held: rows.length, rows: hit.map((r) => brief(kind, r)), page: PAGE };
    if (kind === 'services') {
      const spend = registry.spendOf(rows.filter((r) => !r.deleted_at));
      answer.spend = spend;
    }
    if (words.length && !hit.length) answer.note = `Nothing in ${kind} matches "${str(args, 'search')}". ${rows.length} are held.`;
    await mirror.logWrite({ endpoint: 'mcp:read_registry', kind: 'registry', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${kind} ${hit.length}/${rows.length}${words.length ? ` "${words.join(' ')}"` : ''}`, ms: Date.now() - t0 }).catch(() => undefined);
    return answer;
  },
};

export const writeRegistry: ToolDefinition = {
  name: 'write_registry',
  description: `Add, edit, remove or restore ONE row of the System Registry, the dashboard's list of every tool and service BHA uses: use it when someone says "register this tool in the dashboard" or a tool's details change. kind is services (the default), endpoints or workflows. action create needs name (services, endpoints) and, for endpoints, url; for workflows, id (the n8n workflow id) and name. update, remove and restore need id (read_registry gives it). fields are the row's own columns: for services name, category (hosting, automation, data, ai, comms, storage, other), what_it_is_for, url, managed_by, plan, billing_owner, cost_amount (a number), cost_currency, billing_cycle (monthly, quarterly, yearly, one-off), renewal_date (YYYY-MM-DD), status (active, trial, retired), notes. Leave a cost out when nobody has said it: never guess one. To retire a tool BHA stopped using, update status to retired (it stays listed as history); remove takes a row off the list and is for a row added by mistake. HELD HERE: requester_user_id must be Destiny, Jason or someone with a Builder Profile (not_permitted), and remove and restore are Destiny's or Jason's; NEVER put a password, API key or token in any field: a value shaped like one is refused (secret_refused) and nothing is written. Say where the secret lives instead (e.g. "in Bitwarden"). create refuses a name already held (already_held, naming the row): update it instead. dry_run checks everything and writes nothing. Returns {ok, written, row, page, message}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      kind: { type: 'string', enum: [...MCP_KINDS], description: 'Default services.' },
      id: { type: 'string', description: 'The row id: required for update, remove, restore, and for creating a workflow (its n8n id). A service or endpoint id is made from its name.' },
      fields: { type: 'object', description: 'Column values to write. Only the columns named are changed on update.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking.' },
      dry_run: { type: 'boolean' },
    },
    required: ['action', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Write the System Registry' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id') || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'write_registry', args, access: deps.access, kind: 'registry', requester, dry_run: dry });
    try {
      const action = str(args, 'action') as Action;
      if (!(ACTIONS as readonly string[]).includes(action)) throw new Refusal('unknown_action', `action is one of ${ACTIONS.join(', ')}.`);
      const kind = str(args, 'kind') || 'services';
      if (kind === 'credentials') throw new Refusal('not_served', 'There is no credentials registry, and secrets are never held here. Note where a credential lives in the service row\'s notes instead.');
      if (!isMcpKind(kind)) throw new Refusal('unknown_kind', `kind is one of ${MCP_KINDS.join(', ')}.`);
      if (!requester || !/^[UW][A-Z0-9]{6,}$/.test(requester)) throw new Refusal('requester_required', 'requester_user_id must be the Slack id of the person asking.');
      const who = await profileName(requester);
      if (!who) throw new Refusal('not_permitted', `Only Destiny, Jason or someone with a Builder Profile may change the registry; ${requester} has none.`);
      if ((action === 'remove' || action === 'restore') && requester !== DESTINY && requester !== JASON) {
        throw new Refusal('not_permitted', `Only Destiny or Jason may ${action} a registry row. To mark a tool no longer used, update its status to retired.`);
      }

      const raw = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields) ? (args.fields as Record<string, unknown>) : {};
      const allowed = fieldNames(kind);
      const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new Refusal('unknown_field', `${kind} has no field ${unknown.join(', ')}. Its fields are ${allowed.join(', ')}.`, { fields: allowed });
      const secrets = secretsIn({ ...raw, id: str(args, 'id') });
      if (secrets.length) {
        throw new Refusal('secret_refused', `That looks like a secret (${secrets.map((s) => `${s.field}: ${s.shapes.join('/')}`).join('; ')}). Secrets are never written to the registry. Say where it is kept instead, e.g. "in Bitwarden".`, { fields_with_secrets: secrets.map((s) => s.field) });
      }

      const id = str(args, 'id');
      const held = await registry.list(kind, true);
      let before: registry.RegistryRow | undefined;
      if (action !== 'create') {
        if (!id) throw new Refusal('id_required', `${action} needs the row's id. read_registry lists them.`);
        before = held.find((r) => r.id === id);
        if (!before) throw new Refusal('not_found', `No ${kind} row "${id}" is held.`, { nearest: held.filter((r) => r.id.includes(id.split('-')[0]) || String(r.name ?? '').toLowerCase().includes(id.toLowerCase())).slice(0, 5).map((r) => ({ id: r.id, name: r.name })) });
        if (action === 'remove' && before.deleted_at) throw new Refusal('already_removed', `${id} is already off the list.`);
        if (action === 'restore' && !before.deleted_at) throw new Refusal('not_removed', `${id} is on the list already.`);
        if (action === 'update' && !Object.keys(raw).length) throw new Refusal('nothing_to_change', 'fields names nothing to change.');
      } else {
        const name = String(raw.name ?? '').trim();
        const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const dup = held.find((r) => (name && norm(r.name) === norm(name)) || (id && r.id === id));
        if (dup) throw new Refusal('already_held', `${kind} already holds "${dup.name}" (id ${dup.id})${dup.deleted_at ? ', removed from the list: restore it' : ': update it instead'}.`, { row: brief(kind, dup) });
      }

      let row: registry.RegistryRow | null = null;
      if (dry) {
        await auditClose(audit, { outcome: 'dry_run', detail: `${action} ${kind} ${id || String(raw.name ?? '')}`, natural_id: id || null, before: before ? brief(kind, before) : null, after: raw });
        return { ok: true, written: false, dry_run: true, action, kind, would_write: raw, before: before ? brief(kind, before) : null, message: `Checked: ${action} would be allowed. Nothing was written.`, audit_id: audit };
      }
      const input = id ? { ...raw, id } : raw;
      if (action === 'create') row = await registry.create(kind, input);
      else if (action === 'update') row = await registry.update(kind, id, raw);
      else row = await registry.setDeleted(kind, id, action === 'remove');

      const verb = { create: 'Added', update: 'Updated', remove: 'Removed from the list', restore: 'Restored' }[action];
      await auditClose(audit, { outcome: action === 'create' ? 'created' : action === 'update' ? 'updated' : action === 'remove' ? 'archived' : 'updated', detail: `${verb} ${kind} ${row.id} for ${who}`, natural_id: row.id, before: before ? brief(kind, before) : null, after: brief(kind, row) });
      return { ok: true, written: true, action, kind, row: brief(kind, row), page: PAGE, message: `${verb}: ${String(row.name ?? row.id)} (${row.id}).`, audit_id: audit };
    } catch (e) {
      if (e instanceof Refusal) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was written.`, ...e.extra, audit_id: audit };
      }
      if (e instanceof registry.RegistryError) {
        await auditClose(audit, { outcome: 'refused', detail: e.message, guard_result: { reason: 'registry_refused', status: e.status } });
        return { ok: false, written: false, reason: 'registry_refused', message: `${e.message} Nothing was written.`, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was written.`, raise: true, audit_id: audit };
    }
  },
};

export const REGISTRY_READ_TOOLS: ToolDefinition[] = [readRegistry];
export const REGISTRY_WRITE_TOOLS: ToolDefinition[] = [writeRegistry];
