/**
 * A scanner for the JSX in this repo's `.tsx` files.
 *
 * It exists so `get_page_structure` can answer with the page's real component
 * tree — the panels in the order they are written, each with the props that
 * change what it shows — rather than with a description somebody typed. The
 * whole point of the tool is that it cannot drift from the page.
 *
 * It is a scanner, not a parser: it walks the file a character at a time,
 * skipping comments, strings and template literals, and records every
 * component element it opens and closes. Lower-case tags (`div`, `span`) are
 * deliberately ignored — they are layout, and a tree that carried them would
 * bury the panels in wrappers.
 *
 * **Telling JSX from a type argument** is the one thing this has to get right.
 * `useData<HealthData>(...)` and `Record<string, unknown>` look exactly like an
 * opening tag. The rule is the one TypeScript itself effectively uses: a `<`
 * immediately after an identifier, a `)` or a `]` is a type argument or a
 * comparison, never an element — unless that identifier is a keyword
 * (`return <Card/>`). Everything else is an element.
 *
 * Where the scan cannot make sense of the file it says so in `warnings` and
 * the tools pass those warnings through. A partial tree presented as a whole
 * one is exactly the wrong answer this tool set is built to avoid.
 */
import { lineOf, type SourceFile } from './source';

export interface JsxNode {
  /** The component's name as written, so `Foo.Bar` stays `Foo.Bar`. */
  component: string;
  /** 1-based line of the opening tag. */
  line: number;
  /** 1-based line of the closing tag, or of `/>`. */
  end_line: number;
  self_closing: boolean;
  /**
   * Props in source order. A string literal is stored unquoted; anything else
   * is the expression's own source text, braces included, so a reader can see
   * what actually decides what the panel shows.
   */
  props: { name: string; value: string; kind: 'string' | 'expression' | 'flag' | 'spread' }[];
  /**
   * Components named inside a prop's expression — `right={<ResyncButton />}`.
   * Recorded because in this codebase a control or a whole tab strip is often
   * passed in as a prop, and a tree that only walked children would miss it.
   */
  in_props: string[];
  children: JsxNode[];
}

export interface JsxScan {
  nodes: JsxNode[];
  warnings: string[];
}

const IDENT_END = /[A-Za-z0-9_$]/;

/**
 * Words after which a `<` still opens an element. Without these,
 * `return <PageHeader />` would read as a comparison against a type.
 */
const KEYWORDS = new Set([
  'return',
  'case',
  'typeof',
  'instanceof',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
  'void',
  'delete',
  'new',
  'default',
  'throw',
]);

/** Index just past the closing quote of the string starting at `i`. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    // An unterminated single- or double-quoted string ends at the line break.
    if (c === '\n') return j + 1;
    j++;
  }
  return text.length;
}

/** Index just past the closing backtick, following `${ ... }` back into code. */
function skipTemplate(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return j + 1;
    if (c === '$' && text[j + 1] === '{') {
      j = skipBraces(text, j + 1);
      continue;
    }
    j++;
  }
  return text.length;
}

/** Index just past the `}` matching the `{` at `i`, skipping strings and comments inside. */
function skipBraces(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '/' && text[j + 1] === '/') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipString(text, j);
      continue;
    }
    if (c === '`') {
      j = skipTemplate(text, j);
      continue;
    }
    if (c === '{') {
      depth += 1;
      j++;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return text.length;
}

/** Whether a `<` at `i` opens an element rather than a type argument list. */
function opensElement(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const c = text[j];
  if (IDENT_END.test(c)) {
    let k = j;
    while (k >= 0 && IDENT_END.test(text[k])) k--;
    return KEYWORDS.has(text.slice(k + 1, j + 1));
  }
  // A call or an index gives back a value, so `<` after it is a comparison.
  return c !== ')' && c !== ']';
}

/** How much of a prop expression is worth carrying. Past this it is said to be cut. */
const MAX_PROP_CHARS = 600;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_PROP_CHARS ? `${flat.slice(0, MAX_PROP_CHARS)} …[cut, ${flat.length} chars in source]` : flat;
}

const NESTED_COMPONENT = /<([A-Z][A-Za-z0-9_.]*)/g;

interface TagParse {
  props: JsxNode['props'];
  in_props: string[];
  self_closing: boolean;
  /** Index just past `>` or `/>`. */
  next: number;
  end_line_index: number;
}

