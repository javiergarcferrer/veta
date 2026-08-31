/**
 * The Carl Hansen 3D INGRESS: read a zip's directory without downloading the
 * zip, decide whether the archive is web geometry at all, and propose which
 * mesh material answers to which configurator axis.
 *
 * Three things are pinned here and nothing else — the conversion itself is
 * EXISTING machinery (sceneImport → splitScene → exportPieceGlb →
 * uploadTogoMesh) and the last test in this file fails if anyone rebuilds it:
 *
 *   1. the binary reader, against zips this file BUILDS with node:zlib so the
 *      round trip is real (stored + deflated + a refused method + a truncated
 *      tail). `inflateRaw` is INJECTED, which is the only reason a browser
 *      module that normally runs on DecompressionStream can be tested in Node.
 *   2. classifyZip against the MEASURED entry lists (§8): CH24 obj+mtl ⇒ tier a,
 *      CH07 obj without mtl ⇒ tier b, and the plain <MODEL>.zip — a Revit .rfa,
 *      NOT the 3D zip — ⇒ none.
 *   3. buildBindingPlan: one plan shape, tier B differing only by source,
 *      confidence and needsReview.
 *
 * No network, no three.js, no fixtures on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readCentralDirectory, localDataRange, inflateEntry, crc32 } from '../src/brands/carl-hansen/zipRead.ts';
import { classifyZip } from '../src/brands/carl-hansen/assetTier.ts';
import { buildBindingPlan, materialKindOf } from '../src/brands/carl-hansen/materialBind.ts';

// ── a minimal ZIP writer, so the reader is tested against real bytes ─────────

/**
 * Build a zip. `method` 0 stores, 8 deflates, anything else is written with the
 * bytes STORED but the method DECLARED — the shape of an archive we must refuse
 * rather than decode.
 *
 * The LOCAL header gets an extra field that the CENTRAL directory does NOT
 * (an 'UT' timestamp, exactly like a real zip writer): that mismatch is the
 * whole reason localDataRange over-fetches and inflateEntry re-reads the local
 * header instead of computing the data offset from the directory.
 */
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
    local.writeUInt16LE(0, 6);
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

/** The bytes localDataRange asks for, clamped to the archive like HTTP Range. */
const rangeOf = (zip, entry) => {
  const { start, end } = localDataRange(entry);
  return new Uint8Array(zip.subarray(start, Math.min(end, zip.length)));
};

const OBJ = 'g CH24_seat\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'.repeat(40);
const MTL = 'newmtl CH24_seat\nKd 0.8 0.7 0.5\nnewmtl CH24_Beech_Bright_\nKd 0.9 0.8 0.6\n';

// ── 1. the binary reader ─────────────────────────────────────────────────────

test('the directory is read from the TAIL alone, and every entry round-trips', async () => {
  const zip = buildZip([
    { name: 'CH24.obj', data: OBJ, method: 8 },
    { name: 'CH24.mtl', data: MTL, method: 0 },              // stored, not deflated
    { name: 'textures/beech_bright.png', data: 'PNG-bytes', method: 8 },
  ]);
  // Only the last 512 bytes — the whole point: 8-22 MB never crosses the wire.
  const tail = new Uint8Array(zip.subarray(Math.max(0, zip.length - 512)));
  const { entries, truncated } = readCentralDirectory(tail, zip.length);

  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => e.name), ['CH24.obj', 'CH24.mtl', 'textures/beech_bright.png']);
  assert.deepEqual(entries.map((e) => e.method), [8, 0, 8]);
  assert.equal(entries[0].uncompressedSize, Buffer.byteLength(OBJ));
  assert.ok(entries[0].compressedSize < entries[0].uncompressedSize, 'the obj really is deflated');

  for (const [i, expected] of [OBJ, MTL, 'PNG-bytes'].entries()) {
    const out = await inflateEntry(entries[i], rangeOf(zip, entries[i]), inflateRaw);
    assert.equal(Buffer.from(out).toString('utf8'), expected, entries[i].name);
  }
});

test('localDataRange covers the LOCAL header, whose extra field the directory does not know', async () => {
  // The local extra is 9 bytes here and 0 in the directory. Computing the data
  // offset from the directory would land 9 bytes early and decode garbage.
  const zip = buildZip([{ name: 'CH24.obj', data: OBJ, method: 8 }]);
  const [entry] = readCentralDirectory(new Uint8Array(zip.subarray(-256)), zip.length).entries;
  const { start, end } = localDataRange(entry);

  assert.equal(start, entry.localHeaderOffset, 'the range starts at the local header, not at the data');
  const naiveDataStart = start + 30 + entry.nameLength + entry.extraLength;
  assert.ok(end >= naiveDataStart + entry.compressedSize, 'and over-fetches past any local extra field');

  const out = await inflateEntry(entry, rangeOf(zip, entry), inflateRaw);
  assert.equal(Buffer.from(out).toString('utf8'), OBJ);
});

