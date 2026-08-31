/**
 * REAL FABRIC SWATCHES — the join that turns a selection-tree leaf into one
 * picture, and the discipline that keeps it from costing a gigabyte.
 *
 * Four things are pinned here, each of them a way this feature can silently
 * become wrong rather than visibly break:
 *
 *   1. THE JOIN. `"Canvas 0224"` → code `0224` → the archive entry carrying
 *      `C0224`. Proven against a zip this file BUILDS with node:zlib, read the
 *      way production reads it (directory from the TAIL, then ONE entry), so
 *      the round trip is real bytes and not a string assertion.
 *   2. THE ALIAS TABLE. "Hall.dal" is Hallingdal, "DM" is Divina Melange,
 *      "Canvas" is Canvas 2 — EXPLICIT pairs only. A fuzzy matcher would map
 *      "Divina" onto "Divina Melange" and paint one fabric with another's
 *      photo, which is worse than no photo because the dealer shows it to a
 *      customer.
 *   3. NO SOURCE ⇒ null, NEVER A GUESSED URL. ~277 of CH07's 683 colourways
 *      (Vidar, Focus Royal, Tiree, Joe, Keiga, every leather) have no published
 *      picture anywhere. That is a normal answer with a colour chip behind it,
 *      not an error and not a 404'd <img>.
 *   4. NOBODY DOWNLOADS AN ARCHIVE. The entries are 4–6 MB CMYK print masters
 *      inside 77–490 MB zips. The byte range is a PURE decision (`planSwatchRead`)
 *      so it can be measured here, and the browser glue is scanned for the one
 *      shape that could regress it: a fetch without a Range, or a whole-archive
 *      unzipper.
 *
 * Plus §12a's sizing lever, whose failure mode is inventing an asset key.
 *
 * No network, no DOM, no fixtures on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readCentralDirectory, inflateEntry, crc32 } from '../src/brands/carl-hansen/zipRead.ts';
import {
  CH_MATERIAL_ZIPS,
  CH_PRESSCLOUD_KEYS,
  PRESSCLOUD_ASSET_ORIGIN,
  PRESSCLOUD_SIZES,
  chCoverImageUrl,
  chProductImageUrl,
  chSwatchCoverage,
  chSwatchImageId,
  chSwatchSource,
  entryColourwayCode,
  materialZipsFor,
  planSwatchRead,
  pressCloudImageUrl,
  pressCloudSizedUrl,
  swatchEntryFor,
} from '../src/brands/carl-hansen/materialZips.ts';
import { chCollectionKey, collectionLabelOf, colorwayCode } from '../src/brands/carl-hansen/swatches.ts';
import { createChSwatchLoader, isSwatchCancelled } from '../src/components/carlhansen/chSwatchFetch.js';

// ── a minimal ZIP writer (the carlHansen3d.test.js pattern, kept local so the
//    two suites can never break each other) ───────────────────────────────────

function buildZip(files, { localExtra = Buffer.from([0x55, 0x54, 0x05, 0x00, 1, 2, 3, 4, 5]) } = {}) {
  const chunks = [];
  const dir = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data);
    const method = file.method ?? 8;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(file.name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(new Uint8Array(data));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    chunks.push(local, name, localExtra, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    dir.push(central, name);

    offset += local.length + name.length + localExtra.length + stored.length;
  }
  const cd = Buffer.concat(dir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** The Node half of the injection the browser fills with DecompressionStream. */
const inflateRaw = (deflated) => zlib.inflateRawSync(Buffer.from(deflated));

/** Entry names exactly as measured inside Canvas2.zip (45 of them, one per
 *  Canvas colourway). The bodies are stand-ins for 4–6 MB print masters — big
 *  enough that "one entry" and "the archive" are different numbers. */
const swatchEntry = (code) => `Canvas2/F_1221_C${code}_W24_HIGH_CMYK-LOW_SRGB_JPEG.jpg`;
const MASTER = (code) => `JPEG-master-${code}-`.repeat(400);

