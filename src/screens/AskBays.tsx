import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { useSession } from '../app/session';
import {
  getAskBays,
  pollBaysAnswer,
  saveLocalThreads,
  sendToBays,
  type ChatMessage,
  type ChatThread,
  type Lane,
} from '../data';
import { Icon, LoadFailed, Loading } from '../components/ui';
import { cx } from '../lib';

/** The front door drops the same session_id inside this window (its loop guard). */
const COOLDOWN_MS = 30_000;
/** How long to wait for an answer at the callback before saying so. */
const ANSWER_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function newSessionId(): string {
  return `DASH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function DeliveryLine({ m }: { m: ChatMessage }) {
  if (!m.delivery || m.delivery === 'answered') return null;
  const text =
    m.delivery === 'sending'
      ? 'Sending to the Bays front door'
      : m.delivery === 'sent'
        ? 'Accepted by the front door'
        : m.delivery === 'waiting'
          ? 'Waiting for the answer at the callback'
          : m.delivery === 'timeout'
            ? (m.note ?? 'No answer arrived in time.')
            : (m.note ?? 'Not sent.');
  const tone = m.delivery === 'failed' ? 'text-failing' : m.delivery === 'timeout' ? 'text-degraded' : 'text-faint';
  const live = m.delivery === 'sending' || m.delivery === 'waiting';
  return (
    <div className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] ${tone}`}>
      {live && <span className="pulse-dot h-[6px] w-[6px] rounded-full bg-current" />}
      {text}
    </div>
  );
}

