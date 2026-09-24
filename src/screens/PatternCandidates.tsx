import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import {
  ApiError,
  declineCandidate,
  getBuilderProfiles,
  reassignCandidate,
  registerCandidate,
  type BuildPattern,
  type BuilderProfile,
  type CandidateRegistered,
  type PatternCandidate,
  type PatternCandidatesData,
} from '../data';
import type { RecordColumn } from '../components/ui';
import { Button, ButtonAnchor, Definition, EmptyState, Loading, MonthPicker, Pagination, Pill, RecordTable, relativeTime, SearchBox, Segmented, Toast, TwoLine, usePaged, useToast } from '../components/ui';

/**
 * Pattern candidates (2026-09-23, Destiny; actions 2026-09-24): ideas Bays
 * flags from real work — mostly Jason, through Bays — each with a Suggested
 * Architect (by default the builder who did the work), who decides whether it
 * becomes a registered build pattern.
 *
 * **Filters at a glance, in the address.** Builder, suggested architect, lane
 * and status are each a picker whose options carry their own counts, counted
 * over the rows every *other* filter leaves, so a count is always what picking
 * it would show. They live in the URL (`builder`, `architect`, `lane`,
 * `status`, `month`) so "my candidates" is a bookmark. The month here is the
 * month flagged and defaults to **all time**, unlike the Patterns tab: an
 * architect's backlog spans months, and a bookmark that silently opened on the
 * current one would hide most of it.
 *
 * **Proposed first, oldest first** (2026-09-24, Destiny) — an explicit
 * exception to "newest first": this is a queue of decisions owed, and the
 * oldest undecided one is the one to reach first. Then Approved, Registered,
 * Declined, anything else, oldest first within each.
 *
 * **Acting on one** — register it as a pattern, decline it, or give it another
 * architect — is on its detail panel. The server checks who may act and writes
 * through the MCP write tools' own handlers (`server/src/candidateActions.ts`).
 * The dashboard's login is shared, so the person acting is **declared** here
 * from Builder Profiles and remembered in this browser; the page says so.
 */
export const CANDIDATE_STATUSES = ['Proposed', 'Approved', 'Registered', 'Declined'] as const;

/** What each status means, from the table's own vocabulary and the registration path. */
export const CANDIDATE_DEFS: Record<string, string> = {
  Proposed: 'Flagged from real work; its architect has not decided yet.',
  Approved: 'An architect has agreed it should become a pattern; not yet written up and registered.',
  Registered: 'Written up as a build pattern. Pattern ID and Registered At are set only on these rows.',
  Declined: 'Its architect decided it is not a pattern. The reason and who declined it are on the row.',
};

const ORDER: Record<string, number> = { Proposed: 0, Approved: 1, Registered: 2, Declined: 3 };
/** Jason and Destiny may act on any candidate — the same two ids the loop guard treats as admins. */
const ADMIN_IDS = ['U0AEW3TBYH1', 'U0A9V97949F'];
const ACTING_KEY = 'bha.actingAs';

function candidateTone(status: string | null): 'default' | 'accent' {
  return status === 'Registered' ? 'accent' : 'default';
}

function readActing(): string | null {
  try {
    return window.localStorage.getItem(ACTING_KEY);
  } catch {
    return null;
  }
}
function writeActing(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTING_KEY, id);
    else window.localStorage.removeItem(ACTING_KEY);
  } catch {
    /* storage refused: the choice lasts until the page closes */
  }
}

export function mayAct(c: PatternCandidate, actor: string | null): boolean {
  return Boolean(actor) && (ADMIN_IDS.includes(actor!) || actor === c.architect_slack_id || actor === c.builder_slack_id);
}

function isOpen(c: PatternCandidate): boolean {
  return c.status !== 'Registered' && c.status !== 'Declined';
}

