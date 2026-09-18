/**
 * Reading this repository's own source, at runtime, from the deployed service.
 *
 * Everything the MCP server says about the app's structure is read from the
 * files in this checkout — never from a list written by hand, which would
 * drift the first time somebody moved a panel. Render clones the repo and runs
 * the build in place, so `src/` sits next to `server-dist/` on the live
 * service and the working directory is the repo root, the same assumption
 * index.ts already makes for `dist/`.
 *
 * If that assumption ever stops holding, every structure tool fails loudly
 * naming the path it looked in. A tool that cannot read the source must say so
 * rather than answer from anything else: a wrong answer about structure gets
 * acted on, which is worse than no answer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The repo root, on the same rule `dist` is resolved on. */
export const REPO_ROOT = path.resolve(process.cwd());

/** The one file whose presence proves the source tree came along. */
const SENTINEL = 'src/App.tsx';

/**
 * Every failure a tool reports. `code` is machine-readable so the caller can
 * tell "I asked for something that does not exist" from "this service cannot
 * see its own source".
 */
export class McpError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export function sourceAvailable(): boolean {
  return existsSync(path.join(REPO_ROOT, SENTINEL));
}

/** Throws with the path it looked in, so the answer is actionable rather than "unavailable". */
export function assertSource(): void {
  if (!sourceAvailable()) {
    throw new McpError(
      'source_unavailable',
      `This service cannot read its own source: ${SENTINEL} is not under ${REPO_ROOT}. Every structure tool reads the repository checkout at runtime, so nothing can be answered about the app's structure from here. Check that the deploy still runs from the repo root with src/ present.`,
    );
  }
}

/** Resolve a repo-relative path, refusing anything that escapes the repo. */
export function resolveInRepo(rel: string): string {
  const clean = rel.replace(/^\/+/, '');
  const abs = path.resolve(REPO_ROOT, clean);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
    throw new McpError('outside_repo', `"${rel}" resolves outside the repository, so it is not readable from here.`);
  }
  return abs;
}

export function toRepoRelative(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/* ------------------------------------------------------------- file reads */

interface Cached {
  mtimeMs: number;
  size: number;
  text: string;
  lineStarts: number[];
}

/**
 * Files are cached on mtime and size, because one `get_page_structure` call
 * reads the same screen and the same data module several times over. A deploy
 * replaces the checkout, so a stale entry cannot outlive the process it was
 * read in anyway.
 */
const cache = new Map<string, Cached>();

/** 2 MB. Nothing in this repo is close; a file above it is not source we can usefully return. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface SourceFile {
  /** Repo-relative, forward slashes, the way every answer cites a file. */
  rel: string;
  text: string;
  lines: number;
  /** Byte offset of the start of each line, for turning an index into a line number. */
  lineStarts: number[];
}

export function readSource(rel: string): SourceFile {
  const abs = resolveInRepo(rel);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new McpError('not_found', `No file at "${toRepoRelative(abs)}" in this checkout.`);
  }
  if (!st.isFile()) throw new McpError('not_found', `"${toRepoRelative(abs)}" is not a file.`);
  if (st.size > MAX_FILE_BYTES) {
    throw new McpError('too_large', `"${toRepoRelative(abs)}" is ${st.size} bytes, past the ${MAX_FILE_BYTES}-byte limit this reader accepts.`);
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { rel: toRepoRelative(abs), text: hit.text, lines: hit.lineStarts.length, lineStarts: hit.lineStarts };
  }
  const text = readFileSync(abs, 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text, lineStarts });
  return { rel: toRepoRelative(abs), text, lines: lineStarts.length, lineStarts };
}

