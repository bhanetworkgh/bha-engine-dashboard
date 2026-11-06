/**
 * The daily check of what skills the live agents really have (6 Nov 2026, Destiny).
 *
 * In n8n an agent's published version is its own snapshot, and a snapshot can
 * hold fewer skills than the draft. From 1 Nov the agents ran on versions with
 * no skills for days and nothing said so: `record_agent_inventory` reads the
 * draft, and only when somebody records it. This reads each active version.
 *
 * The baseline is what that agent held **live** on the last read, kept in
 * `meta`, never the inventory row: the row is the draft, so a skill added and
 * not yet published would read as a loss.
 *
 * It reads and alerts. It never changes an agent.
 */

import { getMeta, setMeta } from './db';
import * as engineEvents from './engineEvents';
import * as n8nMcp from './n8nMcp';
import { query } from './pg';
import * as publishGate from './publishGate';
import * as timers from './timers';

export const RULE = { tick_minutes: 60, every_hours: 24, first_look_minutes: 3 };

type Dict = Record<string, unknown>;
type Read = (id: string, versionId?: string) => Promise<Dict>;
type Baseline = { version: string | null; skills: string[] };

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY = (id: string) => `skill_watch.live.${id}`;

/** The skills one get_agent answer lists, by name, falling back to the id. Pure. */
export function liveSkills(result: Dict): string[] {
  const config = isDict(result.config) ? result.config : {};
  const bodies = isDict(result.skills) ? result.skills : {};
  const listed = Array.isArray(config.skills) ? config.skills.filter(isDict) : [];
  return listed.map((s) => {
    const id = String(s.id ?? '');
    const body = bodies[id];
    return String((isDict(body) && body.name) || id);
  });
}

export async function pass(read: Read = n8nMcp.getAgent): Promise<{ checked: number; lost: string[]; unread: string[] }> {
  const rows = (await query<{ agent_id: string; name: string }>(`SELECT agent_id, name FROM engine_agent_inventory ORDER BY name`)).rows;
  const out = { checked: 0, lost: [] as string[], unread: [] as string[] };

  for (const row of rows) {
    try {
      const draft = await read(row.agent_id);
      const meta = isDict(draft.agent) ? draft.agent : {};
      const version = typeof meta.activeVersionId === 'string' ? meta.activeVersionId : null;
      if (!version) continue; // not published: nothing is live to check
      const skills = liveSkills(await read(row.agent_id, version));
      out.checked += 1;

      const held = await getMeta(KEY(row.agent_id));
      const before: Baseline | null = held ? JSON.parse(held) : null;
      const lost = before ? publishGate.droppedSkills(before.skills.map((name) => ({ name })), skills.map((name) => ({ id: name, name }))) : [];
      if (lost.length) {
        out.lost.push(`${row.name}: ${lost.join(', ')}`);
        const said = await publishGate.onSkillsDropped({ agent_id: row.agent_id, name: row.name, version, from: before?.version ?? null, lost, left: skills.length });
        if (said === 'failed') continue; // baseline kept, so the next pass says it again
      }
      await setMeta(KEY(row.agent_id), JSON.stringify({ version, skills } satisfies Baseline));
    } catch (e) {
      out.unread.push(`${row.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  if (out.unread.length) {
    const claim = await engineEvents.record({
      event_type: 'agent_skills_unread', subject_id: 'skill watch', lane: 'ENGINE', actor: 'skill watch',
      detail: { unread: out.unread }, dedupe_key: `agent_skills_unread:${day}`,
    });
    if (claim.recorded) {
      const sent = await publishGate.post(publishGate.message('failure', `Could not read the skills of ${out.unread.length} live agent${out.unread.length === 1 ? '' : 's'}`, [...out.unread, 'These were not checked today. That is not the same as fine.']));
      if (!sent.ok) {
        console.error(`[skill-watch] the unread alert did not post: ${sent.error}`);
        await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
      }
    }
  }
  await engineEvents.record({
    event_type: 'agent_skills_checked', subject_id: 'skill watch', lane: 'ENGINE', actor: 'skill watch',
    detail: { agents: rows.length, ...out }, dedupe_key: `agent_skills_checked:${day}`,
  });
  return out;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

async function tick(): Promise<void> {
  timers.beat('skill watch');
  if (busy) return;
  busy = true;
  try {
    const last = await getMeta('skill_watch.last_run');
    if (last && Date.now() - new Date(last).getTime() < RULE.every_hours * 3_600_000) return;
    const r = await pass();
    if (!r.unread.length) await setMeta('skill_watch.last_run', new Date().toISOString());
    console.log(`[skill-watch] ${r.checked} checked, ${r.lost.length} lost, ${r.unread.length} unread`);
  } catch (e) {
    console.error(`[skill-watch] pass failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}

/** A first look soon after boot: deploys can come more often than the hourly tick. */
export function startSweeping(): void {
  if (timer) return;
  setTimeout(() => void tick(), RULE.first_look_minutes * 60_000).unref();
  timer = setInterval(() => void tick(), RULE.tick_minutes * 60_000);
  timer.unref();
}
