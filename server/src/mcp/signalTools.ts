/**
 * Research signals over MCP (11 Oct 2026, Destiny — LOOP-1788310653393-Q9CR).
 *
 *   run_research_signals — write connection only, in no agent's scope. The
 *                    five-minute sweep's own pass (researchSignals.sweep), on
 *                    demand, so a person does not wait for the clock to see
 *                    what the triggers found. dry_run (the default) opens
 *                    nothing and answers what each signal would get from the
 *                    guard. With `fixture`, one marked test signal is put
 *                    through the real guard, which is how the guard is proved
 *                    live without waiting for a real fault: the job it opens
 *                    carries Fixture true and is removed with delete_record.
 *
 * Every call is audited on engine_mcp_writes, dry runs included.
 */
import * as researchSignals from '../researchSignals';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const runResearchSignalsTool: ToolDefinition = {
  name: 'run_research_signals',
  description:
    'Run the research-signal pass now: the same pass the dashboard runs every five minutes. It finds what the engine\'s own records say needs research (T4 an incident marked research_needed or a step the repair bridge handed to a person twice in 7 days; T5 a North Star answer that flags a lane and ends its gaps with "Research Twin question: …"; T6 a card at needs_revision or pilot_failed, or with missing research and no job; T8 the same Red Flag Name on 3 logs in 14 days) and puts each through one guard: one job per signal, 5 new automatic jobs a day (UTC), backlog at most 3 of the 5, and nothing while the model credit is under $15 or cannot be read. dry_run defaults to true: nothing is opened, and the answer lists every signal with what the guard would do and why. dry_run false needs a reason and runs the pass. fixture { question } puts one marked test signal through the real guard (dry_run must be false): the Research Twin job it opens carries Fixture true, and it must be removed afterwards with delete_record kind rt-jobs. It can open a research job and add a line to an open one; it closes, retries, edits and pays nothing. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: 'Default true: open nothing, list what would happen.' },
      reason: { type: 'string', description: 'Why the pass is being run by hand. Required when dry_run is false.' },
      fixture: {
        type: 'object',
        description: 'One marked test signal for proving the guard. The job it opens is a fixture and must be deleted afterwards.',
        properties: { question: { type: 'string', description: 'The test question. It is prefixed as a fixture on the job.' }, key: { type: 'string', description: 'Optional: reuse a fixture key to prove a repeat adds to the open job. Returned by the first call.' }, ref: { type: 'string', description: 'Optional: what raised it this time. A new ref on the same key is a repeat.' } },
        required: ['question'],
        additionalProperties: false,
      },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Run the research-signal pass' },
  handler: async (args, deps) => {
    const dry = args.dry_run !== false;
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const fx = args.fixture && typeof args.fixture === 'object' ? (args.fixture as Record<string, unknown>) : null;
    const audit = await auditOpen({ tool: 'run_research_signals', args, access: deps.access, kind: 'research_signals', requester, dry_run: dry });
    try {
      if (dry) {
        if (fx) {
          await auditClose(audit, { outcome: 'refused', detail: 'a fixture needs dry_run false' });
          return { ok: false, reason: 'bad_argument', message: 'A fixture goes through the real guard, so it needs dry_run false and a reason.', audit_id: audit };
        }
        const p = await researchSignals.plan();
        await auditClose(audit, { outcome: 'dry_run', detail: `${p.signals.length} signal(s); ${p.signals.filter((s) => s.would === 'open a job').length} would open a job` });
        return { ok: true, dry_run: true, ...p, rule: researchSignals.WORDS, not_built: researchSignals.NOT_BUILT, note: 'dry_run: nothing was opened.', audit_id: audit };
      }
      if (reason.length < 3) {
        await auditClose(audit, { outcome: 'refused', detail: 'no reason' });
        return { ok: false, reason: 'bad_argument', message: 'Send a reason (at least 3 characters) to run the pass for real.', audit_id: audit };
      }
      if (fx) {
        const q = typeof fx.question === 'string' ? fx.question.trim().slice(0, 500) : '';
        if (q.length < 10) {
          await auditClose(audit, { outcome: 'refused', detail: 'fixture question too short' });
          return { ok: false, reason: 'bad_argument', message: 'The fixture question needs at least 10 characters.', audit_id: audit };
        }
        const key = typeof fx.key === 'string' && fx.key.startsWith('fixture:') ? fx.key.trim() : `fixture:${Date.now()}`;
        const ref = typeof fx.ref === 'string' && fx.ref.trim() ? fx.ref.trim().slice(0, 120) : `fixture-ref:${Date.now()}`;
        const r = await researchSignals.open({
          trigger: 'T4',
          key,
          source: 'Engine signal (fixture)',
          ref,
          question: `[FIXTURE, do not research] ${q}`,
          context: `A marked test signal put through the research-signal guard by hand (${reason}). It proves the guard and nothing else. Delete this job; do not research it.`,
          rearm_days: null,
          fixture: true,
          detail: { reason, requester },
        });
        await auditClose(audit, { outcome: r.state === 'failed' ? 'failed' : 'applied', detail: `fixture ${key}: ${r.state}${r.reason ? ` (${r.reason})` : ''}`.slice(0, 500), natural_id: r.job_id, after: r });
        return { ok: r.state !== 'failed', fixture: true, key, ref, ...r, read: await researchSignals.read({ limit: 5 }), note: r.job_id ? `Remove the fixture job when the proof is read: delete_record kind rt-jobs, natural id ${r.job_id}.` : 'No job was opened.', audit_id: audit };
      }
      const r = await researchSignals.sweep();
      const read = await researchSignals.read({ limit: 40 });
      await auditClose(audit, { outcome: r.failed ? 'failed' : 'applied', detail: `${r.detected} signal(s): ${r.jobs_opened} job(s) opened, ${r.added} added, ${r.held} held, ${r.not_reopened} not reopened, ${r.failed} failed. ${reason}`.slice(0, 500), after: r });
      return { ok: r.failed === 0, ...r, read, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message.slice(0, 500) });
      return { ok: false, reason: 'error', message, audit_id: audit };
    }
  },
};

export const SIGNAL_WRITE_TOOLS: ToolDefinition[] = [runResearchSignalsTool];
