/**
 * The help pages, as the Customer Service Twin's voice agent reads them (30 Oct 2026, Destiny: the
 * three help pages are CST's knowledge base, kept as pages on this dashboard, and the voice agent is
 * pointed at them rather than given copies).
 *
 * `GET /api/public/cst-help` with `x-cst-help-key`. Public only in that ElevenLabs holds no session:
 * the key is the lock, and there are two of them, because the Honest Gate is decided here by which
 * key called, never by the agent's instructions:
 *
 *   CST_HELP_KEY          live calls. Only pages at `in_corpus` (Hardik checked that exact text and it
 *                         is in cst-help-manuals). Nothing else is ever returned on this key.
 *   CST_HELP_PREVIEW_KEY  the draft agent while we test it. Every page, each marked with its stage,
 *                         and every page that has not passed marked "draft, not for customers".
 *
 * Going live is moving the agent's tool from the preview key to the live key. No default for either:
 * unset, the route answers 503 and says which variable. The answer is the page text and its stage,
 * never who checked it or any id beyond the page's own.
 */
import { timingSafeEqual } from 'node:crypto';
import type { HelpPage } from './helpPages';

export const KEY_VARS = { live: 'CST_HELP_KEY', preview: 'CST_HELP_PREVIEW_KEY' } as const;
export type Mode = keyof typeof KEY_VARS;

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Which mode a key opens, or why none. */
export function modeFor(key: string | undefined, env: Record<string, string | undefined> = process.env): { ok: true; mode: Mode } | { ok: false; status: 401 | 503; reason: string } {
  const live = env[KEY_VARS.live]?.trim();
  const preview = env[KEY_VARS.preview]?.trim();
  if (!live && !preview) return { ok: false, status: 503, reason: `not_configured: set ${KEY_VARS.live} (live) or ${KEY_VARS.preview} (testing)` };
  const k = (key ?? '').trim();
  if (k && live && same(k, live)) return { ok: true, mode: 'live' };
  if (k && preview && same(k, preview)) return { ok: true, mode: 'preview' };
  return { ok: false, status: 401, reason: 'unauthorised' };
}

export interface AgentPage {
  page_id: string;
  title: string;
  status: 'approved' | 'draft, not for customers';
  body: string;
  /** Parts nobody has written yet, and who owes them. Never to be filled in by the agent. */
  not_written_yet: Array<{ owner: string; note: string }>;
}

/** Pure: what the agent is handed for a mode. A live call never sees a page that has not passed. */
export function agentView(pages: HelpPage[], mode: Mode): { mode: Mode; pages: AgentPage[]; instruction: string } {
  const passed = (p: HelpPage) => p.stage === 'in_corpus' && !!p.checked_sha256 && p.checked_sha256 === p.body_sha256;
  const chosen = mode === 'live' ? pages.filter(passed) : pages;
  const out = chosen.map((p) => ({
    page_id: p.page_id,
    title: p.title,
    status: passed(p) ? ('approved' as const) : ('draft, not for customers' as const),
    body: p.body,
    not_written_yet: p.gaps.map((g) => ({ owner: g.owner, note: g.note })),
  }));
  const instruction =
    mode === 'live'
      ? out.length
        ? 'Answer only from these approved pages. If they do not cover the question, say so and offer to pass it to a person.'
        : 'No help page has been approved yet. Tell the caller you cannot answer that today and offer to pass it to a person.'
      : 'TEST MODE. A page marked "draft, not for customers" has not passed review: say it is not yet confirmed, and never present it as BHA\'s answer. Never fill in anything listed under not_written_yet.';
  return { mode, pages: out, instruction };
}
