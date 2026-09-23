import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getOverview, type FeedItem, type OverviewData, type OverviewTile } from '../data';
import { Button, ButtonLink, Bars, Card, Icon, LoadFailed, Loading, Pill, Ring, type IconName } from '../components/ui';
import { ageTone, healthText } from '../lib';

/**
 * Every kind a Home panel is built from (2026-09-23): a write to any of them
 * re-reads the page within the 750ms debounce, so an approval lands in "What
 * moved" in an open tab without a reload.
 */
const HOME_KINDS = [
  'incidents', 'error_counts', 'retry_attempts', 'digests', 'codex', 'layer0', 'loops', 'patterns', 'pattern_candidates',
  'commercial', 'ns-asks', 'rt-asks', 'rt-jobs', 'vfarm_leads', 'repairs',
] as const;

/** One colour per system, so no two neighbours share a tint. */
const TILE_META: Record<string, { icon: IconName; tint: string }> = {
  'north-star': { icon: 'star', tint: 'tile-indigo' },
  'research-twin': { icon: 'twin', tint: 'tile-purple' },
  'media-twin': { icon: 'tag', tint: 'tile-pink' },
  genie: { icon: 'sparkle', tint: 'tile-purple' },
  vfarm: { icon: 'leaf', tint: 'tile-green' },
  'engine-health': { icon: 'pulse', tint: 'tile-red' },
  'open-loops': { icon: 'loop', tint: 'tile-teal' },
  codex: { icon: 'book', tint: 'tile-brown' },
  'build-patterns': { icon: 'pattern', tint: 'tile-mint' },
  commercial: { icon: 'tag', tint: 'tile-cyan' },
  builders: { icon: 'people', tint: 'tile-blue' },
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function CardTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[15px]">{title}</h2>
      {right}
    </div>
  );
}

/** Headlines the banner rotates through. Copy, not data; the data is in the sentence beneath. */
const HEADLINES = [
  ['Your engine, live', 'in one window.'],
  ['Every loop, every incident,', 'one place.'],
  ['Your day, more', 'connected than ever.'],
  ['Read live from the engine,', 'never typed.'],
];

