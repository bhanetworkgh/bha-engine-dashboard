import { useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { getAskBays, type ChatMessage, type ChatThread } from '../data';
import { Loading, LoadFailed, act } from '../components/ui';

export default function AskBays() {
  const { status, data, error } = useData(getAskBays);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  /** Messages typed this session, keyed by thread. Nothing persists. */
  const [local, setLocal] = useState<Record<string, ChatMessage[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const threads = data?.threads ?? [];
  const active: ChatThread | null = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );

  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.text.toLowerCase().includes(q)),
    );
  }, [threads, search]);

  const messages: ChatMessage[] = active
    ? [...active.messages, ...(local[active.id] ?? [])]
    : (local['__new'] ?? []);

  const started = messages.length > 0;

  function send() {
    const text = draft.trim();
    if (!text) return;
    const key = active ? active.id : '__new';
    const mine: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
      at: 'just now',
    };
    setLocal((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), mine] }));
    setDraft('');
    act('ask-bays.send', key, { text });
  }

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {started ? (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-[70ch] space-y-5">
              {messages.map((m) => (
                <div key={m.id}>
                  <div className="mb-1 flex items-baseline gap-2 text-[11px]">
                    <span className={m.role === 'bays' ? 'text-gold' : 'text-dim'}>
                      {m.role === 'bays' ? 'Bays' : 'You'}
                    </span>
                    <span className="text-faint">{m.at}</span>
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed text-ink">{m.text}</div>
                </div>
              ))}
              {local[active ? active.id : '__new']?.length ? (
                <p className="text-[11px] text-faint">
                  Bays is not wired to this interface yet, so there is no reply. The
                  message above was not sent anywhere.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          /* Empty state: the mark, centred and large, with the one permitted
             decorative animation. Nothing else on screen until the user types. */
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <img
              src="/logo.svg"
              alt="BHA"
              className="idle-mark h-40 w-40 rounded-full"
            />
          </div>
        )}

        <div className="shrink-0 border-t border-line px-6 py-3">
          <div className="mx-auto flex max-w-[70ch] items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              placeholder="Ask Bays"
              className="flex-1 border border-line bg-raised px-2.5 py-1.5 text-ink outline-none placeholder:text-faint focus:border-gold-dim"
            />
            <button
              type="button"
              onClick={send}
              className="border border-line px-2.5 py-1.5 text-dim hover:border-gold-dim hover:text-gold"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Right-hand panel: new chat, history, search. */}
      <aside className="flex w-[236px] shrink-0 flex-col border-l border-line bg-panel">
        <div className="border-b border-line p-2.5">
          <button
            type="button"
            onClick={() => {
              setActiveId(null);
              setLocal((p) => ({ ...p, __new: [] }));
              setDraft('');
              inputRef.current?.focus();
              act('ask-bays.new-chat', 'new');
            }}
            className="w-full border border-line px-2 py-1 text-dim hover:border-gold-dim hover:text-gold"
          >
            New chat
          </button>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search past chats"
            className="mt-2 w-full border border-line bg-raised px-2 py-1 text-[12px] outline-none placeholder:text-faint focus:border-gold-dim"
          />
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {visibleThreads.length === 0 ? (
            <p className="px-3 py-4 text-[12px] leading-relaxed text-dim">
              No stored chat matches that search.
            </p>
          ) : (
            visibleThreads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setActiveId(t.id);
                  act('ask-bays.open-thread', t.id);
                }}
                className={`block w-full border-b border-line px-3 py-1.5 text-left ${
                  t.id === activeId ? 'bg-raised border-l-2 border-l-gold' : 'hover:bg-hover'
                }`}
              >
                <div className="truncate text-[12px]">{t.title}</div>
                <div className="tabular text-[11px] text-faint">{t.updated_at}</div>
              </button>
            ))
          )}
        </div>

        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
          {data.memory_note}
        </p>
      </aside>
    </div>
  );
}