/** The 1-based line a byte offset falls on. */
export function lineOf(file: SourceFile, index: number): number {
  let lo = 0;
  let hi = file.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (file.lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** One line, without its newline. */
export function lineText(file: SourceFile, line: number): string {
  const start = file.lineStarts[line - 1];
  if (start === undefined) return '';
  const end = file.lineStarts[line] ?? file.text.length;
  return file.text.slice(start, end).replace(/\r?\n$/, '');
}

/* --------------------------------------------------------------- the walk */

/**
 * Directories a source question is never about. `dist` and `server-dist` are
 * this repo's own build output — searching them would answer with a minified
 * copy of the file the caller actually wants.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'server-dist', '.cache', 'coverage', '.vite']);

/** Extensions worth reading as text. A grep through a font or a png is noise. */
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md', '.html', '.yaml', '.yml', '.txt', '.example', '.sql']);

export function walkFiles(limit = 20_000): string[] {
  const out: string[] = [];
  const stack: string[] = [REPO_ROOT];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
    } catch {
      continue;
    }
    for (const e of entries as unknown as { name: string; isDirectory(): boolean; isFile(): boolean }[]) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && e.name !== '.env.example') continue;
      out.push(toRepoRelative(path.join(dir, e.name)));
    }
  }
  return out.sort();
}

/* ---------------------------------------------------------------- globbing */

/**
 * A small glob, on purpose: `*` within a segment, `**` across segments, `?`,
 * and `{a,b}`. Enough for `src/screens/**` or `**\/*.tsx`, and nothing that
 * pretends to be a full matcher — a pattern this cannot express is refused by
 * name rather than quietly matching something else.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows the slash so `**/x.ts` also matches a top-level x.ts.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const parts = glob.slice(i + 1, end).split(',');
        out += `(?:${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
        continue;
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function filesMatching(glob: string | null | undefined): string[] {
  const all = walkFiles();
  if (!glob || !glob.trim()) return all;
  const re = globToRegExp(glob.trim());
  return all.filter((f) => re.test(f));
}

/* ------------------------------------------------------------------ grep */

export interface GrepHit {
  file: string;
  line: number;
  text: string;
  /** The lines either side, so a hit reads in context rather than alone. */
  before: string[];
  after: string[];
}

export interface GrepResult {
  query: string;
  glob: string | null;
  regex: boolean;
  files_searched: number;
  /** Every hit found, before paging. */
  total_hits: number;
  offset: number;
  hits: GrepHit[];
  truncated: boolean;
  note: string | null;
}

export interface GrepOptions {
  glob?: string | null;
  regex?: boolean;
  case_sensitive?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
}

export function grepSource(query: string, opts: GrepOptions = {}): GrepResult {
  assertSource();
  if (!query || !query.trim()) throw new McpError('bad_argument', 'A query is required. Pass a literal string, or set regex to true and pass a pattern.');
  const asRegex = Boolean(opts.regex);
  const context = Math.max(0, Math.min(10, opts.context ?? 2));
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  let re: RegExp;
  if (asRegex) {
    try {
      re = new RegExp(query, opts.case_sensitive ? '' : 'i');
    } catch (e) {
      throw new McpError('bad_argument', `That is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.case_sensitive ? '' : 'i');
  }

  const files = filesMatching(opts.glob);
  const hits: GrepHit[] = [];
  let total = 0;
  /** A hard stop so one broad pattern cannot walk the whole repo into memory. */
  const SCAN_CAP = 5000;

  for (const rel of files) {
    let file: SourceFile;
    try {
      file = readSource(rel);
    } catch {
      continue;
    }
    if (!re.test(file.text)) continue;
    for (let line = 1; line <= file.lines; line++) {
      const text = lineText(file, line);
      if (!re.test(text)) continue;
      total += 1;
      if (total > SCAN_CAP) break;
      if (total - 1 < offset || hits.length >= limit) continue;
      const before: string[] = [];
      for (let l = Math.max(1, line - context); l < line; l++) before.push(lineText(file, l));
      const after: string[] = [];
      for (let l = line + 1; l <= Math.min(file.lines, line + context); l++) after.push(lineText(file, l));
      hits.push({ file: rel, line, text, before, after });
    }
    if (total > SCAN_CAP) break;
  }

  const capped = total > SCAN_CAP;
  const truncated = capped || offset + hits.length < total;
  return {
    query,
    glob: opts.glob?.trim() || null,
    regex: asRegex,
    files_searched: files.length,
    total_hits: capped ? SCAN_CAP : total,
    offset,
    hits,
    truncated,
    note: truncated
      ? capped
        ? `Stopped after ${SCAN_CAP} matching lines — the pattern is too broad to answer completely. Narrow the query or pass a glob.`
        : `Showing ${hits.length} of ${total} matching lines, from offset ${offset}. Call again with offset ${offset + hits.length} for the rest.`
      : null,
  };
}
