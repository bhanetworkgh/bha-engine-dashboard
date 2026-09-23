import { useSession } from '../app/session';
import { useData } from '../app/useData';
import { useTheme, type ThemeChoice } from '../app/theme';
import { useZoom, ZOOMS, type ZoomChoice } from '../app/zoom';
import { getServerStatus, TEAM_EMAIL } from '../data';
import { PageHeader, Button, Card, Icon, Segmented } from '../components/ui';

function Row({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default' | 'ok' | 'off' }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-[13.5px]">{label}</span>
      <span className={`text-right text-[13px] ${tone === 'ok' ? 'text-ok' : tone === 'off' ? 'text-faint' : 'text-dim'}`}>{value}</span>
    </div>
  );
}

/** Appearance, the account, and what the server behind this dashboard is connected to. */
export default function Settings() {
  const { session, signOut } = useSession();
  const { choice, setChoice } = useTheme();
  const { zoom, setZoom } = useZoom();
  const server = useData(() => getServerStatus());
  const expires = session?.expires_at ? new Date(session.expires_at).toLocaleString() : 'unknown';
  const s = server.data;

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
          {/*
            Interface size (2026-09-16, Destiny). It opens at 80% because that
            is where this dashboard reads best — more of a table on screen, the
            sidebar whole, cards in three columns. The note says the one thing
            that surprises people: this multiplies with the browser's own zoom.
          */}
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-[13.5px]">Interface size</span>
            <Segmented<ZoomChoice>
              value={zoom}
              onChange={setZoom}
              options={ZOOMS.map((z) => ({ value: z, label: `${z}%` }))}
              ariaLabel="Interface size"
            />
          </div>
          <p className="mt-2 text-[11.5px] leading-snug text-faint">
            This is the dashboard's own scale and it multiplies with the browser's zoom, so a browser already at 80% lands at 64%.
            Set the browser back to 100% and leave this at 80%.
          </p>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[15px]">Account</h2>
          <div className="divide-y divide-line">
            <Row label="Signed in as" value={session?.email ?? TEAM_EMAIL} />
            <Row label="Session ends" value={expires} />
            <Row label="Verified by" value="the dashboard server, with a cookie this browser cannot read" />
          </div>
          <Button onClick={signOut} className="mt-3 gap-2">
            <Icon.lock />
            Sign out
          </Button>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[15px]">Server</h2>
          {server.status === 'loading' && <p className="py-3 text-[12.5px] text-faint">Asking the server what it is connected to.</p>}
          {server.status === 'error' && <p className="py-3 text-[12.5px] text-failing">{server.error}</p>}
          {s && (
            <>
              <div className="divide-y divide-line">
                <Row label="Sign-in credential" value={s.auth_configured ? 'Set on the server' : 'Not set'} tone={s.auth_configured ? 'ok' : 'off'} />
                <Row
                  label="Session signing key"
                  value={s.session_secret_configured ? 'Set' : 'Random each boot · sessions end on restart'}
                  tone={s.session_secret_configured ? 'ok' : 'off'}
                />
                <Row label="Ask Bays" value={s.ask_bays_configured ? 'Connected' : 'No API key on the server'} tone={s.ask_bays_configured ? 'ok' : 'off'} />
                <Row label="Bays workflow" value={<span className="break-all">{s.ask_bays_url}</span>} />
                <Row label="Bays model" value={s.model_label} />
                <Row
                  label="Engine writes"
                  value={s.inbound_configured ? 'Key set · the engine can write to /api/engine' : 'No DASHBOARD_INBOUND_KEY · nothing can reach the record tables'}
                  tone={s.inbound_configured ? 'ok' : 'off'}
                />
                <Row label="Records editable here" value={s.writable.join(' · ')} />
                <Row label="Incidents, twins, vFarm, builders" value="Phase 1 fixtures, served by this server" tone="off" />
                <Row label="Status history since" value={s.history_since ? new Date(s.history_since).toLocaleString() : 'not started'} />
                <Row
                  label="Records held"
                  value={Object.entries(s.records_held)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(' · ')}
                />
                <Row label="Server started" value={new Date(s.started_at).toLocaleString()} />
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-faint">
                The engine's API key and the sign-in credential live in the server's environment. This page only says whether each is set; it never
                shows a value.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