const CANVAS_ZIP = buildZip([
  { name: 'Canvas2/', data: '', method: 0 },
  { name: swatchEntry('0224'), data: MASTER('0224'), method: 8 },
  { name: swatchEntry('0356'), data: MASTER('0356'), method: 8 },
  { name: swatchEntry('0784'), data: MASTER('0784'), method: 8 },
  { name: 'Canvas2/readme.txt', data: 'Kvadrat Canvas 2 — press images', method: 8 },
]);
const CANVAS_DIR = readCentralDirectory(
  // Only the tail: the whole discipline in one line — 244 MB never crosses the
  // wire to learn what is inside.
  new Uint8Array(CANVAS_ZIP.subarray(Math.max(0, CANVAS_ZIP.length - 1024))),
  CANVAS_ZIP.length,
);

// ── 1. the frozen index ──────────────────────────────────────────────────────

test('the zip index is FROZEN DATA — nine archives, each filed under its own key’s shard', () => {
  assert.equal(CH_MATERIAL_ZIPS.length, 9);
  assert.equal(new Set(CH_MATERIAL_ZIPS.map((z) => z.url)).size, 9, 'no duplicated url');

  for (const zip of CH_MATERIAL_ZIPS) {
    const m = new RegExp(`^${PRESSCLOUD_ASSET_ORIGIN}/file/(\\d{2})/(\\d+)/([^/]+)$`).exec(zip.url);
    assert.ok(m, `${zip.file}: not a PressCloud asset url`);
    // The shard is the key's first two digits — the same rule
    // `pressCloudImageUrl` builds product urls with, cross-checked here against
    // nine independently captured urls.
    assert.equal(m[1], m[2].slice(0, 2), `${zip.file}: shard/key mismatch`);
    assert.equal(m[3], zip.file);
    assert.ok(zip.sizeMb > 0, `${zip.file}: the published size is why nothing downloads it`);
    // Index keys are already canonical, or a lookup could never reach them.
    assert.equal(chCollectionKey(zip.collection), zip.collection);
  }

  // Remix 3 ships as TWO archives; a collection is therefore a LIST, and the
  // reader tries them in order.
  assert.deepEqual(materialZipsFor('remix-3').map((z) => z.file), ['Remix3-1.zip', 'Remix3-2.zip']);
});

// ── 2. the alias table: explicit pairs, never fuzzy ──────────────────────────

test('collection aliases are the observed spellings, and nothing else resolves', () => {
  const fileOf = (name) => materialZipsFor(name).map((z) => z.file);

  // Version suffixes: the tree writes the family, Kvadrat names the version.
  assert.deepEqual(fileOf('Canvas'), ['Canvas2.zip']);
  assert.deepEqual(fileOf('Canvas 2'), ['Canvas2.zip']);
  assert.deepEqual(fileOf('Clara'), ['Clara2.zip']);
  assert.deepEqual(fileOf('Fiord'), ['Fiord2.zip']);
  assert.deepEqual(fileOf('Molly'), ['Molly2.zip']);
  assert.deepEqual(fileOf('Remix'), ['Remix3-1.zip', 'Remix3-2.zip']);
  // Contractions and abbreviations observed in the CH07 tree.
  assert.deepEqual(fileOf('Hall.dal'), ['Hallingdal65.zip']);
  assert.deepEqual(fileOf('Hallingdal'), ['Hallingdal65.zip']);
  assert.deepEqual(fileOf('Hallingdal 65'), ['Hallingdal65.zip']);
  assert.deepEqual(fileOf('DM'), ['Divina_Melange3.zip']);
  assert.deepEqual(fileOf('Divina Melange'), ['Divina_Melange3.zip']);
  // Identity still works — that is not a guess, it is the same string.
  assert.deepEqual(fileOf('Rewool'), ['Rewool.zip']);
  assert.deepEqual(fileOf('Re-wool'), ['Rewool.zip']);

  // NO FUZZY MATCHING. "Divina" is a different Kvadrat fabric from "Divina
  // Melange"; a prefix match here would paint it with the wrong photo.
  assert.deepEqual(fileOf('Divina'), []);
  assert.deepEqual(fileOf('Canvas Duo'), []);
  assert.deepEqual(fileOf('Hal'), []);
  // The collections with no published archive (§13) — a permanent, honest gap.
  for (const none of ['Vidar', 'Focus Royal', 'Tiree', 'Joe', 'Keiga', 'Thor', 'Loke', 'Sif', 'Cowhide']) {
    assert.deepEqual(fileOf(none), [], `${none} has no archive and must not resolve to one`);
  }
  assert.deepEqual(fileOf(''), []);
  assert.deepEqual(fileOf(null), []);
});

