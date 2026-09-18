/**
 * Everything the MCP server knows about the app's shape, derived from source.
 *
 * Nothing in this file is a list of pages, panels or sources typed by hand.
 * The routes come out of `src/App.tsx`, the sidebar labels out of
 * `src/components/Layout.tsx`, a page's title and its one-line purpose out of
 * that page's own `PageHeader` (falling back to the spec in `CLAUDE.md`), a
 * page's data out of `src/data/index.ts`, and the external sources out of
 * `sources.ts` and `mirror.ts` as this process actually holds them.
 *
 * That is the whole point. A hand-written map of the interface would be right
 * on the day it was written and wrong by the next commit, and a reader acting
 * on it would not be able to tell. Where a fact cannot be derived, it is
 * reported as null with the reason beside it rather than filled in.
 */
import { lineOf, lineText, McpError, readSource, walkFiles, type SourceFile } from './source';
import { scanJsx, type JsxNode } from './jsx';
import * as sources from '../sources';
import * as mirror from '../mirror';
import * as store from '../store';
import * as bharag from '../bharag';
import * as n8n from '../n8n';
import * as db from '../pg';

const APP = 'src/App.tsx';
const LAYOUT = 'src/components/Layout.tsx';
const DATA_MODULE = 'src/data/index.ts';
const SPEC = 'CLAUDE.md';

/* ------------------------------------------------------- declaration index */

export interface Declaration {
  name: string;
  file: string;
  line: number;
  /** Byte range of the declaration in its file, for scanning just this component. */
  start: number;
  end: number;
  kind: 'function' | 'const' | 'default';
  exported: boolean;
}

/**
 * Where a name is declared, across every source file in the repo.
 *
 * Built by matching top-level declarations, which is why it finds a component
 * wherever it lives without following barrel files — `src/components/ui`
 * re-exports twenty modules with `export *`, and chasing those would answer
 * "the component is in index.ts", which is true and useless.
 */
let declIndex: Map<string, Declaration[]> | null = null;

const DECL_PATTERNS: { re: RegExp; kind: Declaration['kind'] }[] = [
  { re: /^export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm, kind: 'default' },
  { re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm, kind: 'function' },
  { re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm, kind: 'function' },
  { re: /^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/gm, kind: 'const' },
  { re: /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/gm, kind: 'const' },
];

/**
 * Index just past the end of the declaration starting at `from`.
 *
 * Bracket depth alone is not enough: `function f(a, b) { ... }` returns to
 * depth nought at the `)` of its parameter list, which is how an earlier
 * version of this answered with the signature line and no body. So when depth
 * comes back to nought it looks ahead: `{`, `=>` or `:` means the declaration
 * carries on, anything else ends it.
 */
function spanEnd(text: string, from: number): number {
  let i = from;
  let depth = 0;
  let opened = false;
  const skipTrivia = (at: number): number => {
    let j = at;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '/' && text[j + 1] === '/') {
        const nl = text.indexOf('\n', j);
        j = nl < 0 ? text.length : nl + 1;
        continue;
      }
      if (text[j] === '/' && text[j + 1] === '*') {
        const e = text.indexOf('*/', j + 2);
        j = e < 0 ? text.length : e + 2;
        continue;
      }
      return j;
    }
  };
  const endOfLine = (at: number): number => {
    const nl = text.indexOf('\n', at);
    return nl < 0 ? text.length : nl;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n') break;
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') {
      depth += 1;
      opened = true;
      i++;
      continue;
    }
    if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      i++;
      if (opened && depth <= 0) {
        const next = skipTrivia(i);
        const ahead = text.slice(next, next + 2);
        // The body, a return type, or an arrow still to come.
        if (ahead[0] === '{' || ahead[0] === ':' || ahead === '=>') continue;
        return endOfLine(i);
      }
      continue;
    }
    // A declaration with no brackets at all: `const X = 3;`
    if (c === '\n' && !opened) return i;
    i++;
  }
  return text.length;
}

