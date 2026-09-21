import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useSession } from './app/session';
import { Loading } from './components/ui';
import Login from './screens/Login';
import Overview from './screens/Overview';

/**
 * Every screen but the first is loaded when it is first opened (2026-09-16,
 * Destiny).
 *
 * They were all imported eagerly, so opening the dashboard downloaded and
 * parsed every page in it — the Executions drill-down, the registry editors,
 * the Ask Bays thread — before the Overview could paint. Splitting them leaves
 * a small shell and one chunk per page, which is the difference between "the
 * app is slow" and "this page is fetching".
 *
 * Overview is not split: it is what the dashboard opens on, so its chunk would
 * be a second round trip before the first paint every time.
 */
const AskBays = lazy(() => import('./screens/AskBays'));
const NorthStar = lazy(() => import('./screens/NorthStar'));
const ResearchTwin = lazy(() => import('./screens/ResearchTwin'));
const Clients = lazy(() => import('./screens/Clients'));
const VFarm = lazy(() => import('./screens/VFarm'));
const MediaTwin = lazy(() => import('./screens/MediaTwin'));
const Genie = lazy(() => import('./screens/Genie'));
const EngineHealth = lazy(() => import('./screens/EngineHealth'));
const PayTracker = lazy(() => import('./screens/PayTracker'));
const OpenLoops = lazy(() => import('./screens/OpenLoops'));
const Codex = lazy(() => import('./screens/Codex'));
const BuildPatterns = lazy(() => import('./screens/BuildPatterns'));
const Commercial = lazy(() => import('./screens/Commercial'));
const Executions = lazy(() => import('./screens/Executions'));
const Registry = lazy(() => import('./screens/Registry'));
const Settings = lazy(() => import('./screens/Settings'));

export default function App() {
  const { status } = useSession();

  // Nothing renders until the server has said whether this browser is signed in.
  if (status === 'checking') return <div className="h-full bg-bg" aria-busy="true" />;

  // One shared login sits in front of everything.
  if (status === 'out') return <Login />;

  return (
    <div className="page-in h-full">
      {/*
        One fallback for every page's chunk, and it is the same breathing BHA
        mark a page shows while it fetches — so a page that is still arriving
        and a page that is still loading its rows look like one wait rather
        than two different ones.
      */}
      <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/ask-bays" element={<Suspense fallback={<Loading />}><AskBays /></Suspense>} />
        <Route path="/north-star" element={<Suspense fallback={<Loading />}><NorthStar /></Suspense>} />
        <Route path="/research-twin" element={<Suspense fallback={<Loading />}><ResearchTwin /></Suspense>} />
        <Route path="/media-twin" element={<Suspense fallback={<Loading />}><MediaTwin /></Suspense>} />
        <Route path="/genie" element={<Suspense fallback={<Loading />}><Genie /></Suspense>} />
        <Route path="/vfarm" element={<Suspense fallback={<Loading />}><VFarm /></Suspense>} />
        <Route path="/engine-health" element={<Suspense fallback={<Loading />}><EngineHealth /></Suspense>} />
        <Route path="/pay" element={<Suspense fallback={<Loading />}><PayTracker /></Suspense>} />
        {/*
          A stable link per record (2026-09-22, Destiny), so Bays can stop
          linking people into Airtable.

          The path segment is the record's **own** id — `loop_id`,
          `Codex Entry ID` — never this database's row id and never the Airtable
          record id. Those are the two things that change: a row id is local to
          this database, and an Airtable record id changes the moment a loop is
          moved between builder tables, so a link built on either goes stale in
          the one situation somebody most wants to follow it. The natural id
          travels with the row through both.

          **A splat, and it took three attempts to get here — worth writing
          down because two of them look right.**

          Two `<Route>`s for the same component (`/open-loops` and
          `/open-loops/:recordId`) are two different elements to React Router,
          so moving between them unmounts one and mounts the other: the page is
          rebuilt and every piece of its state goes with it. Found in a browser,
          not by reading — a link naming a loop this dashboard does not hold set
          the toast saying so, and the remount destroyed the toast a few
          milliseconds later, so the page answered a bad link with silence.

          One route with an **optional** param (`:recordId?`) reads like the
          fix and is not: React Router expands an optional segment into two
          ranked branches internally, so the two paths still match different
          routes and the component still remounts. Confirmed the same way —
          the hook logged `ready: false, rows: 0` on the second pass, which is
          a fresh mount.

          A splat is one pattern that matches both, so there is one element and
          the segment simply changes underneath it. The record id is
          `useParams()['*']`.
        */}
        <Route path="/open-loops/*" element={<Suspense fallback={<Loading />}><OpenLoops /></Suspense>} />
        <Route path="/codex/*" element={<Suspense fallback={<Loading />}><Codex /></Suspense>} />
        <Route path="/build-patterns" element={<Suspense fallback={<Loading />}><BuildPatterns /></Suspense>} />
        <Route path="/commercial" element={<Suspense fallback={<Loading />}><Commercial /></Suspense>} />
        <Route path="/clients" element={<Suspense fallback={<Loading />}><Clients /></Suspense>} />
        <Route path="/executions" element={<Suspense fallback={<Loading />}><Executions /></Suspense>} />
        <Route path="/registry" element={<Suspense fallback={<Loading />}><Registry /></Suspense>} />
        <Route path="/settings" element={<Suspense fallback={<Loading />}><Settings /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      </Routes>
    </div>
  );
}
