import { useState } from 'react';
import { useData } from '../app/useData';
import { getNorthStar, getResearchTwin, type Query, type TwinData } from '../data';
import {
  EmptyState,
  Loading,
  LoadFailed,
  PageHeader,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
  act,
  healthText,
} from '../components/ui';

const TABS = ['Summary', 'Records', 'Runs', 'Gaps'] as const;
type Tab = (typeof TABS)[number];

const OUTCOME_HEALTH = { answered: 'ok', thin: 'degraded', failed: 'failing' } as const;

function Summary({ d }: { d: TwinData }) {
  const s = d.summary;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-5 border-b border-line">
        {[
          { label: 'Asks', value: String(s.asks), tone: 'text-gold' },
          { label: 'Answered', value: String(s.answered), tone: 'text-ink' },
          { label: 'Thin', value: String(s.thin), tone: s.thin ? 'text-degraded' : 'text-ink' },
          { label: 'Failed', value: String(s.failed), tone: s.failed ? 'text-failing' : 'text-ink' },
          { label: 'Median time to answer', value: s.median_time_to_answer ?? 'not recorded', tone: 'text-dim' },
        ].map((m) => (
          <div key={m.label} className="border-r border-line px-4 py-2 last:border-r-0">
            <div className="text-[11px] text-faint">{m.label}</div>
            <div className={`tabular text-[17px] leading-tight ${m.tone}`}>{m.value}</div>
          </div>
        ))}
      </div>

      {s.median_unavailable_reason && (
        <p className="max-w-[68ch] border-b border-line px-4 py-2 text-[11px] leading-relaxed text-faint">
          {s.median_unavailable_reason}
        </p>
      )}

      <div className="flex flex-wrap">
        <section className="min-w-[280px] flex-1 border-r border-line">
          <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            Top askers
          </h3>
          <table className="w-full text-[12px]">
            <tbody>
              {s.top_askers.map((a) => (
                <tr key={a.builder_id}>
                  <td className="td">{a.builder_id}</td>
                  <td className="td tabular w-16 text-right text-dim">{a.asks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="min-w-[360px] flex-1">
          <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            By lane
          </h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <Th>lane</Th>
                <Th className="text-right">asks</Th>
                <Th className="text-right">thin</Th>
                <Th className="text-right">failed</Th>
              </tr>
            </thead>
            <tbody>
              {s.by_lane.map((l) => (
                <tr key={l.lane}>
                  <td className="td">{l.lane.toLowerCase()}</td>
                  <td className="td tabular text-right text-dim">{l.asks}</td>
                  <td className={`td tabular text-right ${l.thin ? 'text-degraded' : 'text-faint'}`}>{l.thin}</td>
                  <td className={`td tabular text-right ${l.failed ? 'text-failing' : 'text-faint'}`}>{l.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Records({ d }: { d: TwinData }) {
  if (!d.records.length)
    return <EmptyState>No asks recorded for the selected lane in this period.</EmptyState>;
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>question</Th>
          <Th>tags</Th>
          <Th>asked by</Th>
          <Th className="text-right">cycle</Th>
          <Th>outcome</Th>
          <Th>evidence shape</Th>
          {SPINE_HEADERS.map((h) => (
            <Th key={h}>{h}</Th>
          ))}
          <Th>at</Th>
          <Th>source</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {d.records.map((r) => (
          <tr key={r.id}>
            <td className="td td-clip" style={{ maxWidth: '38ch' }} title={r.question}>
              {r.question}
            </td>
            <td className="td"><TagRow tags={r.tags} /></td>
            <td className="td text-dim">{r.asked_by}</td>
            <td className="td tabular text-right text-dim">{r.cycle}</td>
            <td className={`td ${healthText(OUTCOME_HEALTH[r.outcome])}`}>{r.outcome}</td>
            <td className="td">
              {r.evidence_shape_version ? (
                <span className="text-dim">{r.evidence_shape_version}</span>
              ) : (
                <span className="text-faint">not written</span>
              )}
            </td>
            <SpineCells spine={r.spine} />
            <td className="td tabular text-faint">{r.at}</td>
            <td className="td">
              <SourceLink source={r.source} />
            </td>
            <td className="td">
              <RowActions>
                <RowAction label="re-run" onClick={() => act('twin.rerun-ask', r.id)} />
                <RowAction label="open in Slack" onClick={() => act('twin.open-slack', r.id)} />
              </RowActions>
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

const ENDED_HEALTH = {
  logged: 'ok',
  looping: 'degraded',
  quarantined: 'degraded',
  error: 'failing',
} as const;

function Runs({ d }: { d: TwinData }) {
  if (!d.runs.length)
    return <EmptyState>No runs recorded for the selected lane in this period.</EmptyState>;
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>question</Th>
          <Th>searches fired</Th>
          <Th>ended</Th>
          <Th>how it ended</Th>
          <Th>started</Th>
          <Th>source</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {d.runs.map((r) => (
          <tr key={r.id}>
            <td className="td td-clip" style={{ maxWidth: '34ch' }}>{r.question}</td>
            <td className="td">
              <span className="inline-flex flex-wrap gap-1.5">
                {r.searches.map((s) => (
                  <span
                    key={s.tool}
                    className={`border px-1 text-[11px] leading-[16px] ${
                      s.empty ? 'border-line text-degraded' : 'border-line text-dim'
                    }`}
                    title={s.empty ? 'returned nothing' : `${s.returned} results`}
                  >
                    {s.tool} {s.empty ? 'empty' : s.returned}
                  </span>
                ))}
              </span>
            </td>
            <td className={`td ${healthText(ENDED_HEALTH[r.ended])}`}>{r.ended}</td>
            <td className="td td-clip text-faint" style={{ maxWidth: '44ch' }}>{r.end_detail}</td>
            <td className="td tabular text-faint">{r.started_at}</td>
            <td className="td">
              <SourceLink source={r.source} />
            </td>
            <td className="td">
              <RowActions>
                <RowAction label="re-run" onClick={() => act('twin.rerun', r.id)} />
              </RowActions>
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

function Gaps({ d }: { d: TwinData }) {
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
        <table className="w-full text-[12px]">
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
                <td className="td td-clip" style={{ maxWidth: '40ch' }}>{g.question}</td>
                <td className={`td ${g.reason === 'empty' ? 'text-failing' : 'text-degraded'}`}>
                  {g.reason}
                </td>
                <td className="td tabular text-right text-dim">{g.cycles}</td>
                <SpineCells spine={g.spine} />
                <td className="td tabular text-faint">{g.first_seen}</td>
                <td className="td">
                  <SourceLink source={g.source} />
                </td>
                <td className="td">
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
        <table className="w-full text-[12px]">
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
                <td className="td td-clip" style={{ maxWidth: '40ch' }}>{t.question}</td>
                <td className="td tabular text-faint">{t.went_thin_at}</td>
                <td className="td tabular text-dim">{t.answered_at}</td>
                <td className="td tabular text-right text-dim">{t.cycles}</td>
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

function TwinScreen({ fetcher }: { fetcher: (q: Query) => Promise<TwinData> }) {
  const [tab, setTab] = useState<Tab>('Summary');
  const { status, data, error } = useData(fetcher, [fetcher]);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={data.name}
        subtitle={data.summary.period}
        right={
          /* Sub-tabs live inside the page, not the sidebar. */
          <div className="flex gap-4">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 pb-1 text-[12px] ${
                  tab === t
                    ? 'border-gold text-ink'
                    : 'border-transparent text-faint hover:text-dim'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />
      {tab === 'Summary' && <Summary d={data} />}
      {tab === 'Records' && <Records d={data} />}
      {tab === 'Runs' && <Runs d={data} />}
      {tab === 'Gaps' && <Gaps d={data} />}
    </div>
  );
}

export function NorthStar() {
  return <TwinScreen fetcher={getNorthStar} />;
}

export function ResearchTwin() {
  return <TwinScreen fetcher={getResearchTwin} />;
}
