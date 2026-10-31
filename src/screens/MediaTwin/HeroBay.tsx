import { useEffect, useState } from 'react';
import type { HeroBayData, HeroEvidenceClass, HeroField } from '../../data';
import { Card, CardHeader, Pill, relativeTime } from '../../components/ui';
import { fieldsNow, RECHECK_MS } from './heroBayAge';

/**
 * The Halloween hero bay (FOCB, 30 Oct 2026, Hardik). One bay, P1.0 Tray A, read only.
 * Every class, state and note on this page comes from `server/src/heroBay.ts`; the page
 * decides nothing about what is real. A value with no evidence is a dash, never a filler.
 * The one thing re-checked here is the server's own silent-feed rule, every RECHECK_MS, so a
 * kept answer cannot go on saying LIVE after vFarm stops looking (`heroBayAge.ts`).
 */

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');

function ClassPill({ c }: { c: HeroEvidenceClass }) {
  if (c === 'REAL') return <Pill tone="accent">real</Pill>;
  if (c === 'SIMULATED') return <Pill>simulated</Pill>;
  return <Pill>not verified</Pill>;
}

function StatePill({ s }: { s: HeroField['state'] }) {
  if (!s) return null;
  if (s === 'LIVE') return <Pill tone="accent">live</Pill>;
  if (s === 'UNKNOWN') return <Pill>unknown</Pill>;
  return <Pill tone="degraded">{s === 'NO_FEED' ? 'feed quiet' : s.toLowerCase()}</Pill>;
}

function shown(f: HeroField) {
  if (f.value === null) return '—';
  const unit = f.unit === 'celsius' ? '°C' : f.unit === 'percent_rh' ? '%RH' : f.unit && f.unit !== 'day' ? ` ${f.unit}` : '';
  return f.key === 'crop_day' ? `day ${f.value}` : `${f.value}${unit}`;
}

/** The rack as the P1 specification draws it, to scale (1 px = 5 mm). Not the Onshape model. */
function RackDrawing({ data, fields }: { data: HeroBayData; fields: HeroField[] }) {
  const s = 0.2;
  const W = data.cad.width_mm * s;
  const H = data.cad.height_mm * s;
  const x0 = 50;
  const y0 = 20;
  const tiers = Array.from({ length: data.cad.tiers }, (_, i) => i + 1);
  const tierY = (t: number) => y0 + H - (H / (data.cad.tiers + 0.5)) * (t - 0.5);
  const temp = fields.find((f) => f.key === 'temperature');
  return (
    <svg viewBox={`0 0 ${W + x0 + 120} ${H + y0 + 50}`} className="h-auto w-full max-w-[420px]" role="img" aria-label={`P1 rack, ${data.cad.width_mm} by ${data.cad.height_mm} mm, ${data.cad.tiers} tiers, specification drawing`}>
      <rect x={x0} y={y0} width={W} height={H} fill="none" stroke="var(--line-strong)" strokeWidth={2} />
      {tiers.map((t) => (
        <g key={t}>
          <line x1={x0} x2={x0 + W} y1={tierY(t)} y2={tierY(t)} stroke="var(--line-strong)" strokeWidth={2} />
          <text x={x0 + W + 8} y={tierY(t) + 4} fontSize={11} fill="var(--faint)">tier {t}</text>
        </g>
      ))}
      <rect x={x0 + 6} y={tierY(data.cad.hero_tier) - 14} width={W - 12} height={12} fill="var(--accent-soft)" stroke="var(--accent)" />
      <text x={x0 + W / 2} y={tierY(data.cad.hero_tier) - 20} fontSize={11} textAnchor="middle" fill="var(--ink)">{data.bay.name}</text>
      <circle cx={x0 + W + 30} cy={y0 + 24} r={6} fill={temp?.state === 'LIVE' ? 'var(--accent)' : 'var(--faint)'} />
      <text x={x0 + W + 40} y={y0 + 28} fontSize={11} fill="var(--dim)">DHT11</text>
      <text x={x0 + W / 2} y={y0 + H + 18} fontSize={11} textAnchor="middle" fill="var(--dim)">{data.cad.width_mm} mm</text>
      <text x={x0 - 10} y={y0 + H / 2} fontSize={11} textAnchor="middle" fill="var(--dim)" transform={`rotate(-90 ${x0 - 10} ${y0 + H / 2})`}>{data.cad.height_mm} mm</text>
      <text x={x0} y={y0 + H + 40} fontSize={10.5} fill="var(--faint)">specification drawing · depth {data.cad.depth_mm} mm · not the Onshape model</text>
    </svg>
  );
}