function candidateColumns(): RecordColumn<PatternCandidate>[] {
  return [
    {
      key: 'candidate',
      header: 'candidate',
      card: 'title',
      width: '46ch',
      title: (c) => c.summary ?? c.candidate ?? c.id,
      cell: (c) => <TwoLine title={c.candidate ?? c.id} description={c.summary} empty="No summary written on this candidate." />,
    },
    { key: 'lane', header: 'lane', card: 'meta', width: '10ch', clip: true, className: 'text-dim', cell: (c) => c.lane ?? <span className="text-faint">—</span> },
    { key: 'builder', header: 'builder', card: 'meta', width: '14ch', clip: true, className: 'text-dim', cell: (c) => c.builder ?? <span className="text-faint">—</span> },
    {
      key: 'architect',
      header: 'suggested architect',
      card: 'meta',
      width: '16ch',
      clip: true,
      className: 'text-dim',
      title: (c) => c.why_this_architect ?? undefined,
      cell: (c) => c.suggested_architect ?? <span className="text-faint">—</span>,
    },
    {
      key: 'status',
      header: 'status',
      card: 'meta',
      width: '12ch',
      title: (c) => (c.status ? CANDIDATE_DEFS[c.status] ?? `"${c.status}" is not one of ${CANDIDATE_STATUSES.join(', ')}.` : 'No status on this row.'),
      cell: (c) => (c.status ? <Pill tone={candidateTone(c.status)}>{c.status.toLowerCase()}</Pill> : <span className="text-faint">—</span>),
    },
    { key: 'flagged', header: 'flagged', card: 'meta', width: '11ch', className: 'tabular text-faint', cell: (c) => c.date_flagged ?? <span className="text-faint">undated</span> },
  ];
}

type Facet = 'builder' | 'architect' | 'lane' | 'status';
const FACET_OF: Record<Facet, (c: PatternCandidate) => string | null> = {
  builder: (c) => c.builder,
  architect: (c) => c.suggested_architect,
  lane: (c) => c.lane,
  status: (c) => c.status,
};
const NONE = '(none)';

/** One facet as a compact picker: "All builders (52)", then each value with its count. */
function FacetPicker({ label, allLabel, value, options, onChange }: { label: string; allLabel: string; value: string | null; options: [string, number][]; onChange: (v: string | null) => void }) {
  const total = options.reduce((n, [, c]) => n + c, 0);
  const missing = value && !options.some(([v]) => v === value);
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-faint">
      <span>{label}</span>
      <select className="input h-[30px] w-auto max-w-[190px] py-0 text-[12px]" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">
          {allLabel} ({total})
        </option>
        {options.map(([v, n]) => (
          <option key={v} value={v}>
            {v} ({n})
          </option>
        ))}
        {missing && <option value={value!}>{value} (0)</option>}
      </select>
    </label>
  );
}