export default function AskBays() {
  const { lane, me } = useSession();
  const { status, data, error } = useData(getAskBays);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [asker, setAsker] = useState(me);
  const [cooldownUntil, setCooldownUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollers = useRef<Record<string, number>>({});

  useEffect(() => {
    if (data) setThreads(data.threads);
  }, [data]);

  // A one-second clock only while a cooldown is running.
  useEffect(() => {
    const anyActive = Object.values(cooldownUntil).some((t) => t > Date.now());
    if (!anyActive) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [cooldownUntil]);

  useEffect(() => () => Object.values(pollers.current).forEach((id) => clearInterval(id)), []);

  const active = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  const messages = active?.messages ?? [];
  const started = messages.length > 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, activeId]);

  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) => t.title.toLowerCase().includes(q) || t.messages.some((m) => m.text.toLowerCase().includes(q)),
    );
  }, [threads, search]);

  function persist(next: ChatThread[]) {
    setThreads(next);
    saveLocalThreads(next);
  }

  function patchMessage(threadId: string, messageId: string, patch: Partial<ChatMessage>) {
    setThreads((prev) => {
      const next = prev.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }
          : t,
      );
      saveLocalThreads(next);
      return next;
    });
  }

  function appendMessage(threadId: string, m: ChatMessage) {
    setThreads((prev) => {
      const next = prev.map((t) => (t.id === threadId ? { ...t, messages: [...t.messages, m], updated_at: stamp() } : t));
      saveLocalThreads(next);
      return next;
    });
  }

  function startPolling(threadId: string, messageId: string, sessionId: string) {
    const startedAt = Date.now();
    const tick = async () => {
      const res = await pollBaysAnswer(sessionId);
      if (res.status === 'answered') {
        clearInterval(pollers.current[threadId]);
        delete pollers.current[threadId];
        patchMessage(threadId, messageId, { delivery: 'answered' });
        appendMessage(threadId, { id: `bays-${Date.now()}`, role: 'bays', text: res.text, at: res.at });
        return;
      }
      if (res.status === 'unavailable') {
        clearInterval(pollers.current[threadId]);
        delete pollers.current[threadId];
        patchMessage(threadId, messageId, { delivery: 'timeout', note: res.reason });
        return;
      }
      if (Date.now() - startedAt > ANSWER_TIMEOUT_MS) {
        clearInterval(pollers.current[threadId]);
        delete pollers.current[threadId];
        patchMessage(threadId, messageId, {
          delivery: 'timeout',
          note: 'No answer reached the callback within two minutes. Bays may still reply in Slack.',
        });
      }
    };
    pollers.current[threadId] = window.setInterval(() => void tick(), POLL_MS);
    void tick();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !data) return;

    let thread = active;
    let list = threads;
    if (!thread) {
      thread = {
        id: `local-${Date.now()}`,
        title: text.length > 56 ? `${text.slice(0, 56)}…` : text,
        updated_at: stamp(),
        messages: [],
        session_id: newSessionId(),
        local: true,
      };
      list = [thread, ...threads];
      setActiveId(thread.id);
    }
    const sessionId = thread.session_id ?? newSessionId();
    const until = cooldownUntil[thread.id] ?? 0;
    if (until > Date.now()) return;

    const mine: ChatMessage = {
      id: `me-${Date.now()}`,
      role: 'user',
      text,
      at: stamp(),
      delivery: data.wiring.can_send ? 'sending' : 'failed',
      note: data.wiring.can_send ? undefined : data.wiring.note,
    };
    persist(
      list.map((t) =>
        t.id === thread!.id
          ? { ...t, local: true, session_id: sessionId, messages: [...t.messages, mine], updated_at: stamp() }
          : t,
      ),
    );
    setDraft('');

    if (!data.wiring.can_send) return;

    const lane_id: Lane = lane === 'all' ? 'ENGINE_INTERNAL' : lane;
    const result = await sendToBays({ session_id: sessionId, prompt: text, builder_id: asker, lane: lane_id });
    if (!result.ok) {
      patchMessage(thread.id, mine.id, { delivery: 'failed', note: result.error });
      return;
    }
    setCooldownUntil((c) => ({ ...c, [thread!.id]: Date.now() + COOLDOWN_MS }));
    if (data.wiring.can_read_answers) {
      patchMessage(thread.id, mine.id, { delivery: 'waiting' });
      startPolling(thread.id, mine.id, sessionId);
    } else {
      patchMessage(thread.id, mine.id, {
        delivery: 'timeout',
        note:
          data.wiring.delivery === 'slack'
            ? 'Accepted. The answer will be posted to the configured Slack channel; this dashboard cannot read it back.'
            : 'Accepted. The answer goes to the configured callback; no answer endpoint is set for this dashboard to read it.',
      });
    }
  }

  function newChat() {
    setActiveId(null);
    setDraft('');
    setPanelOpen(false);
    inputRef.current?.focus();
  }

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const cooldownLeft = active ? Math.max(0, Math.ceil(((cooldownUntil[active.id] ?? 0) - now) / 1000)) : 0;
  const wiring = data.wiring;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {started ? (
          <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-[72ch] space-y-5">
              {messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="fade-up flex flex-col items-end">
                    <div className="bubble-user max-w-[85%] text-[13.5px] leading-relaxed whitespace-pre-wrap">{m.text}</div>
                    <DeliveryLine m={m} />
                  </div>
                ) : (
                  <div key={m.id} className="fade-up flex gap-3">
                    <img src="/logo.svg" alt="" className="mark mt-0.5 h-6 w-6 shrink-0" />
                    <div className="min-w-0">
                      <div className="mb-1 flex items-baseline gap-2 text-[11px]">
                        <span className="font-medium text-ink">Bays</span>
                        <span className="text-faint">{m.at}</span>
                      </div>
                      <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{m.text}</div>
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        ) : (
          /* Empty state: the mark, centred and large. Nothing else until the user types. */
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">
            <img src="/logo.svg" alt="BHA" className="mark idle-mark h-32 w-32" />
            <p className="font-display text-[22px] text-dim">Ask Bays</p>
          </div>
        )}

        <div className="shrink-0 px-6 pb-5">
          <div className="mx-auto max-w-[72ch]">
            {!wiring.can_send || wiring.delivery === 'none' ? (
              <p className="mb-2 rounded-[10px] bg-degraded-soft px-3 py-2 text-[11.5px] leading-relaxed text-degraded">{wiring.note}</p>
            ) : !wiring.can_read_answers ? (
              <p className="mb-2 px-1 text-[11.5px] leading-relaxed text-faint">{wiring.note}</p>
            ) : null}

            <div className="card flex items-end gap-2 p-2">
              <textarea
                ref={inputRef}
                value={draft}
                rows={1}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={cooldownLeft > 0 ? `Bays refuses the same session inside 30 s · ${cooldownLeft}s` : 'Ask Bays anything about the engine'}
                className="input max-h-40 min-h-[36px] flex-1 resize-none border-0 bg-transparent shadow-none focus:shadow-none"
                style={{ height: 'auto' }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
              />
              <select
                value={asker}
                onChange={(e) => setAsker(e.target.value)}
                className="input h-8 w-auto pr-7 text-[12px]"
                aria-label="Asking as"
                title="builder_id sent with the ask"
              >
                {data.builders.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || cooldownLeft > 0}
                className="btn btn-primary h-8 w-8 rounded-full p-0"
                aria-label="Send"
              >
                <Icon.send />
              </button>
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                aria-label="Open chat history"
                className="btn btn-ghost h-8 md:hidden"
              >
                Chats
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-faint">
              <span>Enter to send · shift+enter for a new line</span>
              <span className="tabular">
                lane {lane === 'all' ? 'engine_internal' : lane.toLowerCase()}
                {active?.session_id ? ` · ${active.session_id}` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right-hand panel: new chat, history, search. */}
      {panelOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setPanelOpen(false)} aria-hidden />}

      <aside
        className={cx(
          'w-[264px] shrink-0 flex-col border-l border-line bg-panel md:static md:flex',
          panelOpen ? 'fixed inset-y-0 right-0 z-50 flex shadow-[var(--shadow-pop)]' : 'hidden',
        )}
      >
        <div className="space-y-2 p-3">
          <button type="button" onClick={newChat} className="btn w-full justify-start gap-2">
            <Icon.plus />
            New chat
          </button>
          <div className="relative">
            <Icon.search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search past chats"
              className="input h-8 pl-8 text-[12px]"
            />
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {visibleThreads.length === 0 ? (
            <p className="px-3 py-4 text-[12px] leading-relaxed text-dim">No stored chat matches that search.</p>
          ) : (
            visibleThreads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setActiveId(t.id);
                  setPanelOpen(false);
                }}
                className={`block w-full rounded-[10px] px-3 py-2 text-left transition-colors ${
                  t.id === activeId ? 'bg-raised' : 'hover:bg-hover'
                }`}
              >
                <div className="truncate text-[12.5px]">{t.title}</div>
                <div className="tabular mt-0.5 text-[11px] text-faint">{t.updated_at}</div>
              </button>
            ))
          )}
        </div>

        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">{data.memory_note}</p>
      </aside>
    </div>
  );
}
