import { useSession } from '../app/session';
import { useTheme, type ThemeChoice } from '../app/theme';
import { authMode, engineConfig, getBaysWiring, TEAM_EMAIL } from '../data';
import { Card, Icon, PageHeader, Segmented } from '../components/ui';

function Row({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default' | 'ok' | 'off' }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-[13.5px]">{label}</span>
      <span className={`text-[13px] ${tone === 'ok' ? 'text-ok' : tone === 'off' ? 'text-faint' : 'text-dim'}`}>{value}</span>
    </div>
  );
}

/** Appearance, the account, and what this deployment is connected to. */
export default function Settings() {
  const { session, signOut } = useSession();
  const { choice, setChoice } = useTheme();
  const wiring = getBaysWiring();
  const mode = authMode();
  const expires = session?.expires_at ? new Date(session.expires_at).toLocaleString() : 'when the tab closes';

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-8">
      <PageHeader title="Settings" subtitle="Appearance, the shared account, and what this dashboard is connected to." />
      <div className="mx-6 grid max-w-[760px] gap-4 md:mx-8">
        <Card className="p-5">
          <h2 className="mb-3 text-[15px]">Appearance</h2>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13.5px]">Theme</span>
            <Segmented<ThemeChoice>
              value={choice}
              onChange={setChoice}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              ariaLabel="Theme"
            />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[15px]">Account</h2>
          <div className="divide-y divide-line">
            <Row label="Signed in as" value={TEAM_EMAIL} />
            <Row label="Session ends" value={expires} />
            <Row label="Verified by" value={mode === 'engine' ? 'the engine login endpoint' : 'this browser, against the team credential'} />
          </div>
          <button type="button" onClick={signOut} className="btn mt-3 gap-2">
            <Icon.lock />
            Sign out
          </button>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[15px]">Connections</h2>
          <div className="divide-y divide-line">
            <Row label="Engine data endpoint" value={engineConfig.apiUrl ? 'Configured' : 'Not set · showing mock data'} tone={engineConfig.apiUrl ? 'ok' : 'off'} />
            <Row label="Bays front door" value={wiring.can_send ? 'Connected' : 'Not set'} tone={wiring.can_send ? 'ok' : 'off'} />
            <Row label="Bays answers" value={wiring.can_read_answers ? 'Readable' : 'No answer endpoint'} tone={wiring.can_read_answers ? 'ok' : 'off'} />
            <Row label="Bays model" value={engineConfig.baysModelLabel} />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-faint">{wiring.note}</p>
        </Card>
      </div>
    </div>
  );
}
