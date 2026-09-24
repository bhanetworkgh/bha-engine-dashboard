/**
 * Text out of a PDF, with Node's own zlib and nothing else (2026-09-24).
 *
 * `read_slack_file` needs a PDF's text. The brief allowed "pdf-parse or
 * equivalent"; CLAUDE.md section 2 rule 5 makes `pg` the ceiling on
 * dependencies, so this is the equivalent, and it is deliberately small: it
 * reads what a text layer is — the strings a page's content stream shows with
 * `Tj`, `TJ`, `'` and `"` — decoded through each font's `ToUnicode` map where
 * the font has one, which every PDF a browser, Word, Google Docs or LaTeX
 * writes does.
 *
 * What it does not do, and says so rather than guessing:
 *   - **encrypted** PDFs are not decrypted (`encrypted: true`, no text);
 *   - **scanned** pages are images and have no text layer — the caller reports
 *     `no_text_layer`, and nothing here tries OCR;
 *   - text drawn inside a form XObject (`Do`) is not followed;
 *   - a CID font with no `ToUnicode` has no mapping to read, so its strings
 *     are skipped rather than emitted as mojibake (counted in `unmapped`).
 */
import { constants, inflateSync } from 'node:zlib';

interface Obj {
  dict: string;
  stream: Buffer | null;
}

export interface PdfText {
  text: string;
  pages: number;
  encrypted: boolean;
  /** Strings skipped because their font had no way to Unicode. */
  unmapped: number;
}

function inflate(raw: Buffer): Buffer | null {
  try {
    return inflateSync(raw);
  } catch {
    try {
      // A stream with a damaged tail still yields everything before the damage.
      return inflateSync(raw, { finishFlush: constants.Z_SYNC_FLUSH });
    } catch {
      return null;
    }
  }
}

function decodeStream(dict: string, raw: Buffer): Buffer | null {
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '';
  const filters = f.match(/\/\w+/g) ?? [];
  let data: Buffer | null = raw;
  for (const name of filters) {
    if (name === '/FlateDecode' || name === '/Fl') data = data && inflate(data);
    else return null; // images (DCT, JPX, CCITT) and anything else: not text.
  }
  return data;
}

/** Every indirect object, with its stream decoded where it is Flate or unfiltered. */
function objects(buf: Buffer): Map<number, Obj> {
  const src = buf.toString('latin1');
  const out = new Map<number, Obj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    let body = src.slice(start, end);
    let stream: Buffer | null = null;
    const si = body.search(/\bstream(\r\n|\n|\r)/);
    if (si >= 0) {
      const nl = body.slice(si).match(/^stream(\r\n|\n|\r)/)![0].length;
      const dataStart = start + si + nl;
      const dict = body.slice(0, si);
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = len ? dataStart + Number(len[1]) : -1;
      if (dataEnd < 0 || src.slice(dataEnd, dataEnd + 20).indexOf('endstream') < 0) dataEnd = src.indexOf('endstream', dataStart);
      if (dataEnd > dataStart) stream = decodeStream(dict, buf.subarray(dataStart, dataEnd));
      body = dict;
      re.lastIndex = end;
    }
    out.set(num, { dict: body, stream });
  }
  // Objects packed inside object streams: dictionaries only, never streams.
  for (const o of [...out.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const s = o.stream.toString('latin1');
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const head = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = head[i * 2 + 1];
      const next = i + 1 < n ? head[(i + 1) * 2 + 1] : s.length - first;
      if (!out.has(num)) out.set(num, { dict: s.slice(first + off, first + next), stream: null });
    }
  }
  return out;
}

