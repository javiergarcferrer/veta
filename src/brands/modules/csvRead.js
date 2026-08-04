/**
 * A price list arrives as a spreadsheet export, so a module set that decodes one
 * needs a READER — `lib/csv.js` only ever had to write them.
 *
 * RFC 4180 with the two concessions every real export needs: the delimiter is
 * sniffed (a Spanish/Latin-American Excel writes `;` because the machine's list
 * separator is `;`, and Sheets writes `\t` on a paste) and a UTF-8 BOM is
 * eaten. Quotes are honoured, doubled quotes unescape, and a quoted field may
 * carry the delimiter or a newline.
 *
 * `readCsvRecords` hands back one object per row keyed by the LOWER-CASED,
 * trimmed header — which is what lets `parsePriceRow` read `SKU`, `sku` and
 * ` Sku ` as the same column without every adapter re-solving it.
 *
 * Pure (no DOM, no File): the caller reads text however it likes.
 */

/** Delimiters we sniff, in preference order. */
const DELIMITERS = [',', ';', '\t', '|'];

/** The delimiter that best explains the header line: the one producing the most
 *  fields. Ties keep the earlier (more common) candidate. */
export function sniffDelimiter(text) {
  const line = String(text || '').split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = splitLine(line, d).length;
    if (n > bestCount) { bestCount = n; best = d; }
  }
  return best;
}

/** One line → its fields, respecting quotes. Used only for sniffing; the real
 *  parse below is character-wise over the whole text (a quoted field may span
 *  lines). */
function splitLine(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/**
 * CSV text → a matrix of trimmed cells. Blank trailing lines are dropped; a
 * fully blank row is dropped (an export routinely ends with several).
 */
export function readCsvRows(text, delimiter) {
  const src = String(text || '').replace(/^﻿/, '');
  if (!src.trim()) return [];
  const d = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => { endField(); if (row.some((c) => c !== '')) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === d) endField();
    else if (c === '\n') endRow();
    else if (c === '\r') { /* CRLF — the \n does the work */ }
    else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * CSV text → `{ headers, records }`, each record an object keyed by the
 * lower-cased header. A row with fewer cells than headers simply leaves the
 * tail undefined; extra cells are kept under their index so nothing is lost
 * silently.
 */
export function readCsvRecords(text) {
  const rows = readCsvRows(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const records = rows.slice(1).map((cells) => {
    const rec = {};
    for (let i = 0; i < Math.max(headers.length, cells.length); i += 1) {
      const key = headers[i] || String(i);
      rec[key] = cells[i] ?? '';
    }
    return rec;
  });
  return { headers, records };
}

/**
 * A money cell → a number, or null. Handles `1,234.56`, `1.234,56`, `$ 1234`,
 * `USD 1,234` and a bare `1234`. Ambiguity is resolved by the LAST separator:
 * whichever of `.` or `,` comes last is the decimal point, which is how both
 * conventions read correctly without asking the dealer which one their
 * spreadsheet used.
 */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value ?? '').replace(/[^\d.,-]/g, '').trim();
  if (!raw) return null;
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let normalized;
  if (lastDot < 0 && lastComma < 0) normalized = raw;
  else if (lastComma > lastDot) normalized = raw.replace(/\./g, '').replace(',', '.');
  else normalized = raw.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** The first present, non-empty value among `keys` — price lists name the same
 *  column five ways and an adapter should read them all. */
export function pick(record, keys) {
  for (const k of keys) {
    const v = record?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
