# vFarm stress test: engine-side checklist

Loop: LOOP-1794168643405-SK22 (Destiny). Front half: LOOP-1794168643166-RS77 (Jegan).
First run: Fri 13 Nov 2026. Run it the same way every time.

## What this half proves

1. **On time.** Every snapshot and reading the farm sends lands on the dashboard on time:
   - no gap between snapshots over 600 s (vFarm sends one every 180 s);
   - the newest snapshot is under 600 s old;
   - 95% of snapshots arrive within 60 s of being taken;
   - 95% of stored readings land within 300 s of being read, and none later than 900 s.
2. **State correct.** The Monitoring Twin marks each sensor live or stale exactly as the stored feed says, for every device, to the second.
3. **One alert.** A sensor going quiet opens one incident, closes it when the sensor comes back, never two at once for one device, and Engine health holds the same incident open or closed.
4. **Nothing old shown as live.** No device reads LIVE on old data, and no device reads LIVE while the feed is silent.

Checks 2 to 4 are UN9D's own conditions on the same rows, so the stress test and UN9D cannot disagree. The numbers live in `RULE` in `server/src/stressTest.ts` and nowhere else.

## Before the run

- Jegan confirms the front half is ready: every sensor reading, the cabinet's computer connected (LOOP-1794168643166-RS77). The engine half depends on it.
- Note the start time in Lagos and UTC.

## The run

1. Let the farm run normally for at least 60 minutes.
2. To prove check 3 on the day, Jegan unplugs one sensor for 16 minutes (past the 15-minute quiet line), then plugs it back in. Note which sensor and the times.
3. Run the check. Through the connector:
   `run_stress_test` with `farm_id: "21dde23e-f7f6-46bc-9b54-e97fabaaafd7"`, `window_minutes: 90`, `label: "Fri 13 Nov run 1"`.
   Without the connector: `POST /api/engine/stress-test` with `x-dashboard-key` and the same fields.
4. The answer gives the four checks, each pass, fail or not_yet_possible with its reason, and one verdict. The run passes only when all four pass.

## Recording the result

- Each run writes one `stress_test_engine_checked` event (read it with `read_engine_events`, event type `stress_test_engine_checked`).
- Post the verdict and the event id on LOOP-1794168643405-SK22, with the sensor unplugged and its times.
- A fail names what failed. Fix it, then run again with the next label ("run 2"). Never edit a run that failed.

## What this does not prove

- The front half (sensors reading, the cabinet staying connected, the farm storing readings). That is Jegan's.
- The vFarm monitoring contract's conditions 1, 2, 5 and 7.
- Anything about a simulated farm: a simulated pass proves the dashboard path, not the rack.
