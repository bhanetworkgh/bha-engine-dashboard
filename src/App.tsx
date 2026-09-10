import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useSession } from './app/session';
import Login from './screens/Login';
import Overview from './screens/Overview';
import AskBays from './screens/AskBays';
import NorthStar from './screens/NorthStar';
import ResearchTwin from './screens/ResearchTwin';
import Clients from './screens/Clients';
import VFarm from './screens/VFarm';
import EngineHealth from './screens/EngineHealth';
import OpenLoops from './screens/OpenLoops';
import Codex from './screens/Codex';
import BuildPatterns from './screens/BuildPatterns';
import Commercial from './screens/Commercial';
import { Builders, BuilderPage } from './screens/Builders';
import Settings from './screens/Settings';

export default function App() {
  const { status } = useSession();

  // Nothing renders until the server has said whether this browser is signed in.
  if (status === 'checking') return <div className="h-full bg-bg" aria-busy="true" />;

  // One shared login sits in front of everything.
  if (status === 'out') return <Login />;

  return (
    <div className="page-in h-full">
      <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/ask-bays" element={<AskBays />} />
        <Route path="/north-star" element={<NorthStar />} />
        <Route path="/research-twin" element={<ResearchTwin />} />
        <Route path="/vfarm" element={<VFarm />} />
        <Route path="/engine-health" element={<EngineHealth />} />
        <Route path="/open-loops" element={<OpenLoops />} />
        <Route path="/codex" element={<Codex />} />
        <Route path="/build-patterns" element={<BuildPatterns />} />
        <Route path="/commercial" element={<Commercial />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/builders" element={<Builders />} />
        <Route path="/builders/:id" element={<BuilderPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      </Routes>
    </div>
  );
}
