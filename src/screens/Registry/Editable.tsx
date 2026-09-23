import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui';

/**
 * Inline editing for the registry tables.
 *
 * Every cell on this page is editable in place: click it, type, press Enter or
 * click away. There is no edit mode and no form — the row *is* the form, which
 * is the only way a registry with eleven columns stays quick enough that people
 * actually keep it current.
 *
 * Two rules the cell holds so the page does not have to:
 *
 *   - **Empty is null, and null is a dash.** Clearing a cell means "nobody has
 *     filled this in", never an empty string masquerading as an answer. The
 *     placeholder reads as absence, not as a value.
 *   - **A rejected write reverts.** The server validates, and if it refuses,
 *     the cell goes back to what it was showing before rather than sitting
 *     there displaying something that was never saved.
 */

export type CellType = 'text' | 'longtext' | 'number' | 'date' | 'array' | 'select' | 'url';

export interface CellProps {
  value: unknown;
  type?: CellType;
  options?: readonly string[];
  placeholder?: string;
  /** Resolves when the server has taken it; rejects with the reason it did not. */
  onSave: (value: unknown) => Promise<unknown>;
  onError: (message: string) => void;
  align?: 'left' | 'right';
  /** How wide the cell may grow before it clips, in characters. */
  width?: string;
  /** Rendered instead of the plain value when there is one — a pill, a link. */
  render?: (value: unknown) => ReactNode;
  disabled?: boolean;
  /** Sits on the same line as whatever precedes it, rather than taking a row of its own. */
  inline?: boolean;
}

/** What the reader sees when a field has no value. Never blank, never zero. */
export const DASH = '—';

function toText(value: unknown, type: CellType): string {
  if (value === null || value === undefined) return '';
  if (type === 'array') return Array.isArray(value) ? value.join(', ') : String(value);
  return String(value);
}

function parse(text: string, type: CellType): unknown {
  const t = text.trim();
  if (!t) return null;
  if (type === 'array') return t.split(',').map((s) => s.trim()).filter(Boolean);
  if (type === 'number') {
    const n = Number(t.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return t;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export function EditableCell({
  value,
  type = 'text',
  options,
  placeholder,
  onSave,
  onError,
  align = 'left',
  width,
  render,
  disabled,
  inline,
}: CellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  // Escape must beat blur: both fire, and without this the blur would commit
  // the very draft Escape just threw away.
  const cancelled = useRef(false);

  useEffect(() => {
    if (editing && input.current) {
      input.current.focus();
      if ('select' in input.current && type !== 'date') input.current.select();
    }
  }, [editing, type]);

  function open() {
    if (disabled || busy) return;
    cancelled.current = false;
    setDraft(toText(value, type));
    setEditing(true);
  }

  async function commit(next: unknown) {
    setEditing(false);
    if (same(next, value ?? null)) return;
    setBusy(true);
    try {
      await onSave(next);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That change did not save.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const shared = {
      className: `input h-[26px] px-2 text-[12.5px] ${align === 'right' ? 'text-right' : ''}`,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          cancelled.current = true;
          setEditing(false);
        } else if (e.key === 'Enter' && type !== 'longtext') {
          e.preventDefault();
          void commit(parse(draft, type));
        }
      },
      onBlur: () => {
        if (cancelled.current) return;
        void commit(parse(draft, type));
      },
    };

    if (type === 'select' && options) {
      return (
        <select
          ref={input as React.Ref<HTMLSelectElement>}
          className="input h-[26px] px-2 text-[12.5px]"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            void commit(parse(e.target.value, type));
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              cancelled.current = true;
              setEditing(false);
            }
          }}
        >
          <option value="">{DASH} not set</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }

    if (type === 'longtext') {
      return (
        <textarea
          ref={input as React.Ref<HTMLTextAreaElement>}
          {...shared}
          className="input min-h-[54px] px-2 py-1 text-[12.5px]"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      );
    }

    return (
      <input
        ref={input as React.Ref<HTMLInputElement>}
        {...shared}
        type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
        step={type === 'number' ? 'any' : undefined}
        min={type === 'number' ? 0 : undefined}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }

  const text = toText(value, type);
  const empty = !text;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={open}
      title={disabled ? 'This field is not editable.' : empty ? `Not recorded. Click to add.` : text}
      // Only a cell that was given a width may clip: an ellipsis on a column
      // narrow enough to cut "active" down to "a…" tells the reader nothing,
      // and every short field here is short precisely so it can be read whole.
      className={`rounded-[6px] px-1 py-[3px] text-left transition-colors ${
        inline ? 'inline-block w-auto align-middle whitespace-nowrap' : width ? '-mx-1 block w-full truncate' : '-mx-1 block w-full whitespace-nowrap'
      } ${align === 'right' ? 'text-right' : ''} ${disabled ? 'cursor-default' : 'hover:bg-hover'} ${busy ? 'opacity-50' : ''}`}
      style={width ? { maxWidth: width } : undefined}
    >
      {empty ? (
        <span className="text-faint">{DASH}</span>
      ) : render ? (
        render(value)
      ) : (
        text
      )}
    </button>
  );
}

/**
 * The add-a-row form. One line of inputs above the table rather than a modal:
 * adding a workflow to the registry should cost about as much as typing its
 * name, or nobody does it and the registry drifts.
 */
export function NewRow({
  fields,
  onCreate,
  onError,
  label,
}: {
  fields: { name: string; label: string; type?: CellType; options?: readonly string[]; required?: boolean; placeholder?: string }[];
  onCreate: (values: Record<string, unknown>) => Promise<unknown>;
  onError: (message: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const values: Record<string, unknown> = {};
      for (const f of fields) values[f.name] = parse(draft[f.name] ?? '', f.type ?? 'text');
      await onCreate(values);
      setDraft({});
      setOpen(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : `The ${label} was not created.`);
    } finally {
      setBusy(false);
    }
  }

  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Add {article} {label}
      </Button>
    );
  }

  return (
    <div className="card mx-6 mb-4 px-5 py-4 md:mx-8">
      <div className="mb-3 text-[13px] font-medium text-ink">New {label}</div>
      <div className="flex flex-wrap items-end gap-3">
        {fields.map((f) => (
          <label key={f.name} className="min-w-[160px] flex-1">
            <span className="kicker mb-1 block">
              {f.label}
              {f.required && <span className="ml-1 text-degraded">required</span>}
            </span>
            {f.type === 'select' && f.options ? (
              <select className="input text-[12.5px]" value={draft[f.name] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}>
                <option value="">{DASH} not set</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input text-[12.5px]"
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                placeholder={f.placeholder}
                value={draft[f.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Create'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-snug text-faint">
        Anything left blank stays empty and shows as {DASH} — fill it in later rather than guessing now.
      </p>
    </div>
  );
}
