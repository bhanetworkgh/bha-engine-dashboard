import type { Health } from '../../data';
import { healthDot } from '../../lib';

/** The one-glyph health signal. Healthy is grey, not green. */
export function Dot({ health, title }: { health: Health; title?: string }) {
  return (
    <span
      title={title ?? health}
      aria-label={title ?? health}
      className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${healthDot(health)}`}
    />
  );
}
