import { useLive } from '../../app/live';

/**
 * Whether this page is being kept current by the change stream (2026-09-23).
 *
 * Green and "Live" while /api/events is open; grey and "Not live" when it is
 * not, with the tooltip saying what the page does instead — re-reads on focus,
 * and every 30 seconds once the stream has been down a minute. Grey rather than
 * amber: a dropped stream is the page catching up more slowly, not a fault in
 * the engine, and colour on this dashboard is kept for genuinely bad states.
 */
export function LiveIndicator() {
  const { connected } = useLive();
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${connected ? 'text-dim' : 'text-faint'}`}
      title={
        connected
          ? 'Live: this page re-reads itself the moment anything it shows is written.'
          : 'Not live: the update stream is disconnected. The page re-reads when you come back to it, and every 30 seconds once the stream has been down a minute, until it reconnects.'
      }
    >
      <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${connected ? 'bg-ok' : 'bg-faint'}`} />
      {connected ? 'Live' : 'Not live'}
    </span>
  );
}