test('a leaf label splits into collection + colourway', () => {
  assert.equal(collectionLabelOf('Canvas 0224'), 'Canvas');
  assert.equal(colorwayCode('Canvas 0224'), '0224');
  assert.equal(collectionLabelOf('Hall.dal 130'), 'Hall.dal');
  assert.equal(collectionLabelOf('Divina Melange 3 671'), 'Divina Melange 3');
  // No number ⇒ no colourway, and the label is left whole.
  assert.equal(collectionLabelOf('Cowhide Brown White'), 'Cowhide Brown White');
  assert.equal(colorwayCode('Cowhide Brown White'), null);
});

// ── 3. the join, over real archive bytes ─────────────────────────────────────

test('the colourway code is read off the ENTRY FILENAME, boundary-exact', () => {
  assert.equal(entryColourwayCode(swatchEntry('0224')), '0224');
  // `CMYK` sits in the very same name: a C followed by letters is not a code.
  assert.ok(!swatchEntry('0224').includes('C0224X'));
  assert.equal(entryColourwayCode('Canvas2/CMYK-LOW_SRGB.jpg'), null);
  assert.equal(entryColourwayCode('Canvas2/readme.txt'), null);
  assert.equal(entryColourwayCode(''), null);
  assert.equal(entryColourwayCode(null), null);
});

test('"Canvas 0224" resolves to ONE entry, and that entry round-trips from its own byte range', async () => {
  assert.equal(CANVAS_DIR.truncated, false, 'the tail alone carried the whole directory');

  const source = chSwatchSource('Canvas', 'Canvas 0224');
  assert.deepEqual(
    { collection: source.collection, code: source.code, imageId: source.imageId },
    { collection: 'canvas-2', code: '0224', imageId: 'chswatch-canvas-2-0224' },
  );
  // Every url it can ever reach comes from the frozen table — the module builds
  // no url of its own, which is what makes "no source ⇒ null" enforceable.
  const known = new Set(CH_MATERIAL_ZIPS.map((z) => z.url));
  assert.ok(source.zips.every((z) => known.has(z.url)));

  const plan = planSwatchRead(CANVAS_DIR.entries, source.code);
  assert.equal(plan.entry.name, swatchEntry('0224'));

  const bytes = new Uint8Array(CANVAS_ZIP.subarray(plan.start, Math.min(plan.end, CANVAS_ZIP.length)));
  const out = await inflateEntry(plan.entry, bytes, inflateRaw);
  assert.equal(Buffer.from(out).toString('utf8'), MASTER('0224'));

  // …and the sibling colourways are reachable the same way, so the join is a
  // rule and not a coincidence of ordering.
  for (const code of ['0356', '0784']) {
    const p = planSwatchRead(CANVAS_DIR.entries, code);
    assert.equal(p.entry.name, swatchEntry(code));
  }
});

test('ONE ENTRY, NEVER THE ARCHIVE — the planned range is bounded by that entry alone', () => {
  const plan = planSwatchRead(CANVAS_DIR.entries, '0224');
  const span = plan.end - plan.start;

  // The upper bound is structural: local header + name + the largest legal
  // extra field + this entry's compressed bytes. Nothing about the range can
  // grow with the archive, which is the property that keeps a 490 MB Fiord2
  // read at ~5 MB.
  const bound = 30 + plan.entry.nameLength + 0xffff + plan.entry.compressedSize;
  assert.equal(span, bound);
  assert.ok(plan.start >= 0 && plan.start < CANVAS_ZIP.length);
  // A tiny fixture cannot prove "much smaller than the archive" the way a real
  // one does, so assert the shape that scales: the range never covers the whole
  // archive plus its directory.
  assert.ok(plan.start + plan.entry.compressedSize <= CANVAS_ZIP.length);
});