function refs(s: string): number[] {
  return [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
}

/** The value of `/Key` in a dictionary: `n 0 R`, an inline `<<…>>`, or `[…]`. */
function entry(dict: string, key: string): string | null {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z0-9])`));
  if (i < 0) return null;
  let j = i + key.length + 1;
  while (/\s/.test(dict[j] ?? '')) j++;
  if (dict.startsWith('<<', j)) {
    let depth = 0;
    for (let k = j; k < dict.length; k++) {
      if (dict.startsWith('<<', k)) {
        depth++;
        k++;
      } else if (dict.startsWith('>>', k)) {
        depth--;
        k++;
        if (!depth) return dict.slice(j, k + 1);
      }
    }
    return dict.slice(j);
  }
  if (dict[j] === '[') return dict.slice(j, dict.indexOf(']', j) + 1);
  const r = /^(\d+\s+\d+\s+R|\/[^\s/<>[\]()]+|[\d.+-]+)/.exec(dict.slice(j));
  return r ? r[1] : null;
}

function resolve(objs: Map<number, Obj>, v: string | null): string | null {
  if (!v) return null;
  const r = /^(\d+)\s+\d+\s+R$/.exec(v.trim());
  return r ? (objs.get(Number(r[1]))?.dict ?? null) : v;
}

/* ------------------------------------------------------------- ToUnicode */

interface CMap {
  map: Map<string, string>;
  bytes: number;
}

function utf16(hex: string): string {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
  return s;
}

function parseCMap(text: string): CMap {
  const map = new Map<string, string>();
  let bytes = 1;
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const h = /<([0-9a-fA-F]+)>/.exec(block[1]);
    if (h) bytes = Math.max(1, h[1].length / 2);
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(p[1].toLowerCase(), utf16(p[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const width = p[1].length;
      if (hi - lo > 65_535) continue;
      if (p[3].startsWith('[')) {
        const list = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        list.forEach((d, i) => map.set((lo + i).toString(16).padStart(width, '0'), d));
      } else {
        const dst = p[3].slice(1, -1);
        const base = parseInt(dst.slice(-4) || '0', 16);
        const prefix = utf16(dst.slice(0, -4));
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(width, '0'), prefix + String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return { map, bytes };
}

interface Font {
  cmap: CMap | null;
  /** A two-byte CID font: without a cmap its codes mean nothing readable. */
  cid: boolean;
}

function fontFrom(objs: Map<number, Obj>, dict: string | null, cache: Map<string, Font>): Font {
  const key = dict ?? '';
  const hit = cache.get(key);
  if (hit) return hit;
  let cmap: CMap | null = null;
  const tu = dict ? entry(dict, 'ToUnicode') : null;
  const tuRef = tu ? /^(\d+)\s+\d+\s+R$/.exec(tu.trim()) : null;
  const stream = tuRef ? objs.get(Number(tuRef[1]))?.stream : null;
  if (stream) cmap = parseCMap(stream.toString('latin1'));
  const font = { cmap, cid: Boolean(dict && /\/Subtype\s*\/Type0/.test(dict)) };
  cache.set(key, font);
  return font;
}

/* --------------------------------------------------------- content streams */

type Tok = { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'arr'; v: Tok[] } | { t: 'op'; v: string } | { t: 'dict' };

function literal(s: string, i: number): [string, number] {
  let out = '';
  let depth = 1;
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in esc) {
        out += esc[n];
        i += 2;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
      } else if (n === '\r' || n === '\n') {
        i += n === '\r' && s[i + 2] === '\n' ? 3 : 2;
      } else {
        out += n ?? '';
        i += 2;
      }
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return [out, i + 1];
    out += c;
    i++;
  }
  return [out, i];
}

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[][] = [out];
  const push = (t: Tok) => stack[stack.length - 1].push(t);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (c === '(') {
      const [v, j] = literal(s, i);
      push({ t: 'str', v });
      i = j;
    } else if (s.startsWith('<<', i)) {
      // Marked-content property lists: skipped whole.
      let depth = 0;
      for (; i < s.length; i++) {
        if (s.startsWith('<<', i)) {
          depth++;
          i++;
        } else if (s.startsWith('>>', i)) {
          depth--;
          i++;
          if (!depth) {
            i++;
            break;
          }
        }
      }
      push({ t: 'dict' });
    } else if (c === '<') {
      const j = s.indexOf('>', i);
      const hex = s.slice(i + 1, j < 0 ? s.length : j).replace(/[^0-9a-fA-F]/g, '');
      const even = hex.length % 2 ? `${hex}0` : hex;
      push({ t: 'str', v: Buffer.from(even, 'hex').toString('latin1') });
      i = j < 0 ? s.length : j + 1;
    } else if (c === '[') {
      const arr: Tok[] = [];
      push({ t: 'arr', v: arr });
      stack.push(arr);
      i++;
    } else if (c === ']') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '/') {
      const m = /^\/[^\s/<>[\]()%{}]*/.exec(s.slice(i, i + 128))![0];
      push({ t: 'name', v: m.slice(1) });
      i += m.length;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?\d*\.?\d*/.exec(s.slice(i, i + 32))![0] || c;
      push({ t: 'num', v: Number(m) || 0 });
      i += m.length;
    } else {
      const m = /^[^\s/<>[\]()%{}]+/.exec(s.slice(i, i + 32))?.[0] ?? c;
      i += m.length;
      if (m === 'BI') {
        // An inline image: its data is binary and runs to EI.
        const e = s.slice(i).search(/\sEI(\s|$)/);
        i = e < 0 ? s.length : i + e + 3;
        continue;
      }
      push({ t: 'op', v: m });
    }
  }
  return out;
}

function show(raw: string, font: Font | null, counter: { unmapped: number }): string {
  if (font?.cmap && font.cmap.map.size) {
    const { map, bytes } = font.cmap;
    let out = '';
    for (let i = 0; i < raw.length; i += bytes) {
      let code = '';
      for (let k = 0; k < bytes; k++) code += (raw.charCodeAt(i + k) || 0).toString(16).padStart(2, '0');
      out += map.get(code) ?? '';
    }
    return out;
  }
  if (font?.cid) {
    counter.unmapped++;
    return '';
  }
  // A simple font with no cmap: its codes are close enough to Latin-1 to read.
  return raw.replace(/[^\x20-\x7e\xa0-\xff\t]/g, '');
}

function pageText(content: string, fonts: Map<string, Font>, counter: { unmapped: number }): string {
  let out = '';
  let font: Font | null = null;
  let ops: Tok[] = [];
  let lastY: number | null = null;
  const nl = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  for (const tok of tokens(content)) {
    if (tok.t !== 'op') {
      ops.push(tok);
      continue;
    }
    const a = ops;
    ops = [];
    switch (tok.v) {
      case 'Tf': {
        const name = a.find((x) => x.t === 'name') as { v: string } | undefined;
        font = name ? (fonts.get(name.v) ?? null) : null;
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        if (tok.v !== 'Tj') nl();
        const s = [...a].reverse().find((x) => x.t === 'str') as { v: string } | undefined;
        if (s) out += show(s.v, font, counter);
        break;
      }
      case 'TJ': {
        const arr = a.find((x) => x.t === 'arr') as { v: Tok[] } | undefined;
        for (const x of arr?.v ?? []) {
          if (x.t === 'str') out += show(x.v, font, counter);
          else if (x.t === 'num' && x.v < -250 && !out.endsWith(' ')) out += ' ';
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const nums = a.filter((x) => x.t === 'num') as { v: number }[];
        // A move down starts a line. A move along the same line is the next
        // run of the same text — browsers split a line at every kerning pair
        // this way — so it adds nothing; a real word gap is a space glyph.
        if (nums.length >= 2 && nums[1].v !== 0) nl();
        break;
      }
      case 'T*':
        nl();
        break;
      case 'Tm': {
        const nums = a.filter((x) => x.t === 'num') as { v: number }[];
        const y = nums.length >= 6 ? nums[5].v : null;
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 1) nl();
        lastY = y;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- pages */

function pageOrder(objs: Map<number, Obj>): number[] {
  const isPage = (d: string) => /\/Type\s*\/Page(?![a-zA-Z])/.test(d);
  const all = [...objs.entries()].filter(([, o]) => isPage(o.dict)).map(([n]) => n);
  const root = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const pagesRef = root ? entry(root.dict, 'Pages') : null;
  const start = pagesRef ? /^(\d+)/.exec(pagesRef)?.[1] : null;
  if (!start) return all.sort((x, y) => x - y);
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (n: number) => {
    if (seen.has(n) || seen.size > 100_000) return;
    seen.add(n);
    const o = objs.get(n);
    if (!o) return;
    if (isPage(o.dict)) out.push(n);
    else for (const k of refs(entry(o.dict, 'Kids') ?? '')) walk(k);
  };
  walk(Number(start));
  return out.length ? out : all.sort((x, y) => x - y);
}

/** A page's /Resources, looked up the /Parent chain where the page inherits it. */
function resourcesOf(objs: Map<number, Obj>, dict: string): string | null {
  let d: string | null = dict;
  for (let depth = 0; d && depth < 32; depth++) {
    const r = resolve(objs, entry(d, 'Resources'));
    if (r) return r;
    d = resolve(objs, entry(d, 'Parent'));
  }
  return null;
}

export function extractPdfText(buf: Buffer): PdfText {
  const objs = objects(buf);
  const encrypted = /\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1')) || [...objs.values()].some((o) => /\/Type\s*\/XRef/.test(o.dict) && /\/Encrypt\s/.test(o.dict));
  const pages = pageOrder(objs);
  if (encrypted) return { text: '', pages: pages.length, encrypted: true, unmapped: 0 };
  const cache = new Map<string, Font>();
  const counter = { unmapped: 0 };
  const parts: string[] = [];
  for (const n of pages) {
    const page = objs.get(n)!;
    const fonts = new Map<string, Font>();
    const res = resourcesOf(objs, page.dict);
    const fontDict = res ? resolve(objs, entry(res, 'Font')) : null;
    if (fontDict) {
      for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(m[1], fontFrom(objs, objs.get(Number(m[2]))?.dict ?? null, cache));
    }
    const contents = entry(page.dict, 'Contents');
    let ids = refs(contents ?? '');
    // /Contents may point at an array object rather than a stream.
    if (ids.length === 1 && !objs.get(ids[0])?.stream) ids = refs(objs.get(ids[0])?.dict ?? '');
    const content = ids.map((id) => objs.get(id)?.stream?.toString('latin1') ?? '').join('\n');
    parts.push(pageText(content, fonts, counter));
  }
  const text = parts
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, pages: pages.length, encrypted: false, unmapped: counter.unmapped };
}
