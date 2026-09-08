import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../app/session';
import { useTheme } from '../app/theme';
import { useData } from '../app/useData';
import { getEngineStatus, type LaneFilter } from '../data';
import { Dot, Icon, type IconName } from './ui';
import { cx } from '../lib';

const GROUPS: { group: string | null; items: { to: string; label: string; icon: IconName; badge?: 'incidents' }[] }[] = [
  {
    group: null,
    items: [
      { to: '/', label: 'Overview', icon: 'overview' },
      { to: '/ask-bays', label: 'Ask Bays', icon: 'chat' },
    ],
  },
  {
    group: 'Systems',
    items: [
      { to: '/north-star', label: 'North Star', icon: 'star' },
      { to: '/research-twin', label: 'Research Twin', icon: 'twin' },
      { to: '/vfarm', label: 'vFarm', icon: 'leaf' },
      { to: '/engine-health', label: 'Engine health', icon: 'pulse', badge: 'incidents' },
    ],
  },
  {
    group: 'Records',
    items: [
      { to: '/open-loops', label: 'Open loops', icon: 'loop' },
      { to: '/codex', label: 'Codex entries', icon: 'book' },
      { to: '/build-patterns', label: 'Build patterns', icon: 'pattern' },
      { to: '/commercial', label: 'Commercial', icon: 'tag' },
    ],
  },
  {
    group: 'People',
    items: [{ to: '/builders', label: 'Builders', icon: 'people' }],
  },
];

const LANES: { value: LaneFilter; label: string }[] = [
  { value: 'all', label: 'All lanes' },
  { value: 'VFARM_CORE', label: 'vFarm core' },
  { value: 'VFARM_MEDIA', label: 'vFarm media' },
  { value: 'CLIENT_CORE', label: 'Client core' },
  { value: 'ENGINE_INTERNAL', label: 'Engine internal' },
];

function ThemeToggle() {
  const { resolved, setChoice } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      className="btn btn-ghost btn-sm gap-1.5"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
      <span>{resolved === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  );
}

function Sidebar({
  openIncidents,
  open,
  onNavigate,
}: {
  openIncidents: number;
  open: boolean;
  onNavigate: () => void;
}) {
  const { signOut, session } = useSession();
  return (
    <nav
      className={cx(
        'w-[228px] shrink-0 flex-col bg-bg md:static md:flex',
        open ? 'fixed inset-y-0 left-0 z-50 flex shadow-[var(--shadow-pop)]' : 'hidden',
      )}
      aria-label="Primary"
    >
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <img src="/logo.svg" alt="" className="mark h-7 w-7" />
        <div className="min-w-0 leading-tight">
          <div className="text-[13.5px] font-medium">BHA engine</div>
          <div className="text-[11px] text-faint">{session?.label === 'Preview' ? 'Preview · mock data' : 'Phase 1 · mock data'}</div>
        </div>
        <button type="button" onClick={onNavigate} className="btn btn-ghost btn-sm ml-auto md:hidden" aria-label="Close navigation">
          <Icon.close />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-3">
        {GROUPS.map((g, i) => (
          <div key={g.group ?? `top-${i}`} className={g.group ? 'mt-5' : ''}>
            {g.group && <div className="kicker px-2.5 pb-1.5">{g.group}</div>}
            <div className="space-y-[2px]">
              {g.items.map((item) => {
                const I = Icon[item.icon];
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className="nav-item"
                  >
                    <I />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge === 'incidents' && openIncidents > 0 && (
                      <span className="tag tag-failing tabular">{openIncidents}</span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <ThemeToggle />
        <button type="button" onClick={signOut} className="btn btn-ghost btn-sm">
          Sign out
        </button>
      </div>
    </nav>
  );
}

export default function Layout() {
  const { lane, setLane } = useSession();
  const status = useData(getEngineStatus);
  const s = status.data;
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex h-full">
      <Sidebar openIncidents={s?.open_incidents ?? 0} open={navOpen} onNavigate={() => setNavOpen(false)} />

      {navOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} aria-hidden />
      )}

      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel md:rounded-[16px] md:shadow-[var(--shadow-card)]">
          {/* Status strip: one health dot, last refresh, the global lane filter. */}
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4 text-[12px] md:px-6">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              className="btn btn-ghost btn-sm -ml-2 md:hidden"
            >
              <Icon.menu />
            </button>

            <span className="flex min-w-0 items-center gap-2">
              <Dot health={s?.health ?? 'ok'} title={s?.note ?? 'Engine healthy'} pulse />
              <span
                className={cx(
                  'truncate',
                  s?.health === 'ok' || !s ? 'text-dim' : s.health === 'failing' ? 'text-failing' : 'text-degraded',
                )}
              >
                {!s ? 'Checking the engine' : s.health === 'ok' ? 'Engine healthy' : s.note}
              </span>
            </span>

            <span className="hidden shrink-0 whitespace-nowrap text-faint md:inline">
              Last refresh <span className="tabular text-dim">{s?.last_refresh ?? '—'}</span>
            </span>

            <label className="ml-auto flex shrink-0 items-center gap-2 text-faint">
              <span className="hidden sm:inline">Lane</span>
              <select
                value={lane}
                onChange={(e) => setLane(e.target.value as LaneFilter)}
                className="input h-7 w-auto pr-7 text-[12px]"
                aria-label="Lane filter"
              >
                {LANES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto md:overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
