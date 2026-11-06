'use strict';

// Reads the first sheet of an .xlsx workbook as rows of strings. No dependencies: an .xlsx file is a zip
// of XML parts, so a small zip reader on Node's built-in zlib is enough for a list of URLs.

const fs = require('fs');
const zlib = require('zlib');

const NOT_A_WORKBOOK = (file) => new Error(`${file} is not an .xlsx workbook. Save the sheet as .xlsx or .csv and try again.`);

function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry, name) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error(`Unsupported compression method ${entry.method} for ${name}`);
}

const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Text of an <si> or <is> element: every <t> run, ignoring phonetic hints.
function textOf(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((m) => decode(m[1] || '')).join('');
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textOf(m[1] || ''));
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function firstSheetPath(entries, read) {
  const workbook = read('xl/workbook.xml');
  const first = workbook && workbook.match(/<sheet\b[^>]*>/);
  const id = first && first[0].match(/\br:id="([^"]+)"/);
  const rels = read('xl/_rels/workbook.xml.rels');
  if (id && rels) {
    for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if ((rel[0].match(/\bId="([^"]+)"/) || [])[1] !== id[1]) continue;
      const target = (rel[0].match(/\bTarget="([^"]+)"/) || [])[1];
      if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
  }
  return entries.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
}

/** Rows of the first sheet as arrays of strings; empty cells are ''. Numbers are kept as written. */
function readXlsxRows(file) {
  const buf = fs.readFileSync(file);
  const entries = readZipEntries(buf);
  if (!entries) throw NOT_A_WORKBOOK(file);
  const read = (name) => (entries.has(name) ? readEntry(buf, entries.get(name), name) : null);
  const sheetPath = firstSheetPath(entries, read);
  const sheetXml = sheetPath && read(sheetPath);
  if (!sheetXml) throw new Error(`${file} has no worksheet. Expected an Excel workbook with the pages in the first sheet.`);
  const strings = sharedStrings(read('xl/sharedStrings.xml'));

  const rows = [];
  for (const row of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let next = 0;
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (c[1].match(/\br="([^"]+)"/) || [])[1];
      const type = (c[1].match(/\bt="([^"]+)"/) || [])[1];
      const at = ref ? columnIndex(ref) : next;
      const inner = c[2] || '';
      const v = (inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
      let value = '';
      if (type === 's') value = v === undefined ? '' : strings[Number(v)] || '';
      else if (type === 'inlineStr') value = textOf((inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/) || [])[1] || '');
      else if (v !== undefined) value = decode(v);
      while (cells.length < at) cells.push('');
      cells[at] = value;
      next = at + 1;
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = { readXlsxRows };
