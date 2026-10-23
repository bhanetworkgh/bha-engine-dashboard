/**
 * Which vFarm farm a page shows (24 Oct 2026, Destiny, D5; Jegan in #bha-coordination
 * 1792735807.245499: "we need to handle multiple farm, we need to add filter also").
 * One control for the vFarm page and the Monitoring Twin, so the two cannot word a farm
 * differently. The choice lives in the URL (?farm=<id>), so a link opens on the same farm.
 * Each option is the farm's name with its id beside it: two farms can share a name.
 */
export function FarmPicker({ value, farms, onChange }: { value: string | null; farms: Array<{ farm_id: string; name: string | null; synthetic?: boolean; listed?: boolean }>; onChange: (v: string | null) => void }) {
  if (farms.length < 2 && !value) return null;
  const missing = value && !farms.some((f) => f.farm_id === value);
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-faint">
      <span>Farm</span>
      <select className="input h-[30px] w-auto max-w-[260px] py-0 text-[12px]" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Farm">
        <option value="">All farms ({farms.length})</option>
        {farms.map((f) => (
          <option key={f.farm_id} value={f.farm_id}>
            {f.name ?? f.farm_id}
            {f.synthetic ? ' (simulated)' : ''}
            {f.listed === false ? ' (no longer listed)' : ''} · {f.farm_id.slice(0, 8)}
          </option>
        ))}
        {missing && <option value={value!}>{value} (not held)</option>}
      </select>
    </label>
  );
}
