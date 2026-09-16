/**
 * What a page shows while it is fetching.
 *
 * It was a grey dot and the word "Loading" in the top-left corner, which on a
 * page that takes a second to answer reads as an empty page with a speck on it
 * (2026-09-16, Destiny). It is the BHA mark now, pulsing.
 *
 * **It fills its own container rather than sitting at the top of it.** A tab
 * switch renders this inside the tab body, which is not always a flex column,
 * so `flex-1` alone left the mark stuck under the tab row instead of centred in
 * the space below it. `min-h` gives it real height to centre inside whatever it
 * is dropped into.
 *
 * `logo-mark.svg` is `logo.svg` with its white background square removed, so
 * the mark sits on the page wash rather than in a white tile. The sidebar and
 * Ask Bays keep the original, where the white circle is the look.
 */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[55vh] w-full flex-1 flex-col items-center justify-center gap-4 px-6" role="status" aria-live="polite">
      <img src="/logo-mark.svg" alt="" className="mark-plain loading-mark h-36 w-36" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** The inline version, for a panel inside a page rather than a whole page. */
export function LoadingInline({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-6 py-10 text-faint">
      <span className="pulse-dot h-[7px] w-[7px] rounded-full bg-faint" />
      <span className="text-[13px]">{label}</span>
    </div>
  );
}
