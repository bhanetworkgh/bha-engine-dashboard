import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useSession } from './app/session';
import Login from './screens/Login';
import Overview from './screens/Overview';
import AskBays from './screens/AskBays';
import { NorthStar, ResearchTwin } from './screens/Twin';
import VFarm from './screens/VFarm';
import EngineHealth from './screens/EngineHealth';
import OpenLoops from './screens/OpenLoops';
import Codex from './screens/Codex';
import BuildPatterns from './screens/BuildPatterns';
import Commercial from './screens/Commercial';
import { Builders, BuilderPage } from './screens/Builders';

export default function App() {
  const { token } = useSession();

  // One shared login sits in front of everything.
  if (!token) return <Login />;

  return (
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
        <Route path="/builders" element={<Builders />} />
        <Route path="/builders/:id" element={<BuilderPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