test('a colourway the archive does not carry is null — no entry, no plan, no url', () => {
  assert.equal(swatchEntryFor(CANVAS_DIR.entries, '9999'), null);
  assert.equal(planSwatchRead(CANVAS_DIR.entries, '9999'), null);
  assert.equal(swatchEntryFor(CANVAS_DIR.entries, ''), null);
  assert.equal(swatchEntryFor(null, '0224'), null);
  // Non-image members are never candidates, however they are named.
  assert.ok(!CANVAS_DIR.entries.some((e) => e.name.endsWith('.txt') && entryColourwayCode(e.name)));
});

test('several renditions of one colourway resolve to the LIGHTEST, deterministically', () => {
  const zip = buildZip([
    { name: 'Canvas2/F_1221_C0224_W24_HIGH_CMYK.jpg', data: 'X'.repeat(4000), method: 0 },
    { name: 'Canvas2/F_1221_C0224_W24_LOW_SRGB.jpg', data: 'X'.repeat(400), method: 0 },
  ]);
  const { entries } = readCentralDirectory(new Uint8Array(zip.subarray(-512)), zip.length);
  assert.equal(swatchEntryFor(entries, '0224').name, 'Canvas2/F_1221_C0224_W24_LOW_SRGB.jpg');
});

// ── 4. no source ⇒ null, never a broken url ──────────────────────────────────

test('a colourway with no published source answers null — the chip is the correct render', () => {
  // No archive for the collection (~277 colourways, every leather).
  assert.equal(chSwatchSource('Vidar', 'Vidar 1062'), null);
  assert.equal(chSwatchSource('Thor', 'Thor 310'), null);
  assert.equal(chSwatchSource('Focus Royal', 'Focus Royal 34'), null);
  // No colourway number at all.
  assert.equal(chSwatchSource('Cowhide', 'Cowhide Brown White'), null);
  assert.equal(chSwatchSource('Canvas', 'Canvas'), null);
  assert.equal(chSwatchSource(null, null), null);

  // The group label naming the PRICE GROUP instead of the collection is the
  // common tree shape; the leaf's own name carries the collection and saves it.
  const viaLeaf = chSwatchSource('Fabric Group 1', 'Canvas 0224');
  assert.equal(viaLeaf.collection, 'canvas-2');
  assert.equal(viaLeaf.imageId, chSwatchImageId('canvas-2', '0224'));
  // …and the id is content-addressed, so every axis/model/session that shows
  // this colourway reads the SAME cached row: fetched once, ever.
  assert.equal(chSwatchImageId('canvas-2', '0224'), 'chswatch-canvas-2-0224');
});

test('coverage is counted, not implied — the screen can say how partial it is', () => {
  const options = [
    { label: 'Canvas 0224', groupLabel: 'Canvas' },
    { label: 'Canvas 0356', groupLabel: 'Canvas' },
    { label: 'Hall.dal 130', groupLabel: 'Hall.dal' },
    { label: 'Vidar 1062', groupLabel: 'Vidar' },
    { label: 'Thor 310', groupLabel: 'Thor' },
    { label: 'Cowhide Brown White', groupLabel: 'Cowhide' },
  ];
  assert.deepEqual(chSwatchCoverage(options), { total: 6, withSource: 3, missing: 3 });
  assert.deepEqual(chSwatchCoverage([]), { total: 0, withSource: 0, missing: 0 });
  assert.deepEqual(chSwatchCoverage(null), { total: 0, withSource: 0, missing: 0 });
});

// ── 5. the browser glue never downloads an archive ───────────────────────────

