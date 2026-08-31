/**
 * Read a ZIP's DIRECTORY without downloading the ZIP.
 *
 * A Carl Hansen 3D archive is 8–22 MB, and 133 furniture products carry one.
 * Deciding whether an archive is even usable (does it hold an `.obj`? an
 * `.mtl`?) by DOWNLOADING it would cost gigabytes to learn a file list that
 * lives in the last few kilobytes: a ZIP stores its whole directory at the END
 * (central directory + End Of Central Directory record). So the read is a
 * single HTTP Range over the tail — that is how §8's coverage numbers were
 * measured over 70 archives, and it is the same trick the importer ships.
 *
 * This module is the PURE half of that: bytes in, structure out. It never
 * fetches (the caller owns the Range request) and it never decompresses on its
 * own — `inflateRaw` is INJECTED, exactly like `glbExport(THREE, …)` hands
 * three.js in from the effectful layer. The browser passes a
 * `DecompressionStream('deflate-raw')` adapter:
 *
 *   const inflateRaw = async (deflated) => new Uint8Array(await new Response(
 *     new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
 *   ).arrayBuffer());
 *
 * and the test passes `zlib.inflateRawSync`. That injection is the whole reason
 * a binary reader can be unit-tested at all — no new npm dependency, no DOM.
 * (Full-archive unzipping in the browser already has a home: `matzExtract.js`
 * uses fflate from inside three. This module exists for the case where
 * downloading the archive is the thing we are trying to avoid.)
 *
 * Pinned by tests/carlHansen3d.test.js.
 */

/** Compression methods we can honestly decode. */
export const ZIP_STORE = 0;
export const ZIP_DEFLATE = 8;

/** One file recorded in the central directory. */
export interface ChZipEntry {
  /** Path inside the archive, separators normalized to `/`. */
  name: string;
  /** APPNOTE compression method — 0 store, 8 deflate, anything else refused. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The directory's CRC-32 of the UNCOMPRESSED bytes (0 when unrecorded). */
  crc32: number;
  /** Absolute offset of this entry's LOCAL file header in the whole archive. */
  localHeaderOffset: number;
  /** Name length in bytes — the local header repeats the name verbatim. */
  nameLength: number;
  /** Extra-field length AS RECORDED IN THE DIRECTORY. The LOCAL header's extra
   *  field is a different, independent length (writers put timestamps in one
   *  and not the other), which is why `localDataRange` cannot compute the data
   *  offset and `inflateEntry` re-reads the local header instead. */
  extraLength: number;
  /** True for a stored directory ("folder/"), which carries no data. */
  directory: boolean;
}

export interface ChZipDirectory {
  entries: ChZipEntry[];
  /**
   * The tail did not contain the whole directory (or contained no EOCD at all).
   * Reported, never thrown: the caller's answer is to re-Range a bigger tail,
   * and a partial list must never read as a complete one.
   */
  truncated: boolean;
}

export type ChInflateRaw = (
  deflated: Uint8Array,
) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const EOCD_MIN = 22;
const EOCD64_LOCATOR_LEN = 20;
const CD_FIXED = 46;
const LOCAL_FIXED = 30;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/**
 * The maximum size of a ZIP extra field, and therefore the exact amount
 * `localDataRange` must over-fetch. The LOCAL header's extra field length is
 * unknowable from the directory, so the range is made correct BY CONSTRUCTION
 * rather than by a guessed slack: a short range would mean a second round trip
 * (or worse, a silently truncated file), and 64 KB against a 2–7 MB texture is
 * nothing. A range past EOF is harmless — HTTP Range and Blob.slice both clamp.
 */
const MAX_EXTRA = 0xffff;

/** APPNOTE 4.4.5 method names, so a refusal can say WHAT it refused. */
const METHOD_NAMES: Record<number, string> = {
  0: 'store', 1: 'shrink', 2: 'reduce', 3: 'reduce', 4: 'reduce', 5: 'reduce',
  6: 'implode', 8: 'deflate', 9: 'deflate64', 10: 'DCL implode', 12: 'bzip2',
  14: 'lzma', 16: 'cmpsc', 18: 'terse', 19: 'lz77', 20: 'zstd (obsoleto)',
  93: 'zstd', 94: 'mp3', 95: 'xz', 96: 'jpeg', 97: 'wavpack', 98: 'ppmd',
  99: 'AES cifrado',
};

const methodLabel = (m: number) => METHOD_NAMES[m] || 'desconocido';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A u64 as a JS number, refusing anything past exact-integer range. */
function u64(view: DataView, at: number): number {
  const big = view.getBigUint64(at, true);
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(big);
}