function indexFile(file: SourceFile, into: Map<string, Declaration[]>): void {
  const seen = new Set<string>();
  for (const { re, kind } of DECL_PATTERNS) {
    re.lastIndex = 0;
    for (const m of file.text.matchAll(re)) {
      const name = m[1];
      const start = m.index ?? 0;
      const key = `${name}@${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = into.get(name) ?? [];
      // The same declaration matched by two patterns (export function / function).
      if (list.some((d) => d.file === file.rel && d.start === start)) continue;
      list.push({
        name,
        file: file.rel,
        line: lineOf(file, start),
        start,
        end: spanEnd(file.text, start),
        kind,
        exported: m[0].startsWith('export'),
      });
      into.set(name, list);
    }
  }
}

export function declarations(): Map<string, Declaration[]> {
  if (declIndex) return declIndex;
  const map = new Map<string, Declaration[]>();
  for (const rel of walkFiles()) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    if (!rel.startsWith('src/') && !rel.startsWith('server/src/')) continue;
    try {
      indexFile(readSource(rel), map);
    } catch {
      continue;
    }
  }
  declIndex = map;
  return map;
}

/** The declarations of a name, closest first: the asking file, then src/, then the rest. */
export function declarationsOf(name: string, preferFile?: string): Declaration[] {
  const all = declarations().get(name) ?? [];
  const rank = (d: Declaration): number => {
    if (preferFile && d.file === preferFile) return 0;
    if (d.file.startsWith('src/components/')) return 1;
    if (d.file.startsWith('src/screens/')) return 2;
    if (d.file.startsWith('src/')) return 3;
    return 4;
  };
  return [...all].sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.start - b.start);
}

/* --------------------------------------------------- resolving a component */

export interface Resolved {
  declaration: Declaration | null;
  /** How it was resolved, so a reader can check the answer. */
  via: 'local' | 'import' | 'unresolved';
  /** The import specifier, when it came in from somewhere. */
  from: string | null;
  /** Set when the name is declared in more than one place and nothing picks between them. */
  ambiguous: string[] | null;
  note: string | null;
}

/**
 * Where the `<Name />` written in `inFile` is actually declared.
 *
 * Resolved through that file's own import, never by picking the likeliest
 * declaration with the same name. `LaneView` is declared in both
 * `src/screens/Clients.tsx` and `src/screens/EngineHealth/LaneView.tsx`, and a
 * ranked guess put Engine health's panel in the Clients file — a wrong answer
 * about structure, which is the one thing these tools must not produce. Where
 * the import cannot be followed the answer is null with the candidates named.
 */
export function resolveComponent(name: string, inFile: string): Resolved {
  const root = name.split('.')[0];
  let file: SourceFile;
  try {
    file = readSource(inFile);
  } catch {
    return { declaration: null, via: 'unresolved', from: null, ambiguous: null, note: `${inFile} could not be read.` };
  }
  const local = (declarations().get(root) ?? []).filter((d) => d.file === inFile);
  if (local.length) return { declaration: local[0], via: 'local', from: null, ambiguous: null, note: null };

  const binding = importsOf(file).find((b) => b.local === root);
  if (!binding) {
    const all = declarations().get(root) ?? [];
    return {
      declaration: null,
      via: 'unresolved',
      from: null,
      ambiguous: all.length ? all.map((d) => `${d.file}:${d.line}`) : null,
      note: `<${name}> is used in ${inFile} but nothing imports or declares that name there, so where it comes from cannot be read from source.`,
    };
  }
  if (!binding.resolved) {
    return { declaration: null, via: 'import', from: binding.from, ambiguous: null, note: `Comes from the package "${binding.from}", which is not in this repository.` };
  }
  const found = followExport(binding.resolved, binding.imported === 'default' ? root : binding.imported, new Set());
  if (found) return { declaration: found, via: 'import', from: binding.from, ambiguous: null, note: null };
  const all = declarations().get(root) ?? [];
  return {
    declaration: null,
    via: 'import',
    from: binding.from,
    ambiguous: all.length ? all.map((d) => `${d.file}:${d.line}`) : null,
    note: `Imported from "${binding.from}" (${binding.resolved}), but no declaration of "${binding.imported}" was found there or in what it re-exports.`,
  };
}

/**
 * A declaration in `rel`, or in whatever `rel` re-exports it from.
 *
 * `seen` guards against a cycle and nothing else — it used to double as a
 * breadth limit, which meant the twenty-third `export *` in
 * `src/components/ui/index.ts` was never followed and every component declared
 * in `Figures.tsx` came back unresolved. Depth is what is capped.
 */
function followExport(rel: string, name: string, seen: Set<string>, depth = 0): Declaration | null {
  if (seen.has(rel) || depth > 6) return null;
  seen.add(rel);
  let file: SourceFile;
  try {
    file = readSource(rel);
  } catch {
    return null;
  }
  const here = (declarations().get(name) ?? []).filter((d) => d.file === rel);
  if (here.length) return here[0];
  // A default export that re-exports a differently named declaration.
  const def = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;/m.exec(file.text);
  if (def) {
    const d = (declarations().get(def[1]) ?? []).filter((x) => x.file === rel);
    if (d.length) return d[0];
  }
  for (const m of file.text.matchAll(/^export\s+(?:\*|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/gm)) {
    const names = m[1];
    const spec = m[2];
    if (names) {
      const wanted = names.split(',').map((t) => t.trim()).some((t) => {
        const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
        return as ? as[2] === name : t === name || t === `type ${name}`;
      });
      if (!wanted) continue;
    }
    const target = resolveSpecifier(rel, spec);
    if (!target) continue;
    const hit = followExport(target, name, seen, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ imports */

export interface ImportBinding {
  local: string;
  imported: string;
  from: string;
  /** Repo-relative file the specifier resolves to, or null when it is a package. */
  resolved: string | null;
  lazy: boolean;
  line: number;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = `${dir}/${spec}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  const base = out.join('/');
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    try {
      readSource(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function importsOf(file: SourceFile): ImportBinding[] {
  const out: ImportBinding[] = [];
  const push = (local: string, imported: string, from: string, lazy: boolean, at: number) => {
    out.push({ local, imported, from, resolved: resolveSpecifier(file.rel, from), lazy, line: lineOf(file, at) });
  };
  // import Default, { a, b as c } from 'x';  /  import * as ns from 'x';
  for (const m of file.text.matchAll(/^import\s+(type\s+)?([^;]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue; // `import type` brings no value binding.
    const clause = m[2];
    const from = m[3];
    const at = m.index ?? 0;
    const named = /\{([^}]*)\}/.exec(clause);
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,\s*$/, '').trim();
    if (head && !head.startsWith('*')) push(head, 'default', from, false, at);
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(head);
    if (ns) push(ns[1], '*', from, false, at);
    if (named) {
      for (const part of named[1].split(',')) {
        const t = part.trim();
        if (!t || t.startsWith('type ')) continue;
        const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
        if (as) push(as[2], as[1], from, false, at);
        else push(t, t, from, false, at);
      }
    }
  }
  // const X = lazy(() => import('./screens/X'));
  for (const m of file.text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g)) {
    push(m[1], 'default', m[2], true, m.index ?? 0);
  }
  return out;
}

/* ------------------------------------------------------------------- routes */

export interface RouteInfo {
  path: string;
  /** The component the route renders, after the Suspense/Loading wrapper is set aside. */
  element: string | null;
  /** Everything named in the element expression, in order, unfiltered. */
  element_expression: string;
  wrappers: string[];
  file: string | null;
  lazy: boolean;
  declared_at: string;
  redirect_to: string | null;
}

/** Components in a route's element that wrap the page rather than being it. */
const ROUTE_WRAPPERS = new Set(['Suspense', 'Loading', 'Fragment']);

function collectRoutes(nodes: JsxNode[], out: JsxNode[] = []): JsxNode[] {
  for (const n of nodes) {
    if (n.component === 'Route') out.push(n);
    collectRoutes(n.children, out);
  }
  return out;
}

export function routes(): RouteInfo[] {
  const file = readSource(APP);
  const scan = scanJsx(file);
  if (scan.warnings.length) {
    throw new McpError('unparsed_router', `${APP} could not be read cleanly, so the route list cannot be trusted: ${scan.warnings.join(' ')}`);
  }
  const binds = new Map(importsOf(file).map((b) => [b.local, b]));
  const out: RouteInfo[] = [];
  for (const node of collectRoutes(scan.nodes)) {
    const pathProp = node.props.find((p) => p.name === 'path');
    if (!pathProp) continue; // The layout route, which carries no path of its own.
    const elementProp = node.props.find((p) => p.name === 'element');
    const expr = elementProp?.value ?? '';
    const named = [...expr.matchAll(/<([A-Z][A-Za-z0-9_.]*)/g)].map((m) => m[1]);
    const wrappers = named.filter((n) => ROUTE_WRAPPERS.has(n));
    const element = named.find((n) => !ROUTE_WRAPPERS.has(n)) ?? null;
    const redirect = element === 'Navigate' ? (/to=["']([^"']+)["']/.exec(expr)?.[1] ?? null) : null;
    const bind = element ? binds.get(element) : undefined;
    out.push({
      path: pathProp.value,
      element,
      element_expression: expr,
      wrappers,
      file: bind?.resolved ?? null,
      lazy: Boolean(bind?.lazy),
      declared_at: `${APP}:${node.line}`,
      redirect_to: redirect,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- the sidebar */

export interface NavItem {
  to: string;
  label: string;
  group: string | null;
  declared_at: string;
}

/**
 * The sidebar, read from the one array that draws it. Group headings are the
 * `group:` keys in the same literal, so an item's section is the section it is
 * actually rendered under.
 */
export function nav(): NavItem[] {
  const file = readSource(LAYOUT);
  const out: NavItem[] = [];
  let group: string | null = null;
  for (let line = 1; line <= file.lines; line++) {
    const text = lineText(file, line);
    const g = /^\s*group:\s*(null|'([^']*)'|"([^"]*)")/.exec(text);
    if (g) {
      group = g[1] === 'null' ? null : (g[2] ?? g[3] ?? null);
      continue;
    }
    const m = /to:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/.exec(text);
    if (m) out.push({ to: m[1], label: m[2], group, declared_at: `${LAYOUT}:${line}` });
  }
  return out;
}

/* ------------------------------------------------------- the spec's own words */

function normaliseHeading(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The first sentence of the section CLAUDE.md gives a page, matched on the
 * page's sidebar label or its component name.
 *
 * This is the repo's own standing spec for the screen, so it is a real source
 * for "what is this page for" rather than a sentence composed here. Headings
 * that name several pages at once — "Media Twin, Genie and vFarm" — are split,
 * so each one matches its own page.
 */
function specSections(): Map<string, { text: string; line: number }> {
  const out = new Map<string, { text: string; line: number }>();
  let file: SourceFile;
  try {
    file = readSource(SPEC);
  } catch {
    return out;
  }
  const headings: { keys: string[]; line: number }[] = [];
  for (let line = 1; line <= file.lines; line++) {
    const m = /^###\s+(.+?)\s*$/.exec(lineText(file, line));
    if (!m) continue;
    const keys = m[1]
      .split(/\s*(?:\/|,| · |\band\b)\s*/)
      .map((p) => normaliseHeading(p))
      .filter(Boolean);
    headings.push({ keys, line });
  }
  for (let h = 0; h < headings.length; h++) {
    const from = headings[h].line + 1;
    const to = h + 1 < headings.length ? headings[h + 1].line - 1 : file.lines;
    const para: string[] = [];
    for (let line = from; line <= to; line++) {
      const t = lineText(file, line).trim();
      if (!t) {
        if (para.length) break;
        continue;
      }
      if (t.startsWith('#') || t.startsWith('---')) break;
      para.push(t);
    }
    if (!para.length) continue;
    const joined = para.join(' ').replace(/\*\*/g, '').replace(/`/g, '');
    const sentence = /^(.+?[.:])(\s|$)/.exec(joined)?.[1] ?? joined;
    for (const key of headings[h].keys) if (!out.has(key)) out.set(key, { text: sentence, line: headings[h].line });
  }
  return out;
}

/* ------------------------------------------------------------- the data module */

export interface DataFunction {
  name: string;
  method: string;
  /** The route as written. A template with a `${}` in it cannot be called without filling it. */
  path: string;
  /** The part before the first `${`, which is the route as the server registers it. */
  path_prefix: string;
  parameterised: boolean;
  declared_at: string;
}

/**
 * The contents of the string or template literal starting at `i`, and where it
 * ends. Templates nest — `/api/x${a ? `?b=${c}` : ''}` has a backtick inside a
 * backtick — so this counts them rather than stopping at the first one it sees,
 * which is how a route once came back cut off mid-expression.
 */
function readLiteral(text: string, i: number): { value: string; end: number } | null {
  const q = text[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let j = i + 1;
  let depth = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (q === '`') {
      if (c === '`' && depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
      if (c === '$' && text[j + 1] === '{') {
        depth += 1;
        j += 2;
        continue;
      }
      if (c === '`' && depth > 0) {
        // A template nested inside an interpolation: skip it whole.
        const inner = readLiteral(text, j);
        j = inner ? inner.end : j + 1;
        continue;
      }
      if (c === '}' && depth > 0) {
        depth -= 1;
        j++;
        continue;
      }
      j++;
      continue;
    }
    if (c === q) return { value: text.slice(i + 1, j), end: j + 1 };
    if (c === '\n') return null;
    j++;
  }
  return null;
}

let dataFns: Map<string, DataFunction> | null = null;

export function dataFunctions(): Map<string, DataFunction> {
  if (dataFns) return dataFns;
  const file = readSource(DATA_MODULE);
  const out = new Map<string, DataFunction>();
  for (const [name, decls] of declarations()) {
    const here = decls.filter((d) => d.file === DATA_MODULE);
    if (!here.length) continue;
    for (const d of here) {
      const body = file.text.slice(d.start, d.end);
      const call = /\bapi<[^>]*>\(|\bapi\(/.exec(body);
      if (!call) continue;
      const after = body.slice((call.index ?? 0) + call[0].length);
      const lead = /^[\s(]*(?:withLane\(\s*)?/.exec(after)?.[0].length ?? 0;
      const lit = readLiteral(after, lead);
      if (!lit) continue;
      const path = lit.value;
      const method = /method:\s*'([A-Z]+)'/.exec(body)?.[1] ?? 'GET';
      out.set(name, {
        name,
        method,
        path,
        path_prefix: path.split('${')[0],
        parameterised: path.includes('${'),
        declared_at: `${DATA_MODULE}:${d.line}`,
      });
      break;
    }
  }
  dataFns = out;
  return out;
}

/* --------------------------------------------------------------- pages */

export interface PageInfo {
  path: string;
  title: string | null;
  title_source: string | null;
  description: string | null;
  description_source: string | null;
  sidebar_label: string | null;
  sidebar_group: string | null;
  component: string | null;
  file: string | null;
  lazy: boolean;
  route_declared_at: string;
  redirect_to: string | null;
  note: string | null;
}

/** The PageHeader a screen opens with, wherever in its files it sits. */
function pageHeader(files: string[]): { title: string | null; subtitle: string | null; at: string | null } {
  for (const rel of files) {
    let file: SourceFile;
    try {
      file = readSource(rel);
    } catch {
      continue;
    }
    if (!file.text.includes('PageHeader')) continue;
    const found = findNode(scanJsx(file).nodes, (n) => n.component === 'PageHeader');
    if (!found) continue;
    const title = found.props.find((p) => p.name === 'title');
    const subtitle = found.props.find((p) => p.name === 'subtitle');
    return {
      title: title ? title.value : null,
      subtitle: subtitle ? subtitle.value : null,
      at: `${rel}:${found.line}`,
    };
  }
  return { title: null, subtitle: null, at: null };
}

function findNode(nodes: JsxNode[], pred: (n: JsxNode) => boolean): JsxNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    const inner = findNode(n.children, pred);
    if (inner) return inner;
  }
  return null;
}

/** Every file that makes up a page: its entry file and, for a directory page, its siblings. */
export function pageFiles(entry: string): string[] {
  if (!entry.endsWith('/index.tsx') && !entry.endsWith('/index.ts')) return [entry];
  const dir = entry.split('/').slice(0, -1).join('/');
  return [entry, ...walkFiles().filter((f) => f !== entry && f.startsWith(`${dir}/`) && /\.tsx?$/.test(f))];
}

export function pages(): PageInfo[] {
  const navItems = new Map(nav().map((n) => [n.to, n]));
  const spec = specSections();
  const out: PageInfo[] = [];
  for (const r of routes()) {
    const navItem = navItems.get(r.path) ?? null;
    if (r.redirect_to) {
      out.push({
        path: r.path,
        title: null,
        title_source: null,
        description: `Catch-all: anything unmatched is redirected to ${r.redirect_to}.`,
        description_source: r.declared_at,
        sidebar_label: null,
        sidebar_group: null,
        component: r.element,
        file: null,
        lazy: false,
        route_declared_at: r.declared_at,
        redirect_to: r.redirect_to,
        note: null,
      });
      continue;
    }
    const files = r.file ? pageFiles(r.file) : [];
    const header = files.length ? pageHeader(files) : { title: null, subtitle: null, at: null };
    const specKeys = [navItem?.label, r.element].filter(Boolean).map((s) => normaliseHeading(s as string));
    const specHit = specKeys.map((k) => spec.get(k)).find(Boolean) ?? null;

    const title = header.title ?? navItem?.label ?? null;
    const description = header.subtitle ?? specHit?.text ?? null;
    out.push({
      path: r.path,
      title,
      title_source: header.title ? `${header.at} (PageHeader title)` : navItem ? `${navItem.declared_at} (sidebar label)` : null,
      description,
      description_source: header.subtitle
        ? `${header.at} (PageHeader subtitle)`
        : specHit
          ? `${SPEC}:${specHit.line} (the section this page's spec opens with)`
          : null,
      sidebar_label: navItem?.label ?? null,
      sidebar_group: navItem?.group ?? null,
      component: r.element,
      file: r.file,
      lazy: r.lazy,
      route_declared_at: r.declared_at,
      redirect_to: null,
      note: r.file
        ? description
          ? null
          : 'This page has no PageHeader subtitle and no matching section in CLAUDE.md, so there is no description to read from source. Nothing is invented in its place.'
        : `The route names <${r.element ?? '?'}> but no import in ${APP} resolves it to a file, so nothing about this page can be read from source.`,
      });
  }
  return out;
}

export function pageByPath(path: string): PageInfo {
  const all = pages();
  const want = path.trim() || '/';
  const hit = all.find((p) => p.path === want) ?? all.find((p) => p.path === want.replace(/\/+$/, '')) ?? null;
  if (!hit) {
    throw new McpError('no_such_page', `"${path}" is not a route this app serves. The routes in ${APP} are: ${all.map((p) => p.path).join(', ')}.`);
  }
  return hit;
}

/* ------------------------------------------------------ a page's own structure */

export interface StructureNode {
  component: string;
  line: number;
  end_line: number;
  props: JsxNode['props'];
  in_props: string[];
  /** Data expressions named in this node's props — what decides what it shows. */
  data_refs: string[];
  /** Where this component is declared, when it is one of this repo's own. */
  defined_at: string | null;
  external_from: string | null;
  /** How defined_at was arrived at: this file, an import followed, or not resolved. */
  resolution: 'local' | 'import' | 'unresolved';
  /** This component's own structure, expanded in place. */
  children: StructureNode[];
  expanded: StructureNode[] | null;
  expansion_note: string | null;
}

export interface PageStructure {
  path: string;
  title: string | null;
  page_component: string;
  file: string;
  files: string[];
  component_declared_at: string;
  data: PageData;
  structure: StructureNode[];
  nodes_returned: number;
  truncated: boolean;
  warnings: string[];
  derivation: string;
  note: string | null;
}

export interface PageData {
  /** Every useData/api call found in the page's files, as written. */
  calls: { source: string; line: number; text: string }[];
  data_functions: string[];
  api_routes: DataFunction[];
  /** Functions imported from src/data that resolve to no /api route — helpers, not reads. */
  other_data_module_calls: string[];
}

const DATA_REF = /\b(?:data|d|rows|s|m|metrics|detail)\.[A-Za-z_$][\w$.]*/g;

function dataRefsOf(node: JsxNode): string[] {
  const out = new Set<string>();
  for (const p of node.props) {
    if (p.kind === 'string' || p.kind === 'flag') continue;
    for (const m of p.value.matchAll(DATA_REF)) out.add(m[0]);
    for (const m of p.value.matchAll(/\/api\/[\w\-/${}.]+/g)) out.add(m[0]);
  }
  return [...out];
}

/**
 * Which of `src/data`'s functions a page's files use, and what they resolve to.
 *
 * Read off the import list rather than off call sites, because the common shape
 * here is `useData(getOverview)` — the function is handed over, never called by
 * name, so a scan for `getOverview(` finds nothing and the page looks as though
 * it reads no data at all.
 */
export function pageData(files: string[]): PageData {
  const known = dataFunctions();
  const used = new Set<string>();
  const others = new Set<string>();
  const calls: PageData['calls'] = [];
  for (const rel of files) {
    let file: SourceFile;
    try {
      file = readSource(rel);
    } catch {
      continue;
    }
    const fromData = importsOf(file).filter((b) => b.resolved === DATA_MODULE);
    const namespaces: string[] = [];
    for (const b of fromData) {
      if (b.imported === '*') {
        namespaces.push(b.local);
        continue;
      }
      if (known.has(b.imported)) used.add(b.imported);
      else if (new RegExp(`\\b${b.local}\\s*\\(`).test(file.text)) others.add(b.imported);
    }
    for (const ns of namespaces) {
      for (const m of file.text.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
        if (known.has(m[1])) used.add(m[1]);
        else others.add(m[1]);
      }
    }
    const names = [...used, ...others];
    for (let line = 1; line <= file.lines; line++) {
      const text = lineText(file, line);
      if (!/\buseData\s*\(|\bapi<|\/api\//.test(text) && !names.some((n) => new RegExp(`\\b${n}\\b`).test(text))) continue;
      calls.push({ source: rel, line, text: text.trim().slice(0, 300) });
    }
  }
  return {
    calls,
    data_functions: [...used].sort(),
    api_routes: [...used].sort().map((n) => known.get(n)!).filter(Boolean),
    other_data_module_calls: [...others].sort(),
  };
}

export interface StructureOptions {
  /** How many levels of this repo's own components to open up in place. */
  expand_depth?: number;
  /** A hard budget, so one page cannot answer with the whole interface. */
  max_nodes?: number;
}

export function pageStructure(path: string, opts: StructureOptions = {}): PageStructure {
  const page = pageByPath(path);
  if (!page.file) throw new McpError('no_source', page.note ?? `No file implements ${page.path}.`);
  if (!page.component) throw new McpError('no_source', `The route for ${page.path} names no component, so there is no structure to read.`);

  const expandDepth = Math.max(0, Math.min(4, opts.expand_depth ?? 2));
  const maxNodes = Math.max(40, Math.min(1200, opts.max_nodes ?? 400));

  const entry = readSource(page.file);
  const decl =
    declarationsOf(page.component, page.file).find((d) => d.file === page.file) ??
    declarationsOf(page.component, page.file)[0] ??
    // A default-exported component can be declared anonymously.
    (/export\s+default\s+function\s*\(/.test(entry.text)
      ? (() => {
          const at = entry.text.search(/export\s+default\s+function\s*\(/);
          return { name: page.component!, file: page.file!, line: lineOf(entry, at), start: at, end: spanEnd(entry.text, at), kind: 'default' as const, exported: true };
        })()
      : undefined);
  if (!decl) {
    throw new McpError('no_declaration', `<${page.component}> is imported into ${APP} from ${page.file}, but no declaration of that name is in ${page.file}. Nothing about this page's layout can be read without it.`);
  }

  const warnings: string[] = [];
  let spent = 0;
  let truncated = false;

  const build = (nodes: JsxNode[], depth: number, chain: string[], preferFile: string): StructureNode[] => {
    const out: StructureNode[] = [];
    for (const n of nodes) {
      if (spent >= maxNodes) {
        truncated = true;
        return out;
      }
      spent += 1;
      const res = resolveComponent(n.component, preferFile);
      const own = res.declaration;
      const node: StructureNode = {
        component: n.component,
        line: n.line,
        end_line: n.end_line,
        props: n.props,
        in_props: n.in_props,
        data_refs: dataRefsOf(n),
        defined_at: own ? `${own.file}:${own.line}` : null,
        external_from: own ? null : res.from,
        resolution: res.via,
        children: build(n.children, depth, chain, preferFile),
        expanded: null,
        expansion_note: res.note,
      };
      if (own && depth < expandDepth) {
        const key = `${own.file}:${own.start}`;
        if (chain.includes(key)) {
          node.expansion_note = 'Not opened up again: this component is already on the path above it.';
        } else if (spent >= maxNodes) {
          truncated = true;
          node.expansion_note = 'Not opened up: the node budget for this answer was already spent.';
        } else {
          const ownFile = readSource(own.file);
          const inner = scanJsx(ownFile, own.start, own.end);
          for (const w of inner.warnings) warnings.push(`${own.file}: ${w}`);
          node.expanded = build(inner.nodes, depth + 1, [...chain, key], own.file);
          if (!node.expanded.length) node.expansion_note = `Declared at ${own.file}:${own.line} and renders no component of its own (only HTML elements).`;
        }
      } else if (own && depth >= expandDepth) {
        node.expansion_note = `Declared at ${own.file}:${own.line}. Not opened up: expand_depth is ${expandDepth}. Raise it, or call get_component("${n.component}").`;
      }
      out.push(node);
    }
    return out;
  };

  const scan = scanJsx(entry, decl.start, decl.end);
  warnings.push(...scan.warnings.map((w) => `${page.file}: ${w}`));
  const structure = build(scan.nodes, 0, [`${decl.file}:${decl.start}`], page.file);
  const files = pageFiles(page.file);

  return {
    path: page.path,
    title: page.title,
    page_component: page.component,
    file: page.file,
    files,
    component_declared_at: `${decl.file}:${decl.line}`,
    data: pageData(files),
    structure,
    nodes_returned: countStructure(structure),
    truncated,
    warnings,
    derivation: `Scanned the JSX of <${page.component}> in ${page.file} (lines ${decl.line}–${lineOf(entry, decl.end)}) and opened up each of this repo's own components in place, ${expandDepth} level(s) deep. Lower-case HTML tags are left out; a component passed in as a prop is listed under in_props. Data routes come from resolving each src/data function to its api() call.`,
    note: truncated
      ? `Cut at ${maxNodes} nodes. Raise max_nodes, lower expand_depth, or call get_component on the part you want in full — this answer is incomplete.`
      : null,
  };
}

function countStructure(nodes: StructureNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countStructure(node.children) + (node.expanded ? countStructure(node.expanded) : 0);
  return n;
}

/* ------------------------------------------------------------- one component */

export interface ComponentSource {
  name: string;
  file: string;
  line: number;
  end_line: number;
  kind: Declaration['kind'];
  exported: boolean;
  source: string;
  /** The block comment immediately above the declaration, which is where this repo puts the why. */
  doc: string | null;
  other_declarations: string[];
  truncated: boolean;
  note: string | null;
}

const MAX_COMPONENT_CHARS = 60_000;

export function component(name: string, file?: string | null): ComponentSource {
  const clean = name.trim().replace(/^<|\/?>$/g, '');
  if (!clean) throw new McpError('bad_argument', 'A component name is required.');
  const all = declarationsOf(clean, file ?? undefined);
  if (!all.length) {
    throw new McpError('not_found', `Nothing named "${clean}" is declared in src/ or server/src/ in this checkout. Try search_source with the name to find where it is referenced.`);
  }
  const files = [...new Set(all.map((d) => d.file))];
  if (!file && files.length > 1) {
    throw new McpError(
      'ambiguous',
      `"${clean}" is declared in ${files.length} files: ${all.map((d) => `${d.file}:${d.line}`).join(', ')}. Pass the file you mean — picking one here would be a guess, and two components with the same name do different things.`,
    );
  }
  const chosen = file ? all.find((d) => d.file === file) : all[0];
  if (!chosen) {
    throw new McpError('not_found', `"${clean}" is not declared in ${file}. It is declared in: ${all.map((d) => `${d.file}:${d.line}`).join(', ')}.`);
  }
  const src = readSource(chosen.file);
  let text = src.text.slice(chosen.start, chosen.end);
  const truncated = text.length > MAX_COMPONENT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_COMPONENT_CHARS)}\n… [cut: ${chosen.end - chosen.start} characters in source, ${MAX_COMPONENT_CHARS} returned]`;
  const before = src.text.slice(0, chosen.start);
  const doc = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before)?.[1]?.replace(/^[ \t]*\*[ \t]?/gm, '').trim() ?? null;
  return {
    name: clean,
    file: chosen.file,
    line: chosen.line,
    end_line: lineOf(src, chosen.end),
    kind: chosen.kind,
    exported: chosen.exported,
    source: text,
    doc: doc || null,
    other_declarations: all.filter((d) => d !== chosen).map((d) => `${d.file}:${d.line}`),
    truncated,
    note: truncated ? 'The declaration is longer than this tool returns in one answer. Read the file directly for the rest.' : null,
  };
}

/* ----------------------------------------------------------- data sources */

export interface DataSource {
  system: 'airtable' | 'bharag' | 'n8n' | 'postgres';
  label: string;
  /** Airtable base, or the endpoint for the others. */
  base: string | null;
  table: string | null;
  link: string | null;
  access: 'read' | 'read and write' | 'write';
  credential: string | null;
  credential_set: boolean | null;
  /** The engine_* table the rows land in, where a mirror kind claims this source. */
  mirror_kind: string | null;
  postgres_table: string | null;
  /** Pages whose own /api routes reach this source, derived — see `derivation`. */
  pages: string[];
  declared_at: string | null;
  note: string | null;
}

/** Objects in sources.ts shaped like a location: `{ base, table, label }`. */
function locationConstants(): { name: string; base: string; table: string; label: string }[] {
  const out: { name: string; base: string; table: string; label: string }[] = [];
  const mod = sources as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.base === 'string' && typeof v.table === 'string') {
      out.push({ name, base: v.base, table: v.table, label: typeof v.label === 'string' ? v.label : name });
    }
  }
  const m = mirror as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(m)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.base === 'string' && typeof v.table === 'string' && !out.some((o) => o.table === v.table)) {
      out.push({ name, base: v.base, table: v.table, label: typeof v.label === 'string' ? v.label : name });
    }
  }
  return out;
}

/**
 * Which page reads which record kind, chained rather than declared.
 *
 * page → the src/data function its files import → that function's /api route →
 * the handler index.ts answers that route with → the record kinds named as
 * literals in that handler's own body. Each step is read from source; where a
 * step does not resolve the page simply contributes nothing, so a missing link
 * shows up as an empty list and never as a plausible one.
 */
const HANDLER_MODULES = ['engine', 'store', 'health', 'pay', 'executions', 'mirror', 'registry'] as const;

function kindsByPage(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const index = readSource('server/src/index.ts');
  for (const p of pages()) {
    if (!p.file) continue;
    const kinds = new Set<string>();
    for (const route of pageData(pageFiles(p.file)).api_routes) {
      // A parameterised route's prefix is not a route index.ts registers, so
      // looking one up by it would match whatever else that string appears in.
      if (route.method !== 'GET' || route.parameterised) continue;
      const at = index.text.indexOf(`'${route.path_prefix}'`);
      if (at < 0) continue;
      const call = new RegExp(`\\b(${HANDLER_MODULES.join('|')})\\.([A-Za-z_$][\\w$]*)`).exec(index.text.slice(at, at + 400));
      if (!call) continue;
      const moduleFile = `server/src/${call[1]}.ts`;
      let body: string;
      try {
        const mod = readSource(moduleFile);
        const decl = declarationsOf(call[2], moduleFile).find((d) => d.file === moduleFile);
        body = decl ? mod.text.slice(decl.start, decl.end) : index.text.slice(at, at + 400);
      } catch {
        body = index.text.slice(at, at + 400);
      }
      for (const m of body.matchAll(/'([a-z][a-z0-9_-]*)'/g)) {
        const k = m[1];
        if ((store.KINDS as string[]).includes(k) || mirror.isKind(k)) kinds.add(k);
      }
    }
    if (kinds.size) out.set(p.path, kinds);
  }
  return out;
}

function baseOfKind(kind: string): string | null {
  try {
    if ((store.KINDS as string[]).includes(kind)) return sources.baseFor(kind as never);
  } catch {
    /* a kind sources.ts has no base for */
  }
  return null;
}

export function dataSources(): { sources: DataSource[]; derivation: string; note: string } {
  const byPage = kindsByPage();
  const mirrorByLabel = new Map<string, { kind: string; table: string }>();
  for (const kind of mirror.KIND_LIST) mirrorByLabel.set(mirror.KINDS[kind].label, { kind, table: mirror.KINDS[kind].table });

  const pagesFor = (base: string | null, mirrorKind: string | null): string[] => {
    const hits: string[] = [];
    for (const [path, kinds] of byPage) {
      for (const k of kinds) {
        if (mirrorKind && k === mirrorKind) {
          hits.push(path);
          break;
        }
        if (base && baseOfKind(k) === base) {
          hits.push(path);
          break;
        }
      }
    }
    return [...new Set(hits)].sort();
  };

  const out: DataSource[] = [];

  // Airtable: one entry per table, with the per-builder tables expanded.
  const writeBases = new Set([sources.LOOPS_BASE, sources.CODEX_BASE]);
  const perBuilder: { name: string; base: string; table: string; label: string; kind: string }[] = [
    ...sources.LOOP_TABLES.map((t) => ({ name: 'LOOP_TABLES', base: sources.LOOPS_BASE, table: t.table, label: `Open Loops — ${t.label}`, kind: 'loops' })),
    ...sources.CODEX_TABLES.map((t) => ({ name: 'CODEX_TABLES', base: sources.CODEX_BASE, table: t.table, label: `BHA Submissions & Logs — ${t.sheet}`, kind: 'codex' })),
  ];
  const sourcesFile = (() => {
    try {
      return readSource('server/src/sources.ts');
    } catch {
      return null;
    }
  })();
  const declaredAt = (name: string): string | null => {
    if (!sourcesFile) return null;
    const d = declarationsOf(name, 'server/src/sources.ts').find((x) => x.file === 'server/src/sources.ts');
    return d ? `server/src/sources.ts:${d.line}` : null;
  };

  for (const loc of [...perBuilder, ...locationConstants()]) {
    // A per-builder table's kind is the constant it came from, not a label match:
    // the builder is which table the row sits in, and all seven are one kind.
    const explicit = (loc as { kind?: string }).kind;
    const mk = explicit && mirror.isKind(explicit) ? { kind: explicit, table: mirror.KINDS[explicit].table } : (mirrorByLabel.get(loc.label) ?? null);
    const write = writeBases.has(loc.base);
    out.push({
      system: 'airtable',
      label: loc.label,
      base: loc.base,
      table: loc.table,
      link: `https://airtable.com/${loc.base}/${loc.table}`,
      access: write ? 'read and write' : 'read',
      credential: 'AIRTABLE_TOKEN',
      credential_set: Boolean(process.env.AIRTABLE_TOKEN?.trim()),
      mirror_kind: mk?.kind ?? null,
      postgres_table: mk?.table ?? null,
      pages: pagesFor(loc.base, mk?.kind ?? null),
      declared_at: declaredAt(loc.name),
      note: mk ? null : 'No mirror kind in mirror.ts claims this table by label, so no engine_* table is asserted for it here.',
    });
  }

  // BHARAG: the incident ledger, one call and one credential per lane.
  for (const [lane, envVar] of Object.entries(bharag.LANE_KEY_VARS)) {
    out.push({
      system: 'bharag',
      label: `Incident ledger — ${lane}`,
      base: `${bharag.BHARAG_URL}/incidents?status=open&source=${lane}`,
      table: null,
      link: null,
      access: 'read',
      credential: envVar,
      credential_set: bharag.laneConfigured(lane),
      mirror_kind: 'incidents',
      postgres_table: mirror.KINDS.incidents.table,
      pages: pagesFor(null, 'incidents'),
      declared_at: 'server/src/bharag.ts',
      note: bharag.laneConfigured(lane) ? null : `${envVar} is not set on this service, so this lane is never read. An unread lane is not a healthy lane.`,
    });
  }

  // n8n: read only, two endpoints.
  for (const endpoint of ['/executions', '/workflows']) {
    out.push({
      system: 'n8n',
      label: `n8n instance API — GET ${endpoint}`,
      base: `${n8n.n8nBase()}${endpoint}`,
      table: null,
      link: n8n.n8nHost(),
      access: 'read',
      credential: n8n.N8N_API_VAR,
      credential_set: n8n.n8nConfigured(),
      mirror_kind: null,
      postgres_table: 'engine_execution_runs',
      pages: ['/executions'],
      declared_at: 'server/src/n8n.ts',
      note: n8n.n8nConfigured() ? null : `${n8n.N8N_API_VAR} is not set, so no execution is ever read and the Executions page says so rather than reading zero.`,
    });
  }

  // Postgres: not an engine source, but it is what every page actually reads.
  const identity = db.databaseIdentity();
  out.push({
    system: 'postgres',
    label: 'This dashboard’s own database',
    base: identity ? `${identity.host}/${identity.database}` : null,
    table: null,
    link: null,
    access: 'read and write',
    credential: 'DATABASE_URL',
    credential_set: Boolean(db.DATABASE_URL),
    mirror_kind: null,
    postgres_table: null,
    pages: [...byPage.keys()].sort(),
    declared_at: 'server/src/pg.ts',
    note: 'Every page reads here, not from the source above it. The engine writes a row through /api/engine/:kind and the page reads that row.',
  });

  return {
    sources: out,
    derivation:
      'Airtable bases and tables are read from the exported constants in server/src/sources.ts and server/src/mirror.ts as this process holds them, never from a list typed here. The engine_* table beside each one is the mirror kind whose label matches. `pages` is chained: page → the src/data function its files call → that function’s /api route → the handler index.ts answers that route with → the record kinds named in the handler’s body → the base sources.baseFor() gives that kind at runtime.',
    note: 'Every read path in this list except n8n goes through Postgres: the engine writes rows in and the pages read them out, so a page is linked to an Airtable table by the kind it reads, not by calling Airtable. Where the chain cannot be established the list is empty rather than guessed at.',
  };
}
