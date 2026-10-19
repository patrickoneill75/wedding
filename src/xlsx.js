/**
 * A minimal .xlsx reader on platform APIs only (no npm): unzip with
 * DecompressionStream("deflate-raw"), then pull cells out of the sheet XML.
 *
 * Returns, per sheet, a map of cell address -> { v, f }: v is the cached value (what
 * the spreadsheet last calculated; numbers come back as numbers) and f is the formula
 * text, if any. Formulas are never evaluated -- the importer only reads them to learn
 * which Constants cell a quantity pointed at.
 */

const decoder = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file isn't an .xlsx (no zip directory found).");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt .xlsx (bad zip entry).");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip compression method ${method}.`);
    files.set(name, { data, method });
  }
  return {
    has: (name) => files.has(name),
    async text(name) {
      const entry = files.get(name);
      if (!entry) return null;
      return decoder.decode(entry.method === 8 ? await inflateRaw(entry.data) : entry.data);
    },
  };
}

export function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
};

function textRuns(xml) {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
}

/** True when a formula has a cell reference that isn't fully absolute ($F$43 is; F43 isn't). */
function hasRelativeRef(formula) {
  if (!formula) return false;
  return [...String(formula).matchAll(/(\$?)\b([A-Z]{1,3})(\$?)(\d+)\b/g)].some((m) => !m[1] || !m[3]);
}

function parseSheet(xml, shared) {
  const cells = new Map();
  const sharedFormulas = new Map();
  for (const m of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const inner = m[2] || "";
    const ref = attr(attrs, "r");
    if (!ref) continue;
    const type = attr(attrs, "t");
    let formula = null;
    const fm = /<f([^>]*)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    if (fm) {
      const si = attr(fm[1], "si");
      formula = fm[2] ? decodeXml(fm[2]) : null;
      if (si != null) {
        if (formula) sharedFormulas.set(si, formula);
        // A filled-down formula's other cells shift its relative references (F43 in the
        // first row is F44 in the next). Rather than shift them, a child of a formula
        // with any relative reference has no formula: the importer uses its value.
        else formula = hasRelativeRef(sharedFormulas.get(si)) ? null : sharedFormulas.get(si) || null;
      }
    }
    // An empty <v></v> (a formula never calculated) is "no value", not zero.
    const vm = /<v>([\s\S]+?)<\/v>/.exec(inner);
    let value = null;
    if (type === "s" && vm) value = shared[Number(vm[1])] ?? "";
    else if (type === "inlineStr") value = textRuns(inner);
    else if (type === "b" && vm) value = vm[1] === "1";
    else if ((type === "str" || type === "e") && vm) value = decodeXml(vm[1]);
    else if (vm) {
      const n = Number(vm[1]);
      value = Number.isFinite(n) ? n : decodeXml(vm[1]);
    }
    if (value === null && formula === null) continue;
    cells.set(ref, { v: value, f: formula });
  }
  return cells;
}

/** Parse every sheet: returns Map(sheetName -> Map(cellRef -> { v, f })). */
export async function readWorkbook(buffer) {
  const zip = await unzip(buffer);
  const workbook = await zip.text("xl/workbook.xml");
  const rels = await zip.text("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("That file isn't an .xlsx workbook.");
  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    targets.set(attr(m[1], "Id"), attr(m[1], "Target"));
  }
  const shared = parseSharedStrings(await zip.text("xl/sharedStrings.xml"));
  const sheets = new Map();
  for (const m of workbook.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const name = attr(m[1], "name");
    const target = targets.get(attr(m[1], "r:id"));
    if (!name || !target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = await zip.text(path);
    if (xml) sheets.set(name, parseSheet(xml, shared));
  }
  return sheets;
}

/** Column letters -> 0-based index ("A" -> 0, "AA" -> 26). */
export function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Turn a sheet's cell map into rows of { A: {v,f}, B: ... }, keyed by row number. */
export function sheetRows(cells) {
  const rows = new Map();
  for (const [ref, cell] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    const row = Number(m[2]);
    if (!rows.has(row)) rows.set(row, Object.create(null));
    rows.get(row)[m[1]] = cell;
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]);
}