/** The summary banner: label, a rotating two-line headline, the live sentence, a pill, and the orb beside three glass chips. */
function Hero({ data }: { data: OverviewData }) {
  // The headline crossfades: ease the current line out, swap, ease the next in.
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    let swap: number | undefined;
    const t = window.setInterval(() => {
      setShown(false);
      swap = window.setTimeout(() => {
        setI((n) => (n + 1) % HEADLINES.length);
        setShown(true);
      }, 700);
    }, 7000);
    return () => {
      clearInterval(t);
      if (swap) clearTimeout(swap);
    };
  }, []);

  const pin = (label: string) => data.pins.find((p) => p.label === label)?.value ?? '—';
  const loops = pin('Open loops');
  const entries = pin('Entries this week');
  const halloween = pin('Days to Halloween');
  const builders = data.series.loops_by_owner.length;
  // Incidents came out of the summary and the chips on 2026-09-14: the count
  // was read from phase 1 fixtures and the page behind it is a placeholder now.
  const sentence = `${loops} loops open across ${builders} builders, and ${entries} entries logged this week. ${halloween} days to Halloween.`;

  const chip = (cls: string, tilt: string, tint: string, I: IconName, label: string, value: string) => {
    const Ic = Icon[I];
    return (
      <div className={`${cls} glass absolute flex h-[56px] w-[164px] items-center gap-2.5 rounded-[16px] px-3`} style={{ ['--tilt' as string]: tilt }}>
        <span className={`tile tile-sm ${tint}`}>
          <Ic />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[11px] text-dim">{label}</span>
          <span className="tabular block text-[15px] font-semibold">{value}</span>
        </span>
      </div>
    );
  };

  return (
    <section className="hero flex h-full min-h-[320px] flex-col justify-center px-7 py-8 md:px-9">
      <div className="relative z-10 max-w-[54%] md:max-w-[50%]">
        <div className="mb-3 text-[11.5px] font-medium text-accent-ink">Bays summary</div>
        <h2
          className="font-display text-[26px] leading-[1.15] transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.2,0.7,0.2,1)] md:text-[29px]"
          style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(6px)' }}
        >
          {HEADLINES[i][0]}
          <br />
          {HEADLINES[i][1]}
        </h2>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-dim">{sentence}</p>
        <ButtonLink to="/ask-bays" className="mt-5 h-9 rounded-full px-4 text-[13px] shadow-[var(--shadow-card)]">
          Ask Bays about today
        </ButtonLink>
      </div>

      {/* The orb sits just left of three uniform glass chips that step down to the right, clear of the edge. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[50%] md:block" aria-hidden>
        <div className="glass orb absolute top-1/2 right-[236px] h-[96px] w-[96px] -translate-y-1/2 rotate-[7deg] rounded-[26px] p-3">
          <span className="spin-slow absolute inset-3 rounded-full bg-[conic-gradient(from_0deg,var(--tint-blue),var(--tint-purple),var(--tint-teal),var(--tint-pink),var(--tint-blue))] opacity-90 blur-[2px]" />
          <span className="absolute inset-[15px] rounded-full bg-panel" />
          <img src="/logo.svg" alt="" className="mark absolute inset-[20px] h-[56px] w-[56px]" />
        </div>
        {chip('drift top-[13%] right-[80px]', '-4deg', 'tile-brown', 'book', 'Entries this week', entries)}
        {chip('drift-slow top-[42%] right-[36px]', '3deg', 'tile-teal', 'loop', 'Open loops', loops)}
        {chip('drift-fast bottom-[11%] right-[72px]', '-3deg', 'tile-green', 'leaf', 'Days to Halloween', halloween)}
      </div>
    </section>
  );
}

/**
 * One section's tile (2026-09-22, Destiny's brief): the same shape for every
 * section, so a row of them reads as one set. Icon and name; one figure in the
 * display face at one size — a dash where the section has none, at the same
 * size, so a placeholder does not read as a smaller number; what the figure
 * counts; and the section's worst current signal as a sentence, with the
 * health dot beside it. The signal gets two lines whatever its length, which is
 * what keeps the tiles the same height.
 */
function SystemTile({ t }: { t: OverviewTile }) {
  const meta = TILE_META[t.key] ?? { icon: 'overview' as IconName, tint: 'tile-graphite' };
  const I = Icon[meta.icon];
  const none = t.headline === '—' || Boolean(t.muted);
  // Green is health, so a section with nothing wired up gets no colour at all rather than a green it has not earned.
  const dot = t.health === 'failing' ? 'bg-failing' : t.health === 'degraded' ? 'bg-degraded' : none ? 'bg-line-strong' : 'bg-ok';
  return (
    <Link
      to={t.to}
      className={`group flex h-full flex-col rounded-[14px] bg-raised px-3.5 pt-3 pb-3 text-left transition-colors hover:bg-hover active:scale-[0.99] ${t.muted ? 'opacity-60' : ''}`}
      aria-label={t.muted ? `${t.label}: not connected yet` : undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={`tile ${meta.tint} h-7 w-7 shrink-0 rounded-[9px]`}>
          <I className="h-4 w-4" />
        </span>
        <span className="truncate text-[13px] font-medium">{t.label}</span>
      </span>
      <span className={`font-display tabular mt-3 text-[26px] leading-none ${none ? 'text-faint' : 'text-ink'}`}>{t.headline}</span>
      <span className="mt-1 truncate text-[12px] text-dim">{t.sublabel}</span>
      {t.figures && (
        <span className="mt-1.5 space-y-0.5">
          {t.figures.map((f) => (
            <span key={f.label} className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="truncate text-dim">{f.label}</span>
              <span className={`tabular shrink-0 ${f.value < f.of ? 'text-degraded' : 'text-ink'}`}>
                {f.value} of {f.of}
              </span>
            </span>
          ))}
        </span>
      )}
      <span className="mt-2 flex flex-1 items-start gap-1.5 border-t border-line pt-2 text-[12px] leading-snug text-dim">
        <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="line-clamp-2 min-h-[2.75em]" title={t.signal}>
          {t.signal}
        </span>
      </span>
    </Link>
  );
}

/** "14:02", with "yesterday" in front when it was. Local time, like the clock in the top bar. */
function feedTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `yesterday ${hm}`;
}

/**
 * One row of a 24-hour column (2026-09-23): a real row from a table, opening
 * the record it is about. Recovered and Needs a person appear only where the
 * row says so.
 */
function FeedRow({ e }: { e: FeedItem }) {
  const body = (
    <>
      <span className={`tile tile-sm ${e.health === 'failing' ? 'tile-red' : e.health === 'degraded' ? 'tile-graphite' : 'tile-blue'} mt-0.5`}>
        {e.health === 'ok' ? <Icon.check /> : <Icon.bolt />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium" title={e.title}>{e.title}</span>
          {e.status && <Pill tone={e.status === 'Recovered' ? 'ok' : 'failing'}>{e.status}</Pill>}
        </div>
        <div className={`truncate text-[12px] ${e.health === 'ok' ? 'text-dim' : healthText(e.health)}`} title={e.detail}>{e.detail}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-faint">
          <span className="tabular shrink-0" title={e.at}>{feedTime(e.at)}</span>
          <span className="shrink-0">{e.what}</span>
          {e.where && <span className="truncate">{BUILDER_NAMES[e.where] ?? e.where}</span>}
        </div>
      </div>
    </>
  );
  return e.to ? (
    <Link to={e.to} className="rowlike -mx-2 flex items-start gap-3 rounded-[10px] px-2 py-2">
      {body}
    </Link>
  ) : (
    <div className="rowlike -mx-2 flex items-start gap-3 rounded-[10px] px-2 py-2">{body}</div>
  );
}

/** One of Home's two 24-hour columns. Empty is a sentence, never a sample. */
function Feed({ title, items, empty, all }: { title: string; items: FeedItem[]; empty: string; all: string }) {
  const [more, setMore] = useState(false);
  const shown = more ? items : items.slice(0, 6);
  return (
    <Card className="frost p-5">
      <CardTitle title={title} right={<Link to={all} className="link">View all</Link>} />
      {items.length === 0 ? (
        <p className="text-[13px] text-dim">{empty}</p>
      ) : (
        <>
          <div className="divide-y divide-line">
            {shown.map((e) => (
              <FeedRow key={e.id} e={e} />
            ))}
          </div>
          {items.length > 6 && (
            <Button variant="ghost" size="sm" className="mt-2 text-[12.5px]" onClick={() => setMore((v) => !v)}>
              {more ? 'Show fewer' : `Show all ${items.length}`}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

function QuickAction({ to, icon, tint, title, sub }: { to: string; icon: IconName; tint: string; title: string; sub: string }) {
  const I = Icon[icon];
  return (
    <Link to={to} className="rowlike -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-3 active:scale-[0.99]">
      <span className={`tile ${tint}`}>
        <I />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="block truncate text-[12px] text-dim">{sub}</span>
      </span>
      <Icon.chevron className="text-faint" />
    </Link>
  );
}

export default function Overview() {
  const { status, data, error } = useData(getOverview, [], { kinds: HOME_KINDS });
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const s = data.series;
  const maxOwner = Math.max(1, ...s.loops_by_owner.map((o) => o.open + o.in_progress));
  const asks = s.asks_by_outcome;
  const askTotal = asks.answered + asks.thin + asks.failed + asks.refused + asks.needs_human;
  const handoffs = s.twin_handoffs;
  const halloween = data.pins.find((p) => p.label === 'Days to Halloween')?.value ?? '—';
  const attention = data.tiles.filter((t) => t.health !== 'ok');

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-8">
      <header className="mb-6">
        <h1 className="font-display text-[34px] leading-none">{greeting()}, Admin</h1>
        <p className="mt-2 text-[15px] text-dim">Here is what is happening across the engine, the loops and the builders.</p>
      </header>

      {/*
        One grid, two columns, explicit rows: each right-hand card sits in the
        same row as its left-hand neighbour, so their heights match.
      */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* Row 1 */}
        <div className="min-w-0">
          <Hero data={data} />
        </div>
        <Card className="frost flex flex-col p-5">
          <CardTitle title="Quick actions" />
          <div className="flex flex-1 flex-col justify-around divide-y divide-line">
            <QuickAction to="/ask-bays" icon="chat" tint="tile-graphite" title="Ask Bays" sub="Question the engine" />
            <QuickAction to="/open-loops" icon="loop" tint="tile-teal" title="Open loops" sub="Close, start or open a loop" />
            <QuickAction to="/engine-health" icon="pulse" tint="tile-red" title="Engine health" sub="Incidents and retries" />
            <QuickAction to="/vfarm" icon="leaf" tint="tile-green" title="vFarm" sub={`${halloween} days to Halloween`} />
          </div>
        </Card>

        {/* Row 2 */}
        <Card className="frost p-5">
          <CardTitle title="Your systems" right={<span className="text-[12.5px] text-faint">{data.tiles.length} sections</span>} />
          <div className="grid grid-cols-2 items-stretch gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
            {data.tiles.map((t) => (
              <SystemTile key={t.key} t={t} />
            ))}
          </div>
        </Card>
        <Card className="frost flex flex-col p-5">
          <CardTitle title="This week" right={<Link to="/codex" className="link">View details</Link>} />
          <div className="flex flex-1 flex-col justify-around divide-y divide-line">
            <div className="flex items-center gap-3 py-3">
              <span className="tile tile-sm tile-brown"><Icon.book /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Entries logged</div>
                <div className="tabular text-[20px] font-semibold">{data.pins.find((p) => p.label === 'Entries this week')?.value ?? '—'}</div>
              </div>
              <div className="w-[88px]">
                <Bars values={s.entries_by_week.map((p) => p.value)} labels={s.entries_by_week.map((p) => p.label)} height={30} tone="accent" highlightLast={false} />
              </div>
            </div>
            {/*
              Both twins' ledgers, read from the rows rather than from a
              fixture (2026-09-17). Nought asks is a real answer here — the
              ledgers opened on 17 Sep with nothing carried in — so it prints
              as nought and the ring simply has nothing in it.
            */}
            <div className="flex items-center gap-3 py-3">
              <span className="tile tile-sm tile-indigo"><Icon.star /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Asks answered, both twins</div>
                <div className="tabular text-[20px] font-semibold">
                  {asks.answered}
                  <span className="text-[13px] font-normal text-faint"> of {askTotal}</span>
                </div>
              </div>
              <Ring value={asks.answered} total={askTotal} size={44} tone="accent" label="answered" />
            </div>
            {/*
              The one figure about the pair rather than about either twin.
              Until 17 Sep they could not reach each other at all — every
              handoff went through a person or through Bays — so this is the
              only way to tell whether being able to changed the behaviour or
              merely made it possible. The footnote it carries on the twins'
              pages names the known gap: `Linked Twin Ask` is empty on early
              rows, so this counts the fallbacks too and reads slightly high
              rather than silently low.
            */}
            <div className="flex items-center gap-3 py-3" title={handoffs.note}>
              <span className="tile tile-sm tile-purple"><Icon.chat /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Twin-to-twin handoffs</div>
                <div className="tabular text-[20px] font-semibold">
                  {handoffs.n}
                  <span className="text-[13px] font-normal text-faint"> of {handoffs.of} asks</span>
                </div>
              </div>
              <Ring value={handoffs.n} total={Math.max(handoffs.of, 1)} size={44} tone="accent" label="consulted" />
            </div>
            <div className="flex items-center gap-3 py-3">
              <span className="tile tile-sm tile-teal"><Icon.loop /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Loops raised, 14 days</div>
                <div className="tabular text-[20px] font-semibold">{s.loops_raised_14d.reduce((n, p) => n + p.value, 0)}</div>
              </div>
              <div className="w-[88px]">
                <Bars values={s.loops_raised_14d.map((p) => p.value)} labels={s.loops_raised_14d.map((p) => p.label)} height={30} tone="accent" highlightLast={false} />
              </div>
            </div>
          </div>
        </Card>

        {/* Row 3. The Engine health card that sat beside this one is gone
            (2026-09-14, Destiny): its self-heal rate and its incidents by class
            were computed from phase 1 fixtures, and the page it linked to is a
            placeholder now. Loops by builder takes the row. */}
        <div className="min-w-0">
          <Card className="frost p-5">
            <CardTitle title="Loops by builder" right={<Link to="/open-loops" className="link">View all</Link>} />
            {s.loops_by_owner.length === 0 ? (
              <p className="text-[13px] text-dim">No open loops in the selected lane.</p>
            ) : (
              <div className="space-y-3">
                {s.loops_by_owner.map((o) => (
                  <div key={o.owner} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
                    <div className="flex items-center gap-2.5 text-[13px]">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raised text-[11px] font-medium text-dim">
                        {(BUILDER_NAMES[o.owner] ?? o.owner).slice(0, 1)}
                      </span>
                      {BUILDER_NAMES[o.owner] ?? o.owner}
                    </div>
                    <div className="tabular flex items-center gap-2 text-[12px] text-dim">
                      <span>{o.open + o.in_progress} open</span>
                      <span className={ageTone(o.oldest_days)}>{o.oldest_days}d</span>
                    </div>
                    <div className="col-span-2 h-[6px] overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${((o.open + o.in_progress) / maxOwner) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

        </div>
        <Card className="frost p-5">
          <CardTitle title="Needs a look" />
          {attention.length === 0 ? (
            <p className="text-[13px] text-dim">Nothing is flagged right now.</p>
          ) : (
            <div className="divide-y divide-line">
              {attention.map((t) => {
                const meta = TILE_META[t.key];
                const I = Icon[meta?.icon ?? 'overview'];
                return (
                  <Link key={t.key} to={t.to} className="rowlike -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-2.5">
                    <span className={`tile tile-sm ${meta?.tint ?? 'tile-graphite'}`}><I /></span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block text-[13px] font-medium">{t.label}</span>
                      <span className="block truncate text-[12px] text-dim">{t.signal}</span>
                    </span>
                    <Icon.chevron className="text-faint" />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        {/* Row 4 — both columns read from the tables (2026-09-23); see server/src/feeds.ts. */}
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Feed title="What broke in the last 24 hours" items={data.broke_24h} empty="Nothing broke in the last 24 hours." all="/engine-health" />
          <Feed title="What moved in the last 24 hours" items={data.moved_24h} empty="Nothing moved in the last 24 hours." all="/codex" />
        </div>
        <div className="hidden xl:block" />
      </div>

      <p className="mt-8 text-center text-[12px] text-faint">One window onto the engine. Every number here is read, never typed.</p>
    </div>
  );
}