/** Source with its comments removed — the pin below asks what the file DOES,
 *  and a header that names the banned shapes in order to forbid them must not
 *  read as the file using them. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('chSwatchFetch reads by RANGE only — one fetch, no whole-archive unzipper', () => {
  const file = fileURLToPath(new URL('../src/components/carlhansen/chSwatchFetch.js', import.meta.url));
  const src = codeOnly(readFileSync(file, 'utf8'));

  // ONE CALL SITE — not one request: a mint performs TWO (the directory, then
  // the entry), both through this single function, which is exactly why "it
  // always ranges" is checkable by reading one line.
  const fetches = src.match(/\bfetchImpl\(|\bfetch\(/g) || [];
  assert.equal(fetches.length, 2, 'one fetch call site + the browser adapter that supplies it');
  assert.match(
    src,
    /fetchImpl\(url,\s*\{\s*headers:\s*\{\s*Range:\s*header\s*\},\s*signal\s*\}\)/,
    'the one call site must carry a Range AND an abort signal — a plain GET here downloads up to 490 MB, '
    + 'and an unabortable one cannot be stopped once started',
  );
  assert.match(
    src,
    /res\.status !== 206/,
    'a 200 means the peer ignored the Range and is handing over the whole archive — refuse at the headers',
  );
  // fflate/JSZip take the WHOLE archive in memory: their presence would mean
  // the range discipline was abandoned.
  for (const banned of ['unzipSync', 'fflate', 'JSZip', 'unzip(']) {
    assert.ok(!src.includes(banned), `chSwatchFetch.js must not unzip whole archives (found "${banned}")`);
  }
  // The pure decisions stay pure: the reader and the plan are imported, not
  // re-implemented (a second zip reader is how two opinions start drifting).
  assert.match(src, /readCentralDirectory/);
  assert.match(src, /planSwatchRead/);
  assert.ok(!src.includes('0x06054b50'), 'no second ZIP parser — zipRead.ts owns the binary format');
  // A print master is 4–6 MB of CMYK: cached as STORED BYTES, never linked to
  // as a CDN pointer the browser would download in full.
  assert.match(src, /externalUrl: null/);
});

// ── 6. THE LOADER, EXECUTED — the queue, the memo, the brake, the ceiling ────
//
// Everything below RUNS `createChSwatchLoader` against the in-memory archive
// above, with only the four effects faked (fetch, decode, store, cache index).
// The zip parsing, the two-range mint, the queue and the cancellation are the
// real code. This section exists because the file previously had ZERO execution
// coverage — it was scanned, never run — which is how a stop button that did
// not stop shipped green.

const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** A caller that never settles is its own defect (a spinner that spins forever
 *  and a promise nobody can await), so it must fail as an ASSERTION and not as
 *  a hung test file that takes the rest of the suite down with it. */
const HUNG = Symbol('hung');
function orHang(promise, ms = 250) {
  let timer;
  // Deliberately NOT unref'd: this timer is the only thing keeping the loop
  // alive while a broken cancel leaves promises parked, and without it Node
  // exits mid-test and the runner reports "cancelled by parent" for the whole
  // FILE instead of the one honest assertion failure.
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(HUNG), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

/** An HTTP peer that honours Range over `zip`, counts every request, and can
 *  HOLD responses open so concurrency and cancellation are deterministic. */
function fakeArchiveServer(zip, { gated = false, status = 206 } = {}) {
  const calls = [];
  const held = [];
  let bodyReads = 0;
  return {
    calls,
    bodyReads: () => bodyReads,
    inFlight: () => held.length,
    release() { held.splice(0).forEach((w) => w.resolve()); },
    async fetchImpl(url, { headers = {}, signal } = {}) {
      const header = String(headers.Range || '');
      calls.push({ url, header });
      if (gated) {
        await new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          held.push(waiter);
          signal?.addEventListener?.('abort', () => {
            const at = held.indexOf(waiter);
            if (at >= 0) held.splice(at, 1);
            reject(abortError());
          });
        });
      }
      if (signal?.aborted) throw abortError();
      const m = /^bytes=(\d*)-(\d*)$/.exec(header);
      assert.ok(m, `the loader must always range; got "${header}"`);
      const [start, end] = m[1] === ''
        ? [Math.max(0, zip.length - Number(m[2])), zip.length]
        : [Number(m[1]), Math.min(zip.length, Number(m[2]) + 1)];
      const slice = new Uint8Array(zip.subarray(start, end));
      return {
        status,
        headers: {
          get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${start}-${end - 1}/${zip.length}` : null),
        },
        body: { cancel() {} },
        async arrayBuffer() { bodyReads += 1; return slice.buffer; },
      };
    },
  };
}

function testLoader(server, options = {}) {
  const stored = [];
  const loader = createChSwatchLoader({
    fetchImpl: server.fetchImpl,
    // The real decode needs createImageBitmap; what matters here is that it
    // receives the entry's REAL inflated bytes.
    toChip: async (bytes, name) => ({ size: bytes.length, name }),
    storeChip: async (source, chip) => {
      stored.push({ id: source.imageId, size: chip.size });
      return `https://bucket/${source.imageId}.webp`;
    },
    cachedUrls: async () => new Map(),
    ...options,
  });
  return { loader, stored };
}