test('an unsupported compression method is refused BY NAME, without calling the inflater', async () => {
  const zip = buildZip([{ name: 'CH103.obj', data: OBJ, method: 12 }]);   // bzip2
  const { entries } = readCentralDirectory(new Uint8Array(zip.subarray(-256)), zip.length);
  assert.equal(entries[0].method, 12, 'the directory still LISTS it — refusal happens at decode');

  let called = 0;
  await assert.rejects(
    () => inflateEntry(entries[0], rangeOf(zip, entries[0]), () => { called += 1; return new Uint8Array(); }),
    /bzip2/,
    'the error names the method it refused',
  );
  assert.equal(called, 0, 'never hand unverified bytes to an inflater that cannot read them');
});

test('corrupt bytes fail the CRC the archive itself carries — never emitted as content', async () => {
  const zip = buildZip([{ name: 'CH24.mtl', data: MTL, method: 0 }]);
  const { entries } = readCentralDirectory(new Uint8Array(zip.subarray(-256)), zip.length);
  const bytes = rangeOf(zip, entries[0]);
  // One flipped byte, INSIDE the entry's data (past the local header + its own
  // name + its own extra field — the offsets only the local header knows).
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[30 + head.getUint16(26, true) + head.getUint16(28, true)] ^= 0xff;
  await assert.rejects(() => inflateEntry(entries[0], bytes, inflateRaw), /CRC/);
});

test('a tail too short to hold the directory reports truncated instead of throwing', () => {
  const zip = buildZip([
    { name: 'CH24.obj', data: OBJ, method: 8 },
    { name: 'CH24.mtl', data: MTL, method: 8 },
  ]);
  // The EOCD is in the tail; the central directory it points at is not.
  const short = readCentralDirectory(new Uint8Array(zip.subarray(-30)), zip.length);
  assert.deepEqual(short, { entries: [], truncated: true });

  // No EOCD at all (a tail read of the middle of the file, or a non-zip).
  const junk = readCentralDirectory(new Uint8Array(64), 1_000_000);
  assert.deepEqual(junk, { entries: [], truncated: true });

  // Empty / nonsense input is the same answer, never an exception.
  assert.deepEqual(readCentralDirectory(new Uint8Array(0), 0), { entries: [], truncated: true });
});

// ── 2. classifyZip, against the MEASURED archives (§8) ───────────────────────

// ch24_3d-2.zip — the shape 92% of the 3D zips have: an .obj with its .mtl,
// beside the CAD/Max originals the browser cannot open.
const CH24_ZIP = [
  { name: 'CH24.obj' }, { name: 'CH24.mtl' }, { name: 'CH24.3ds' },
  { name: 'CH24.max' }, { name: 'CH24.dwg' },
  { name: 'beech_bright.png' }, { name: 'beech_br.png' }, { name: 'brushedsteel_tnt.png' },
  { name: 'reflection_brass.png' }, { name: 'DarkgreenFabric.png' },
];

// CH07 — 12 groups `ch07_00…ch07_11`, ZERO usemtl, no .mtl in the archive.
const CH07_ZIP = [
  { name: '3d_ch07/ch07.obj' }, { name: '3d_ch07/ch07.3ds' }, { name: '3d_ch07/ch07.dwg' },
  { name: '3d_ch07/beech_bright.png' }, { name: '3d_ch07/DarkgreenFabric.png' },
  { name: '3d_ch07/Fabric_bump.png' }, { name: '3d_ch07/leather_bump.png' },
];

test('CH24: obj + mtl ⇒ tier A, and the .obj wins over the .3ds/.max/.dwg beside it', () => {
  const got = classifyZip(CH24_ZIP);
  assert.equal(got.tier, 'a');
  assert.equal(got.reason, 'mesh-with-mtl');
  assert.equal(got.mesh, 'CH24.obj');
  assert.equal(got.mtl, 'CH24.mtl');
  assert.equal(got.textures.length, 5);
  assert.ok(!got.textures.some((t) => /\.(max|dwg|3ds)$/i.test(t)));
});

