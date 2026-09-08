import { useEffect, useState } from 'react';

/**
 * A small weather summary for the top-right chip. Uses the browser's location
 * (with permission) and Open-Meteo, which needs no key. If either is refused
 * or fails, the hook returns null and the chip shows date and time only —
 * nothing is guessed.
 */
export interface Weather {
  temp_c: number;
  label: string;
  kind: 'sun' | 'cloud' | 'rain';
}

const CACHE_KEY = 'bha.weather';
const CACHE_MS = 30 * 60 * 1000;

function describe(code: number): { label: string; kind: Weather['kind'] } {
  if (code === 0) return { label: 'Clear', kind: 'sun' };
  if (code === 1) return { label: 'Mostly clear', kind: 'sun' };
  if (code === 2) return { label: 'Partly cloudy', kind: 'cloud' };
  if (code === 3) return { label: 'Overcast', kind: 'cloud' };
  if (code === 45 || code === 48) return { label: 'Fog', kind: 'cloud' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', kind: 'rain' };
  if (code >= 61 && code <= 67) return { label: 'Rain', kind: 'rain' };
  if (code >= 71 && code <= 77) return { label: 'Snow', kind: 'rain' };
  if (code >= 80 && code <= 82) return { label: 'Showers', kind: 'rain' };
  if (code >= 95) return { label: 'Thunderstorms', kind: 'rain' };
  return { label: 'Cloudy', kind: 'cloud' };
}

function readCache(): Weather | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, weather } = JSON.parse(raw) as { at: number; weather: Weather };
    return Date.now() - at < CACHE_MS ? weather : null;
  } catch {
    return null;
  }
}

export function useWeather(): Weather | null {
  const [weather, setWeather] = useState<Weather | null>(readCache);

  useEffect(() => {
    if (weather) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let live = true;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(3)}&longitude=${longitude.toFixed(3)}&current=temperature_2m,weather_code`;
          const res = await fetch(url);
          if (!res.ok) return;
          const json = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
          const temp = json.current?.temperature_2m;
          const code = json.current?.weather_code;
          if (typeof temp !== 'number' || typeof code !== 'number') return;
          const w: Weather = { temp_c: Math.round(temp), ...describe(code) };
          if (!live) return;
          setWeather(w);
          try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), weather: w }));
          } catch {
            // Fine without a cache.
          }
        } catch {
          // No weather; the chip shows date and time only.
        }
      },
      () => {
        // Permission refused or unavailable. Nothing to show.
      },
      { timeout: 6000, maximumAge: CACHE_MS },
    );

    return () => {
      live = false;
    };
  }, [weather]);

  return weather;
}
