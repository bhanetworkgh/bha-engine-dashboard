import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../app/session';
import { useTheme } from '../app/theme';
import { useData } from '../app/useData';
import { useWeather } from '../app/useWeather';
import { getEngineStatus } from '../data';
import { Icon, type IconName } from './ui';
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

/** The shared account, with a small menu: settings and sign out. */
function UserBlock({ onNavigate }: { onNavigate: () => void }) {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        <div className="card fade-up absolute bottom-full left-3 z-20 mb-2 w-[200px] p-1.5 shadow-[var(--shadow-pop)]">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNavigate();
              navigate('/settings');
            }}
            className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] hover:bg-hover"
          >
            <Icon.settings className="text-dim" />
            Settings
          </button>
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] hover:bg-hover"
          >
            <Icon.lock className="text-dim" />
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-[12px] px-2 py-2 text-left transition-colors hover:bg-hover active:scale-[0.98]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[14px] font-medium text-accent-ink">
          A
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13.5px] font-medium">Admin</span>
          <span className="block truncate text-[11.5px] text-faint">Shared team login</span>
        </span>
        <Icon.chevron className={cx('shrink-0 text-faint transition-transform', open ? '-rotate-90' : 'rotate-90')} />
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
        <span className="text-[15px] font-semibold">BHA Engine</span>
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

      <UserBlock onNavigate={onNavigate} />
    </nav>
  );
}

/** Date, a live clock, and the weather when the browser will share a location. */
function ClockChip() {
  const [now, setNow] = useState(() => new Date());
  const weather = useWeather();
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(i);
  }, []);
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const W = weather?.kind === 'sun' ? Icon.sun : weather?.kind === 'rain' ? Icon.rain : Icon.cloud;
  return (
    <span className="chip">
      <Icon.calendar className="text-faint" />
      <span>{date}</span>
      <span className="tabular text-ink">{time}</span>
      {weather && (
        <>
          <span className="text-faint">·</span>
          <W className="text-accent-ink" />
          <span className="tabular text-ink">{weather.temp_c}°</span>
          <span className="hidden lg:inline">{weather.label}</span>
        </>
      )}
    </span>
  );
}

function ThemeChip() {
  const { resolved, setChoice } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" onClick={() => setChoice(next)} className="chip h-8 w-8 justify-center px-0 transition-transform active:scale-95" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}

export default function Layout() {
  const status = useData(getEngineStatus);
  const s = status.data;
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  /* Ask Bays owns its whole column, so the top row steps aside there. */
  const bare = location.pathname.startsWith('/ask-bays');

  return (
    <div className="flex h-full bg-bg">
      <Sidebar openIncidents={s?.open_incidents ?? 0} open={navOpen} onNavigate={() => setNavOpen(false)} />

      {navOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        {!bare && (
          <div className="flex shrink-0 items-center gap-2 px-4 pt-4 md:px-8 md:pt-6">
            <button type="button" onClick={() => setNavOpen(true)} aria-label="Open navigation" className="btn btn-ghost btn-sm -ml-2 md:hidden">
              <Icon.menu />
            </button>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <ClockChip />
              <ThemeChip />
            </div>
          </div>
        )}
        {bare && (
          <button type="button" onClick={() => setNavOpen(true)} aria-label="Open navigation" className="btn btn-ghost btn-sm absolute top-3 left-3 z-30 md:hidden">
            <Icon.menu />
          </button>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto md:overflow-hidden">
          <div key={location.pathname} className="page-in flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