const canvasSource = (code) => chSwatchSource('Canvas', `Canvas ${code}`);

test('a mint is exactly TWO ranged requests: the directory, then the one entry', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader, stored } = testLoader(server);

  const url = await loader.load(canvasSource('0224'), { allowFetch: true });
  assert.equal(url, 'https://bucket/chswatch-canvas-2-0224.webp');
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls[0].header, `bytes=-${128 * 1024}`, 'the directory comes off the TAIL');

  const entry = /^bytes=(\d+)-(\d+)$/.exec(server.calls[1].header);
  assert.ok(entry, 'the entry read is an explicit range, never an open GET');
  assert.ok(Number(entry[2]) - Number(entry[1]) + 1 < CANVAS_ZIP.length, 'and it is not the archive');
  // The chip really came from the archive's own bytes.
  assert.deepEqual(stored, [{ id: 'chswatch-canvas-2-0224', size: MASTER('0224').length }]);

  // Asked again, the session answers from memory — fetched once, ever.
  assert.equal(await loader.load(canvasSource('0224'), { allowFetch: true }), url);
  assert.equal(server.calls.length, 2);
});

test('the directory is read ONCE however many swatches come out of the archive', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader, stored } = testLoader(server);

  await Promise.all(['0224', '0356', '0784'].map((c) => loader.load(canvasSource(c), { allowFetch: true })));

  assert.equal(server.calls.filter((c) => c.header.startsWith('bytes=-')).length, 1, 'ONE directory read');
  assert.equal(server.calls.length, 4, '1 directory + 3 entries');
  assert.equal(stored.length, 3);
  assert.equal(loader.stats().directories, 1);
});

test('THE BRAKE: turning the switch off drains the queue AND aborts what is in flight', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP, { gated: true });
  const { loader, stored } = testLoader(server);

  const jobs = ['0224', '0356', '0784'].map(
    (c) => loader.load(canvasSource(c), { allowFetch: true }).catch((e) => e),
  );
  await flush();
  // Two slots, one shared directory read: the third job is waiting for a slot.
  assert.equal(server.inFlight(), 1);
  assert.equal(loader.stats().pending, 1);

  server.release();
  await flush();
  assert.equal(server.inFlight(), 2, 'MAX_PARALLEL holds — never three entry reads at once');

  const stopped = loader.cancelAll();
  assert.deepEqual(stopped, { dropped: 1, aborted: 2 });

  const results = await Promise.all(jobs.map((j) => orHang(j)));
  assert.ok(!results.includes(HUNG), 'every caller SETTLES — a drained waiter must not hang forever');
  assert.ok(results.every((r) => r instanceof Error && isSwatchCancelled(r)),
    'and settles as CANCELLED, not as a silent success');
  assert.equal(stored.length, 0, 'nothing was uploaded after the brake was pulled');

  // …and nothing restarts behind the dealer's back.
  const after = server.calls.length;
  server.release();
  await flush();
  assert.equal(server.calls.length, after, 'no request survives the cancel');
  assert.equal(loader.stats().pending, 0);
  assert.equal(loader.stats().inFlight, 0);
});

