/**
 * Reads of GitHub, Render, Twilio, ElevenLabs and Stripe over MCP, and Twilio changes for Destiny (4 Nov 2026,
 * Destiny). The rules are ../serviceReads.ts.
 *
 *   `read_github`, `read_render`, `read_twilio`, `read_elevenlabs`, `read_stripe`
 *                     — read only, both connections, in Bays' scope. GET to an allowlisted path and nothing else.
 *   `twilio_admin`    — write connection, in no agent's scope, refused on any agent token. Destiny or Jason. A GET
 *                       goes straight through; a change is previewed until `confirm` repeats it word for word.
 *                       Audited on engine_mcp_writes, kind twilio.
 */
import * as sr from '../serviceReads';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const APPROVERS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const str = (a: Record<string, unknown>, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
function strings(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, String(x)]));
}

const SCHEMA = (pathHelp: string) => ({
  type: 'object',
  properties: {
    path: { type: 'string', description: pathHelp },
    query: { type: 'object', description: 'Query string values.', additionalProperties: { type: 'string' } },
    offset: { type: 'number', description: `Where to read from in a long answer: next_offset from the last call. ${sr.MAX_CHARS} characters come back at a time.` },
  },
  required: ['path'],
  additionalProperties: false,
});

function reader(service: sr.Service, name: string, title: string, description: string, pathHelp: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: SCHEMA(pathHelp),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title },
    handler: async (args, deps) => {
      const t0 = Date.now();
      const path = str(args, 'path');
      const r = await sr.read(service, path, strings(args.query), { offset: typeof args.offset === 'number' ? args.offset : 0, mask: !!deps.agent });
      await mirror.logWrite({ endpoint: `mcp:${name}`, kind: 'service_reads', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${path}: ${r.ok ? `${String(r.total_chars)} chars` : String(r.reason)}`, ms: Date.now() - t0 });
      return r;
    },
  };
}

export const readGithub = reader('github', 'read_github', 'Read GitHub', `Read a bhanetworkgh repository as it is now, to check what was really committed, merged or tested. Read only. Paths: /orgs/${sr.GITHUB_ORG}/repos; /repos/${sr.GITHUB_ORG}/<repo> then /commits (query sha, since, until, author, path), /commits/<sha>, /commits/<sha>/check-runs, /commits/<sha>/status, /compare/<base>...<head>, /branches, /branches/<name>, /pulls (query state), /pulls/<n>, /pulls/<n>/files, /pulls/<n>/commits, /pulls/<n>/reviews, /contents/<file> (query ref; a file comes back as text), /git/trees/<sha> (query recursive=1), /actions/runs (query branch, head_sha), /actions/runs/<id>/jobs, /tags, /releases, /deployments; /search/code, /search/commits and /search/issues with org:${sr.GITHUB_ORG} in q. A 404 can mean the token cannot see it: say so, never that it does not exist.`, 'For example /repos/bhanetworkgh/bhavfarm/commits.');
export const readRender = reader('render', 'read_render', 'Read Render', 'Read what is deployed on Render, to check whether a commit is live. Read only; environment variables are never reachable. Paths: /services, /services/<id>, /services/<id>/deploys, /services/<id>/deploys/<id>, /services/<id>/events, /logs (query ownerId, resource, limit, startTime, endTime, text). Each deploy names its commit.', 'For example /services/srv-dagj84ijnfac73ds5100/deploys.');
export const readTwilio = reader('twilio', 'read_twilio', 'Read Twilio', 'Read BHA\'s Twilio account: calls, texts, numbers and errors. Read only; sends nothing. Paths: /Calls.json, /Calls/<sid>.json, /Messages.json, /Messages/<sid>.json, /IncomingPhoneNumbers.json, /Recordings.json, /Calls/<sid>/Recordings.json, /monitor/v1/Alerts, /monitor/v1/Events, /messaging/v1/Services. A2P status is not on this key.', 'For example /Messages.json.');
export const readElevenlabs = reader('elevenlabs', 'read_elevenlabs', 'Read ElevenLabs', 'Read the Customer Service Twin\'s voice agent on ElevenLabs. Read only. Paths: /convai/agents, /convai/agents/<id>, /convai/conversations (query agent_id), /convai/conversations/<id>, /convai/phone-numbers, /convai/tools.', 'For example /convai/conversations.');
export const readStripe = reader('stripe', 'read_stripe', 'Read Stripe', 'Read BHA\'s Stripe account, to check a payment or a webhook. Read only; it can never charge, refund or pay out. Paths: /events, /payment_intents, /charges, /invoices, /products, /prices, /webhook_endpoints, each with /<id>, and /checkout/sessions.', 'For example /events.');

export const twilioAdmin: ToolDefinition = {
  name: 'twilio_admin',
  description: `Work on BHA's Twilio account for Destiny, including what read_twilio cannot see, such as A2P and Trust Hub. method GET, POST or DELETE. path: under the account (/Messages.json, /IncomingPhoneNumbers/<sid>.json) or on a product host (/messaging/v1/..., /trusthub/v1/..., /voice/v1/..., /numbers/v2/...). params: form values, or the query for a GET. A GET runs at once. A POST or DELETE changes nothing until it is called again with confirm set to exactly "<METHOD> <path>", once the person has seen the preview: it can send real texts to customers, repoint a live number or release one. Use it only when Destiny or Jason asks for that change. requester_user_id is theirs. Refused on any agent token. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: [...sr.TWILIO_ADMIN_METHODS] },
      path: { type: 'string' },
      params: { type: 'object', additionalProperties: { type: 'string' } },
      confirm: { type: 'string' },
      requester_user_id: { type: 'string' },
    },
    required: ['method', 'path', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: 'Work on Twilio' },
  handler: async (args, deps: ToolDeps) => {
    const method = str(args, 'method') as sr.AdminMethod;
    const raw = str(args, 'path');
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    const params = strings(args.params);
    const requester = str(args, 'requester_user_id');
    const change = method !== 'GET';
    const confirmed = str(args, 'confirm') === sr.confirmWords(method, path);
    const audit = await auditOpen({ tool: 'twilio_admin', args, access: deps.access, kind: 'twilio', requester, dry_run: change && !confirmed });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not use twilio_admin.`);
    if (!APPROVERS.has(requester)) return refuse('not_permitted', 'Only Destiny or Jason may use twilio_admin.');
    if (!sr.TWILIO_ADMIN_METHODS.includes(method)) return refuse('bad_method', 'method is GET, POST or DELETE.');
    if (path.includes('..') || /^\/?https?:/i.test(raw)) return refuse('bad_path', 'path is a Twilio path, not a URL.');
    if (change && !confirmed) {
      await auditClose(audit, { outcome: 'dry_run', detail: `${method} ${path}` });
      return { ok: false, reason: 'needs_confirmation', preview: { method, path, params }, confirm_with: sr.confirmWords(method, path), message: 'Nothing has changed. Show this to the person, then call again with confirm set to confirm_with.', audit_id: audit };
    }
    const r = await sr.twilioAdmin(method, path, params);
    await auditClose(audit, { outcome: r.ok ? (change ? 'updated' : 'unchanged') : 'failed', detail: `${method} ${path}: ${String(r.status ?? r.reason)}` });
    return { ...r, audit_id: audit };
  },
};

export const SERVICE_READ_TOOLS: ToolDefinition[] = [readGithub, readRender, readTwilio, readElevenlabs, readStripe];
export const SERVICE_WRITE_TOOLS: ToolDefinition[] = [twilioAdmin];
