import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getModelSpend } from '../data';
import type { ModelSpendData, ModelSpendDay } from '../data/types';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState, LoadFailed, Loading, PageHeader, Stat, StatCell, StatStrip, TableFrame, Tabs, Th } from '../components/ui';

/** Provider usage and measured account counters are kept separate. */

const TABS = ['Dollars', 'Tokens', 'Evals', 'Providers & cache'] as const;
type Tab = (typeof TABS)[number];
const SLUG: Record<Tab, string> = { Dollars: 'dollars', Tokens: 'tokens', Evals: 'evals', 'Providers & cache': 'backup' };
const AGENT: Record<string, string> = { bays: 'Bays', north_star: 'North Star', research_twin: 'Research Twin' };

const usd = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? 'Not recorded' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const k = (n: number | null | undefined) => (n === null || n === undefined ? 'Not recorded' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
// Whole days when any are measured; otherwise the stretch the readings do cover, said as such; otherwise nothing.
const spanHint = (v: number | null, measured: number, of: number, span: { from: string; to: string } | null) =>
  v !== null ? `${measured} of ${of} days measured` : span ? `only ${when(span.from)} to ${when(span.to)} UTC is measured` : 'not measured';
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'Not recorded');

/** Daily dollars as small bars; a day not measured is a gap with a dashed tick, never a zero bar. */
function DailyBars({ days }: { days: ModelSpendDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.spent_usd ?? 0));
  const w = 760;
  const h = 140;
  const bw = w / Math.max(days.length, 1);
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} className="w-full" role="img" aria-label="Dollars spent per day">
      {days.map((d, i) => {
        const x = i * bw;
        if (!d.measured || d.spent_usd === null) return <line key={d.day} x1={x + bw / 2} x2={x + bw / 2} y1={h - 6} y2={h} className="stroke-faint" strokeDasharray="2 2" />;
        const bh = Math.max(1, (d.spent_usd / max) * (h - 10));
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${usd(d.spent_usd)}`}</title>
            <rect x={x + 1} y={h - bh} width={Math.max(1, bw - 2)} height={bh} rx={1.5} className="fill-accent" />
          </g>
        );
      })}
      {days.length > 0 && (
        <>
          <text x={0} y={h + 14} className="fill-faint text-[10px]">{days[0].day}</text>
          <text x={w} y={h + 14} textAnchor="end" className="fill-faint text-[10px]">{days[days.length - 1].day}</text>
        </>
      )}
    </svg>
  );
}

function Dollars({ data }: { data: ModelSpendData }) {
  const o = data.openrouter;
  const days = [...o.daily].reverse();
  return (
    <>
      <ProviderUsage data={data} />
      <StatStrip cols={4}>
        <StatCell>
          <Stat label="OpenRouter, last 7 days" value={usd(o.last_7_days_usd ?? o.last_7_days_span?.spent_usd)} hint={spanHint(o.last_7_days_usd, o.last_7_days_measured, 7, o.last_7_days_span)} size="lg" />
        </StatCell>
        <StatCell>
          <Stat label="OpenRouter, this month" value={usd(o.month_to_date_usd ?? o.month_to_date_span?.spent_usd)} hint={spanHint(o.month_to_date_usd, o.month_to_date_measured, o.month_days, o.month_to_date_span)} />
        </StatCell>
        <StatCell>
          <Stat label="OpenRouter per measured day" value={usd(o.per_day_usd)} hint={`over the last ${data.window.days} days`} />
        </StatCell>
        <StatCell>
          <Stat
            label="OpenRouter left"
            value={usd(o.latest?.remaining_usd ?? null)}
            hint={o.latest ? `read ${when(o.latest.at)} UTC` : 'no reading yet'}
            tone={o.latest?.remaining_usd !== null && o.latest?.remaining_usd !== undefined && o.latest.remaining_usd < 15 ? 'failing' : 'default'}
          />
        </StatCell>
      </StatStrip>
      {o.last_read_error && <p className="px-6 pb-2 text-[12px] text-failing md:px-8">The last hourly reading failed: {o.last_read_error}</p>}
      <div className="px-6 pb-4 md:px-8">
        <Card>
          <CardHeader title="OpenRouter dollars per day (UTC)" right={<span className="text-[11.5px] text-faint">a dashed tick is a day not measured</span>} />
          <div className="px-5 pb-4">
            <DailyBars days={o.daily} />
          </div>
        </Card>
      </div>
      <TableFrame grow={false} label="Dollars per day">
        <thead>
          <tr>
            <Th>Day</Th>
            <Th>Spent</Th>
            <Th>Measured</Th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day} className="border-b border-line">
              <td className="tabular px-3 py-2 text-ink">{d.day}</td>
              <td className="tabular px-3 py-2 text-ink">{d.measured ? usd(d.spent_usd) : <span className="text-faint">not measured</span>}</td>
              <td className="px-3 py-2 text-dim">{d.measured ? 'yes' : 'no reading near both edges of the day'}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}

function Tokens({ data }: { data: ModelSpendData }) {
  const total = data.agents.reduce((a, x) => a + x.tokens, 0);
  return (
    <>
      <StatStrip cols={3}>
        {data.agents.map((a) => (
          <StatCell key={a.agent}>
            <Stat
              label={AGENT[a.agent] ?? a.agent}
              value={k(a.tokens)}
              hint={`${a.asks} asks · p50 ${k(a.p50)} · p95 ${k(a.p95)}`}
            />
          </StatCell>
        ))}
      </StatStrip>
      <p className="px-6 pb-3 text-[12px] text-dim md:px-8">
        {k(total)} tokens across the three agents in the last {data.window.days} days. Tokens include cached context and repeated calls. Dollar attribution by token share is disabled because provider and model rates differ.
      </p>
      <div className="px-6 pb-2 md:px-8">
        <h2 className="text-[13px] font-medium text-ink">Bays, by where the ask came from</h2>
      </div>
      <TableFrame grow={false} label="Bays tokens by source">
        <thead>
          <tr>
            <Th>Source</Th>
            <Th>Asks</Th>
            <Th>Tokens</Th>
            <Th>p50 per ask</Th>
          </tr>
        </thead>
        <tbody>
          {data.bays_by_source.map((s) => (
            <tr key={s.source} className="border-b border-line">
              <td className="px-3 py-2 text-ink">{s.source}</td>
              <td className="tabular px-3 py-2 text-dim">{s.asks}</td>
              <td className="tabular px-3 py-2 text-ink">{k(s.tokens)}</td>
              <td className="tabular px-3 py-2 text-dim">{s.p50 === null ? <span className="text-faint">no tokens recorded</span> : k(s.p50)}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <div className="px-6 pb-2 md:px-8">
        <h2 className="text-[13px] font-medium text-ink">Per agent, per day</h2>
      </div>
      <TableFrame grow={false} label="Tokens per agent per day">
        <thead>
          <tr>
            <Th>Day</Th>
            <Th>Agent</Th>
            <Th>Asks</Th>
            <Th>Tokens</Th>
            <Th>p50</Th>
            <Th>p95</Th>
          </tr>
        </thead>
        <tbody>
          {[...data.by_agent_day]
            .sort((a, b) => (a.day === b.day ? a.agent.localeCompare(b.agent) : b.day.localeCompare(a.day)))
            .map((r) => (
              <tr key={`${r.day}-${r.agent}`} className="border-b border-line">
                <td className="tabular px-3 py-2 text-dim">{r.day}</td>
                <td className="px-3 py-2 text-ink">{AGENT[r.agent] ?? r.agent}</td>
                <td className="tabular px-3 py-2 text-dim">{r.asks}{r.with_tokens < r.asks ? <span className="text-faint"> ({r.asks - r.with_tokens} without tokens)</span> : null}</td>
                <td className="tabular px-3 py-2 text-ink">{k(r.tokens)}</td>
                <td className="tabular px-3 py-2 text-dim">{k(r.p50)}</td>
                <td className="tabular px-3 py-2 text-dim">{k(r.p95)}</td>
              </tr>
            ))}
        </tbody>
      </TableFrame>
    </>
  );
}

function Evals({ data }: { data: ModelSpendData }) {
  const e = data.evals;
  return (
    <>
      <StatStrip cols={2}>
        <StatCell>
          <Stat label="OpenRouter spend during eval windows" value={usd(e.merged_usd)} hint={`${e.runs_counted} runs in the last ${data.window.days} days · an upper bound`} size="lg" />
        </StatCell>
        <StatCell>
          <Stat label="Share of OpenRouter spend" value={data.openrouter.window_usd && data.openrouter.window_usd.spent_usd > 0 ? `${Math.round((e.merged_usd / data.openrouter.window_usd.spent_usd) * 100)}%` : 'Not recorded'} hint={data.openrouter.window_usd ? `of ${usd(data.openrouter.window_usd.spent_usd)} measured in the window` : 'no measured spend in the window'} />
        </StatCell>
      </StatStrip>
      {e.runs.length === 0 ? (
        <EmptyState>No eval run recorded its cost in this window.</EmptyState>
      ) : (
        <TableFrame grow={false} label="Eval runs">
          <thead>
            <tr>
              <Th>Finished (UTC)</Th>
              <Th>Run</Th>
              <Th>Answers</Th>
              <Th>OpenRouter only</Th>
              <Th>Answered by</Th>
            </tr>
          </thead>
          <tbody>
            {e.runs.map((r) => (
              <tr key={`${r.run_id}-${r.at}`} className="border-b border-line">
                <td className="tabular px-3 py-2 text-dim">{when(r.at)}</td>
                <td className="px-3 py-2 text-ink">{r.run_id || 'Not recorded'}</td>
                <td className="tabular px-3 py-2 text-dim">{Number.isFinite(r.results) ? r.results : 'Not recorded'}</td>
                <td className="tabular px-3 py-2 text-ink">{usd(r.spent_usd)}</td>
                <td className="px-3 py-2 text-dim">{r.answered_by ? Object.entries(r.answered_by as Record<string, number>).map(([a, n]) => `${a === 'anthropic_backup' ? 'backup' : a} ${n}`).join(' · ') : 'not recorded'}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </>
  );
}

function ProviderUsage({ data }: { data: ModelSpendData }) {
  const usage = data.provider_usage;
  if (!usage) return <EmptyState>Provider usage has not been read yet.</EmptyState>;
  return <div className="space-y-3 px-6 py-4 md:px-8">
    <h2 className="text-[13px] font-medium text-ink">Anthropic primary and OpenRouter fallback</h2>
    <p className="text-[12px] text-dim">{usage.note}</p>
    {usage.last_error && <p className="text-[12px] text-failing">Usage collection failed: {usage.last_error}</p>}
    <p className="text-[11.5px] text-faint">Response capture from {usage.since}. Last scan: {when(usage.last_scan_at)} UTC. Missing usage is unknown.</p>
    {usage.providers.length === 0 ? <EmptyState>No model responses captured yet.</EmptyState> : <TableFrame grow={false} label="Provider usage and cache coverage">
      <thead><tr><Th>Provider</Th><Th>Responses</Th><Th>Input</Th><Th>Output</Th><Th>Cache reads</Th><Th>Cache writes, 5m / 1h</Th><Th>Calculated cost, partial</Th></tr></thead>
      <tbody>{usage.providers.map(p => <tr key={p.provider} className="border-b border-line">
        <td className="px-3 py-2 text-ink">{p.provider}</td><td className="px-3 py-2 tabular">{p.calls}</td>
        <td className="px-3 py-2 tabular">{k(p.input_tokens)}</td><td className="px-3 py-2 tabular">{k(p.output_tokens)}</td>
        <td className="px-3 py-2 tabular">{k(p.cache_read_tokens)}<span className="block text-faint">{p.calls_without_cache_split} without split</span></td>
        <td className="px-3 py-2 tabular">{k(p.cache_write_5m_tokens)} / {k(p.cache_write_1h_tokens)}</td>
        <td className="px-3 py-2 tabular">{usd(p.estimated_usd)}<span className="block text-faint">{p.unpriced_calls} unpriced</span></td>
      </tr>)}</tbody>
    </TableFrame>}
    <p className="text-[12px] text-dim">Planning budget: $350-$500/month of Anthropic credits, plus a separate $50 OpenRouter reserve. Forecast only, excluding tax. Anthropic remaining credit must be checked in its billing console.</p>
  </div>;
}

function Backup({ data }: { data: ModelSpendData }) {
  const b = data.anthropic_backup;
  const answered = b.by_day.reduce((a, d) => a + d.answered, 0);
  const failed = b.by_day.reduce((a, d) => a + d.failed, 0);
  return (
    <>
      <ProviderUsage data={data} />
      <StatStrip cols={3}>
        <StatCell>
          <Stat label="Fallback answers, both historical routes" value={answered} hint={`last ${data.window.days} days`} />
        </StatCell>
        <StatCell>
          <Stat label="Backup also failed" value={failed} tone={failed ? 'failing' : 'default'} hint="both providers failed on the same ask" />
        </StatCell>
        <StatCell>
          <Stat label="Refused for credit" value={b.credit_refusals} tone={b.credit_refusals ? 'failing' : 'default'} hint={b.last_refusal_at ? `last ${when(b.last_refusal_at)}` : 'none in the window'} />
        </StatCell>
      </StatStrip>
      <p className="px-6 pb-3 text-[12px] text-dim md:px-8">{b.note}</p>
      <TableFrame grow={false} label="Backup answers per day">
        <thead>
          <tr>
            <Th>Day</Th>
            <Th>Answered</Th>
            <Th>Failed too</Th>
          </tr>
        </thead>
        <tbody>
          {[...b.by_day].reverse().map((d) => (
            <tr key={d.day} className="border-b border-line">
              <td className="tabular px-3 py-2 text-dim">{d.day}</td>
              <td className="tabular px-3 py-2 text-ink">{d.answered}</td>
              <td className={`tabular px-3 py-2 ${d.failed ? 'text-failing' : 'text-dim'}`}>{d.failed}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}

export default function ModelSpend() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => SLUG[t] === params.get('tab')) ?? 'Dollars') as Tab;
  const { status, data, error } = useData(getModelSpend, [], { kinds: ['bays-asks', 'ns-asks', 'rt-asks'] });
  const setTab = (t: Tab) => setParams(t === 'Dollars' ? {} : { tab: SLUG[t] }, { replace: true });
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Model spend"
        subtitle="Anthropic primary, OpenRouter fallback: recorded tokens, cache usage and provider costs"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} />}
      />
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-8">
          {tab === 'Dollars' ? <Dollars data={data} /> : tab === 'Tokens' ? <Tokens data={data} /> : tab === 'Evals' ? <Evals data={data} /> : <Backup data={data} />}
          <div className="mt-4 space-y-1 px-6 text-[11.5px] leading-relaxed text-faint md:px-8">
            {data.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <p>{data.window.readings_held} OpenRouter readings held, the first {when(data.window.first_reading)} UTC.</p>
          </div>
        </div>
      )}
    </div>
  );
}