test('THE BRAKE holds even before anything is queued — a cancel during the index lookup', async () => {
  // The gap this pins: `load` awaits the cached-image index BEFORE it queues
  // anything, so a dealer who taps ON and immediately OFF leaves a whole axis
  // of callers parked at that await with an EMPTY queue and NOTHING in flight.
  // A cancel that only drains and aborts stops none of them, and every one
  // starts fetching the instant the index resolves — after the brake.
  const server = fakeArchiveServer(CANVAS_ZIP);
  let releaseIndex;
  const gate = new Promise((res) => { releaseIndex = res; });
  const { loader, stored } = testLoader(server, { cachedUrls: async () => { await gate; return new Map(); } });

  const jobs = ['0224', '0356', '0784'].map(
    (c) => loader.load(canvasSource(c), { allowFetch: true }).catch((e) => e),
  );
  await flush();
  assert.equal(loader.stats().pending, 0, 'nothing is queued yet — the index has not answered');
  assert.equal(server.calls.length, 0);

  loader.cancelAll();
  releaseIndex();

  const results = await Promise.all(jobs.map((j) => orHang(j)));
  assert.ok(!results.includes(HUNG));
  assert.equal(server.calls.length, 0, 'NOT ONE byte after the brake — not even the directory');
  assert.equal(stored.length, 0);
});

test('a peer that ignores Range is refused AT THE HEADERS — its body is never read', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP, { status: 200 });
  const { loader } = testLoader(server);

  await assert.rejects(
    () => loader.load(canvasSource('0224'), { allowFetch: true }),
    /no respetó el rango/,
  );
  // A 200 here IS the whole archive: reading it would be the 490 MB download
  // the module forbids.
  assert.equal(server.bodyReads(), 0);
});

test('the byte budget is a hard ceiling, checked BEFORE the bytes are spent', async () => {
  // The ceiling is set one byte under what this entry costs, so the refusal is
  // about the arithmetic and not about a round number.
  const cost = planSwatchRead(CANVAS_DIR.entries, '0224').entry.compressedSize;
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader, stored } = testLoader(server, { byteBudget: cost - 1 });

  await assert.rejects(() => loader.load(canvasSource('0224'), { allowFetch: true }), /límite de descarga/);
  assert.equal(server.calls.length, 1, 'only the cheap directory read happened');
  assert.equal(stored.length, 0);
  assert.equal(loader.stats().budgetSpent, true);

  // Once spent, further requests answer null instead of queueing more work.
  assert.equal(await loader.load(canvasSource('0356'), { allowFetch: true }), null);
  assert.equal(server.calls.length, 1);

  // …and a ceiling that DOES cover the read lets it through: the guard refuses
  // what it cannot afford, not everything.
  const afford = testLoader(fakeArchiveServer(CANVAS_ZIP), { byteBudget: cost });
  assert.ok(await afford.loader.load(canvasSource('0224'), { allowFetch: true }));
});

test('a colourway the archive does not carry is RECORDED, and the banner subtracts it', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader, stored } = testLoader(server);
  let notified = 0;
  loader.subscribe(() => { notified += 1; });

  // The collection HAS an archive, so the source resolves — but 9999 is not one
  // of its colourways. This is exactly the case the coverage caption used to
  // count as a swatch forever.
  const source = canvasSource('9999');
  assert.ok(source, 'the source is an upper bound: collection known, colourway unproven');
  assert.equal(await loader.load(source, { allowFetch: true }), null);
  assert.equal(stored.length, 0);
  assert.ok(loader.missingIds().has('chswatch-canvas-2-9999'));
  assert.ok(notified >= 1, 'the UI is told, so the count can correct itself');

  const options = [
    { label: 'Canvas 0224', groupLabel: 'Canvas' },
    { label: 'Canvas 9999', groupLabel: 'Canvas' },
  ];
  assert.deepEqual(chSwatchCoverage(options), { total: 2, withSource: 2, missing: 0 });
  assert.deepEqual(
    chSwatchCoverage(options, { unavailable: loader.missingIds() }),
    { total: 2, withSource: 1, missing: 1 },
  );

  // A confirmed absence is remembered: the archive is not re-read for it.
  const calls = server.calls.length;
  assert.equal(await loader.load(source, { allowFetch: true }), null);
  assert.equal(server.calls.length, calls);
});

test('an already-cached swatch costs NO network at all', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader } = testLoader(server, {
    cachedUrls: async () => new Map([['chswatch-canvas-2-0224', 'https://bucket/prev.webp']]),
  });

  assert.equal(await loader.load(canvasSource('0224'), { allowFetch: false }), 'https://bucket/prev.webp');
  assert.equal(server.calls.length, 0);
});

