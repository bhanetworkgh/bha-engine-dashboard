import type { TwinData } from '../../data';
import {
  EmptyState,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  Th,
} from '../../components/ui';
import { act } from '../../lib';

export function Gaps({ d }: { d: TwinData }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
        Still unanswered
      </h3>
      {d.gaps.length === 0 ? (
        <EmptyState>
          Nothing came back empty or thin for the selected lane in this period.
        </EmptyState>
      ) : (
        <table className="table-cards w-full text-[12px]">
          <thead>
            <tr>
              <Th>question</Th>
              <Th>came back</Th>
              <Th className="text-right">cycles</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>first seen</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {d.gaps.map((g) => (
              <tr key={g.id}>
                <td className="td card-title td-clip" style={{ maxWidth: '40ch' }}>{g.question}</td>
                <td className={`td card-meta ${g.reason === 'empty' ? 'text-failing' : 'text-degraded'}`}>
                  {g.reason}
                </td>
                <td className="td card-meta tabular text-right text-dim">{g.cycles}</td>
                <SpineCells spine={g.spine} />
                <td className="td tabular text-faint">{g.first_seen}</td>
                <td className="td">
                  <SourceLink source={g.source} />
                </td>
                <td className="td card-actions">
                  <RowActions>
                    <RowAction label="re-run" onClick={() => act('twin.rerun-gap', g.id)} />
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="border-y border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
        Went thin, later answered
      </h3>
      {d.transitions.length === 0 ? (
        <EmptyState>
          {d.notes.transitions ??
            'No ask has gone thin and later been answered for the selected lane.'}
        </EmptyState>
      ) : (
        <table className="table-cards w-full text-[12px]">
          <thead>
            <tr>
              <Th>question</Th>
              <Th>went thin</Th>
              <Th>answered</Th>
              <Th className="text-right">cycles</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>source</Th>
            </tr>
          </thead>
          <tbody>
            {d.transitions.map((t) => (
              <tr key={t.id}>
                <td className="td card-title td-clip" style={{ maxWidth: '40ch' }}>{t.question}</td>
                <td className="td tabular text-faint">{t.went_thin_at}</td>
                <td className="td card-meta tabular text-dim">{t.answered_at}</td>
                <td className="td card-meta tabular text-right text-dim">{t.cycles}</td>
                <SpineCells spine={t.spine} />
                <td className="td">
                  <SourceLink source={t.source} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