test('CH07: a mesh with NO mtl ⇒ tier B — the textures are the only semantic signal', () => {
  const got = classifyZip(CH07_ZIP);
  assert.equal(got.tier, 'b');
  assert.equal(got.reason, 'mesh-without-mtl');
  assert.equal(got.mesh, '3d_ch07/ch07.obj');
  assert.equal(got.mtl, null);
  assert.deepEqual(got.textures, [
    '3d_ch07/beech_bright.png', '3d_ch07/DarkgreenFabric.png',
    '3d_ch07/Fabric_bump.png', '3d_ch07/leather_bump.png',
  ]);
});

test('the plain <MODEL>.zip is a Revit .rfa — NOT the 3D zip, and never web geometry', () => {
  const got = classifyZip([{ name: 'CH24.rfa' }]);
  assert.deepEqual(got, { tier: 'none', mesh: null, mtl: null, textures: [], reason: 'revit-only' });

  // Its neighbours get their own reasons, so the UI can say WHY nothing loaded.
  assert.equal(classifyZip([{ name: 'CH45.max' }]).reason, 'max-only');
  assert.equal(classifyZip([{ name: 'CH45.dwg' }, { name: 'CH45.pdf' }]).reason, 'cad-only');
  assert.equal(classifyZip([{ name: 'readme.txt' }]).reason, 'no-mesh');
  assert.equal(classifyZip([]).reason, 'empty');
  assert.equal(classifyZip(null).tier, 'none');
});

test('archive noise is not content: folder records, __MACOSX and resource forks', () => {
  const got = classifyZip([
    { name: '3d/', directory: true },
    { name: '__MACOSX/3d/._CH25.obj' },
    { name: '3d/._CH25.mtl' },
    { name: '3d/.DS_Store' },
    { name: '3d/CH25.obj' },
  ]);
  assert.equal(got.tier, 'b', 'the resource fork of the mtl is not an mtl');
  assert.equal(got.mesh, '3d/CH25.obj');
});

// ── 3. buildBindingPlan — ONE shape, two tiers ───────────────────────────────

// CH24_Frame is Wood → species → treatment (12 leaves); CH24_Seat is the paper
// cord (01/02); CH24_ExtraMont are the gliders, priced but never modelled.
const CH24_AXES = [
  { id: 'CH24_Frame', kind: 'wood', label: 'Wood' },
  { id: 'CH24_Seat', kind: 'weaving', label: 'Cord' },
  { id: 'CH24_ExtraMont', kind: null, label: 'Gliders' },
];

test('Tier A (CH24): the MTL names bind wood and cord on their own', () => {
  const plan = buildBindingPlan({
    tier: 'a',
    materialNames: ['CH24_seat', 'CH24_Beech_Bright_'],
    textureNames: ['beech_bright.png'],
    axes: CH24_AXES,
  });

  assert.equal(plan.needsReview, false, 'tier A is auto-bindable — that is what makes it tier A');
  assert.deepEqual(plan.groups.map((g) => [g.name, g.axisId, g.source]), [
    // `CH24_seat` IS the tree's own key: identity, the strongest signal a
    // 2009-era export can give — and on a Wishbone the seat IS the paper cord,
    // so no material word appears in the name at all.
    ['CH24_seat', 'CH24_Seat', 'mtl'],
    // `beech` ⇒ wood ⇒ the Frame axis, which carries all 13 wood groups.
    ['CH24_Beech_Bright_', 'CH24_Frame', 'mtl'],
  ]);
  assert.ok(plan.groups.every((g) => g.confidence >= 0.8));
  // The gliders axis models no mesh; that alone must never fail a Wishbone.
  assert.ok(!plan.groups.some((g) => g.axisId === 'CH24_ExtraMont'));
});

test('Tier A (CH25): five materials, and the one with no axis stays UNBOUND', () => {
  const plan = buildBindingPlan({
    tier: 'a',
    materialNames: ['ch25_wicker__cray_', 'ch25_wicker_back', 'ch25_oak__tnt_', 'ch25_wicker__cray___tnt_', 'Brushed_Steel_Max'],
    axes: [{ id: 'CH25_Frame', kind: 'wood' }, { id: 'CH25_Seat', kind: 'weaving' }],
  });
  const by = Object.fromEntries(plan.groups.map((g) => [g.name, g.axisId]));
  assert.equal(by.ch25_wicker__cray_, 'CH25_Seat');
  assert.equal(by.ch25_wicker_back, 'CH25_Seat');
  assert.equal(by.ch25_oak__tnt_, 'CH25_Frame', 'the lacquer suffix never outranks the species');
  assert.equal(by.Brushed_Steel_Max, null, 'no metal axis on this model — say so, do not invent one');
  assert.equal(plan.needsReview, true);
});