/** Entry names are UTF-8 when flag bit 11 says so; Carl Hansen archives are
 *  plain ASCII either way, and a non-strict UTF-8 decode of CP437 ASCII is the
 *  same bytes. A name is never used as a key into anything money-shaped. */
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes).replace(/\\/g, '/');
  } catch {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return s.replace(/\\/g, '/');
  }
}

/**
 * Parse the ZIP directory out of the archive's TAIL.
 *
 * @param tailBytes the LAST bytes of the archive (an HTTP Range read)
 * @param totalSize the archive's full size in bytes — what turns an offset
 *        inside the tail into an absolute offset in the archive, and back
 */
export function readCentralDirectory(tailBytes: Uint8Array, totalSize: number): ChZipDirectory {
  const bytes = tailBytes instanceof Uint8Array ? tailBytes : new Uint8Array(0);
  const size = Number.isFinite(totalSize) ? Math.max(0, Math.floor(totalSize)) : bytes.length;
  const tailStart = Math.max(0, size - bytes.length);
  if (bytes.length < EOCD_MIN) return { entries: [], truncated: true };
  const view = viewOf(bytes);

  // The EOCD is the last record in the file, but its trailing comment can hold
  // anything — including a fake signature. Scan backwards and prefer the
  // candidate whose comment length lands exactly on the end of the file;
  // fall back to the last signature seen.
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== EOCD_SIG) continue;
    if (eocd < 0) eocd = i;
    if (i + EOCD_MIN + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) return { entries: [], truncated: true };

  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64 — any sentinel field means the real numbers live in the ZIP64 EOCD,
  // located through its own locator record sitting just before the EOCD.
  if (count === U16_MAX || cdOffset === U32_MAX || view.getUint32(eocd + 12, true) === U32_MAX) {
    const loc = eocd - EOCD64_LOCATOR_LEN;
    if (loc < 0 || view.getUint32(loc, true) !== EOCD64_LOCATOR_SIG) return { entries: [], truncated: true };
    const abs = u64(view, loc + 8);
    const at = abs - tailStart;
    if (!Number.isFinite(abs) || at < 0 || at + 56 > bytes.length) return { entries: [], truncated: true };
    if (view.getUint32(at, true) !== EOCD64_SIG) return { entries: [], truncated: true };
    count = u64(view, at + 32);
    cdOffset = u64(view, at + 48);
    if (!Number.isFinite(count) || !Number.isFinite(cdOffset)) return { entries: [], truncated: true };
  }

  // The directory starts before the tail we were given: nothing can be parsed
  // safely (a record boundary is not findable mid-stream), so say so and let
  // the caller widen the Range rather than hand back a plausible-looking half.
  if (cdOffset < tailStart) return { entries: [], truncated: true };

  const entries: ChZipEntry[] = [];
  let truncated = false;
  let at = cdOffset - tailStart;
  for (let i = 0; i < count; i += 1) {
    if (at + CD_FIXED > bytes.length || view.getUint32(at, true) !== CD_SIG) { truncated = true; break; }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameAt = at + CD_FIXED;
    const extraAt = nameAt + nameLength;
    const next = extraAt + extraLength + commentLength;
    if (next > bytes.length) { truncated = true; break; }

    const name = decodeName(bytes.subarray(nameAt, extraAt));
    let uncompressedSize = view.getUint32(at + 24, true);
    let compressedSize = view.getUint32(at + 20, true);
    let localHeaderOffset = view.getUint32(at + 42, true);
    // ZIP64 extended information (0x0001): only the fields that were sentinels
    // are present, in this fixed order.
    if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      let x = extraAt;
      while (x + 4 <= extraAt + extraLength) {
        const id = view.getUint16(x, true);
        const len = view.getUint16(x + 2, true);
        if (x + 4 + len > extraAt + extraLength) break;
        if (id === 0x0001) {
          let f = x + 4;
          const take = () => { const v = u64(view, f); f += 8; return v; };
          if (uncompressedSize === U32_MAX && f + 8 <= x + 4 + len) uncompressedSize = take();
          if (compressedSize === U32_MAX && f + 8 <= x + 4 + len) compressedSize = take();
          if (localHeaderOffset === U32_MAX && f + 8 <= x + 4 + len) localHeaderOffset = take();
          break;
        }
        x += 4 + len;
      }
    }
    if (!Number.isFinite(uncompressedSize) || !Number.isFinite(compressedSize) || !Number.isFinite(localHeaderOffset)) {
      truncated = true;
      break;
    }

    entries.push({
      name,
      method: view.getUint16(at + 10, true),
      compressedSize,
      uncompressedSize,
      crc32: view.getUint32(at + 16, true) >>> 0,
      localHeaderOffset,
      nameLength,
      extraLength,
      directory: name.endsWith('/'),
    });
    at = next;
  }

  return { entries, truncated: truncated || entries.length < count };
}

