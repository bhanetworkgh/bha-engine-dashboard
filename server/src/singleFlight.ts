/**
 * Identical page reads share one answer (23 Nov 2026, Destiny).
 *
 * The dashboard ran out of memory three times on 23 Nov (10:01, 12:02, 12:10
 * UTC). In the 100 seconds before the 12:02 crash one person's two open tabs
 * asked for /api/open-loops 28 times (522 KB each, 10 to 15 s to build), the
 * loop metrics 25 times and the Home page 12 times: every loop change tells an
 * open page to re-read, and the re-reads arrived faster than they finished, so
 * dozens of copies of the same rows were in memory at once.
 *
 * shared(key, fn) runs fn once for every caller that arrives while it is
 * running, and they all get the same answer. A change on the events bus starts
 * a new generation: a caller that arrives after the change never joins a read
 * that began before it, so nobody is handed rows older than a change they were
 * told about. At most one read per key per generation is ever running, which
 * is what bounds the memory. Nothing is cached once a read has finished.
 */
import * as events from './events';

interface Flight {
  gen: number;
  promise: Promise<unknown>;
}

const flights = new Map<string, Flight>();
let generation = 0;
let joined = 0;
let started = 0;

events.onChange(() => {
  generation += 1;
});

/** Runs fn, or joins the run already going for this key in this generation. */
export function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = flights.get(key);
  if (now && now.gen === generation) {
    joined += 1;
    return now.promise as Promise<T>;
  }
  started += 1;
  const flight: Flight = { gen: generation, promise: Promise.resolve() };
  flight.promise = (async () => {
    try {
      return await fn();
    } finally {
      // Only the newest run for a key removes its own entry.
      if (flights.get(key) === flight) flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise as Promise<T>;
}

/** For get_health and the tests: how often callers shared a read. */
export function stats(): { started: number; joined: number; running: number; generation: number } {
  return { started, joined, running: flights.size, generation };
}
