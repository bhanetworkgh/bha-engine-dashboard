import { Link } from 'react-router-dom';
import { useData } from '../app/useData';
import { useSession } from '../app/session';
import { BUILDER_NAMES, getOverview, type OverviewData, type OverviewEvent, type OverviewTile } from '../data';
import { Bars, Card, Dot, Icon, LoadFailed, Loading, Ring, SourceLink, type IconName } from '../components/ui';
import { ageTone, errorClassLabel, healthLabel, healthText, laneLabel } from '../lib';

const TILE_META: Record<string, { icon: IconName; tint: string }> = {
  'north-star': { icon: 'star', tint: 'tile-indigo' },
  'research-twin': { icon: 'twin', tint: 'tile-purple' },
  vfarm: { icon: 'leaf', tint: 'tile-green' },
  'engine-health': { icon: 'pulse', tint: 'tile-blue' },
  'open-loops': { icon: 'loop', tint: 'tile-teal' },
  codex: { icon: 'book', tint: 'tile-graphite' },
  'build-patterns': { icon: 'pattern', tint: 'tile-graphite' },
  commercial: { icon: 'tag', tint: 'tile-pink' },
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

/** The summary banner. Every number in it is read from the data, never typed. */
function Hero({ data, name }: { data: OverviewData; name: string }) {
  const pin = (label: string) => data.pins.find((p) => p.label === label)?.value ?? '—';
  const incidents = pin('Open incidents');
  const loops = pin('Open loops');
  const entries = pin('Entries this week');
  const halloween = pin('Days to Halloween');
  const worst = data.tiles.filter((t) => t.health !== 'ok');
  const sentence =
    worst.length === 0
      ? `Everything is healthy. ${loops} loops open, ${entries} entries this week, ${halloween} days to Halloween.`
      : `${incidents} incident${incidents === '1' ? '' : 's'} open, ${loops} loops open, ${entries} entries logged this week. ${worst.length} of ${data.tiles.length} systems need a look. ${halloween} days to Halloween.`;

  return (
    <section className="hero p-6 md:p-8">
      <div className="relative z-10 max-w-[52%] md:max-w-[50%]">
        <div className="mb-3 flex items-center gap-1.5 text-[12px] font-medium tracking-[0.02em] text-accent-ink">
          <Icon.sparkle />
          Bays summary
        </div>
        <h2 className="font-display text-[24px] leading-tight md:text-[27px]">
          {name}, here is your engine right now.
        </h2>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-dim">{sentence}</p>
        <Link to="/ask-bays" className="btn mt-5 h-9 rounded-full bg-panel px-4 text-[13px]">
          Ask Bays about today
        </Link>
      </div>

      {/* Floating chips: the pinned numbers, each a small card. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[48%] md:block" aria-hidden>
        <div className="drift absolute top-[14%] right-[30%] card flex items-center gap-3 px-3.5 py-2.5" style={{ ['--tilt' as string]: '-4deg' }}>
          <span className="tile tile-sm tile-blue"><Icon.pulse /></span>
          <span className="leading-tight"><span className="block text-[11px] text-faint">Open incidents</span><span className="tabular block text-[15px] font-semibold">{incidents}</span></span>
        </div>
        <div className="drift-slow absolute top-[44%] right-[6%] card flex items-center gap-3 px-3.5 py-2.5" style={{ ['--tilt' as string]: '3deg' }}>
          <span className="tile tile-sm tile-teal"><Icon.loop /></span>
          <span className="leading-tight"><span className="block text-[11px] text-faint">Open loops</span><span className="tabular block text-[15px] font-semibold">{loops}</span></span>
        </div>
        <div className="drift-fast absolute bottom-[12%] right-[34%] card flex items-center gap-3 px-3.5 py-2.5" style={{ ['--tilt' as string]: '-2deg' }}>
          <span className="tile tile-sm tile-green"><Icon.leaf /></span>
          <span className="leading-tight"><span className="block text-[11px] text-faint">Days to Halloween</span><span className="tabular block text-[15px] font-semibold">{halloween}</span></span>
        </div>
      </div>
    </section>
  );
}

function SystemTile({ t }: { t: OverviewTile }) {
  const meta = TILE_META[t.key] ?? { icon: 'overview' as IconName, tint: 'tile-graphite' };
  const I = Icon[meta.icon];
  return (
    <Link to={t.to} className="group flex flex-col items-center rounded-[14px] px-2 py-3 text-center transition-colors hover:bg-hover">
      <span className={`tile ${meta.tint} h-12 w-12 rounded-[14px]`}>
        <I className="h-6 w-6" />
      </span>
      <span className="mt-2.5 text-[13px] font-medium">{t.label}</span>
      <span className="tabular text-[12px] text-dim">
        {t.headline} {t.sublabel}
      </span>
      <span className={`mt-1.5 flex items-center gap-1.5 text-[11.5px] ${t.health === 'ok' ? 'text-ok' : t.health === 'failing' ? 'text-failing' : 'text-dim'}`}>
        <Dot health={t.health} />
        {healthLabel(t.health)}
      </span>
    </Link>
  );
}

function EventRow({ e }: { e: OverviewEvent }) {
  return (
    <div className="rowlike -mx-2 flex items-start gap-3 rounded-[10px] px-2 py-2">
      <span className={`tile tile-sm ${e.health === 'failing' ? 'tile-pink' : e.health === 'degraded' ? 'tile-graphite' : 'tile-blue'} mt-0.5`}>
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
    <Link to={to} className="rowlike -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-2.5">
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
  const { me } = useSession();
  const { status, data, error } = useData(getOverview);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const name = BUILDER_NAMES[me] ?? me;
  const s = data.series;
  const maxOwner = Math.max(1, ...s.loops_by_owner.map((o) => o.open + o.in_progress));
  const asks = s.asks_by_outcome;
  const askTotal = asks.answered + asks.thin + asks.failed;
  const openIncidents = data.pins.find((p) => p.label === 'Open incidents')?.value ?? '0';
  const engineTile = data.tiles.find((t) => t.key === 'engine-health');
  const halloween = data.pins.find((p) => p.label === 'Days to Halloween')?.value ?? '—';

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-8 md:px-8">
      <header className="mb-6">
        <h1 className="font-display text-[34px] leading-none">
          {greeting()}, {name}
        </h1>
        <p className="mt-2 text-[15px] text-dim">Here is what is happening across the engine, the loops and the builders.</p>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* Left column */}
        <div className="min-w-0 space-y-4">
          <Hero data={data} name={name} />

          <Card className="p-5">
            <CardTitle title="Your systems" right={<span className="text-[12.5px] text-faint">{data.tiles.length} sections</span>} />
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-5 lg:grid-cols-5">
              {data.tiles.map((t) => (
                <SystemTile key={t.key} t={t} />
              ))}
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-5">
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
                        <div className="h-full rounded-full bg-accent" style={{ width: `${((o.open + o.in_progress) / maxOwner) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-5">
              <CardTitle title="Engine health" right={<Link to="/engine-health" className="link">View details</Link>} />
              <div className="flex items-center gap-4">
                <span className={`tile h-14 w-14 rounded-[16px] ${engineTile?.health === 'failing' ? 'tile-pink' : engineTile?.health === 'degraded' ? 'tile-graphite' : 'tile-green'}`}>
                  <Icon.shield className="h-7 w-7" />
                </span>
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold">
                    {openIncidents === '0' ? 'All good' : `${openIncidents} open incident${openIncidents === '1' ? '' : 's'}`}
                  </div>
                  <div className="text-[12.5px] text-dim">
                    {engineTile?.signal ?? ''}
                  </div>
                </div>
              </div>
              <div className="mt-4 divide-y divide-line">
                <div className="flex items-center gap-3 py-2.5">
                  <Ring value={data.rates.self_heal.value} total={data.rates.self_heal.total} size={36} tone="accent" label="self-healed" />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-[13px] font-medium">Self-heal rate</div>
                    <div className="text-[12px] text-dim">{data.rates.self_heal.value} of {data.rates.self_heal.total} resolved without a person</div>
                  </div>
                </div>
                {s.incidents_by_class.map((c) => (
                  <Link key={c.error_class} to="/engine-health" className="rowlike flex items-center gap-3 py-2.5">
                    <span className={`tile tile-sm ${c.open > 0 ? (c.error_class === 'BILLING_QUOTA' || c.error_class === 'CONFIG_AUTH' ? 'tile-pink' : 'tile-graphite') : 'tile-soft'}`}>
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

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <CardTitle title="What broke in the last 24 hours" right={<Link to="/engine-health" className="link">View all</Link>} />
              {data.broke_24h.length === 0 ? (
                <p className="text-[13px] text-dim">Nothing broke in this window for the selected lane.</p>
              ) : (
                <div className="divide-y divide-line">
                  {data.broke_24h.slice(0, 6).map((e) => (
                    <EventRow key={e.id} e={e} />
                  ))}
                </div>
              )}
            </Card>
            <Card className="p-5">
              <CardTitle title="What moved in the last 24 hours" right={<Link to="/codex" className="link">View all</Link>} />
              {data.moved_24h.length === 0 ? (
                <p className="text-[13px] text-dim">Nothing moved in this window for the selected lane.</p>
              ) : (
                <div className="divide-y divide-line">
                  {data.moved_24h.slice(0, 6).map((e) => (
                    <EventRow key={e.id} e={e} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Right column */}
        <div className="min-w-0 space-y-4">
          <Card className="p-5">
            <CardTitle title="Quick actions" />
            <div className="divide-y divide-line">
              <QuickAction to="/ask-bays" icon="chat" tint="tile-blue" title="Ask Bays" sub="Question the engine" />
              <QuickAction to="/open-loops" icon="loop" tint="tile-teal" title="Open loops" sub="Close, start or open a loop" />
              <QuickAction to="/engine-health" icon="pulse" tint="tile-indigo" title="Engine health" sub="Incidents and retries" />
              <QuickAction to="/vfarm" icon="leaf" tint="tile-green" title="vFarm" sub={`${halloween} days to Halloween`} />
            </div>
          </Card>

          <Card className="p-5">
            <CardTitle title="This week" right={<Link to="/codex" className="link">View details</Link>} />
            <div className="divide-y divide-line">
              <div className="flex items-center gap-3 py-3">
                <span className="tile tile-sm tile-graphite"><Icon.book /></span>
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
                <span className="tile tile-sm tile-blue"><Icon.pulse /></span>
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

          <Card className="p-5">
            <CardTitle title="Needs a look" />
            {data.tiles.filter((t) => t.health !== 'ok').length === 0 ? (
              <p className="text-[13px] text-dim">Every system is healthy in the selected lane.</p>
            ) : (
              <div className="divide-y divide-line">
                {data.tiles
                  .filter((t) => t.health !== 'ok')
                  .map((t) => {
                    const meta = TILE_META[t.key];
                    const I = Icon[meta?.icon ?? 'overview'];
                    return (
                      <Link key={t.key} to={t.to} className="rowlike -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-2.5">
                        <span className={`tile tile-sm ${meta?.tint ?? 'tile-graphite'}`}><I /></span>
                        <span className="min-w-0 flex-1 leading-tight">
                          <span className="block text-[13px] font-medium">{t.label}</span>
                          <span className={`block truncate text-[12px] ${healthText(t.health)}`}>{t.signal}</span>
                        </span>
                        <Icon.chevron className="text-faint" />
                      </Link>
                    );
                  })}
              </div>
            )}
          </Card>
        </div>
      </div>

      <p className="mt-8 text-center text-[12px] text-faint">One window onto the engine. Every number here is read, never typed.</p>
    </div>
  );
}
