/**
 * The evidence store (2026-10-28, Destiny — D3).
 *
 * The documents the engine's decisions rest on, held here so Bays, Genie and the twins read the
 * same copy by name: an acceptance bundle, a live-payment proof, a test report. One record per
 * document, newest first, with what it proves, the gate or loop it belongs to, who wrote it and
 * when. Opening one shows its full text and a button for the original file.
 *
 * Read only. A document is saved by Bays ("save this into the evidence store") or on the
 * connector, and never edited: a correction is a new version, and the old one stays readable.
 */
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getEvidence, getEvidenceDoc } from '../data';
import type { EvidenceDoc, EvidenceRecord } from '../data';
import { ButtonAnchor, Button, LoadFailed, Loading, PageHeader, Pagination, Pill, RecordTable, SearchBox, usePaged, type RecordColumn } from '../components/ui';

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

function columns(): RecordColumn<EvidenceRecord>[] {
  return [
    { key: 'saved', header: 'saved', className: 'tabular text-faint', cell: (r) => when(r.saved_at) },
    {
      key: 'title',
      header: 'document',
      card: 'title',
      width: '44ch',
      clip: true,
      title: (r) => `${r.title} — ${r.proves}`,
      cell: (r) => (
        <span>
          {r.title}
          {r.version > 1 && <span className="ml-2 text-faint">v{r.version}</span>}
          {r.test && (
            <span className="ml-2">
              <Pill>test</Pill>
            </span>
          )}
        </span>
      ),
    },
    { key: 'proves', header: 'proves', card: 'meta', width: '48ch', clip: true, title: (r) => r.proves, cell: (r) => <span className="text-dim">{r.proves}</span> },
    { key: 'gate', header: 'gate or loop', card: 'meta', cell: (r) => (r.gate || r.loop_id ? <span className="tabular">{[r.gate, r.loop_id].filter(Boolean).join(' · ')}</span> : <span className="text-faint">none named</span>) },
    { key: 'author', header: 'written by', card: 'meta', cell: (r) => r.author_name ?? r.author_id },
    { key: 'id', header: 'id', className: 'tabular text-faint', cell: (r) => r.evidence_id },
  ];
}

function EvidenceDialog({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [doc, setDoc] = useState<EvidenceDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setErr(null);
    getEvidenceDoc(id)
      .then((r) => live && setDoc(r))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : 'The document could not be read.'));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[920px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Evidence">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">
              {id}
              {doc ? ` · ${doc.name} v${doc.version}` : ''}
            </div>
            <h2 className="mt-1 text-[18px] leading-tight">{doc ? doc.title : err ? 'Evidence' : 'Loading the document…'}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {doc && (
              <ButtonAnchor variant="secondary" size="sm" href={doc.file_url}>
                Download the original
              </ButtonAnchor>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        {err && <div className="mt-4 text-[13px] text-dim">{err}</div>}
        {doc && (
          <>
            {doc.superseded_by && (
              <div className="mt-3 text-[13px] text-dim">
                A newer version exists:{' '}
                <button className="text-accent hover:underline" onClick={() => onOpen(doc.superseded_by as string)}>
                  {doc.superseded_by}
                </button>
                . This one stays as it was, because a decision may rest on it.
              </div>
            )}
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] md:grid-cols-[140px_1fr]">
              <dt className="text-faint">Proves</dt>
              <dd>{doc.proves}</dd>
              <dt className="text-faint">Gate</dt>
              <dd>{doc.gate ?? <span className="text-faint">none named</span>}</dd>
              <dt className="text-faint">Loop</dt>
              <dd className="tabular">{doc.loop_id ?? <span className="text-faint">none named</span>}</dd>
              <dt className="text-faint">Written by</dt>
              <dd>
                {doc.author_name ?? doc.author_id}
                {doc.written_at && <span className="text-faint">, {day(doc.written_at)}</span>}
              </dd>
              <dt className="text-faint">Saved</dt>
              <dd>
                {when(doc.saved_at)} by {doc.saved_by_name ?? doc.saved_by}
              </dd>
              <dt className="text-faint">File</dt>
              <dd>
                {doc.file_name} <span className="text-faint">({size(doc.file_size)}, {doc.text_chars.toLocaleString()} characters of text)</span>
              </dd>
              <dt className="text-faint">Source</dt>
              <dd className="break-all">
                {doc.source_ref && /^https:\/\//.test(doc.source_ref) ? (
                  <a href={doc.source_ref} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    the file in Slack ↗
                  </a>
                ) : (
                  doc.source_ref ?? <span className="text-faint">the text was handed over directly</span>
                )}
              </dd>
              {doc.versions.length > 1 && (
                <>
                  <dt className="text-faint">Versions</dt>
                  <dd className="flex flex-wrap gap-x-3">
                    {doc.versions.map((v) =>
                      v.evidence_id === doc.evidence_id ? (
                        <span key={v.evidence_id} className="tabular">
                          v{v.version} (this one)
                        </span>
                      ) : (
                        <button key={v.evidence_id} className="tabular text-accent hover:underline" onClick={() => onOpen(v.evidence_id)}>
                          v{v.version}
                        </button>
                      ),
                    )}
                  </dd>
                </>
              )}
              {doc.notes && (
                <>
                  <dt className="text-faint">Notes</dt>
                  <dd>{doc.notes}</dd>
                </>
              )}
              <dt className="text-faint">File hash</dt>
              <dd className="tabular break-all text-faint">sha256 {doc.file_sha256}</dd>
            </dl>
            <div className="mt-4 border-t border-line pt-4">
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{doc.text}</div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default function Evidence() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('doc');
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('doc', id);
    else next.delete('doc');
    setParams(next, { replace: true });
  };
  const { status, data, error } = useData(getEvidence, [], { kinds: ['evidence'] });
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.records ?? [];
    return needle
      ? all.filter((r) => [r.title, r.name, r.proves, r.gate ?? '', r.loop_id ?? '', r.evidence_id, r.author_name ?? ''].some((v) => v.toLowerCase().includes(needle)))
      : all;
  }, [data, q]);
  const paged = usePaged(rows, q.trim());

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Evidence store"
        subtitle="The documents the engine's decisions rest on, held once so Bays, Genie and the twins read the same copy by name. Never edited: a correction is a new version."
      />
      {status === 'error' && !data ? (
        <LoadFailed error={error ?? 'The evidence store could not be read.'} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-faint">
                <span className="text-ink">{data.total}</span> {data.total === 1 ? 'document' : 'documents'}, the newest version of each. Saved by Bays (&ldquo;save this into the evidence store&rdquo; on a file in Slack) or on the connector.
              </p>
              <SearchBox value={q} onChange={setQ} placeholder="Search evidence" />
            </div>
          </div>
          <RecordTable
            columns={columns()}
            rows={paged.rows}
            rowKey={(r) => r.evidence_id}
            onOpen={(r) => setOpenId(r.evidence_id)}
            label="Evidence"
            empty={q.trim() ? 'No document matches that search.' : 'No document has been saved into the evidence store yet.'}
          />
          {rows.length > 0 && <Pagination paged={paged} unit="documents" />}
        </div>
      )}
      {openId && <EvidenceDialog id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />}
    </div>
  );
}
