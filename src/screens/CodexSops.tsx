/**
 * The SOPs tab on Codex (2026-10-13, Destiny).
 *
 * Every SOP the twins read, straight from BHARAG's codex workspace, where Bays
 * writes them ("SOP -- …"). Nothing is copied into this dashboard: the server
 * walks the workspace (held five minutes) and this tab lists what it found,
 * newest first. A read that could not reach every page says so, because a list
 * that silently stopped early would look complete. Read only.
 */
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import type { SopDoc, SopRow, SopsData } from '../data';
import { Button, LoadFailed, Loading, Pagination, Pill, RecordTable, SearchBox, usePaged, type RecordColumn } from '../components/ui';

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** "SOP -- Title" reads as "Title" in the list; the full title is in the panel. */
function shortTitle(t: string): string {
  return t.replace(/^\s*SOP\s*[-–—:]+\s*/i, '').trim() || t;
}

function columns(): RecordColumn<SopRow>[] {
  return [
    { key: 'date', header: 'logged', className: 'tabular text-faint', cell: (s) => when(s.created_at) },
    {
      key: 'title',
      header: 'sop',
      card: 'title',
      width: '70ch',
      clip: true,
      title: (s) => s.title,
      cell: (s) => shortTitle(s.title),
    },
    {
      key: 'copies',
      header: 'copies',
      card: 'meta',
      cell: (s) =>
        s.same_title > 1 ? (
          <span title="More than one SOP in BHARAG carries this exact title.">
            <Pill>{s.same_title} with this title</Pill>
          </span>
        ) : (
          <span className="text-faint">one</span>
        ),
    },
    {
      key: 'source',
      header: 'source',
      card: 'meta',
      cell: (s) =>
        s.source_link ? (
          <a href={s.source_link} target="_blank" rel="noreferrer" className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
            thread ↗
          </a>
        ) : (
          <span className="text-faint">not recorded</span>
        ),
    },
  ];
}

function SopDialog({ id, onClose, getSop }: { id: string; onClose: () => void; getSop: (id: string) => Promise<SopDoc> }) {
  const [doc, setDoc] = useState<SopDoc['sop'] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setErr(null);
    getSop(id)
      .then((r) => live && setDoc(r.sop))
      .catch((e: unknown) => {
        if (live) setErr(e instanceof Error ? e.message : 'The SOP could not be read.');
      });
    return () => {
      live = false;
    };
  }, [id, getSop]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="SOP">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">BHARAG {id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{doc ? shortTitle(doc.title) : err ? 'SOP' : 'Loading the SOP…'}</h2>
            {doc && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                <span className="tabular">logged {when(doc.created_at)}</span>
                {doc.requested_by && <span>asked by {doc.requested_by}</span>}
                {doc.source_link && (
                  <a href={doc.source_link} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    source thread ↗
                  </a>
                )}
                {doc.status && <span>BHARAG: {doc.status}</span>}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {err && <div className="mt-4 text-[13px] text-dim">{err}</div>}
        {doc && (
          <div className="mt-4 border-t border-line pt-4">
            {doc.content ? (
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{doc.content}</div>
            ) : (
              <div className="text-[13px] text-faint">BHARAG returned this SOP without its text.</div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The two reads are handed in by Codex.tsx, the page file, so the dashboard's
 * own page-structure reader (which reads the page's file for its data calls)
 * lists `/api/sops` as one of this page's routes.
 */
export default function CodexSops({
  openId,
  setOpenId,
  getSops,
  getSop,
}: {
  openId: string | null;
  setOpenId: (id: string | null) => void;
  getSops: (fresh?: boolean) => Promise<SopsData>;
  getSop: (id: string) => Promise<SopDoc>;
}) {
  const [data, setData] = useState<SopsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  async function load(fresh: boolean) {
    setBusy(true);
    try {
      setData(await getSops(fresh));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(false);
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.sops ?? [];
    return needle ? all.filter((s) => s.title.toLowerCase().includes(needle) || s.id.startsWith(needle)) : all;
  }, [data, q]);
  const paged = usePaged(rows, q.trim());

  if (error && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  const copies = data.sops.filter((s) => s.same_title > 1).length;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 space-y-3 px-6 pt-4 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-faint">
            {data.ok ? (
              <>
                <span className="text-ink">{data.sops.length}</span> {data.sops.length === 1 ? 'SOP' : 'SOPs'} in BHARAG&rsquo;s codex workspace, read {ago(data.read_at)} from {data.documents_scanned} documents.
                {copies > 0 && ` ${copies} share a title with another SOP.`}
              </>
            ) : (
              <span className="text-failing">{data.error}</span>
            )}
          </p>
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void load(true)}>
            Read BHARAG again
          </Button>
        </div>
        {data.note && <p className="text-[12px] text-degraded">{data.note}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Search SOPs" />
        </div>
      </div>
      <RecordTable
        columns={columns()}
        rows={paged.rows}
        rowKey={(s) => s.id}
        onOpen={(s) => setOpenId(s.id)}
        label="SOPs"
        empty={!data.ok ? 'BHARAG could not be read, so no SOPs are listed.' : q.trim() ? 'No SOP matches that search.' : 'BHARAG holds no document titled "SOP" in the codex workspace.'}
      />
      {rows.length > 0 && <Pagination paged={paged} unit="SOPs" />}
      {openId && <SopDialog id={openId} onClose={() => setOpenId(null)} getSop={getSop} />}
    </div>
  );
}
