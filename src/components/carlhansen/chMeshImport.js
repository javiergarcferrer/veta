/**
 * Carl Hansen 3D → a servable GLB, ENTIRELY IN THE BROWSER.
 *
 * This module is GLUE and nothing else. Every hard part already exists and is
 * pinned by its own test, so the job here is to compose them in the one order
 * that works:
 *
 *   Range-read the zip TAIL  → `zipRead.readCentralDirectory`   (a few KB, not 22 MB)
 *   decide what it even is   → `assetTier.classifyZip`          (tier a / b / none)
 *   Range-read ONE entry     → `zipRead.localDataRange` + `inflateEntry`
 *   load + split + re-export → `components/configurator/sceneImport`    (the existing pipeline)
 *   publish                  → `db/configuratorMeshUpload` (bucket `togo-models`)
 *   record                   → `carl_hansen_assets`
 *
 * ⚠ THE RANGE READS GO THROUGH THE EDGE FUNCTION, NOT THE CDN — measured with a
 * real CORS preflight, 2026-08-06. A `Range` header makes a fetch NON-SIMPLE,
 * so the browser sends OPTIONS first, and admincms answers:
 *
 *   access-control-allow-origin:  *
 *   access-control-allow-headers: Origin, X-Requested-With, Content-Type,
 *                                 Accept, X-Token            ← no `Range`
 *
 * The browser therefore never sends the request, and «Inspeccionar ZIP» died
 * with a bare "Failed to fetch". A `*` origin is NOT the whole answer: a header
 * this app needs has to be listed too, and only an OPTIONS carrying
 * `Access-Control-Request-Headers: range` can tell you. (The swatch archives on
 * assets.presscloud.com DO list `Range`, which is why `chSwatchFetch.js` still
 * reads those directly — same trick, different host, opposite verdict.)
 *
 * Only the TRANSPORT moved. The function is a byte mover: it hands back the raw
 * tail and one bounded range, and every zip decision stays here on top of
 * `brands/carl-hansen/zipRead.js`, so no second parser exists across the Deno↔Vite
 * wall to drift against this one.
 *
 * WHAT THIS FILE MUST NEVER GROW: an .obj/.mtl text parser, a glTF writer, a
 * decimator, a Draco/meshopt encoder. `sceneImport` already creases at 60°,
 * welds, quantizes POSITION→Int16 / NORMAL→Int8, splits solids, repairs .3ds
 * material groups and downsizes bundled bitmaps to 1024 px. The last test in
 * tests/carlHansen3d.test.js fails if any of that is re-implemented here.
 *
 * AND NEVER a `togo_models` row: that table feeds the PUBLIC dealer
 * configurator, and a Carl Hansen piece landing in it would leak the range into
 * a storefront. The mesh machinery and the bucket are shared; the row shape is
 * not.
 */
import { readCentralDirectory, localDataRange, inflateEntry } from '../../brands/carl-hansen/zipRead.js';
import { classifyZip } from '../../brands/carl-hansen/assetTier.js';
import { buildBindingPlan } from '../../brands/carl-hansen/materialBind.js';
import { partKeyFor } from '../../lib/configurator/meshParts.js';
import { ACCEPT_TEXTURES, loadPiecesFromFiles, exportPieceGlb } from '../configurator/sceneImport.js';
import { ALCOVER_MESH_V } from '../configurator/modelLoader.js';
import { uploadConfiguratorMesh, removeConfiguratorMesh } from '../../db/configuratorMeshUpload.js';
import { db, TEAM_PROFILE_ID } from '../../db/database.js';
import { supabase } from '../../db/supabaseClient.js';

/** A zip's directory lives at its END. 128 KB covered every measured archive
 *  (70 read this way); a truncated read says so and is retried wider ONCE. */
const TAIL_BYTES = 128 * 1024;
const WIDE_TAIL_BYTES = 1024 * 1024;

const baseName = (path) => String(path || '').split('/').pop() || 'archivo';

