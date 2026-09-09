import type { Spine } from '../../data';
import { laneLabel, subsystemLabel } from '../../lib';

/** Column headers matching SpineCells, so the two never drift apart. */
export const SPINE_HEADERS = ['session', 'builder', 'subsystem', 'lane'];

/** The four-field spine, rendered identically on every screen that carries it. */
export function SpineCells({ spine }: { spine: Spine }) {
  return (
    <>
      <td className="td text-faint tabular">{spine.session_id ?? '—'}</td>
      <td className="td text-dim">{spine.builder_id ?? '—'}</td>
      <td className="td text-faint">{spine.subsystem ? subsystemLabel(spine.subsystem) : '—'}</td>
      <td className="td text-faint">{spine.lane ? laneLabel(spine.lane) : '—'}</td>
    </>
  );
}
