import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { useSession } from '../app/session';
import {
  forgetThread,
  getAskBays,
  pollBaysAnswer,
  saveLocalThreads,
  sendToBays,
  type ChatMessage,
  type ChatThread,
  type Lane,
} from '../data';
import { Icon, LoadFailed, Loading } from '../components/ui';
import { ClockChip, ThemeChip } from '../components/ClockChip';
import { cx } from '../lib';

/** The front door drops the same session_id inside this window (its loop guard). */
const COOLDOWN_MS = 30_000;
/** How long to wait for an answer at the callback before saying so. */
const ANSWER_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
/** The builder_id sent with every ask from this shared login. */
const ASKER = 'admin';
/** Dictation stops itself after this long. */
const DICTATION_MAX_MS = 10 * 60 * 1000;
/** The composer grows to this height, then scrolls. */
const COMPOSER_MAX_PX = 240;

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
          ? 'Waiting for the answer'
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

/** Browser dictation, where the browser offers it. Nothing is sent anywhere. */
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The three-dot menu on a thread: pin, rename, delete. */
function ThreadMenu({
  thread,
  onPin,
  onRename,
  onDelete,
}: {
  thread: ChatThread;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const item = (label: string, I: React.ComponentType<React.SVGProps<SVGSVGElement>>, fn: () => void, danger?: boolean) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        fn();
      }}
      className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover ${danger ? 'text-failing' : ''}`}
    >
      <I className={danger ? '' : 'text-dim'} />
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Thread options"
        className={cx('btn btn-ghost h-7 w-7 rounded-full p-0 text-faint transition-colors hover:text-ink', open && 'bg-hover text-ink')}
      >
        <Icon.more />
      </button>
      {open && (
        <div className="card fade-up absolute top-full right-0 z-20 mt-1 w-[150px] p-1 shadow-[var(--shadow-pop)]">
          {item(thread.pinned ? 'Unpin' : 'Pin', Icon.pin, onPin)}
          {item('Rename', Icon.edit, onRename)}
          {item('Delete', Icon.trash, onDelete, true)}
        </div>
      )}
    </div>
  );
}

export default function AskBays() {
  const { lane } = useSession();
  const { status, data, error } = useData(getAskBays);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [listeningSince, setListeningSince] = useState<number | null>(null);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollers = useRef<Record<string, number>>({});
  const recog = useRef<Recognition | null>(null);
  /** Text committed by dictation so far, and the draft it started from. */
  const dictation = useRef<{ base: string; final: string; active: boolean }>({ base: '', final: '', active: false });

  useEffect(() => {
    if (data) setThreads(data.threads);
  }, [data]);

  useEffect(() => {
    const anyActive = Object.values(cooldownUntil).some((t) => t > Date.now());
    if (!anyActive) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [cooldownUntil]);

  useEffect(
    () => () => {
      Object.values(pollers.current).forEach((id) => clearInterval(id));
      dictation.current.active = false;
      recog.current?.stop();
    },
    [],
  );

  const active = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  const messages = active?.messages ?? [];
  const started = messages.length > 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, activeId]);

  // The composer grows with its text, whether typed or dictated, up to a cap.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, COMPOSER_MAX_PX);
    el.style.height = `${h}px`;
    el.classList.toggle('at-max', el.scrollHeight > COMPOSER_MAX_PX);
    if (listening) el.scrollTop = el.scrollHeight;
  }, [draft, listening]);

  // A one-second clock while dictating, for the elapsed time and the cap.
  useEffect(() => {
    if (!listening) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [listening]);

  const query = search.trim().toLowerCase();
  const visibleThreads = useMemo(() => {
    if (!query) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(query) || t.messages.some((m) => m.text.toLowerCase().includes(query)));
  }, [threads, query]);
  const pinned = visibleThreads.filter((t) => t.pinned);
  const recent = visibleThreads.filter((t) => !t.pinned);

  function persist(next: ChatThread[]) {
    setThreads(next);
    saveLocalThreads(next);
  }

  /** Any change to a thread makes it local, so it persists in this browser. */
  function updateThread(id: string, patch: Partial<ChatThread> | ((t: ChatThread) => ChatThread)) {
    setThreads((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...(typeof patch === 'function' ? patch(t) : { ...t, ...patch }), local: true } : t));
      saveLocalThreads(next);
      return next;
    });
  }

  function patchMessage(threadId: string, messageId: string, patch: Partial<ChatMessage>) {
    updateThread(threadId, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }));
  }

  function appendMessage(threadId: string, m: ChatMessage) {
    updateThread(threadId, (t) => ({ ...t, messages: [...t.messages, m], updated_at: stamp() }));
  }

  function deleteThread(id: string) {
    forgetThread(id);
    persist(threads.filter((t) => t.id !== id));
    if (activeId === id) setActiveId(null);
  }

  function startPolling(threadId: string, messageId: string, sessionId: string) {
    const startedAt = Date.now();
    const tick = async () => {
      const res = await pollBaysAnswer(sessionId);
      const stop = () => {
        clearInterval(pollers.current[threadId]);
        delete pollers.current[threadId];
      };
      if (res.status === 'answered') {
        stop();
        patchMessage(threadId, messageId, { delivery: 'answered' });
        appendMessage(threadId, { id: `bays-${Date.now()}`, role: 'bays', text: res.text, at: res.at });
        return;
      }
      if (res.status === 'unavailable') {
        stop();
        patchMessage(threadId, messageId, { delivery: 'timeout', note: res.reason });
        return;
      }
      if (Date.now() - startedAt > ANSWER_TIMEOUT_MS) {
        stop();
        patchMessage(threadId, messageId, { delivery: 'timeout', note: 'No answer reached the callback within two minutes. Bays may still reply in Slack.' });
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
    if ((cooldownUntil[thread.id] ?? 0) > Date.now()) return;

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
        t.id === thread!.id ? { ...t, local: true, session_id: sessionId, messages: [...t.messages, mine], updated_at: stamp() } : t,
      ),
    );
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

    if (!data.wiring.can_send) return;

    const lane_id: Lane = lane === 'all' ? 'ENGINE_INTERNAL' : lane;
    const result = await sendToBays({ session_id: sessionId, prompt: text, builder_id: ASKER, lane: lane_id });
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

  function stopMic() {
    dictation.current.active = false;
    recog.current?.stop();
    recog.current = null;
    setListening(false);
    setListeningSince(null);
  }

  /**
   * Browsers end a recognition session after a pause. While dictation is
   * active we start a fresh one on each end, folding finished text into the
   * draft, until the person stops it or ten minutes pass.
   */
  function startRecognition(Ctor: new () => Recognition) {
    const r = new Ctor();
    r.lang = navigator.language || 'en-GB';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      let finalChunk = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) dictation.current.final = `${dictation.current.final}${dictation.current.final ? ' ' : ''}${finalChunk.trim()}`;
      const d = dictation.current;
      setDraft([d.base, d.final, interim.trim()].filter(Boolean).join(' '));
    };
    r.onend = () => {
      const d = dictation.current;
      const since = listeningSinceRef.current;
      if (!d.active) return;
      if (since && Date.now() - since >= DICTATION_MAX_MS) {
        stopMic();
        setMicNote('Dictation stopped after ten minutes.');
        setTimeout(() => setMicNote(null), 4000);
        return;
      }
      // Pause detected by the browser: keep going.
      try {
        startRecognition(Ctor);
      } catch {
        stopMic();
      }
    };
    r.onerror = () => {
      if (!dictation.current.active) return;
      stopMic();
      setMicNote('Dictation stopped. Check the microphone permission.');
      setTimeout(() => setMicNote(null), 4000);
    };
    recog.current = r;
    r.start();
  }

  const listeningSinceRef = useRef<number | null>(null);
  useEffect(() => {
    listeningSinceRef.current = listeningSince;
  }, [listeningSince]);

  function toggleMic() {
    if (listening) {
      stopMic();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setMicNote('This browser does not offer dictation. Safari and Chrome do.');
      setTimeout(() => setMicNote(null), 4000);
      return;
    }
    dictation.current = { base: draft.trim(), final: '', active: true };
    setListening(true);
    const t = Date.now();
    setListeningSince(t);
    listeningSinceRef.current = t;
    startRecognition(Ctor);
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

  const threadRow = (t: ChatThread) => (
    <div
      key={t.id}
      role="button"
      tabIndex={0}
      onClick={() => {
        setActiveId(t.id);
        setPanelOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setActiveId(t.id);
      }}
      className={`group flex w-full items-center gap-1 rounded-[10px] px-3 py-2 text-left transition-colors ${t.id === activeId ? 'bg-raised' : 'hover:bg-hover'}`}
    >
      {renaming?.id === t.id ? (
        <input
          autoFocus
          value={renaming.title}
          onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              updateThread(t.id, { title: renaming.title.trim() || t.title });
              setRenaming(null);
            }
            if (e.key === 'Escape') setRenaming(null);
          }}
          onBlur={() => {
            updateThread(t.id, { title: renaming.title.trim() || t.title });
            setRenaming(null);
          }}
          className="input h-7 flex-1 px-2 text-[12.5px]"
        />
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {t.pinned && <Icon.pin className="shrink-0 text-faint" width={11} height={11} />}
            <span className="truncate text-[12.5px]">{t.title}</span>
          </div>
          <div className="tabular mt-0.5 text-[11px] text-faint">{t.updated_at}</div>
        </div>
      )}
      <ThreadMenu
        thread={t}
        onPin={() => updateThread(t.id, { pinned: !t.pinned })}
        onRename={() => setRenaming({ id: t.id, title: t.title })}
        onDelete={() => deleteThread(t.id)}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Page header: the name on the left, date and theme on the right. */}
        <div className="flex h-[72px] shrink-0 items-center gap-3 px-6 md:px-8">
          <img src="/logo.svg" alt="" className="mark h-7 w-7 max-md:ml-8" />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold">Ask Bays</div>
            <div className="text-[11.5px] text-faint">{active ? active.title : 'New chat'}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ClockChip />
            <ThemeChip />
          </div>
        </div>
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
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">
            <img src="/logo.svg" alt="BHA" className="mark idle-mark h-32 w-32" />
            <p className="font-display text-[22px] text-dim">Ask Bays</p>
          </div>
        )}

        <div className="shrink-0 px-6 pb-4">
          <div className="mx-auto max-w-[72ch]">
            {!wiring.can_send || wiring.delivery === 'none' ? (
              <p className="mb-2 rounded-[10px] bg-degraded-soft px-3 py-2 text-[11.5px] leading-relaxed text-degraded">{wiring.note}</p>
            ) : !wiring.can_read_answers ? (
              <p className="mb-2 px-1 text-[11.5px] leading-relaxed text-faint">{wiring.note}</p>
            ) : null}
            {micNote && <p className="fade-up mb-2 px-1 text-[11.5px] text-dim">{micNote}</p>}

            <div className="card flex items-end gap-1.5 p-2 transition-shadow focus-within:shadow-[var(--shadow-pop)]">
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
                placeholder={cooldownLeft > 0 ? `Bays refuses the same session inside 30 s · ${cooldownLeft}s` : listening ? 'Listening' : 'Ask Bays anything about the engine'}
                className="input min-h-[36px] flex-1 resize-none border-0 bg-transparent shadow-none focus:shadow-none"
                style={{ height: 'auto' }}
              />
              <button
                type="button"
                onClick={toggleMic}
                aria-label={listening ? 'Stop dictation' : 'Dictate a message'}
                aria-pressed={listening}
                className={cx('btn btn-ghost h-8 rounded-full p-0', listening ? 'w-auto gap-1.5 bg-accent-soft px-2.5 text-accent-ink' : 'w-8')}
              >
                {listening ? (
                  <>
                    <span className="pulse-dot"><Icon.mic /></span>
                    <span className="tabular text-[11.5px]">
                      {(() => {
                        const secs = Math.max(0, Math.floor((now - (listeningSince ?? now)) / 1000));
                        return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} / 10:00`;
                      })()}
                    </span>
                  </>
                ) : (
                  <Icon.mic />
                )}
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || cooldownLeft > 0}
                className="btn btn-primary h-8 w-8 rounded-full p-0"
                aria-label="Send"
              >
                <Icon.send />
              </button>
              <button type="button" onClick={() => setPanelOpen(true)} aria-label="Open chat history" className="btn btn-ghost h-8 md:hidden">
                Chats
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-faint">
              <span>Enter to send · shift+enter for a new line</span>
              <span className="flex items-center gap-1.5">
                <Icon.sparkle width={11} height={11} />
                {data.model_label}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right-hand panel: full height. New chat, search, pinned, recents. */}
      {panelOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setPanelOpen(false)} aria-hidden />}

      {panelHidden ? (
        <div className="hidden w-[52px] shrink-0 flex-col items-center border-l border-line bg-panel py-3 md:flex">
          <button type="button" onClick={() => setPanelHidden(false)} className="btn btn-ghost h-8 w-8 rounded-full p-0" aria-label="Show chat history" title="Show chat history">
            <Icon.sidebar />
          </button>
          <button type="button" onClick={newChat} className="btn btn-ghost mt-1 h-8 w-8 rounded-full p-0" aria-label="New chat" title="New chat">
            <Icon.plus />
          </button>
        </div>
      ) : (
        <aside
          className={cx(
            'w-[276px] shrink-0 flex-col border-l border-line bg-panel md:static md:flex',
            panelOpen ? 'fixed inset-y-0 right-0 z-50 flex shadow-[var(--shadow-pop)]' : 'hidden',
          )}
        >
          <div className="space-y-2 p-3 pt-4">
            <button type="button" onClick={newChat} className="btn w-full justify-start gap-2">
              <Icon.plus />
              New chat
            </button>
            <div className="relative">
              <Icon.search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats" className="input h-8 pr-7 pl-8 text-[12px]" aria-label="Search chats" />
              {search && (
                <button type="button" onClick={() => setSearch('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-ink" aria-label="Clear search">
                  <Icon.close width={12} height={12} />
                </button>
              )}
            </div>
            {query && (
              <p className="px-1 text-[11px] text-faint">
                {visibleThreads.length === 0 ? 'No chat matches' : `${visibleThreads.length} chat${visibleThreads.length === 1 ? '' : 's'} match`} “{search.trim()}”
              </p>
            )}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {pinned.length > 0 && (
              <>
                <div className="kicker px-3 pt-1 pb-1">Pinned</div>
                {pinned.map(threadRow)}
                <div className="kicker px-3 pt-3 pb-1">Recent</div>
              </>
            )}
            {recent.length === 0 && pinned.length === 0 ? (
              <p className="px-3 py-4 text-[12px] leading-relaxed text-dim">{query ? 'Nothing matches that search.' : 'No chats yet. Start one below.'}</p>
            ) : (
              recent.map(threadRow)
            )}
          </div>

          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <button type="button" onClick={() => setPanelHidden(true)} className="btn btn-ghost btn-sm gap-1.5 text-faint" aria-label="Hide chat history">
              <Icon.sidebar />
              <span className="hidden md:inline">Hide</span>
            </button>
            <span className="text-[11px] text-faint">{threads.length} chat{threads.length === 1 ? '' : 's'}</span>
          </div>
        </aside>
      )}
    </div>
  );
}