/**
 * The bitmaps `sceneImport` itself takes as SIDECARS, derived from its own
 * accept list so the two can never disagree about what a sidecar is. The
 * archives also ship `.tif`/`.tiff` maps: no browser decodes them, and handing
 * one to the loader would both waste the download and surface as a false
 * "no se pudo leer" casualty. Tier-B binding still reads EVERY texture name
 * (names come off the directory, not off the bytes), so nothing is lost.
 */
const SIDECAR_RE = new RegExp(
  `(${ACCEPT_TEXTURES.split(',').map((e) => e.trim().replace('.', '\\.')).join('|')})$`,
  'i',
);

const slugify = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'modelo-3d';

/**
 * The injected inflater `zipRead` asks for — the browser's own, so no zip
 * dependency enters the bundle. (The Node test injects `zlib.inflateRawSync`
 * into the same seam, which is the only reason a binary reader is testable.)
 */
const inflateRaw = async (deflated) => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador no puede descomprimir el archivo (falta DecompressionStream).');
  }
  const stream = new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/* ------------------------------------------------------------- transporte -- */

/**
 * WHICH STEP FAILED, in words the dealer can act on.
 *
 * "Failed to fetch" is what the browser says when a preflight refuses a header,
 * and it told nobody anything — least of all which of the three reads broke.
 * Each stage names itself and carries the FUNCTION'S OWN message when there is
 * one ("el archivo 3D respondió HTTP 404", "rango inválido…"), because that
 * text is the whole diagnosis and supabase-js drops it by default: a non-2xx
 * arrives as a `FunctionsHttpError` with `data` null and the body still sitting
 * unread on the attached Response.
 */
const STAGE_LABEL = {
  directory: 'No se pudo leer el directorio del ZIP',
  entry: 'No se pudo bajar una entrada del ZIP',
  convert: 'No se pudo convertir la geometría',
};

const STAGE_HINT = {
  directory: 'El archivo 3D se lee a través de la función carl-hansen; revisa la sesión y la conexión.',
  entry: 'La malla o una de sus texturas no llegó completa.',
  convert: 'El archivo llegó bien pero el lector de mallas no pudo abrirlo.',
};

function chStageError(stage, detail) {
  const text = String(detail ?? '').trim();
  const head = STAGE_LABEL[stage] || 'Falló la lectura del archivo 3D';
  return new Error(text ? `${head}: ${text}` : `${head}. ${STAGE_HINT[stage] || ''}`.trim());
}

/** The function's own `{error}` off a non-2xx, which supabase-js leaves unread. */
async function functionMessage(fnError) {
  const ctx = fnError?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      const msg = body?.error ?? body?.message;
      if (msg) return String(msg);
    } catch { /* body consumed or not JSON — fall through */ }
  }
  return fnError?.message || '';
}

/**
 * THE ONE DOOR TO THE ARCHIVE, and it is the edge function (see the header
 * note: admincms's preflight does not allow `Range`, so a direct browser read
 * is blocked before it leaves the machine).
 */
async function chZipOp(op, body, stage) {
  let data;
  let fnError;
  try {
    ({ data, error: fnError } = await supabase.functions.invoke('carl-hansen', { body: { op, ...body } }));
  } catch (e) {
    throw chStageError(stage, e?.message || '');
  }
  if (fnError) throw chStageError(stage, await functionMessage(fnError));
  if (!data || data.ok === false) throw chStageError(stage, data?.error || '');
  return data;
}

/** base64 → bytes. The tail rides in JSON because the reply also carries
 *  `totalSize`, and a header cannot come back through `functions.invoke`. */