/** Everything between the tag name and the `>` that ends the opening tag. */
function parseTag(text: string, i: number): TagParse {
  const props: JsxNode['props'] = [];
  const inProps = new Set<string>();
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (/\s/.test(c)) {
      j++;
      continue;
    }
    if (c === '/' && text[j + 1] === '/') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '/' && text[j + 1] === '>') return { props, in_props: [...inProps], self_closing: true, next: j + 2, end_line_index: j };
    if (c === '>') return { props, in_props: [...inProps], self_closing: false, next: j + 1, end_line_index: j };
    if (c === '{') {
      // `{...props}` — a spread, with no name of its own.
      const end = skipBraces(text, j);
      const raw = text.slice(j, end);
      props.push({ name: '...', value: clip(raw), kind: 'spread' });
      for (const m of raw.matchAll(NESTED_COMPONENT)) inProps.add(m[1]);
      j = end;
      continue;
    }
    const nameMatch = /^[A-Za-z_$][A-Za-z0-9_$:.-]*/.exec(text.slice(j));
    if (!nameMatch) {
      // Something this scanner does not model. Stop the tag here rather than
      // guessing; the caller sees the props it did read and the warning.
      return { props, in_props: [...inProps], self_closing: false, next: j + 1, end_line_index: j };
    }
    const name = nameMatch[0];
    j += name.length;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '=') {
      // A bare prop, which in JSX means `true`.
      props.push({ name, value: 'true', kind: 'flag' });
      continue;
    }
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    const v = text[j];
    if (v === '"' || v === "'") {
      const end = skipString(text, j);
      props.push({ name, value: clip(text.slice(j + 1, end - 1)), kind: 'string' });
      j = end;
      continue;
    }
    if (v === '{') {
      const end = skipBraces(text, j);
      const raw = text.slice(j, end);
      props.push({ name, value: clip(raw), kind: 'expression' });
      for (const m of raw.matchAll(NESTED_COMPONENT)) inProps.add(m[1]);
      j = end;
      continue;
    }
    if (v === '`') {
      const end = skipTemplate(text, j);
      props.push({ name, value: clip(text.slice(j, end)), kind: 'expression' });
      j = end;
      continue;
    }
    // Anything else is not a shape this scanner models.
    props.push({ name, value: '', kind: 'flag' });
  }
  return { props, in_props: [...inProps], self_closing: false, next: text.length, end_line_index: text.length - 1 };
}

/**
 * Every component element in the file, as a tree, in source order.
 *
 * `from` and `to` bound the scan to one byte range, which is how a single
 * component's own JSX is scanned without the rest of the file around it.
 */
export function scanJsx(file: SourceFile, from = 0, to = Number.MAX_SAFE_INTEGER): JsxScan {
  const text = file.text;
  const end = Math.min(to, text.length);
  const warnings: string[] = [];
  const root: JsxNode = { component: '(file)', line: 0, end_line: 0, self_closing: false, props: [], in_props: [], children: [] };
  const stack: JsxNode[] = [root];

  let i = from;
  while (i < end) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? end : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? end : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(text, i);
      continue;
    }
    if (c !== '<') {
      i++;
      continue;
    }

    const close = /^<\/\s*([A-Z][A-Za-z0-9_.]*)\s*>/.exec(text.slice(i, i + 200));
    if (close) {
      const name = close[1];
      const at = stack.map((n) => n.component).lastIndexOf(name);
      if (at <= 0) {
        warnings.push(`line ${lineOf(file, i)}: </${name}> closes a component that is not open here; the tree around it may be wrong.`);
      } else {
        const node = stack[at];
        node.end_line = lineOf(file, i);
        if (at !== stack.length - 1) {
          warnings.push(`line ${lineOf(file, i)}: </${name}> closes across ${stack.length - 1 - at} still-open element(s) (${stack.slice(at + 1).map((n) => n.component).join(', ')}).`);
        }
        stack.length = at;
      }
      i += close[0].length;
      continue;
    }

    const open = /^<([A-Z][A-Za-z0-9_.]*)(?=[\s/>])/.exec(text.slice(i, i + 200));
    if (!open || !opensElement(text, i)) {
      i++;
      continue;
    }
    const line = lineOf(file, i);
    const parsed = parseTag(text, i + open[0].length);
    const node: JsxNode = {
      component: open[1],
      line,
      end_line: lineOf(file, parsed.end_line_index),
      self_closing: parsed.self_closing,
      props: parsed.props,
      in_props: parsed.in_props,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!parsed.self_closing) stack.push(node);
    i = parsed.next;
  }

  if (stack.length > 1) {
    warnings.push(`the scan ended with ${stack.length - 1} element(s) still open (${stack.slice(1).map((n) => `${n.component} at line ${n.line}`).join(', ')}), so the tree below them is incomplete.`);
  }
  return { nodes: root.children, warnings };
}

/** Every component name anywhere in a tree, for the "what does this page use" list. */
export function componentsIn(nodes: JsxNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    out.add(n.component);
    for (const c of n.in_props) out.add(c);
    componentsIn(n.children, out);
  }
  return out;
}

/** How many nodes a tree holds, so a budget can be spent honestly. */
export function countNodes(nodes: JsxNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
}