test('Tier B (CH07): the SAME plan shape, read from texture basenames, always reviewed', () => {
  const axes = [{ id: 'CH07_Frame', kind: 'wood' }, { id: 'CH07_SeatBack', kind: 'upholstery' }];
  const plan = buildBindingPlan({
    tier: 'b',
    // Generic by definition — reading them would manufacture confidence.
    materialNames: ['ch07_00', 'ch07_01', 'ch07_11'],
    textureNames: classifyZip(CH07_ZIP).textures,
    axes,
  });

  assert.equal(plan.needsReview, true, 'no MTL ⇒ a human decides which mesh wears what');
  assert.ok(plan.groups.every((g) => g.source === 'texture'));
  assert.ok(plan.groups.every((g) => g.confidence < 0.8), 'a texture proves the axis EXISTS, not which group wears it');
  assert.deepEqual(plan.groups.map((g) => [g.name, g.axisId]), [
    ['beech_bright.png', 'CH07_Frame'],
    ['DarkgreenFabric.png', 'CH07_SeatBack'],
    ['Fabric_bump.png', 'CH07_SeatBack'],
    ['leather_bump.png', 'CH07_SeatBack'],
  ]);
  assert.ok(!plan.groups.some((g) => /^ch07_/.test(g.name)), 'the generic group names contribute nothing');
});

test('Tier B collapses a material’s map variants into ONE proposal', () => {
  const plan = buildBindingPlan({
    tier: 'b',
    textureNames: ['brushedsteel_tnt.png', 'reflection_brass.png', 'brass_bump.png', 'logo.png'],
    axes: [{ id: 'CH103_Metal', kind: 'metal' }],
  });
  assert.deepEqual(plan.groups.map((g) => g.name), ['brushedsteel_tnt.png', 'reflection_brass.png']);
  assert.ok(plan.groups.every((g) => g.axisId === 'CH103_Metal'));
});

test('nothing to bind: none-tier and axis-less plans are empty and reviewed, never thrown', () => {
  assert.deepEqual(buildBindingPlan({ tier: 'none', materialNames: ['CH24_seat'] }), { groups: [], needsReview: true });
  const noAxes = buildBindingPlan({ tier: 'a', materialNames: ['CH24_seat'], axes: [] });
  assert.deepEqual(noAxes.groups, [{ name: 'CH24_seat', axisId: null, confidence: 0, source: 'mtl' }]);
  assert.equal(noAxes.needsReview, true);
});

test('the material-word table reads the families the selection trees actually expose', () => {
  assert.equal(materialKindOf('CH24_Beech_Bright_'), 'wood');
  assert.equal(materialKindOf('ch25_wicker__cray_'), 'cord');
  assert.equal(materialKindOf('DarkgreenFabric'), 'upholstery');
  assert.equal(materialKindOf('leather_bump'), 'upholstery');
  assert.equal(materialKindOf('Brushed_Steel_Max'), 'metal');
  assert.equal(materialKindOf('oak_soap'), 'wood', 'a finish word never outranks the substance');
  assert.equal(materialKindOf('CH24_seat'), null, 'a PART name is not a material word');
  assert.equal(materialKindOf(''), null);
  assert.equal(materialKindOf(null), null);
});

// ── the ANTI-REBUILD pin ─────────────────────────────────────────────────────

test('the browser importer REUSES the existing pipeline — no second OBJ/GLB stack', (t) => {
  const file = fileURLToPath(new URL('../src/components/carlhansen/chMeshImport.js', import.meta.url));
  if (!existsSync(file)) {
    t.skip('chMeshImport.js not written yet — this pin arms itself the moment it is');
    return;
  }
  const src = readFileSync(file, 'utf8');
  assert.match(src, /sceneImport/, 'load through sceneImport.js (loadSceneFile / loadPiecesFromFiles), not a new loader');
  for (const banned of ['GLTFExporter', 'new THREE.BufferGeometry', 'newmtl', 'usemtl']) {
    assert.ok(
      !src.includes(banned),
      `chMeshImport.js must not re-implement the mesh pipeline (found "${banned}"). `
      + 'GLB export is exportPieceGlb; material NAMES come off the loaded scene’s materials '
      + '(meshParts.partKeyFor), never from parsing .obj/.mtl text.',
    );
  }
});
