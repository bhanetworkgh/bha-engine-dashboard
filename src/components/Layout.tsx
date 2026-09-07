import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../app/session';
import { useData } from '../app/useData';
import { getEngineStatus, type LaneFilter } from '../data';
import { Dot } from './ui';

const GROUPS: { group: string | null; items: { to: string; label: string; badge?: 'incidents' }[] }[] = [
  {
    group: null,
    items: [
      { to: '/', label: 'Overview' },
      { to: '/ask-bays', label: 'Ask Bays' },
    ],
  },
  {
    group: 'Systems',
    items: [
      { to: '/north-star', label: 'North Star' },
      { to: '/research-twin', label: 'Research Twin' },
      { to: '/vfarm', label: 'vFarm' },
      { to: '/engine-health', label: 'Engine health', badge: 'incidents' },
    ],
  },
  {
    group: 'Records',
    items: [
      { to: '/open-loops', label: 'Open loops' },
      { to: '/codex', label: 'Codex entries' },
      { to: '/build-patterns', label: 'Build patterns' },
      { to: '/commercial', label: 'Commercial' },
    ],
  },
  {
    group: 'People',
    items: [{ to: '/builders', label: 'Builders' }],
  },
];

const LANES: { value: LaneFilter; label: string }[] = [
  { value: 'all', label: 'All lanes' },
  { value: 'VFARM_CORE', label: 'vfarm core' },
  { value: 'VFARM_MEDIA', label: 'vfarm media' },
  { value: 'CLIENT_CORE', label: 'client core' },
  { value: 'ENGINE_INTERNAL', label: 'engine internal' },
];

function Sidebar({ openIncidents }: { openIncidents: number }) {
  return (
    <nav className="flex w-[188px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <img src="/logo.svg" alt="" className="h-5 w-5 rounded-full opacity-90" />
        <span className="font-medium">BHA engine</span>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto py-2">
        {GROUPS.map((g, i) => (
          <div key={g.group ?? `top-${i}`} className={g.group ? 'mt-4' : ''}>
            {g.group && (
              <div className="px-4 pb-1 text-[10px] tracking-[0.08em] text-faint uppercase">
                {g.group}
              </div>
            )}
            {g.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'flex items-center justify-between px-4 py-[5px] border-l-2',
                    isActive
                      ? 'border-gold text-ink bg-raised'
                      : 'border-transparent text-dim hover:text-ink hover:bg-hover',
                  ].join(' ')
                }
              >
                <span>{item.label}</span>
                {item.badge === 'incidents' && openIncidents > 0 && (
                  <span className="tabular border border-failing px-1 text-[10px] leading-[15px] text-failing">
                    {openIncidents}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-line px-4 py-2 text-[11px] text-faint">
        Phase 1 · mock data
      </div>
    </nav>
  );
}

export default function Layout() {
  const { lane, setLane, signOut } = useSession();
  const status = useData(getEngineStatus);
  const s = status.data;

  return (
    <div className="flex h-full">
      <Sidebar openIncidents={s?.open_incidents ?? 0} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Status strip. Last refresh, one health dot, the global lane filter. */}
        <div className="flex h-9 shrink-0 items-center gap-4 border-b border-line bg-panel px-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <Dot health={s?.health ?? 'ok'} title={s?.note ?? 'Engine healthy'} />
            <span className={s?.health === 'ok' || !s ? 'text-dim' : s.health === 'failing' ? 'text-failing' : 'text-degraded'}>
              {!s ? 'checking…' : s.health === 'ok' ? 'engine healthy' : s.note}
            </span>
          </span>

          <span className="text-faint">
            last refresh <span className="tabular text-dim">{s?.last_refresh ?? '—'}</span>
          </span>

          <label className="ml-auto flex items-center gap-1.5 text-faint">
            lane
            <select
              value={lane}
              onChange={(e) => setLane(e.target.value as LaneFilter)}
              className="border border-line bg-raised px-1.5 py-[2px] text-[11px] text-ink hover:border-line-strong focus:border-gold-dim focus:outline-none"
            >
              {LANES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={signOut}
            className="text-faint hover:text-ink"
          >
            sign out
          </button>
        </div>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
