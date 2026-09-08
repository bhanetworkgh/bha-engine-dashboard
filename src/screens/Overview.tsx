import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getOverview, type OverviewData, type OverviewEvent, type OverviewTile } from '../data';
import { Bars, Card, Icon, LoadFailed, Loading, Ring, SourceLink, type IconName } from '../components/ui';
import { ageTone, errorClassLabel, healthText, laneLabel } from '../lib';

/** One colour per system, so no two neighbours share a tint. */
const TILE_META: Record<string, { icon: IconName; tint: string }> = {
  'north-star': { icon: 'star', tint: 'tile-indigo' },
  'research-twin': { icon: 'twin', tint: 'tile-purple' },
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
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % HEADLINES.length), 5200);
    return () => clearInterval(t);
  }, []);

  const pin = (label: string) => data.pins.find((p) => p.label === label)?.value ?? '—';
  const incidents = pin('Open incidents');
  const loops = pin('Open loops');
  const entries = pin('Entries this week');
  const halloween = pin('Days to Halloween');
  const builders = data.series.loops_by_owner.length;
  const sentence = `${incidents} incident${incidents === '1' ? '' : 's'} open, ${loops} loops open across ${builders} builders, and ${entries} entries logged this week, with ${halloween} days to Halloween. Every number here is read live from the engine as it changes.`;

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
        <div className="mb-3 text-[11.5px] font-medium tracking-[0.12em] text-accent-ink uppercase">Bays summary</div>
        <h2 key={i} className="font-display headline-in text-[26px] leading-[1.15] md:text-[29px]">
          {HEADLINES[i][0]}
          <br />
          {HEADLINES[i][1]}
        </h2>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-dim">{sentence}</p>
        <Link to="/ask-bays" className="btn mt-5 h-9 rounded-full bg-panel px-4 text-[13px] shadow-[var(--shadow-card)]">
          Ask Bays about today
        </Link>
      </div>

      {/* The orb sits just left of three uniform glass chips that step down to the right, clear of the edge. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[50%] md:block" aria-hidden>
        <div className="glass orb absolute top-1/2 right-[236px] h-[96px] w-[96px] -translate-y-1/2 rotate-[7deg] rounded-[26px] p-3">
          <span className="spin-slow absolute inset-3 rounded-full bg-[conic-gradient(from_0deg,var(--tint-blue),var(--tint-purple),var(--tint-teal),var(--tint-pink),var(--tint-blue))] opacity-90 blur-[2px]" />
          <span className="absolute inset-[15px] rounded-full bg-panel" />
          <img src="/logo.svg" alt="" className="mark absolute inset-[20px] h-[56px] w-[56px]" />
        </div>
        {chip('drift top-[13%] right-[80px]', '-4deg', 'tile-red', 'pulse', 'Open incidents', incidents)}
        {chip('drift-slow top-[42%] right-[36px]', '3deg', 'tile-teal', 'loop', 'Open loops', loops)}
        {chip('drift-fast bottom-[11%] right-[72px]', '-3deg', 'tile-green', 'leaf', 'Days to Halloween', halloween)}
      </div>
    </section>
  );
}

function SystemTile({ t }: { t: OverviewTile }) {
  const meta = TILE_META[t.key] ?? { icon: 'overview' as IconName, tint: 'tile-graphite' };
  const I = Icon[meta.icon];
  return (
    <Link to={t.to} className="dock-item group flex flex-col items-center rounded-[14px] px-2 pt-4 pb-3 text-center transition-colors hover:bg-hover active:scale-[0.98]">
      <span className={`tile dock-tile ${meta.tint} h-12 w-12 rounded-[14px]`}>
        <I className="h-6 w-6" />
      </span>
      <span className="mt-2.5 text-[13px] font-medium">{t.label}</span>
      <span className="tabular text-[12px] text-dim">
        {t.headline} {t.sublabel}
      </span>
    </Link>
  );
}

function EventRow({ e }: { e: OverviewEvent }) {
  return (
    <div className="rowlike -mx-2 flex items-start gap-3 rounded-[10px] px-2 py-2">
      <span className={`tile tile-sm ${e.health === 'failing' ? 'tile-red' : e.health === 'degraded' ? 'tile-graphite' : 'tile-blue'} mt-0.5`}>
        {e.health === 'ok' ? <Icon.check /> : <Icon.bolt />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{e.title}</div>
        <div className={`truncate text-[12px] ${e.health === 'ok' ? 'text-dim' : healthText(e.health)}`}>{e.detail}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
          <span className="tabular">{e.at}</span>
          <span>{laneLabel(e.spine.lane)}</span>
          <SourceLink source={e.source} />
        </div>
      </div>
    </div>
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
  const { status, data, error } = useData(getOverview);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const s = data.series;
  const maxOwner = Math.max(1, ...s.loops_by_owner.map((o) => o.open + o.in_progress));
  const asks = s.asks_by_outcome;
  const askTotal = asks.answered + asks.thin + asks.failed;
  const openIncidents = data.pins.find((p) => p.label === 'Open incidents')?.value ?? '0';
  const engineTile = data.tiles.find((t) => t.key === 'engine-health');
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
          <div className="dock grid grid-cols-3 gap-1 sm:grid-cols-5">
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
            <div className="flex items-center gap-3 py-3">
              <span className="tile tile-sm tile-indigo"><Icon.star /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Asks answered</div>
                <div className="tabular text-[20px] font-semibold">
                  {asks.answered}
                  <span className="text-[13px] font-normal text-faint"> of {askTotal}</span>
                </div>
              </div>
              <Ring value={asks.answered} total={askTotal} size={44} tone="accent" label="answered" />
            </div>
            <div className="flex items-center gap-3 py-3">
              <span className="tile tile-sm tile-red"><Icon.pulse /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] text-dim">Incidents opened, 7 days</div>
                <div className="tabular text-[20px] font-semibold">{s.incidents_7d.reduce((n, p) => n + p.value, 0)}</div>
              </div>
              <div className="w-[88px]">
                <Bars values={s.incidents_7d.map((p) => p.value)} labels={s.incidents_7d.map((p) => p.label)} height={30} tone="accent" highlightLast={false} />
              </div>
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

        {/* Row 3 */}
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
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

          <Card className="frost p-5">
            <CardTitle title="Engine health" right={<Link to="/engine-health" className="link">View details</Link>} />
            <div className="flex items-center gap-4">
              <span className={`tile h-14 w-14 rounded-[16px] ${engineTile?.health === 'failing' ? 'tile-red' : engineTile?.health === 'degraded' ? 'tile-graphite' : 'tile-green'}`}>
                <Icon.shield className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <div className="text-[16px] font-semibold">
                  {openIncidents === '0' ? 'All good' : `${openIncidents} open incident${openIncidents === '1' ? '' : 's'}`}
                </div>
                <div className="text-[12.5px] text-dim">{engineTile?.signal ?? ''}</div>
              </div>
            </div>
            <div className="mt-4 space-y-0.5">
              <div className="flex items-center gap-3 px-2 py-2.5">
                <Ring value={data.rates.self_heal.value} total={data.rates.self_heal.total} size={40} tone="accent" label="self-healed" />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="text-[13px] font-medium">Self-heal rate</div>
                  <div className="text-[12px] text-dim">{data.rates.self_heal.value} of {data.rates.self_heal.total} resolved without a person</div>
                </div>
              </div>
              {s.incidents_by_class.map((c) => (
                <Link key={c.error_class} to="/engine-health" className="rowlike -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-2.5">
                  <span className={`tile tile-sm ${c.open > 0 ? (c.error_class === 'BILLING_QUOTA' || c.error_class === 'CONFIG_AUTH' ? 'tile-red' : 'tile-graphite') : 'tile-soft'}`}>
                    <Icon.bolt />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-[13px] font-medium">{errorClassLabel(c.error_class)}</span>
                    <span className={`block text-[12px] ${c.open ? healthText(c.error_class === 'BILLING_QUOTA' ? 'failing' : 'degraded') : 'text-dim'}`}>
                      {c.open ? `${c.open} open · ${c.n} total` : `${c.n} total, none open`}
                    </span>
                  </span>
                  <Icon.chevron className="text-faint" />
                </Link>
              ))}
            </div>
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

        {/* Row 4 */}
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Card className="frost p-5">
            <CardTitle title="What broke in the last 24 hours" right={<Link to="/engine-health" className="link">View all</Link>} />
            {data.broke_24h.length === 0 ? (
              <p className="text-[13px] text-dim">Nothing broke in this window.</p>
            ) : (
              <div className="divide-y divide-line">
                {data.broke_24h.slice(0, 6).map((e) => (
                  <EventRow key={e.id} e={e} />
                ))}
              </div>
            )}
          </Card>
          <Card className="frost p-5">
            <CardTitle title="What moved in the last 24 hours" right={<Link to="/codex" className="link">View all</Link>} />
            {data.moved_24h.length === 0 ? (
              <p className="text-[13px] text-dim">Nothing moved in this window.</p>
            ) : (
              <div className="divide-y divide-line">
                {data.moved_24h.slice(0, 6).map((e) => (
                  <EventRow key={e.id} e={e} />
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="hidden xl:block" />
      </div>

      <p className="mt-8 text-center text-[12px] text-faint">One window onto the engine. Every number here is read, never typed.</p>
    </div>
  );
}