test('with fetching not allowed, an uncached swatch answers null and touches nothing', async () => {
  const server = fakeArchiveServer(CANVAS_ZIP);
  const { loader } = testLoader(server);

  assert.equal(await loader.load(canvasSource('0224')), null);
  assert.equal(await loader.load(null, { allowFetch: true }), null);
  assert.equal(server.calls.length, 0);
});

// ── 7. supplier text is not a key into Object.prototype ──────────────────────

test('a collection named like an Object member resolves to nothing, not to a builtin', () => {
  for (const nasty of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    assert.equal(typeof chCollectionKey(nasty), 'string', `${nasty} must not return a function`);
    assert.deepEqual(materialZipsFor(nasty), []);
    assert.equal(chProductImageUrl(nasty), null);
  }
  assert.equal(chCollectionKey('constructor'), 'constructor');
});

// ── 8. §12a — the sizing lever, and the key it must never invent ─────────────

test('PressCloud renditions are built from the asset key’s own shard', () => {
  assert.deepEqual([...PRESSCLOUD_SIZES], ['thumb', 'preview', 'canvas']);
  assert.equal(
    pressCloudImageUrl('822790217756557', 'thumb'),
    'https://assets.presscloud.com/file/82/822790217756557/thumb.jpg',
  );
  assert.equal(
    pressCloudImageUrl('822790217756557', 'preview'),
    'https://assets.presscloud.com/file/82/822790217756557/preview.jpg',
  );
  // Nothing that isn't a real key becomes a url — a 404'd <img> is the failure
  // this whole module is shaped to avoid.
  assert.equal(pressCloudImageUrl('CH24', 'thumb'), null);
  assert.equal(pressCloudImageUrl('', 'thumb'), null);
  assert.equal(pressCloudImageUrl(null), null);
  assert.equal(pressCloudImageUrl('822790217756557', 'original'), null);
});

test('re-sizing touches PressCloud urls ONLY — admincms comes back byte-identical', () => {
  const asset = 'https://assets.presscloud.com/file/82/822790217756557/CH24_oak.jpg';
  assert.equal(pressCloudSizedUrl(asset, 'thumb'), 'https://assets.presscloud.com/file/82/822790217756557/thumb.jpg');
  assert.equal(pressCloudSizedUrl(asset, 'preview'), 'https://assets.presscloud.com/file/82/822790217756557/preview.jpg');

  // §12a: this host ignores every resize param, so appending one buys nothing
  // and costs a cache-busting query string.
  const cms = 'https://admincms.carlhansen.com/globalassets/products/ch24/ch24_oak.jpg';
  assert.equal(pressCloudSizedUrl(cms, 'thumb'), cms);
  assert.ok(!pressCloudSizedUrl(cms, 'thumb').includes('width'));
  assert.equal(pressCloudSizedUrl('', 'thumb'), '');
  assert.equal(pressCloudSizedUrl(null), '');
});

test('the model → PressCloud key map is EMPTY on purpose, so no card gets a guessed url', () => {
  assert.deepEqual(
    Object.keys(CH_PRESSCLOUD_KEYS),
    [],
    'TODO: fill from a real showroom product-index capture. A 15-digit key cannot be derived from "CH24".',
  );
  assert.equal(chProductImageUrl('CH24', 'thumb'), null);

  // …and with no key, a card keeps exactly the source it has today: the lever
  // is armed and inert, never a regression.
  const cms = 'https://admincms.carlhansen.com/globalassets/products/ch24/cover.jpg';
  assert.equal(chCoverImageUrl('CH24', cms, 'thumb'), cms);
  assert.equal(chCoverImageUrl('', cms, 'thumb'), cms);
  assert.equal(chCoverImageUrl('CH24', '', 'thumb'), '');
  // A card whose photo already lives on PressCloud gets the 15 KB rendition
  // without any mapping at all.
  assert.equal(
    chCoverImageUrl('CH24', 'https://assets.presscloud.com/file/60/600414306847395/hero.jpg', 'thumb'),
    'https://assets.presscloud.com/file/60/600414306847395/thumb.jpg',
  );
});
