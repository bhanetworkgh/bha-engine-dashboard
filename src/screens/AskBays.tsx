import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { askBays, forgetThread, getAskBays, saveLocalThreads, type ChatMessage, type ChatThread } from '../data';
import { Icon, LoadFailed, Loading } from '../components/ui';
import { ClockChip, ThemeChip } from '../components/ClockChip';
import { cx } from '../lib';

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
  if (!m.delivery || m.delivery === 'answered' || m.delivery === 'sent') return null;
  const text = m.delivery === 'sending' ? 'Sending' : (m.note ?? 'Not sent.');
  const tone = m.delivery === 'failed' ? 'text-failing' : 'text-faint';
  return (
    <div className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] ${tone}`}>
      {m.delivery === 'sending' && <span className="pulse-dot h-[6px] w-[6px] rounded-full bg-current" />}
      {text}
    </div>
  );
}

/**
 * Why a message did not get an answer, in one plain sentence each. Keyed by
 * the `error` the data module returns, so the screen never has to guess from
 * the text of the answer.
 */
const NOTICE_NOTE: Record<string, string> = {
  unauthorised: 'The workflow rejected the dashboard’s API key. Bays never saw this.',
  empty_message: 'The workflow received no question.',
  not_configured: 'Ask Bays is not connected on the server.',
  timeout: 'Bays did not answer in time.',
  unreachable: 'Nothing answered.',
  bad_response: 'The reply could not be read.',
};

/** The shorter form, shown under the message that failed to get through. */
const NOT_SENT: Record<string, string> = {
  unauthorised: 'Not delivered — key rejected.',
  empty_message: 'Not delivered — no question received.',
  not_configured: 'Not delivered — Ask Bays is not connected.',
  timeout: 'No answer in time.',
  unreachable: 'Not delivered.',
  bad_response: 'Not delivered.',
};

/**
 * The app speaking, not Bays. The workflow answers a refused key with HTTP
 * 200 and a sentence, so without this the words "This request was not
 * authorised." would sit under the BHA mark with his name on them.
 */
function Notice({ m }: { m: ChatMessage }) {
  return (
    <div className="fade-up flex justify-center">
      <div className="max-w-[85%] rounded-[14px] bg-raised px-3.5 py-2.5 text-center">
        <div className="text-[12.5px] leading-relaxed text-degraded">{m.text}</div>
        {m.note && <div className="mt-1 text-[11px] text-faint">{m.note}</div>}
      </div>
    </div>
  );
}

/**
 * Shown while a reply is in flight. It says only what is true: that Bays is
 * working and for how long. What it looked at arrives with the answer, as
 * `steps`, and is shown under the reply; nothing is guessed here.
 */
function Thinking({ since, now }: { since: number; now: number }) {
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const caption = secs < 8 ? 'Bays is thinking' : secs < 30 ? 'Still working on it' : secs < 60 ? 'Taking longer than usual' : 'Bays has up to ninety seconds';
  return (
    <div className="fade-up flex gap-3" aria-live="polite">
      <img src="/logo.svg" alt="" className="mark idle-mark mt-0.5 h-6 w-6 shrink-0" />
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline gap-2 text-[11px]">
          <span className="font-medium text-ink">Bays</span>
          <span className="tabular text-faint">{secs}s</span>
        </div>
        <div className="flex items-center gap-2.5 text-[13px] text-dim">
          <span className="thinking-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          {caption}
        </div>
      </div>
    </div>
  );
}

/** The agent's own trace of what it looked at, under its answer. Absent when it looked at nothing. */
function StepsTrace({ steps }: { steps?: string[] }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
      <span className="mr-0.5">Looked at</span>
      {steps.map((st, i) => (
        <span key={`${st}-${i}`} className="chip-step">
          {st}
        </span>
      ))}
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
  /** The reply in flight, if any: one per thread. */
  const [pending, setPending] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recog = useRef<Recognition | null>(null);
  /** Text committed by dictation so far, and the draft it started from. */
  const dictation = useRef<{ base: string; final: string; active: boolean }>({ base: '', final: '', active: false });

  useEffect(() => {
    if (data) setThreads(data.threads);
  }, [data]);

  // A one-second clock while a reply is in flight, for the thinking indicator.
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [pending]);

  useEffect(
    () => () => {
      dictation.current.active = false;
      recog.current?.stop();
    },
    [],
  );

  const active = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  const messages = active?.messages ?? [];
  const started = messages.length > 0;
  const thinkingSince = active ? pending[active.id] : undefined;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, activeId, thinkingSince]);

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
    if (pending[thread.id]) return;
    // One session_id for the life of the thread. That is what Bays remembers by.
    const sessionId = thread.session_id ?? newSessionId();
    const threadId = thread.id;

    const mine: ChatMessage = { id: `me-${Date.now()}`, role: 'user', text, at: stamp(), delivery: 'sending' };
    persist(list.map((t) => (t.id === threadId ? { ...t, local: true, session_id: sessionId, messages: [...t.messages, mine], updated_at: stamp() } : t)));
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

    const startedAt = Date.now();
    setNow(startedAt);
    setPending((p) => ({ ...p, [threadId]: startedAt }));
    const reply = await askBays(text, sessionId, ASKER);
    setPending((p) => {
      const next = { ...p };
      delete next[threadId];
      return next;
    });
    patchMessage(threadId, mine.id, { delivery: reply.ok ? 'answered' : 'failed', note: reply.ok ? undefined : NOT_SENT[reply.error ?? 'bad_response'] });
    // ok:false arrives with HTTP 200 and a sentence in `answer`, but that
    // sentence is the gate refusing, not Bays answering. It goes in as a
    // notice so nothing attributes it to him.
    appendMessage(threadId, {
      id: `${reply.ok ? 'bays' : 'notice'}-${Date.now()}`,
      role: reply.ok ? 'bays' : 'notice',
      text: reply.answer,
      at: stamp(),
      steps: reply.ok ? reply.steps : undefined,
      delivery: reply.ok ? 'answered' : 'failed',
      note: reply.ok ? undefined : NOTICE_NOTE[reply.error ?? 'bad_response'],
    });
    if (reply.session_id && reply.session_id !== sessionId) updateThread(threadId, { session_id: reply.session_id });
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

  const inFlight = Boolean(thinkingSince);

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
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Page header: the name on the left, date and theme on the right. Messages scroll under it. */}
        <div className="frost-bar absolute inset-x-0 top-0 z-20 flex h-[84px] items-center gap-3 px-6 pb-3 md:px-8">
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
          <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pt-[84px] pb-6">
            <div className="mx-auto max-w-[72ch] space-y-5">
              {messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="fade-up flex flex-col items-end">
                    <div className="bubble-user max-w-[85%] text-[13.5px] leading-relaxed whitespace-pre-wrap">{m.text}</div>
                    <DeliveryLine m={m} />
                  </div>
                ) : m.role === 'notice' ? (
                  <Notice key={m.id} m={m} />
                ) : (
                  <div key={m.id} className="fade-up flex gap-3">
                    <img src="/logo.svg" alt="" className="mark mt-0.5 h-6 w-6 shrink-0" />
                    <div className="min-w-0">
                      <div className="mb-1 flex items-baseline gap-2 text-[11px]">
                        <span className="font-medium text-ink">Bays</span>
                        <span className="text-faint">{m.at}</span>
                        {m.delivery === 'failed' && <span className="text-degraded">{m.note ?? 'Could not complete this.'}</span>}
                      </div>
                      <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{m.text}</div>
                      <StepsTrace steps={m.steps} />
                    </div>
                  </div>
                ),
              )}
              {thinkingSince && <Thinking since={thinkingSince} now={now} />}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 pt-[72px]">
            <img src="/logo.svg" alt="BHA" className="mark idle-mark h-32 w-32" />
            <p className="font-display text-[22px] text-dim">Ask Bays</p>
          </div>
        )}

        <div className="shrink-0 px-6 pb-4">
          <div className="mx-auto max-w-[72ch]">
            {!data.connected && (
              <p className="mb-2 rounded-[10px] bg-degraded-soft px-3 py-2 text-[11.5px] leading-relaxed text-degraded">
                Ask Bays is not connected: the server has no API key for the Bays workflow. Anything sent will come back with that answer.
              </p>
            )}
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
                placeholder={inFlight ? 'Bays is answering' : listening ? 'Listening' : 'Ask Bays anything about the engine'}
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
                disabled={!draft.trim() || inFlight}
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
            'frost-side w-[276px] shrink-0 flex-col border-l border-line md:static md:flex',
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
