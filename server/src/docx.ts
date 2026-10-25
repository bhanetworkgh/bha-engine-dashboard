/**
 * Text out of a Word file (.docx), with Node's own zlib and nothing else
 * (2026-10-26, Destiny: "let's upgrade Bays to be able to read docx and pdf
 * when sent in chat"). Hardik's Stripe acceptance bundle (#workflow-logs-destiny,
 * 1792966737.567289) came to Bays as raw zip bytes, because `read_slack_file`
 * handed anything that was not a PDF back as UTF-8 text.
 *
 * A .docx is a zip; the body is `word/document.xml`. This reads the zip's
 * central directory, inflates that one entry (method 8, or stored), and walks
 * the XML in order:
 *   - a paragraph (`w:p`) is one line; a tab (`w:tab`) is a tab and a break
 *     (`w:br`, `w:cr`) a new line; a heading keeps its text, nothing more;
 *   - a table row (`w:tr`) is one line, its cells joined with " | ", so a
 *     two-column table of label and value reads as "label | value";
 *   - deleted text (`w:del`, `w:delText`) is left out, inserted text kept.
 * Footnotes, headers, footers, comments, text boxes drawn as shapes and
 * embedded images are not read, and the answer counts the images it skipped.
 * Rule 5 of CLAUDE.md section 2 makes `pg` the ceiling on dependencies, so
 * this is the small equivalent of mammoth, like `pdf.ts` is of pdf-parse.
 */
import { inflateRawSync } from 'node:zlib';

export interface DocxText {
  text: string;
  paragraphs: number;
  tables: number;
  /** Pictures in the body, not read. */
  images: number;
}

export class DocxError extends Error {
  constructor(public readonly reason: 'not_a_zip' | 'not_a_docx' | 'unreadable_entry', message: string) {
    super(message);
  }
}

/** The local file signature every zip starts with. */
export function isZip(b: Buffer): boolean {
  return b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;
}

/** The zip's entries by name, read from the central directory (sizes there are always right). */
function entries(b: Buffer): Map<string, { method: number; compSize: number; offset: number }> {
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError('not_a_zip', 'The file starts like a zip but has no zip directory; it is damaged or cut short.');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, { method: number; compSize: number; offset: number }>();
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const offset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.set(name, { method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(b: Buffer, e: { method: number; compSize: number; offset: number }, name: string): Buffer {
  if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) throw new DocxError('unreadable_entry', `${name} could not be found where the zip says it is.`);
  const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
  const raw = b.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch (err) {
      throw new DocxError('unreadable_entry', `${name} could not be unpacked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new DocxError('unreadable_entry', `${name} uses zip method ${e.method}, which is not read here.`);
}

/** The names a zip holds, so a caller can say what kind of Office file it was. */
export function zipNames(b: Buffer): string[] {
  try {
    return [...entries(b).keys()];
  } catch {
    return [];
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? '';
  });
}

/**
 * Walk document.xml once, tag by tag. Text is collected into the current
 * paragraph; a paragraph inside a table cell goes into that cell; a row is
 * written as its cells joined by " | ".
 */
export function docxXmlToText(xml: string): DocxText {
  const lines: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  let images = 0;
  let para: string[] | null = null;
  // A stack, because a table can sit inside a table cell.
  const rows: string[][] = [];
  const cells: string[][] = [];
  let inText = false;
  let deleted = 0;

  const tag = /<(\/?)([A-Za-z0-9_]+:[A-Za-z0-9_]+|[A-Za-z0-9_]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    if (m[5] !== undefined) {
      if (inText && para && !deleted) para.push(unescapeXml(m[5]));
      continue;
    }
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    const name = m[2];
    switch (name) {
      case 'w:p':
        if (!closing) {
          para = [];
          if (selfClosing) {
            para = null;
            if (cells.length) cells[cells.length - 1].push('');
            else lines.push('');
          }
        } else if (para) {
          const t = para.join('');
          paragraphs++;
          if (cells.length) cells[cells.length - 1].push(t);
          else lines.push(t);
          para = null;
        }
        break;
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tab':
        if (!closing && para && !deleted) para.push('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing && para && !deleted) para.push('\n');
        break;
      case 'w:del':
        if (!selfClosing) deleted += closing ? -1 : 1;
        break;
      case 'w:tbl':
        if (!closing) tables++;
        break;
      case 'w:tr':
        if (!closing && !selfClosing) rows.push([]);
        else if (closing) {
          const row = rows.pop() ?? [];
          const line = row.join(' | ');
          if (cells.length) cells[cells.length - 1].push(line);
          else lines.push(line);
        }
        break;
      case 'w:tc':
        if (!closing && !selfClosing) cells.push([]);
        else if (closing) {
          const cell = (cells.pop() ?? []).filter((s) => s.trim() !== '').join(' / ');
          if (rows.length) rows[rows.length - 1].push(cell);
        }
        break;
      case 'w:drawing':
      case 'w:pict':
        if (!closing) images++;
        break;
      default:
        break;
    }
  }
  // Runs of blank lines become one, so a spaced-out document reads compactly.
  const text = lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, paragraphs, tables, images };
}

/** Read a .docx: throws DocxError naming what was wrong when it cannot. */
export function extractDocxText(b: Buffer): DocxText {
  if (!isZip(b)) throw new DocxError('not_a_zip', 'The file is not a zip, so it is not a .docx.');
  const all = entries(b);
  const e = all.get('word/document.xml');
  if (!e) throw new DocxError('not_a_docx', 'The zip has no word/document.xml, so it is not a Word document.');
  return docxXmlToText(readEntry(b, e, 'word/document.xml').toString('utf8'));
}
