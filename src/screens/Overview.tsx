import { Link } from 'react-router-dom';
import { useData } from '../app/useData';
import { getOverview, type OverviewEvent } from '../data';
import { Dot, Loading, LoadFailed, SourceLink, healthText } from '../components/ui';

function EventList({ title, events }: { title: string; events: OverviewEvent[] }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line last:border-r-0">
      <h2 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
        {title}
      </h2>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <p className="px-4 py-4 text-dim">
            Nothing recorded in this window for the selected lane.
          </p>
        ) : (
          events.map((e) => (
            <div key={e.id} className="rowlike border-b border-line px-4 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="tabular w-9 shrink-0 text-faint">{e.at}</span>
                <Dot health={e.health} />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <SourceLink source={e.source} />
              </div>
              <div className="flex items-baseline gap-2 pl-[44px]">
                <span className={`min-w-0 flex-1 truncate ${healthText(e.health)}`}>
                  {e.detail}
                </span>
                <span className="shrink-0 text-faint">{e.spine.lane.toLowerCase()}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function Overview() {
  const { status, data, error } = useData(getOverview);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pinned across the top. */}
      <div className="grid shrink-0 grid-cols-5 border-b border-line">
        {data.pins.map((p) => (
          <div key={p.label} className="border-r border-line px-4 py-2 last:border-r-0">
            <div className="text-[11px] text-faint">{p.label}</div>
            <div
              className={`tabular text-[19px] leading-tight ${
                p.accent ? 'text-gold' : p.health === 'ok' ? 'text-ink' : healthText(p.health)
              }`}
            >
              {p.value}
            </div>
          </div>
        ))}
      </div>

      {/* One tile per sidebar section. Clicking navigates in. */}
      <div className="grid shrink-0 grid-cols-3 border-b border-line lg:grid-cols-5">
        {data.tiles.map((t) => (
          <Link
            key={t.key}
            to={t.to}
            className="rowlike group border-r border-b border-line px-4 py-2 last:border-r-0"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-faint group-hover:text-dim">{t.label}</span>
              <Dot health={t.health} />
            </div>
            <div className="tabular text-[17px] leading-tight">{t.headline}</div>
            <div className="truncate text-[11px] text-faint">{t.sublabel}</div>
            <div className={`truncate text-[11px] ${healthText(t.health)}`}>{t.signal}</div>
          </Link>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <EventList title="What broke in the last 24 hours" events={data.broke_24h} />
        <EventList title="What moved in the last 24 hours" events={data.moved_24h} />
      </div>
    </div>
  );
}
