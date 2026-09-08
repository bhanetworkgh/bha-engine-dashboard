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
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6 md:px-8">
      <h3 className="pt-1 pb-2 text-[13px] font-medium">Still unanswered</h3>
      {d.gaps.length === 0 ? (
        <EmptyState compact>
          Nothing came back empty or thin for the selected lane in this period.
        </EmptyState>
      ) : (
        <div className="card overflow-hidden"><table className="table-cards w-full text-[12.5px]">
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
                <td className="td card-actions td-actions">
                  <RowActions>
                    <RowAction label="Re-run" onClick={() => act('twin.rerun-gap', g.id)} />
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <h3 className="pt-6 pb-2 text-[13px] font-medium">Went thin, later answered</h3>
      {d.transitions.length === 0 ? (
        <EmptyState compact>
          {d.notes.transitions ??
            'No ask has gone thin and later been answered for the selected lane.'}
        </EmptyState>
      ) : (
        <div className="card overflow-hidden"><table className="table-cards w-full text-[12.5px]">
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
        </table></div>
      )}
    </div>
  );
}