export function CandidatesTab({
  state,
  months,
  q,
  onQ,
  patterns,
  onOpenPattern,
}: {
  state: { status: 'loading' | 'ready' | 'error'; data: PatternCandidatesData | null; error: string | null };
  months: string[];
  q: string;
  onQ: (q: string) => void;
  patterns: BuildPattern[];
  onOpenPattern: (id: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const { toast, setToast } = useToast();
  const profiles = useData(getBuilderProfiles, []);
  const [acting, setActingState] = useState<string | null>(() => readActing());
  const setActing = (id: string | null) => {
    setActingState(id);
    writeActing(id);
  };

  const filters: Record<Facet, string | null> = {
    builder: params.get('builder'),
    architect: params.get('architect'),
    lane: params.get('lane'),
    status: params.get('status'),
  };
  const month = params.get('month');
  const openId = params.get('open');
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const all = state.data?.candidates ?? [];
  const needle = q.trim().toLowerCase();
  const base = useMemo(
    () =>
      all
        .filter((c) => !month || c.date_flagged?.slice(0, 7) === month)
        .filter(
          (c) =>
            !needle ||
            [c.id, c.candidate, c.summary, c.lane, c.builder, c.suggested_architect, c.why_this_architect, c.flagged_by, c.pattern_id, c.declined_reason].some((v) => v?.toLowerCase().includes(needle)),
        ),
    [all, month, needle],
  );
  const passes = (c: PatternCandidate, except: Facet | null) =>
    (Object.keys(filters) as Facet[]).every((f) => f === except || !filters[f] || (FACET_OF[f](c) ?? NONE) === filters[f]);
  /** Each facet counted over what the other filters leave, so a count is what picking it would show. */
  const facet = (f: Facet): [string, number][] => {
    const m = new Map<string, number>();
    for (const c of base) if (passes(c, f)) m.set(FACET_OF[f](c) ?? NONE, (m.get(FACET_OF[f](c) ?? NONE) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (f === 'status' ? (ORDER[a[0]] ?? 9) - (ORDER[b[0]] ?? 9) : b[1] - a[1]) || a[0].localeCompare(b[0]));
  };
  const rows = useMemo(
    () =>
      base
        .filter((c) => passes(c, null))
        .slice()
        .sort((a, b) => (ORDER[a.status ?? ''] ?? 9) - (ORDER[b.status ?? ''] ?? 9) || (a.date_flagged ?? '9999').localeCompare(b.date_flagged ?? '9999') || a.id.localeCompare(b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, filters.builder, filters.architect, filters.lane, filters.status],
  );
  const paged = usePaged(rows, `${JSON.stringify(filters)}|${needle}|${month ?? 'all'}`);
  const open = openId ? all.find((c) => c.id === openId) ?? null : null;
  const me = profiles.data?.profiles.find((p) => p.user_id === acting) ?? null;
  const filtered = (Object.keys(filters) as Facet[]).some((f) => filters[f]) || Boolean(month);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error' || !state.data) {
    return (
      <div className="card mx-6 mt-2 px-5 py-4 text-[12.5px] text-failing md:mx-8">
        Could not read the pattern candidates: {state.error ?? 'no answer'}. This is a failed read, not an empty list.
      </div>
    );
  }

  const statusOptions = facet('status');
  return (
    <div className="relative scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 px-6 pb-3 text-[12px] text-faint md:px-8">
        {state.data.held} {state.data.held === 1 ? 'candidate' : 'candidates'} held
        {state.data.updated_at ? ` · newest change ${relativeTime(state.data.updated_at) ?? state.data.updated_at}` : ''} · the oldest undecided first
      </div>
      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* The status strip: each count is the filter. */}
          <Segmented
            ariaLabel="Filter by status"
            value={filters.status ?? 'all'}
            onChange={(v) => setParam('status', v === 'all' ? null : v)}
            options={[
              { value: 'all', label: 'All', count: statusOptions.reduce((n, [, c]) => n + c, 0), title: 'Every candidate the other filters leave.' },
              ...statusOptions.map(([st, n]) => ({ value: st, label: st === NONE ? 'No status' : st, count: n, title: CANDIDATE_DEFS[st] ?? `"${st}" is not one of ${CANDIDATE_STATUSES.join(', ')}.` })),
            ]}
          />
          <div className="flex flex-1 items-center justify-end gap-3">
            <MonthPicker months={months} value={month} onChange={(m) => setParam('month', m)} allowAll />
            <SearchBox value={q} onChange={onQ} placeholder="Search candidate, summary, lane, people" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FacetPicker label="Builder" allLabel="All builders" value={filters.builder} options={facet('builder')} onChange={(v) => setParam('builder', v)} />
          <FacetPicker label="Suggested architect" allLabel="All architects" value={filters.architect} options={facet('architect')} onChange={(v) => setParam('architect', v)} />
          <FacetPicker label="Lane" allLabel="All lanes" value={filters.lane} options={facet('lane')} onChange={(v) => setParam('lane', v)} />
          {me && filters.architect !== me.name && (
            <Button variant="ghost" size="sm" onClick={() => setParam('architect', me.name)} title="Candidates where you are the suggested architect. Bookmark the address to come back to it.">
              Mine as architect
            </Button>
          )}
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(params);
                for (const k of ['builder', 'architect', 'lane', 'status', 'month']) next.delete(k);
                setParams(next, { replace: true });
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
        {filters.status && CANDIDATE_DEFS[filters.status] && <Definition term={filters.status}>{CANDIDATE_DEFS[filters.status]}</Definition>}
      </div>
      {state.data.held === 0 ? (
        <EmptyState>No pattern candidate is held. Bays writes them to engine_pattern_candidates as it flags them; none has arrived.</EmptyState>
      ) : (
        <>
          <RecordTable
            columns={candidateColumns()}
            rows={paged.rows}
            rowKey={(c) => c.id}
            onOpen={(c) => setParam('open', c.id)}
            lines={2}
            label="Pattern candidates"
            empty={needle ? 'No candidate matches that search with these filters.' : 'No candidate matches these filters.'}
          />
          <Pagination paged={paged} unit="candidates" />
        </>
      )}
      {open && (
        <CandidateView
          c={open}
          onClose={() => setParam('open', null)}
          patternRecord={open.pattern_id ? patterns.find((p) => p.pattern_id === open.pattern_id)?.id ?? null : null}
          onOpenPattern={(id) => {
            setParam('open', null);
            onOpenPattern(id);
          }}
          profiles={profiles.data?.profiles ?? null}
          profilesError={profiles.status === 'error' ? profiles.error ?? 'no answer' : null}
          acting={acting}
          onActing={setActing}
          onDone={(text) => setToast({ text, tone: 'ok' })}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}

type Mode = 'view' | 'register' | 'decline' | 'reassign';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-faint">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

function errorText(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

/** The whole candidate, and what its architect can do with it. */
function CandidateView({
  c,
  onClose,
  patternRecord,
  onOpenPattern,
  profiles,
  profilesError,
  acting,
  onActing,
  onDone,
}: {
  c: PatternCandidate;
  onClose: () => void;
  patternRecord: string | null;
  onOpenPattern: (id: string) => void;
  profiles: BuilderProfile[] | null;
  profilesError: string | null;
  acting: string | null;
  onActing: (id: string | null) => void;
  onDone: (text: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<CandidateRegistered | null>(null);
  const me = profiles?.find((p) => p.user_id === acting) ?? null;
  const permitted = mayAct(c, acting);
  const open = isOpen(c);

  // A different candidate, or the same one changing under us, resets the form.
  useEffect(() => {
    setMode('view');
    setError(null);
  }, [c.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, onClose]);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const facts: [string, ReactNode][] = [
    ['Candidate', c.candidate ?? '—'],
    ['Status', c.status ?? 'no status'],
    ['Builder', c.builder ?? '—'],
    ['Lane', c.lane ?? '—'],
    ['Suggested architect', c.suggested_architect ?? '—'],
    ['Flagged by', c.flagged_by ?? '—'],
    ['Date flagged', c.date_flagged ?? 'undated'],
    [
      'Source link',
      c.source_link ? (
        <a className="link break-all" href={c.source_link} target="_blank" rel="noreferrer">
          {c.source_link.includes('slack.com') ? 'Open the Slack thread ↗' : c.source_link}
        </a>
      ) : (
        'No Source Link on this row, so there is no thread to open.'
      ),
    ],
  ];

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={() => !busy && onClose()}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Pattern candidate">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{c.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{c.candidate ?? c.id}</h2>
            <div className="mt-2">{c.status ? <Pill tone={candidateTone(c.status)}>{c.status.toLowerCase()}</Pill> : <span className="text-[12px] text-faint">no status</span>}</div>
          </div>
          <div className="flex items-center gap-2">
            {c.source_link && (
              <ButtonAnchor variant="ghost" size="sm" href={c.source_link} target="_blank" rel="noreferrer">
                Open the Slack thread
              </ButtonAnchor>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Close
            </Button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {c.status === 'Registered' && (
            <div>
              <div className="mb-1 text-[11px] text-faint">Registered as</div>
              {c.pattern_id ? (
                patternRecord ? (
                  <button type="button" className="link tabular text-[13px]" onClick={() => onOpenPattern(patternRecord)}>
                    {c.pattern_id}
                  </button>
                ) : (
                  <span className="tabular text-[13px] text-ink">
                    {c.pattern_id} <span className="text-faint">— no pattern with this id is held on the Patterns tab yet</span>
                  </span>
                )
              ) : (
                <span className="text-[13px] text-faint">Registered, but the row carries no Pattern ID.</span>
              )}
              {c.registered_at && <span className="tabular ml-3 text-[12px] text-faint">{c.registered_at.slice(0, 16).replace('T', ' ')}</span>}
              {c.registered_by && <span className="ml-3 text-[12px] text-faint">by {c.registered_by}</span>}
            </div>
          )}
          {c.status === 'Declined' && (
            <div>
              <div className="mb-1 text-[11px] text-faint">
                Declined{c.declined_by ? ` by ${c.declined_by}` : ''}
                {c.declined_at ? ` · ${c.declined_at.slice(0, 16).replace('T', ' ')}` : ''}
              </div>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{c.declined_reason ?? <span className="text-faint">No reason recorded.</span>}</p>
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] text-faint">Summary</div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{c.summary ?? <span className="text-faint">No summary written.</span>}</p>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-faint">Why this architect</div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{c.why_this_architect ?? <span className="text-faint">Not written.</span>}</p>
            {c.reassigned_by && (
              <p className="mt-1 text-[11.5px] text-faint">
                Architect changed by {c.reassigned_by}
                {c.reassigned_at ? ` on ${c.reassigned_at.slice(0, 10)}` : ''}; the reason above was written for the architect first suggested.
              </p>
            )}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[auto_minmax(0,1fr)]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="text-dim">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* ------------------------------------------------------------ act */}
        <div className="mt-5 border-t border-line pt-4">
          {registered ? (
            <RegisteredNote r={registered} onOpenPattern={onOpenPattern} patternRecord={patternRecord} />
          ) : !open ? (
            <p className="text-[12.5px] text-faint">This candidate is {c.status?.toLowerCase()}; there is nothing left to decide on it here.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[11.5px] text-faint">
                  <span>Acting as</span>
                  <select className="input h-[30px] w-auto py-0 text-[12px]" value={acting ?? ''} onChange={(e) => onActing(e.target.value || null)} aria-label="Acting as" disabled={busy}>
                    <option value="">Choose your name…</option>
                    {(profiles ?? []).map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {profilesError && <span className="text-[12px] text-failing">Could not read Builder Profiles: {profilesError}</span>}
                <span className="text-[11.5px] text-faint">The login is shared, so this is who you say you are — remembered in this browser, not checked.</span>
              </div>
              {!me ? (
                <p className="mt-3 text-[12.5px] text-faint">Choose your name to register, decline or reassign this candidate.</p>
              ) : !permitted ? (
                <p className="mt-3 text-[12.5px] text-dim">
                  {me.name} cannot act on this one: only its suggested architect ({c.suggested_architect ?? 'not set'}), its builder ({c.builder ?? 'not set'}), Jason or Destiny can.
                </p>
              ) : mode === 'view' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => setMode('register')}>
                    Register as a pattern
                  </Button>
                  <Button onClick={() => setMode('decline')}>Decline</Button>
                  <Button onClick={() => setMode('reassign')}>Reassign architect</Button>
                </div>
              ) : mode === 'register' ? (
                <RegisterForm
                  c={c}
                  busy={busy}
                  onCancel={() => setMode('view')}
                  onSubmit={(pattern) =>
                    run(async () => {
                      const r = await registerCandidate(c.id, me.user_id, pattern);
                      setRegistered(r);
                      onDone(r.pattern_id ? `Registered as ${r.pattern_id}` : 'Registered');
                    })
                  }
                />
              ) : mode === 'decline' ? (
                <DeclineForm
                  busy={busy}
                  onCancel={() => setMode('view')}
                  onSubmit={(reason) =>
                    run(async () => {
                      await declineCandidate(c.id, me.user_id, reason);
                      setMode('view');
                      onDone('Candidate declined');
                    })
                  }
                />
              ) : (
                <ReassignForm
                  c={c}
                  profiles={profiles ?? []}
                  busy={busy}
                  onCancel={() => setMode('view')}
                  onSubmit={(architect) =>
                    run(async () => {
                      const r = await reassignCandidate(c.id, me.user_id, architect);
                      setMode('view');
                      onDone(`Architect is now ${r.suggested_architect}`);
                    })
                  }
                />
              )}
              {error && <p className="mt-3 text-[12.5px] text-failing">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const REUSE = ['Narrow', 'Moderate', 'Broad'] as const;

function RegisterForm({ c, busy, onCancel, onSubmit }: { c: PatternCandidate; busy: boolean; onCancel: () => void; onSubmit: (pattern: Record<string, string>) => void }) {
  const seed = c.summary ?? '';
  const [f, setF] = useState<Record<string, string>>({
    pattern_name: c.candidate ?? '',
    bha_system: c.lane ?? '',
    reusability: 'Moderate',
    problem: seed,
    solution: seed,
    context: seed,
    implementation_checklist: '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = f.pattern_name.trim().length > 0;
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit(f);
      }}
    >
      <p className="text-[12px] text-faint">
        Prefilled from the candidate — the summary seeds problem, solution and context; rewrite each before you register. Saving mints the BP- id, writes the pattern, ingests it into BHARAG and makes its Google Doc, then marks this candidate Registered.
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14ch_14ch]">
        <Field label="Pattern name">
          <input className="input" value={f.pattern_name} onChange={set('pattern_name')} required />
        </Field>
        <Field label="BHA system" hint="From the lane; names the BP- id.">
          <input className="input" value={f.bha_system} onChange={set('bha_system')} />
        </Field>
        <Field label="Reusability">
          <select className="input" value={f.reusability} onChange={set('reusability')}>
            {REUSE.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      </div>
      {(['problem', 'solution', 'context'] as const).map((k) => (
        <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
          <textarea className="input min-h-[72px] py-2 text-[12.5px] leading-relaxed" value={f[k]} onChange={set(k)} />
        </Field>
      ))}
      <Field label="Implementation checklist (optional)" hint="One step per line; stored joined with ' | ', as patterns are.">
        <textarea className="input min-h-[56px] py-2 text-[12.5px]" value={f.implementation_checklist} onChange={set('implementation_checklist')} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" type="submit" loading={busy} disabled={!ready}>
          Register pattern
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeclineForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 3;
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit(reason.trim());
      }}
    >
      <Field label="Why is this not a pattern?" hint="Required. The builder and Bays read it.">
        <textarea className="input min-h-[64px] py-2 text-[12.5px]" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />
      </Field>
      <div className="flex gap-2">
        <Button variant="destructive" type="submit" loading={busy} disabled={!ready}>
          Decline candidate
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReassignForm({ c, profiles, busy, onCancel, onSubmit }: { c: PatternCandidate; profiles: BuilderProfile[]; busy: boolean; onCancel: () => void; onSubmit: (userId: string) => void }) {
  const choices = profiles.filter((p) => p.user_id !== c.architect_slack_id);
  const [to, setTo] = useState('');
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (to && !busy) onSubmit(to);
      }}
    >
      <Field label={`New suggested architect (now ${c.suggested_architect ?? 'not set'})`}>
        <select className="input h-[32px] w-auto min-w-[220px] py-0 text-[12.5px]" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a builder…</option>
          {choices.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.name}
              {p.lane ? ` — ${p.lane}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Button variant="primary" type="submit" loading={busy} disabled={!to}>
        Reassign
      </Button>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </form>
  );
}

function RegisteredNote({ r, onOpenPattern, patternRecord }: { r: CandidateRegistered; onOpenPattern: (id: string) => void; patternRecord: string | null }) {
  return (
    <div className="space-y-1.5 text-[12.5px]">
      <p className="text-ink">
        Registered as <span className="tabular font-medium">{r.pattern_id ?? '(no id returned)'}</span>
        {patternRecord && (
          <button type="button" className="link ml-2" onClick={() => onOpenPattern(patternRecord)}>
            open it
          </button>
        )}
        .
      </p>
      <p className="text-dim">
        Google Doc:{' '}
        {r.doc_created && r.doc_link ? (
          <a className="link" href={r.doc_link} target="_blank" rel="noreferrer">
            open the Doc ↗
          </a>
        ) : (
          <span className="text-failing">not made{r.doc_error ? ` — ${r.doc_error}` : ''}</span>
        )}
      </p>
      <p className="text-dim">BHARAG: {r.ingested_to_bharag ? 'ingested' : <span className="text-failing">not ingested — the pattern is saved but not searchable there yet</span>}</p>
      {!r.candidate_updated && <p className="text-failing">{r.note ?? r.candidate_error}</p>}
    </div>
  );
}
