import type { Health } from '../../data';
import { healthDot } from '../../lib';

/** The one-glyph health signal. Healthy is grey, not green. */
export function Dot({ health, title, pulse }: { health: Health; title?: string; pulse?: boolean }) {
  return (
    <span
      title={title ?? health}
      aria-label={title ?? health}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${healthDot(health)} ${
        pulse && health !== 'ok' ? 'pulse-dot' : ''
      }`}
    />
  );
}
