import { useCallback, useState } from 'react';
import { useData } from '../../app/useData';
import { getEngineHealth, resyncHealth, type HealthData } from '../../data';
import { LoadFailed, Loading, PageHeader, ResyncButton, Tabs, Toast, useResync, useToast } from '../../components/ui';
import FinalImportPanel from './FinalImport';
import LaneView from './LaneView';
import Repairs from './Repairs';
import Retries from './Retries';

/**
 * Engine Health — built 2026-09-17, where a "coming soon" page stood.
 *
 * It answers one question: **is the engine actually working right now, and if
 * not, what broke, was it fixed by itself, and does anyone need to do
 * something?** Everything on it is read from three sources that were already
 * being written and had never been read — the BHARAG incident ledger, and
 * `error_counts` and `retry_attempts` in Airtable.
 *
 * **The three lane tabs are one component with a different `lane`.** The
 * handlers are deliberately identical, and a per-lane copy would drift the
 * first time one of them changed.
 *
 * The rule the whole page is built around: **no incidents and no reporting look
 * identical from the outside**, and only one of them is good news. Every tab
 * leads with which lanes answered — each lane needs its own BHARAG credential,
 * so an unkeyed or refused lane is a real and common state — and no figure is
 * allowed to imply an answer a lane never gave.
 */
/**
 * Six tabs. **Repairs is last because it is the newest half of the same
 * question** (2026-09-20): Retries is what the healer did on its own, and
 * Repairs is what the bridge changed in a workflow. A failure ends as retried,
 * repaired, or waiting on a person, and those two tabs are where the last two
 * of those are read.
 */
const TABS = ['All systems', 'Bays', 'North Star', 'Research Twin', 'Retries', 'Repairs'] as const;
type Tab = (typeof TABS)[number];

/** Which lane each tab reads. All systems and Retries read every lane. */
const LANE_OF: Partial<Record<Tab, string>> = {
  Bays: 'bays',
  'North Star': 'north_star',
  'Research Twin': 'research_twin',
};

export default function EngineHealth() {
  const [tab, setTab] = useState<Tab>('All systems');
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<HealthData | null>(null);
  const { toast, setToast } = useToast();
  const { status, data: loaded, error } = useData(getEngineHealth, [tick === -1]);

  const data = held ?? loaded;

  /** Re-reads the rows and re-runs every figure, after a resync or a retry. */
  const reload = useCallback(async () => {
    setTick((n) => n + 1);
    setHeld(await getEngineHealth());
  }, []);

  const resync = useResync({ run: resyncHealth, reload, setToast });

  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  const openNow = data.incidents.filter((i) => i.open_now).length;
  const exhausted = data.retries.filter((r) => r.status === 'Exhausted').length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Engine health"
        subtitle="What broke, whether it healed itself, and what is waiting on a person"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            /*
              Counts on the two tabs where a number above nought is genuinely
              bad. Nothing else carries one: a count on every tab is decoration,
              and decoration that looks like a warning is worse than none.
            */
            counts={{
              'All systems': openNow ? { n: openNow, tone: 'degraded' } : undefined,
              Retries: exhausted ? { n: exhausted, tone: 'failing' } : undefined,
            }}
          />
        }
      />

      {tab === 'Repairs' ? (
        /*
          Repairs reads its own route rather than the health payload: the rows
          come from this engine's repair loop, not from the three lanes, and
          folding them into a payload keyed on lanes would put them behind the
          lane reads they have nothing to do with.
        */
        <Repairs />
      ) : tab === 'Retries' ? (
        <Retries data={data} tick={tick} onChanged={() => void reload()} />
      ) : (
        <LaneView data={data} lane={LANE_OF[tab] ?? null} tick={tick} />
      )}

      {/*
        The final import (2026-09-22), on All systems only and under the page's
        own content.

        It is a one-off control for the Airtable cutover rather than part of
        this page's subject, so it does not push the incident figures down, and
        it is not repeated on a lane tab or on Repairs where it would read as
        something to do with that tab. All systems is where the engine as a
        whole is, it is the tab this page opens on, and it is the only one that
        is about every source at once — which is what this button is.

        It takes itself off the page once Airtable is retired, on the same
        check the resync buttons use.
      */}
      {tab === 'All systems' && <FinalImportPanel />}

      <Toast toast={toast} />
    </div>
  );
}