function fromBase64(value) {
  const bin = atob(String(value || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The LAST `tail` bytes of the archive, plus its full size.
 *
 * `totalSize` is what turns an offset inside the tail into an absolute offset
 * in the archive; the function reads it off `Content-Range`, so one round trip
 * answers both questions and no HEAD is needed.
 */
async function tailRead(zipUrl, tail) {
  const data = await chZipOp('zipIndex', { url: zipUrl, tail }, 'directory');
  const bytes = fromBase64(data.tail);
  const total = Number(data.totalSize);
  return { bytes, total: Number.isFinite(total) && total > 0 ? total : bytes.length };
}

/** One bounded range, as bytes. `[start, end]` inclusive, the shape the
 *  function validates and re-emits. */
async function entryRead(zipUrl, start, end) {
  const data = await chZipOp('zipFetch', { url: zipUrl, range: `bytes=${start}-${end}` }, 'entry');
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // `functions.invoke` hands an `application/octet-stream` reply back as a Blob.
  if (typeof data?.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw chStageError('entry', 'la función devolvió algo que no son bytes');
}

/**
 * The archive's file list and what it makes the archive BE — for the price of
 * a few kilobytes, before anything decides to download 22 MB of it.
 *
 * @returns {Promise<{entries: object[], truncated: boolean, totalSize: number,
 *                    classification: object}>}
 */
export async function readChZipDirectory(zipUrl) {
  if (!zipUrl) throw new Error('Este modelo no tiene archivo 3D publicado.');
  let read = await tailRead(zipUrl, TAIL_BYTES);
  let dir = readCentralDirectory(read.bytes, read.total);
  if (dir.truncated && read.bytes.length < read.total) {
    // The file table started before the window. Widening is the CLIENT's call
    // because the client is the only side that parses: the function never looks
    // inside the bytes it moves.
    read = await tailRead(zipUrl, Math.min(WIDE_TAIL_BYTES, read.total));
    dir = readCentralDirectory(read.bytes, read.total);
  }
  return { ...dir, totalSize: read.total, classification: classifyZip(dir.entries) };
}

/** ONE entry out of the archive, as a `File` the loader can eat. The range
 *  starts at the LOCAL header (see `localDataRange`) and is clamped to the
 *  archive; `inflateEntry` verifies signature, method, length and CRC-32 before
 *  a single byte is handed on — so a truncated relay is caught, never loaded. */
async function fileFromEntry(zipUrl, entry, totalSize) {
  const { start, end } = localDataRange(entry);
  const bytes = await entryRead(zipUrl, start, Math.min(end, totalSize) - 1);
  return new File([await inflateEntry(entry, bytes, inflateRaw)], baseName(entry.name));
}

/**
 * Convert one model's 3D archive and store the result.
 *
 * @param {object}   opts
 * @param {string}   opts.modelId  the PIM model id — the `carl_hansen_assets` PK.
 * @param {string}   opts.zipUrl   the published archive (kept as `meshSourceUrl`,
 *                                 so the piece stays re-convertible forever).
 * @param {string}  [opts.zipName]
 * @param {Array}   [opts.axes]    the configurator axes (`{id, kind, label}`) the
 *                                 binding plan joins the mesh materials onto.
 * @param {Function}[opts.onProgress] `({phase, note})` — 'directory' | 'download'
 *                                 | 'convert' | 'export' | 'upload' | 'save'.
 */
export async function convertChZip({ modelId, zipUrl, zipName = '', axes = null, onProgress = null } = {}) {
  if (!modelId) throw new Error('Falta el modelo al que pertenece el archivo 3D.');
  const say = (phase, note = '') => onProgress?.({ phase, note });

  say('directory', zipName || baseName(zipUrl));
  const { entries, truncated, totalSize, classification } = await readChZipDirectory(zipUrl);
  if (truncated) throw chStageError('directory', 'llegó incompleto; vuelve a intentarlo');
  if (classification.tier === 'none' || !classification.mesh) {
    throw new Error('El archivo no trae geometría que el navegador pueda abrir.');
  }

  // ONLY what the loader can use. The `.max`/`.dwg`/`.rfa` siblings are most of
  // the archive's weight and none of its value — that is the whole reason the
  // directory is read first.
  const byName = new Map(entries.map((e) => [e.name, e]));
  const maps = classification.textures.filter((name) => SIDECAR_RE.test(name));
  const files = [await fileFromEntry(zipUrl, byName.get(classification.mesh), totalSize)];
  for (const [i, name] of maps.entries()) {
    say('download', `${i + 1}/${maps.length} · ${baseName(name)}`);
    // A bitmap that won't come down costs that map, never the import — the same
    // rule `sceneImport` applies to a bitmap that won't decode.
    try { files.push(await fileFromEntry(zipUrl, byName.get(name), totalSize)); } catch { /* sin ese mapa */ }
  }

  say('convert', baseName(classification.mesh));
  const { THREE, pieces, failed } = await loadPiecesFromFiles(files, {
    onProgress: (p) => say('convert', p.current),
  });
  if (!pieces.length) {
    throw chStageError('convert', failed?.[0]?.error || 'no se detectaron piezas en el archivo 3D');
  }
  // ONE archive is ONE product: whatever the footprint clustering separated
  // (a chair and its loose cushion) is still the same piece of furniture, so it
  // exports as one mesh instead of becoming several models.
  const meshes = pieces.flatMap((p) => p.meshes);

  // The material NAMES come off the LOADED SCENE — the same keys the runtime
  // binds by (`partKeyFor`, node index for an unnamed material), and the same
  // node order `exportPieceGlb` walks. Reading them out of the archive's text
  // instead would be a second parser with a second opinion.
  const materialNames = [...new Set(meshes.flatMap((m, i) => (
    (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => partKeyFor(mat?.name, i))
  )))];
  const binding = buildBindingPlan({
    tier: classification.tier,
    materialNames,
    textureNames: classification.textures,
    axes: (axes || []).map((a) => ({ id: a?.id, kind: a?.kind ?? null, label: a?.label ?? null })),
  });

  say('export');
  const blob = await exportPieceGlb(THREE, meshes);
  say('upload', `${(blob.size / 1048576).toFixed(1)} MB`);
  const meshUrl = await uploadConfiguratorMesh(
    new File([blob], `ch-${slugify(modelId)}.glb`, { type: 'model/gltf-binary' }),
  );

  say('save');
  const previous = await db.carlHansenAssets.get(modelId).catch(() => null);
  const row = {
    id: modelId,
    profileId: TEAM_PROFILE_ID,
    sourceZipUrl: zipUrl,
    sourceZipName: zipName || baseName(zipUrl),
    meshTier: classification.tier,
    meshUrl,
    // The ORIGINAL archive, so a future pipeline version can re-convert from
    // the source instead of re-exporting an already-baked GLB.
    meshSourceUrl: zipUrl,
    meshV: ALCOVER_MESH_V,
    binding,
    // A re-conversion can change the material set, so an OLD confirmation must
    // not carry over onto a NEW proposal — the human looks again.
    bindingReviewedAt: null,
    ingestedAt: Date.now(),
  };
  await db.carlHansenAssets.put(row);
  // Best-effort: the superseded GLB is nobody's source of truth once the row
  // points elsewhere, and leaving it litters the bucket.
  if (previous?.meshUrl && previous.meshUrl !== meshUrl) await removeConfiguratorMesh(previous.meshUrl);

  say('done');
  return { ...row, classification, materialNames, failed: failed || [] };
}

/**
 * Stamp the human's confirmed material→axis map.
 *
 * The machine PROPOSES and the dealer CONFIRMS (the `classifyPartGroups`
 * precedent): tier B always arrives `needsReview`, and only what a person
 * signed off on is stored as reviewed. `bindingReviewedAt` is what flips the
 * asset state from `needs-review` to `ready`.
 */
export async function saveChBindingReview(modelId, groups) {
  if (!modelId) throw new Error('Falta el modelo.');
  // A confirmation with no converted mesh behind it would UPDATE zero rows and
  // read as saved. There is nothing to bind before there is a mesh, so say so.
  const row = await db.carlHansenAssets.get(modelId);
  if (!row) throw new Error('Todavía no hay malla convertida para este modelo.');
  await db.carlHansenAssets.update(modelId, {
    binding: { groups: groups || [], needsReview: false },
    bindingReviewedAt: Date.now(),
  });
}
