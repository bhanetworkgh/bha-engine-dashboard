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
        <Route path="/open-loops" element={<Suspense fallback={<Loading />}><OpenLoops /></Suspense>} />
        <Route path="/codex" element={<Suspense fallback={<Loading />}><Codex /></Suspense>} />
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