export function HeroBay({ data }: { data: HeroBayData }) {
  const stageOf = data.story.current_stage;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RECHECK_MS);
    return () => clearInterval(timer);
  }, []);
  const fields = fieldsNow(data, now);
  return (
    <div className="flex flex-col gap-4 px-6 pb-8 md:px-8">
      <p className="text-[12.5px] text-dim">
        One bay on the real farm <code>{data.bay.farm_code}</code>, read only. Every value says whether it was measured (real), is a story value (simulated),
        or exists but cannot be vouched for (not verified). Nothing here switches a light or a pump.
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Card>
          <CardHeader title="The rack" right={<ClassPill c={data.cad.class} />} />
          <div className="flex flex-col gap-2 px-5 pb-4">
            <RackDrawing data={data} fields={fields} />
            <p className="text-[11.5px] text-faint">
              {data.cad.cabinet_type} · {data.cad.note}. Onshape document {data.cad.onshape_document}, version {data.cad.onshape_version ?? 'not pinned'}. Which tier holds
              Tray A and where the DHT11 is mounted are not recorded; the drawing places them for the picture only.
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader
            title={`Bay status · ${data.bay.name}`}
            right={<span className="tabular text-[11.5px] text-faint">vFarm last looked {when(data.feed.last_snapshot_at)}{data.feed.last_snapshot_at ? ` (${relativeTime(data.feed.last_snapshot_at) ?? '—'})` : ''}</span>}
          />
          <div className="flex flex-col divide-y divide-line px-5 pb-3">
            {fields.map((f) => (
              <div key={f.key} className="grid grid-cols-[110px_90px_1fr] items-start gap-3 py-2">
                <span className="text-[12.5px] text-dim">{f.label}</span>
                <span className="tabular text-[14px] font-medium text-ink">{shown(f)}</span>
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ClassPill c={f.class} />
                    <StatePill s={f.state} />
                    {f.observed_at && <span className="tabular text-[11.5px] text-faint">observed {when(f.observed_at)}</span>}
                  </span>
                  <span className="text-[11.5px] text-faint">{f.note} · {f.source}</span>
                </span>
              </div>
            ))}
            <p className="flex flex-wrap items-center gap-1.5 pt-2 text-[11.5px] text-faint">
              <span>Reported cabinet:</span>
              <span className="tabular text-ink">{data.bay.cabinet_id ?? '—'}</span>
              <ClassPill c={data.bay.class} />
              {data.bay.config_hash && <span className="tabular" title={data.bay.config_hash}>config {data.bay.config_hash.slice(0, 12)}…</span>}
            </p>
            <p className="text-[11.5px] text-faint">Bay identity: {data.bay.note}.</p>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Seed → growth → harvest" right={<ClassPill c={data.story.class} />} />
        <div className="flex flex-col gap-2 px-5 pb-4">
          <ol className="flex flex-wrap gap-2">
            {data.story.stages.map((s) => (
              <li
                key={`${s.where}-${s.stage}`}
                className={`rounded-md border px-3 py-2 text-[12px] ${s.stage === stageOf && s.where === 'cabinet' ? 'border-accent text-ink' : 'border-line text-dim'}`}
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-[11px] text-faint">{s.where === 'supplier' ? 'at the supplier' : `cabinet days ${s.from_day}–${s.to_day}`}</div>
              </li>
            ))}
          </ol>
          <p className="text-[11.5px] text-faint">
            {data.story.note} Day 0 is {data.story.day0.at.slice(0, 10)}, {data.story.day0.event}: {data.story.day0.source}. Profile {data.story.profile_id} v{data.story.profile_version ?? '—'}.
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader title="Not shown and not claimed" />
        <ul className="list-disc px-10 pb-4 text-[12px] text-dim">
          {data.not_claimed.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
