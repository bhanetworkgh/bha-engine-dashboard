import { useEffect, useState } from 'react';
import { useTheme } from '../app/theme';
import { useWeather } from '../app/useWeather';
import { Icon } from './ui';

/** Date, a live clock, and the weather when the browser will share a location. */
export function ClockChip() {
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

export function ThemeChip() {
  const { resolved, setChoice } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      className="chip h-8 w-8 justify-center px-0 transition-transform active:scale-95"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}

/**
 * The field design preview (1 Nov 2026, Destiny): the website's colours and
 * font over the same layout. A personal look, remembered in this browser
 * only; the dashboard's own design stays the default. See the "Field design"
 * block at the end of index.css.
 */
const DESIGN_KEY = 'bha.design';

export function DesignChip() {
  const [field, setField] = useState(() => document.documentElement.dataset.design === 'field');
  useEffect(() => {
    if (field) document.documentElement.dataset.design = 'field';
    else delete document.documentElement.dataset.design;
    try {
      if (field) localStorage.setItem(DESIGN_KEY, 'field');
      else localStorage.removeItem(DESIGN_KEY);
    } catch {
      // The choice simply will not persist.
    }
  }, [field]);
  const label = field ? 'Back to the dashboard design' : 'Preview the website design';
  return (
    <button
      type="button"
      onClick={() => setField((f) => !f)}
      className="chip h-8 w-8 justify-center px-0 transition-transform active:scale-95"
      aria-label={label}
      aria-pressed={field}
      title={label}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10Zm0 0 6-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={field ? 'currentColor' : 'none'}
          fillOpacity={field ? 0.25 : 0}
        />
      </svg>
    </button>
  );
}
