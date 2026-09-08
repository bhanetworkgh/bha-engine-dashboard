import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../app/session';
import { useTheme } from '../app/theme';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getEngineStatus, type LaneFilter } from '../data';
import { Dot, Icon, type IconName } from './ui';
import { cx } from '../lib';

const GROUPS: { group: string | null; items: { to: string; label: string; icon: IconName; badge?: 'incidents' }[] }[] = [
  {
    group: null,
    items: [
      { to: '/', label: 'Home', icon: 'overview' },
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

/** Who is at the keyboard, with a small menu to change it, switch theme, or sign out. */
function UserBlock() {
  const { me, setMe, signOut } = useSession();
  const { resolved, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = BUILDER_NAMES[me] ?? me;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative px-3 pb-4">
      {open && (
        <div className="card fade-up absolute bottom-full left-3 z-20 mb-2 w-[220px] p-1.5 shadow-[var(--shadow-pop)]">
          <div className="kicker px-2.5 pt-1.5 pb-1">Signed in as</div>
          {Object.entries(BUILDER_NAMES).map(([id, n]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMe(id);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-hover ${id === me ? 'text-ink' : 'text-dim'}`}
            >
              {n}
              {id === me && <Icon.check className="text-accent-ink" />}
            </button>
          ))}
          <div className="my-1.5 border-t border-line" />
          <button
            type="button"
            onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] text-dim hover:bg-hover"
          >
            {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
            {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] text-dim hover:bg-hover"
          >
            <Icon.lock />
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-[12px] px-2 py-2 text-left hover:bg-hover"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[14px] font-medium text-accent-ink">
          {name.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13.5px] font-medium">{name}</span>
          <span className="block truncate text-[11.5px] text-faint">Shared team login</span>
        </span>
        <Icon.chevron className="shrink-0 rotate-90 text-faint" />
      </button>
    </div>
  );
}

function Sidebar({ openIncidents, open, onNavigate }: { openIncidents: number; open: boolean; onNavigate: () => void }) {
  return (
    <nav
      className={cx(
        'w-[240px] shrink-0 flex-col bg-bg md:static md:flex',
        open ? 'fixed inset-y-0 left-0 z-50 flex shadow-[var(--shadow-pop)]' : 'hidden',
      )}
      aria-label="Primary"
    >
      <div className="flex items-center gap-3 px-6 pt-6 pb-5">
        <img src="/logo.svg" alt="" className="mark h-8 w-8" />
        <span className="text-[15px] font-semibold">BHA engine</span>
        <button type="button" onClick={onNavigate} className="btn btn-ghost btn-sm ml-auto md:hidden" aria-label="Close navigation">
          <Icon.close />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-3">
        {GROUPS.map((g, i) => (
          <div key={g.group ?? `top-${i}`} className={g.group ? 'mt-5' : ''}>
            {g.group && <div className="kicker px-3 pb-1.5">{g.group}</div>}
            <div className="space-y-[2px]">
              {g.items.map((item) => {
                const I = Icon[item.icon];
                return (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={onNavigate} className="nav-item">
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

      <UserBlock />
    </nav>
  );
}

function today(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Layout() {
  const { lane, setLane } = useSession();
  const status = useData(getEngineStatus);
  const s = status.data;
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex h-full bg-bg">
      <Sidebar openIncidents={s?.open_incidents ?? 0} open={navOpen} onNavigate={() => setNavOpen(false)} />

      {navOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top row: no bar, just the date, engine health and the lane filter on the right. */}
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 md:px-8 md:pt-6">
          <button type="button" onClick={() => setNavOpen(true)} aria-label="Open navigation" className="btn btn-ghost btn-sm -ml-2 md:hidden">
            <Icon.menu />
          </button>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="chip hidden sm:inline-flex">
              <Icon.calendar className="text-faint" />
              {today()}
            </span>
            <span className="chip min-w-0" title={s?.note ?? undefined}>
              <Dot health={s?.health ?? 'ok'} pulse />
              <span className={cx('truncate', s?.health === 'failing' ? 'text-failing' : s?.health === 'degraded' ? 'text-degraded' : '')}>
                {!s ? 'Checking' : s.health === 'ok' ? 'Engine healthy' : s.health === 'degraded' ? 'Engine degraded' : 'Engine failing'}
              </span>
              <span className="tabular hidden text-faint lg:inline">· {s?.last_refresh ?? '—'}</span>
            </span>
            <select
              value={lane}
              onChange={(e) => setLane(e.target.value as LaneFilter)}
              className="input h-8 w-auto rounded-full pr-8 text-[12.5px] shadow-[var(--shadow-card)]"
              style={{ boxShadow: 'var(--shadow-card)' }}
              aria-label="Lane filter"
            >
              {LANES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto md:overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
