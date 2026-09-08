import { useData } from '../app/useData';
import { BUILDER_NAMES, getOverview, type OverviewEvent, type OverviewTile } from '../data';
import {
  Bars,
  Card,
  CardHeader,
  Dot,
  HBar,
  Icon,
  LoadFailed,
  Loading,
  PageHeader,
  Ring,
  SourceLink,
  Sparkline,
} from '../components/ui';
import { ageTone, errorClassLabel, healthText, laneLabel } from '../lib';

function Tile({ t }: { t: OverviewTile }) {
  const toneForTrend = t.health === 'failing' ? 'failing' : t.health === 'degraded' ? 'degraded' : 'ink';
  return (
    <Card to={t.to} className="group flex min-h-[118px] flex-col justify-between p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{t.label}</span>
        <Dot health={t.health} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display tabular text-[30px] leading-none">{t.headline}</div>
          <div className="mt-1 truncate text-[11.5px] text-faint">{t.sublabel}</div>
        </div>
        {t.share ? (
          <div className="flex items-center gap-2">
            <Ring value={t.share.value} total={t.share.total} size={44} tone={t.share.value === t.share.total ? 'ink' : 'accent'} label={t.share.label} />
          </div>
        ) : t.trend ? (
          <Sparkline values={t.trend} width={88} height={34} tone={toneForTrend} />
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px]">
        <span className={`truncate ${healthText(t.health)}`}>{t.share ? `${t.share.label} · ${t.signal}` : t.signal}</span>
        <Icon.arrow className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </Card>
  );
}

function EventList({ title, events, empty }: { title: string; events: OverviewEvent[]; empty: string }) {
  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader title={title} right={<span className="kicker tabular">{events.length}</span>} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
        {events.length === 0 ? (
          <p className="px-5 py-3 text-[12.5px] text-dim">{empty}</p>
        ) : (
          events.map((e) => (
            <div key={e.id} className="rowlike px-5 py-[7px]">
              <div className="flex items-baseline gap-2">
                <span className="tabular w-9 shrink-0 text-[11.5px] text-faint">{e.at}</span>
                <Dot health={e.health} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.title}</span>
                <SourceLink source={e.source} />
              </div>
              <div className="flex items-baseline gap-2 pl-[52px]">
                <span className={`min-w-0 flex-1 truncate text-[11.5px] ${healthText(e.health)}`}>{e.detail}</span>
                <span className="shrink-0 text-[11px] text-faint">{laneLabel(e.spine.lane)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export default function Overview() {
  const { status, data, error } = useData(getOverview);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const s = data.series;
  const maxOwner = Math.max(1, ...s.loops_by_owner.map((o) => o.open + o.in_progress));
  const maxClass = Math.max(1, ...s.incidents_by_class.map((c) => c.n));
  const asks = s.asks_by_outcome;
  const askTotal = asks.answered + asks.thin + asks.failed;

  return (
    <div className="flex min-h-0 flex-col gap-4 pb-6 md:h-full">
      <PageHeader title="Overview" subtitle="Everything the engine knows about itself, on one screen. Open any system from its card." />

      {/* Pinned across the top. */}
      <div className="card mx-6 grid shrink-0 grid-cols-2 md:mx-8 md:grid-cols-5">
        {data.pins.map((p, i) => (
          <div
            key={p.label}
            className={`px-5 py-3.5 ${i % 2 === 0 ? 'border-r border-line' : ''} ${i < data.pins.length - 2 ? 'border-b border-line' : ''} md:border-b-0 md:border-r md:border-line md:last:border-r-0`}
          >
            <div className="kicker truncate">{p.label}</div>
            <div
              className={`font-display tabular mt-1 truncate text-[24px] leading-none ${
                p.accent ? 'text-accent-ink' : p.health === 'ok' ? 'text-ink' : healthText(p.health)
              }`}
            >
              {p.value}
            </div>
          </div>
        ))}
      </div>

      {/* One card per system. Click through. */}
      <div className="mx-6 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 md:mx-8 lg:grid-cols-3 xl:grid-cols-5">
        {data.tiles.map((t) => (
          <Tile key={t.key} t={t} />
        ))}
      </div>

      {/* Bottom row: where work piles up, how the engine is coping, and the last day. */}
      <div className="mx-6 grid min-h-0 flex-1 grid-cols-1 gap-3 md:mx-8 lg:grid-cols-2 xl:grid-cols-[240px_260px_minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader title="Loops by builder" right={<span className="kicker">oldest</span>} />
          <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 pb-4">
            {s.loops_by_owner.length === 0 ? (
              <p className="text-[12.5px] text-dim">No open loops in the selected lane.</p>
            ) : (
              s.loops_by_owner.map((o) => (
                <HBar
                  key={o.owner}
                  label={BUILDER_NAMES[o.owner] ?? o.owner}
                  value={o.open + o.in_progress}
                  max={maxOwner}
                  tone={o.oldest_days >= 30 ? 'failing' : o.oldest_days >= 14 ? 'degraded' : 'ink'}
                  right={<span className={`tabular ${ageTone(o.oldest_days)}`}>{o.oldest_days}d</span>}
                />
              ))
            )}
          </div>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader title="Engine" right={<span className="kicker">last 7 days</span>} />
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            <div className="flex items-center gap-3">
              <Ring value={data.rates.self_heal.value} total={data.rates.self_heal.total} size={52} tone="ink" label="self-healed" />
              <div className="min-w-0 flex-1 text-[11.5px] leading-snug">
                <div className="text-[12.5px] text-ink">Self-heal rate</div>
                <div className="text-faint">
                  {data.rates.self_heal.value} of {data.rates.self_heal.total} resolved unaided
                </div>
                <div className="text-faint">
                  retries {data.rates.retries.value} of {data.rates.retries.total} succeeded
                </div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-faint">
                <span>Incidents opened per day</span>
                <span className="tabular">{s.incidents_7d.reduce((n, p) => n + p.value, 0)} total</span>
              </div>
              <Bars values={s.incidents_7d.map((p) => p.value)} labels={s.incidents_7d.map((p) => p.label)} height={44} tone="ink" />
            </div>
            <div className="mt-4 space-y-2.5">
              {s.incidents_by_class.map((c) => (
                <HBar
                  key={c.error_class}
                  label={errorClassLabel(c.error_class)}
                  value={c.n}
                  max={maxClass}
                  tone={c.open > 0 ? (c.error_class === 'BILLING_QUOTA' || c.error_class === 'CONFIG_AUTH' ? 'failing' : 'degraded') : 'ink'}
                  right={c.open > 0 ? <span className={c.error_class === 'BILLING_QUOTA' ? 'text-failing' : 'text-degraded'}>{c.open} open</span> : null}
                />
              ))}
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-faint">
                <span>Asks across both twins</span>
                <span className="tabular">{askTotal}</span>
              </div>
              <div className="flex h-[6px] w-full gap-[2px] overflow-hidden rounded-full">
                {askTotal === 0 ? (
                  <div className="h-full w-full bg-raised" />
                ) : (
                  <>
                    <div style={{ width: `${(asks.answered / askTotal) * 100}%` }} className="bg-ink/60" title={`answered ${asks.answered}`} />
                    <div style={{ width: `${(asks.thin / askTotal) * 100}%` }} className="bg-degraded" title={`thin ${asks.thin}`} />
                    <div style={{ width: `${(asks.failed / askTotal) * 100}%` }} className="bg-failing" title={`failed ${asks.failed}`} />
                  </>
                )}
              </div>
              <div className="mt-1.5 flex gap-4 text-[11.5px]">
                <span className="text-dim">
                  <span className="tabular text-ink">{asks.answered}</span> answered
                </span>
                <span className="text-dim">
                  <span className={`tabular ${asks.thin ? 'text-degraded' : 'text-ink'}`}>{asks.thin}</span> thin
                </span>
                <span className="text-dim">
                  <span className={`tabular ${asks.failed ? 'text-failing' : 'text-ink'}`}>{asks.failed}</span> failed
                </span>
              </div>
            </div>
          </div>
        </Card>

        <EventList title="What broke in the last 24 hours" events={data.broke_24h} empty="Nothing broke in this window for the selected lane." />
        <EventList title="What moved in the last 24 hours" events={data.moved_24h} empty="Nothing moved in this window for the selected lane." />
      </div>
    </div>
  );
}