/**
 * The byte range to Range-request for ONE entry — `[start, end)`, covering the
 * entry's LOCAL HEADER and its data.
 *
 * It deliberately starts at the local header rather than at the data: the data
 * offset depends on the LOCAL extra-field length, which the directory does not
 * record, so the only honest way to find the data is to read the header that
 * precedes it. `inflateEntry` does exactly that with these same bytes, so the
 * two compose: `localDataRange` → fetch → `inflateEntry`.
 */
export function localDataRange(entry: ChZipEntry): { start: number; end: number } {
  const start = Math.max(0, Math.floor(Number(entry?.localHeaderOffset) || 0));
  const name = Math.max(0, Math.floor(Number(entry?.nameLength) || 0));
  const data = Math.max(0, Math.floor(Number(entry?.compressedSize) || 0));
  return { start, end: start + LOCAL_FIXED + name + MAX_EXTRA + data };
}

/** CRC-32 (IEEE), the checksum the ZIP format itself carries. Table built once,
 *  lazily — it is only needed once bytes are actually being decoded. */
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function asBytes(v: Uint8Array | ArrayBuffer): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(v);
}

/**
 * Decode ONE entry from the bytes `localDataRange` describes.
 *
 * Refuses — by name — anything that is not store (0) or deflate (8). A ZIP can
 * legally carry bzip2, lzma, zstd or AES-encrypted members, and emitting their
 * raw bytes as if they were the file would hand the mesh loader confident
 * garbage. The whole point of naming the method in the error is that the
 * dealer's screen can say WHY an archive can't be read instead of showing a
 * broken model.
 *
 * Everything that CAN be verified IS verified before the bytes are returned:
 * the local signature, the method agreeing with the directory, the declared
 * uncompressed length, and the CRC-32 the archive itself recorded.
 */
export async function inflateEntry(
  entry: ChZipEntry,
  bytes: Uint8Array,
  inflateRaw: ChInflateRaw,
): Promise<Uint8Array> {
  const where = entry?.name ? `«${entry.name}»` : 'una entrada sin nombre';
  const method = Math.floor(Number(entry?.method));
  if (method !== ZIP_STORE && method !== ZIP_DEFLATE) {
    throw new Error(
      `ZIP: método de compresión no soportado en ${where}: ${Number.isFinite(method) ? method : '?'} `
      + `(${methodLabel(method)}). Solo se admiten 0 (store) y 8 (deflate).`,
    );
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < LOCAL_FIXED) {
    throw new Error(`ZIP: el rango leído para ${where} no alcanza ni la cabecera local.`);
  }
  const view = viewOf(bytes);
  if (view.getUint32(0, true) !== LOCAL_SIG) {
    throw new Error(`ZIP: el rango leído para ${where} no empieza en su cabecera local (usa localDataRange).`);
  }
  const flags = view.getUint16(6, true);
  if (flags & 0x0001) throw new Error(`ZIP: ${where} está cifrado con contraseña; no se puede leer.`);
  const localMethod = view.getUint16(8, true);
  if (localMethod !== method) {
    throw new Error(
      `ZIP: ${where} declara el método ${localMethod} (${methodLabel(localMethod)}) en su cabecera local `
      + `y ${method} (${methodLabel(method)}) en el directorio.`,
    );
  }

  const dataAt = LOCAL_FIXED + view.getUint16(26, true) + view.getUint16(28, true);
  const compressed = Math.max(0, Math.floor(Number(entry.compressedSize) || 0));
  if (dataAt + compressed > bytes.length) {
    throw new Error(`ZIP: el rango leído para ${where} está incompleto (faltan bytes de datos).`);
  }
  const raw = bytes.subarray(dataAt, dataAt + compressed);
  const out = method === ZIP_STORE
    ? new Uint8Array(raw)                      // copy: the caller must not own a view into the range
    : asBytes(await inflateRaw(raw));

  const expected = Math.max(0, Math.floor(Number(entry.uncompressedSize) || 0));
  if (out.length !== expected) {
    throw new Error(`ZIP: ${where} descomprime a ${out.length} bytes y el directorio declara ${expected}.`);
  }
  // A recorded 0 means "unknown" for an empty file as much as for a streamed
  // one, so it is not checked; every real entry carries a real CRC.
  if (entry.crc32) {
    const got = crc32(out);
    if (got !== (entry.crc32 >>> 0)) {
      throw new Error(`ZIP: ${where} no pasa la verificación CRC-32 (datos corruptos).`);
    }
  }
  return out;
}
