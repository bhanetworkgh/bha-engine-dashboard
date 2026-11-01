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
