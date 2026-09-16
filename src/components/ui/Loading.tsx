/**
 * What a page shows while it is fetching.
 *
 * It was a grey dot and the word "Loading" in the top-left corner, which on a
 * page that takes a second to answer reads as an empty page with a speck on it
 * (2026-09-16, Destiny). It is now the BHA mark, centred and breathing, the
 * same idle animation Ask Bays uses on its empty state — so the two places the
 * dashboard waits for something look like the same product.
 *
 * `logo-mark.svg` is `logo.svg` with its white background square removed, so
 * the mark sits on the page wash rather than in a white tile. The sidebar and
 * Ask Bays keep the original, where the white circle is the look.
 */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16" role="status" aria-live="polite">
      <img src="/logo-mark.svg" alt="" className="mark-plain idle-mark h-28 w-28" />
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
