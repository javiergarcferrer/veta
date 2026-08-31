/**
 * Rendered PERSPECTIVE thumbnails for the Togo models — a small offscreen
 * three.js render of each piece (the real FBX, the studio rig), framed at a
 * flattering 3/4 angle and exported as a PNG data URL. These replace the
 * hand-drawn wireframes in the picker/hotbar/selected-piece header so every
 * model reads as a true rendered representation of its shape, consistent with
 * the live 3D stage (same builder, same lighting).
 *
 * One shared offscreen renderer is reused for every model (created lazily, kept
 * for the session); pieces render sequentially so they never contend for the
 * GPU. The heavy three import is code-split via safeDynamicImport, exactly like
 * the live stage, so the picker stays light until a thumbnail is actually wanted.
 */
import { useEffect, useState } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { inferConfiguratorForm } from '../../lib/configurator/model.js';
import { loadConfiguratorModels } from './modelLoader.js';
import { buildConfiguratorGroup, setupConfiguratorStage, disposeGroup, makeFabricMaps, sampleSwatchColor, fabricAnisotropy, STANDARD_CONFIGURATOR_FINISH } from './sceneBuilder.js';
import { loadFabricAppearance, makeAppearanceCache } from './fabricAppearance.js';
import { lruGet, lruSet, revokeObjectUrl } from '../../lib/lruCache.js';

// The thumbnail frame, in the ASPECT the tiles actually display at (4:3 — the
// collection index, the piece grid, the drawer rows are all wide boxes). It used
// to render SQUARE, and every one of those tiles shows it `object-contain`: a
// square image in a 4:3 box is height-limited, so a quarter of the tile's width
// was structurally unusable before the piece was even framed. A sofa is the
// widest thing we draw, and it was being handed the narrowest frame we had.
//
// The frame is a FIXED DEVICE resolution, and the renderer's pixel ratio is
// pinned to 1 to keep it that way. It used to be 384×288 scaled by the
// visitor's DPR, which made the OUTPUT depend on the machine that happened to
// render it — and these are CACHED IMAGES shown in CSS-sized boxes, so that is
// backwards twice over: a DPR-1 laptop minted a 384-px file for a ~400-px tile
// (upscaled, soft), and a DPR-3 phone minted 768 px for a tile it paints across
// ~1050 device px (upscaled again). Neither device was ever asked how big the
// picture is; the tile was. 1024×768 covers the largest box any surface gives a
// piece — the collection hero, `aspect-[4/3]` of a full phone column, hovered
// to 1.05 — with the piece itself spanning THUMB_FILL of it.
const THUMB_W = 1024, THUMB_H = 768;

// ── The frame each SURFACE asks for ─────────────────────────────────────────
// A render costs its PIXELS, twice over: the GPU draw plus a synchronous PNG
// encode of the read-back, on the main thread, once per model. THUMB_W/H is the
// biggest frame any surface could want — and the catalogue index was spending it
// on every tile, 38 of them, to paint boxes measured at 358×263 CSS px on a
// phone and 291×212 on a desktop (the splash grid, measured). That is ~8× more
// pixels than the box, ~177 KB of PNG each, and ~20 s of blocking to walk the
// index — for detail that has nowhere to land.
//
// So the frame is now a per-CALL opt, and each surface names its own. The
// default stays the full frame: the callers that need it (the back-office
// catalogue's own previews) keep exactly what they had, and a new caller that
// says nothing is never silently downgraded.
//
//  • TILE — the 4:3 catalogue tile (collection index, piece grid, drawer, pane).
//    512 px across the widest of those boxes is 1.43× its CSS width on the phone
//    splash and ~1.8–2.5× on the narrower panels. These are soft-shaded pieces
//    on a white plate, not type or line art, so that reads sharp at display size
//    while costing a QUARTER of the pixels.
//  • ROW — the Resumen / cotización rows, 48 CSS px squares showing a 4:3 render
//    object-contain (so ~48 px across). 256 is 5× that; it renders per (piece ×
//    fabric), which is the one thing a customer changes over and over.
export const TILE_THUMB = { width: 512, height: 384 };
export const ROW_THUMB = { width: 256, height: 192 };
// Bounds for a requested frame — a caller can't ask for a 1-pixel thumbnail or a
// GPU-melting one.
const FRAME_MIN = 96, FRAME_MAX = 2048;
const frameDim = (v, fallback) => Math.min(FRAME_MAX, Math.max(FRAME_MIN, Math.round(Number(v) || fallback)));

// How much of the frame the piece spans, 0..1 of the half-extent. Short of 1 so
// the raking key's ground shadow isn't sliced off at the edge.
const THUMB_FILL = 0.9;
// The render caches are LRU-BOUNDED and revoke what they evict. They used to
// grow for the whole session with nothing ever released: every (model × fabric)
// a customer tries mints another PNG, so ten pieces against twenty fabrics is two
// hundred blobs — tens of megabytes pinned on a phone that is in the middle of
// building something, and a tab the OS kills for memory takes the build with it.
// The count was sized against the FULL frame (110 × 786k ≈ 86 Mpx), which is now
// the worst case rather than the common one: the catalogue tiles that actually
// fill this cache ask for TILE_THUMB, a quarter of the pixels. Left where it is
// deliberately — it is a memory ceiling, and what used to justify raising it (a
// visitor scrolling back up into tiles that had aged out) is now answered by the
// cross-visit store below, which re-paints them without a render.
const THUMB_CACHE_MAX = 110;
const SCENE_CACHE_MAX = 12;
const cache = new Map();                  // `${modelId}:${fabricCode}` → object URL (LRU)
const colorCache = new Map();             // fabric code → sampled hex (or null), session-lived

// The ONE shape the server's snapshot decoder accepts
// (`snapshotBytesFromDataUrl`, togo-embed/dealer.ts) — mirrored character for
// character so the browser's gate and the Edge Function's gate can never
// disagree about what a snapshot IS. A `blob:` URL matches nothing here, which
// is exactly the point: it is a HANDLE into this tab's memory, meaningless the
// moment it leaves the browser.
const PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** Does this string carry the PNG BYTES (base64, in-band) rather than point at
 *  them? The wire test for anything that leaves the device. */
export function isPngDataUrl(url) {
  return typeof url === 'string' && PNG_DATA_URL_RE.test(url);
}

/** The rendered canvas as a PNG DATA URL — the bytes INSIDE the string, so it
 *  survives leaving the browser (a lead payload, a stored image). Pure over the
 *  canvas so the wire shape is testable without a GPU; null on a tainted or
 *  unencodable canvas. */
export function canvasPngDataUrl(cv) {
  try {
    const url = cv?.toDataURL?.('image/png');
    return isPngDataUrl(url) ? url : null;
  } catch { return null; }
}

/** The rendered canvas as an <img>-able URL. `toBlob` rather than `toDataURL`:
 *  the data URL it replaces was a ~120 KB base64 STRING per thumbnail, encoded
 *  synchronously on the main thread and then held in React state — with a
 *  catalogue's worth of pieces that is megabytes of string churn during the
 *  exact seconds the visitor is waiting for the first screen. A blob URL costs a
 *  handle, and the PNG encode happens off-thread. Session-lived like the cache
 *  it lands in, so nothing to revoke. Falls back to the old path wherever
 *  `toBlob` isn't there or hands back nothing.
 *
 *  `encode: 'dataUrl'` opts OUT of all that — for the one consumer whose image
 *  does not stay in this tab (the lead's composition snapshot, POSTed to the
 *  Edge Function). An object URL is a per-document handle: it left the browser
 *  as ~55 characters of `blob:https://…/uuid`, sailed through a length gate
 *  written for base64, and decoded to nothing server-side, so EVERY lead
 *  stored a null image. Anything that crosses the wire asks for the bytes. */
function canvasUrl(cv, encode = 'objectUrl') {
  if (encode === 'dataUrl') return Promise.resolve(canvasPngDataUrl(cv));
  return canvasImage(cv).then((img) => img?.url ?? null);
}

/** The rendered canvas as a PNG BLOB (encoded off-thread), or null. */
function canvasBlob(cv) {
  return new Promise((resolve) => {
    if (typeof cv?.toBlob !== 'function') { resolve(null); return; }
    try { cv.toBlob((blob) => resolve(blob || null), 'image/png'); } catch { resolve(null); }
  });
}

/** `{ url, blob }` — the object URL this tab paints from AND the bytes behind
 *  it, so the same encode can be written to the cross-visit store without a
 *  second pass over the canvas. `blob: null` on the fallback path (no `toBlob`):
 *  that render still shows, it just isn't persisted. */
async function canvasImage(cv) {
  const blob = await canvasBlob(cv);
  if (blob) {
    try { return { url: URL.createObjectURL(blob), blob }; } catch { /* fall through to the data URL */ }
  }
  try { const url = cv.toDataURL('image/png'); return url ? { url, blob: null } : null; } catch { return null; }
}

// The lead payload's snapshot budget, in CHARACTERS of the data URL — which is
// what the browser can measure. The server refuses over SNAPSHOT_MAX_BYTES
// (1_500_000 decoded); base64 is 4 chars per 3 bytes, so this sits ~75 KB of
// bytes inside its budget and the two gates agree on every real snapshot.
export const SNAPSHOT_MAX_URL_CHARS = 1_900_000;

/** The `snapshot` field for a lead payload, or null when there is nothing
 *  sendable. Null is a complete answer: the request travels without a picture,
 *  never with one the server will silently drop. */
export function snapshotFieldFor(url) {
  if (!isPngDataUrl(url)) return null;
  return url.length <= SNAPSHOT_MAX_URL_CHARS ? url : null;
}

/* ── The cross-visit thumbnail store ─────────────────────────────────────────
 *
 * The LRU above is SESSION memory: it dies with the tab, so a visitor who comes
 * back tomorrow — or reloads, or reopens the widget — pays the entire catalogue
 * again. The GLBs themselves are HTTP-cached, so what repeats is the expensive
 * half: the parse, the GPU draw and the PNG encode, once per tile.
 *
 * So the encoded PNGs persist. Cache Storage rather than IndexedDB because these
 * ARE responses — blobs in, blobs out, no serialisation, and the browser evicts
 * the whole store under pressure instead of failing a write mid-catalogue.
 *
 * EVERY path here is best-effort. Cache Storage is absent on an insecure origin,
 * blocked in some private modes, and partitioned or denied outright when this
 * widget runs as a third-party iframe on a dealer's own domain — which is its
 * main deployment. A store that isn't there must cost exactly what it did
 * before: a render. Nothing in this section is ever awaited by a caller that
 * paints, and nothing here can throw into one.
 */
const THUMB_STORE = 'togo-thumbs-v1';   // the version is the RIG: bump it when a
                                        // change to the frame, lighting or
                                        // material makes stored PNGs wrong, and
                                        // every older generation is dropped on
                                        // the next open (see openThumbStore).
const THUMB_STORE_MAX = 200;            // entries; trimmed to KEEP when exceeded
const THUMB_STORE_KEEP = 150;

/** A short, stable digest of a string (FNV-1a, two lanes → base36). Not a
 *  security hash: it exists so a key can carry the model's whole render-relevant
 *  CONTENT without carrying a 100-character storage URL. */
function fingerprint(text) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

/**
 * THE PICTURE'S FINGERPRINT — the row's render-relevant content, and the thing
 * that decides whether anyone sees today's piece or last month's.
 *
 * There is no `updatedAt` on a payload model to lean on, so this IS the stamp:
 * the mesh (url + the scale/axis/rotation applied to it), the footprint the
 * piece is fitted to, the name the procedural form is inferred from, and the
 * collection. `mesh.url` alone would not do it — a mesh is only ever REPLACED,
 * never edited in place (`uploadConfiguratorMesh` mints a fresh `crypto.randomUUID()`
 * path with `upsert: false`, so a re-upload always changes the URL) — but a
 * piece can also be re-dimensioned, renamed or moved to another collection on
 * the same mesh, and each of those changes the picture.
 *
 * READS EITHER SHAPE, and normalizes: the back-office bakes from a `togo_models`
 * ROW (`meshUrl`, `meshScale`, …) and the widget checks the baked stamp against
 * the PAYLOAD model (`mesh: {url, scale, …}`, collection defaulted to 'Togo').
 * Those are the same piece, so they must fingerprint identically — otherwise
 * every baked thumbnail reads as stale and the widget quietly renders the whole
 * catalogue anyway, which is the exact cost the bake exists to remove.
 */
export function configuratorThumbStamp(model) {
  if (!model) return '';
  const mesh = model.mesh || null;
  // JSON, not a joined string: it delimits the fields unambiguously, so a URL
  // that happens to contain the separator can't make two different pieces
  // fingerprint the same.
  return fingerprint(JSON.stringify([
    (mesh?.url ?? model.meshUrl) || '',
    Number(mesh?.scale ?? model.meshScale) || null,
    (mesh?.upAxis ?? model.meshUpAxis) || 'y',
    Number(mesh?.rotateY ?? model.meshRotateY) || 0,
    Number(model.widthCm) || null,
    Number(model.depthCm) || null,
    model.name || model.label || '',
    model.collection || 'Togo',
  ]));
}

/**
 * The BAKED image to use for this exact render, or null to render it here.
 *
 * THE STAMP IS THE STORE KEY. A row carries a picture and the key it was baked
 * under, and the key already encodes everything that makes two renders two
 * different images: the piece's content, the FRAME and the CLOTH. So the check
 * is one string comparison, and it can only ever hand back an image of THIS
 * piece, at THIS size, in THIS fabric.
 *
 * That is what keeps the catalogue self-healing. A model that has been
 * re-dimensioned, renamed, re-meshed or re-dressed since the bake no longer
 * matches its own stamp: this returns null, the widget renders it live (slower,
 * correct) and the studio's next pass re-bakes it. A slow tile is survivable;
 * the wrong piece in a Ligne Roset catalogue is not.
 *
 * TWO SLOTS, same rule. `thumb*` is the bare-body catalogue tile every piece
 * gets; `heroThumb*` is the one DRESSED render a collection's cover needs (the
 * fabricked path is per piece × cloth and can never be baked wholesale, but the
 * covers are a handful of images and they are the first screen anyone sees).
 */
export function bakedThumbUrl(model, opts = null) {
  const key = configuratorThumbStoreKey(model, opts || {});
  if (!key) return null;
  if (model.thumbUrl && model.thumbStamp === key) return String(model.thumbUrl);
  if (model.heroThumbUrl && model.heroThumbStamp === key) return String(model.heroThumbUrl);
  return null;
}

/**
 * The store key for one rendered thumbnail — pure, and what the per-device
 * Cache Storage entry is named.
 *
 * The picture's fingerprint (above) plus the two things that make one piece two
 * different images: the render FRAME (two frames are not a hit at the wrong
 * size) and the CLOTH it is dressed in, when the render is fabricked.
 */
export function configuratorThumbStoreKey(model, { code = '', fab = null, width, height } = {}) {
  if (!model?.id) return null;
  const w = frameDim(width, THUMB_W), h = frameDim(height, THUMB_H);
  const stamp = fingerprint(JSON.stringify([
    configuratorThumbStamp(model),
    fab ? [fab.textureUrl || '', fab.normalUrl || '', fab.rgb || null, !!fab.tint] : null,
  ]));
  // A same-origin path: Cache Storage keys on a Request, so it must be a real
  // URL. Nothing ever FETCHES it — it is a name, not an endpoint.
  return `/__configurator-thumb/${encodeURIComponent(model.id)}/${w}x${h}/${encodeURIComponent(code || '-')}/${stamp}.png`;
}

let storePromise;
/** The open store, or null forever if this browser/context won't give us one. */
function openThumbStore() {
  if (storePromise !== undefined) return storePromise;
  storePromise = (async () => {
    if (typeof caches === 'undefined' || !caches?.open) return null;
    const store = await caches.open(THUMB_STORE);
    // Lazy wipe of earlier generations: a rig bump renames the store, so the old
    // one is dead weight in the origin's quota. Best-effort, once per session.
    try {
      for (const name of await caches.keys()) {
        if (name !== THUMB_STORE && name.startsWith('togo-thumbs-')) await caches.delete(name);
      }
    } catch { /* enumeration denied — the current store still works */ }
    return store;
  })().catch(() => null);
  return storePromise;
}

/** A stored PNG as a fresh object URL, or null. The ONLY thing on the hit path,
 *  and it touches no GPU state — which is why it runs OUTSIDE the render chain
 *  (see renderConfiguratorThumb): a warm catalogue then paints without queueing behind
 *  anything, and without waiting a frame per tile. */
async function readStoredThumb(key) {
  if (!key) return null;
  try {
    const store = await openThumbStore();
    if (!store) return null;
    const res = await store.match(key);
    if (!res) return null;
    const blob = await res.blob();
    if (!blob?.size) return null;
    return URL.createObjectURL(blob);
  } catch { return null; }
}

// Entry count, discovered on the first write and tracked from there — so the
// bound costs one `keys()` per session rather than one per write.
let storeCount = -1;
// Writes are the only thing here that can fail REPEATEDLY (a full origin quota
// fails every single put). Three in a row and this session stops asking: reads
// keep working, and the catalogue simply behaves as it did before the store.
let storeWriteFails = 0;
const STORE_WRITE_GIVE_UP = 3;
/** WRITE-BEHIND: the render has already returned its URL by the time this runs.
 *  Bounded FIFO by insertion order (Cache Storage keeps `keys()` in that order,
 *  and a re-put replaces in place) — not true LRU, but the entries it drops are
 *  the ones a visitor stopped coming back to, and the memory LRU above is what
 *  protects the working set. */
function writeStoredThumb(key, blob) {
  if (!key || !blob || storeWriteFails >= STORE_WRITE_GIVE_UP) return;
  (async () => {
    const store = await openThumbStore();
    if (!store) return;
    await store.put(key, new Response(blob, { headers: { 'Content-Type': 'image/png' } }));
    storeWriteFails = 0;
    if (storeCount < 0) storeCount = (await store.keys()).length;
    else storeCount += 1;
    if (storeCount <= THUMB_STORE_MAX) return;
    const keys = await store.keys();
    for (const req of keys.slice(0, Math.max(0, keys.length - THUMB_STORE_KEEP))) await store.delete(req);
    storeCount = THUMB_STORE_KEEP;
  })().catch(() => { storeWriteFails += 1; storeCount = -1; });   // quota/denied — recount next time
}

/** Hand the main thread back between thumbnails. One render is an FBX parse, a
 *  normals rebuild, a GPU draw and a PNG encode; a queue of them run back to
 *  back never yields, so taps land late and the panel that is filling in can't
 *  paint — the app reads as stuck precisely while it works. One frame between
 *  renders is invisible to the fill rate and gives input and paint their turn. */
function breathe() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

/** The dominant colour (hex) of a fabric swatch, sampled once and cached — the
 *  SAME read the live stage does, so a Resumen thumbnail matches the placed
 *  piece. CORS-clean via the swatch-proxy; a failure resolves to null (oatmeal). */
async function colorForCode(THREE, code) {
  if (!code) return null;
  if (colorCache.has(code)) return colorCache.get(code);
  const url = swatchProxyUrl(code) || swatchUrl(code);
  if (!url) { colorCache.set(code, null); return null; }
  try {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    const c = sampleSwatchColor(tex.image); tex.dispose?.();
    colorCache.set(code, c ?? null);
    return c ?? null;
  } catch { colorCache.set(code, null); return null; }
}

let enginePromise = null;
async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const [THREE, { RoomEnvironment }, { RoundedBoxGeometry }] = await Promise.all([
      safeDynamicImport(() => import('three')),
      safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
      safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
    ]);
    const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    // 1, deliberately: THUMB_W/H are already device pixels (see above), so a
    // DPR multiplier here would re-introduce the machine-dependent output.
    renderer.setPixelRatio(1);
    renderer.setSize(THUMB_W, THUMB_H);
    renderer.shadowMap.enabled = true;
    // PCF, not PCFSoft — same reason as ConfiguratorStage: three r184 deprecated
    // PCFSoftShadowMap and falls back to this exact value on the first shadow
    // pass, so naming it costs nothing and drops the warning.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);        // transparent — sits on any card
    const scene = new THREE.Scene();
    // Presentation lighting: these render ONE piece alone on a white card, where
    // the live stage's soft colour-true wash flattens it to a silhouette.
    const { dispose: disposeStage, retarget } = setupConfiguratorStage(deps, renderer, scene, 120, { presentation: true });
    scene.background = null;                     // keep it transparent (stage set a colour)
    const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE, {
      anisotropy: fabricAnisotropy(renderer),
    });
    const camera = new THREE.PerspectiveCamera(28, THUMB_W / THUMB_H, 1, 6000);
    return { THREE, deps, renderer, scene, camera, quilt, grain, disposeStage, retarget, fabricCache: makeAppearanceCache() };
  })();
  return enginePromise;
}

// All renders share ONE offscreen renderer/scene, so they MUST run one at a time
// — two concurrent calls (the hotbar's generic hook + the Resumen's per-fabric
// hook) would otherwise add both groups to the scene at once and cross-render.
// Chain every call through this promise so they serialise (and the chain survives
// a single failure).
let renderChain = Promise.resolve();
// How many renders are enqueued and not yet settled, INCLUDING the one running.
// It is read synchronously at enqueue time to answer one question: am I queueing
// behind somebody? If so, yield a frame before starting.
let queuedRenders = 0;

/**
 * Put one render on the shared chain.
 *
 * The `breathe()` between thumbnails used to live in the HOOKS' own loops, which
 * meant it only covered the surfaces that loop — and the boot path does not.
 * On the opening screen every tile in range fires its own `renderConfiguratorThumb`
 * (useLazyThumb), so a dozen land on the chain at once and ran back to back with
 * nothing between them: the tiles were in the DOM but the thread was gone for
 * seconds, so nothing was hit-testable and nothing painted. The yield belongs
 * where the queue is, not in one caller's loop.
 *
 * Only when queueing BEHIND something, so a single isolated render (the selected
 * piece's header, a fabric pick) still starts immediately.
 */
function enqueueRender(run) {
  const behind = queuedRenders > 0;
  queuedRenders += 1;
  const go = () => (behind ? breathe().then(run) : run());
  const next = renderChain.then(go, go);
  renderChain = next.then(() => {}, () => {});
  const done = () => { queuedRenders -= 1; };
  next.then(done, done);
  return next;
}

/**
 * A model's thumbnail: the session cache, then the cross-visit store, then — and
 * only then — a render.
 *
 * The two cache reads deliberately happen OFF the chain. They touch no shared
 * GPU state, so serialising them would buy nothing and cost everything: a
 * returning visitor's whole catalogue is hits, and behind the chain each one
 * would still wait its turn (and a frame) for work that never happens. Off the
 * chain, a warm index paints with zero renders and zero queueing.
 */
export function renderConfiguratorThumb(model, opts = {}) {
  return resolveConfiguratorThumb(model, opts);
}

// One resolution per key at a time. The grid asks for the same piece from more
// than one place (a tile and its Resumen row, two mounted surfaces), and without
// this each of them opens the store separately — two reads of one entry, and two
// object URLs for one blob where only the last is in the cache to be revoked.
const inflight = new Map();               // session cache key → Promise<url|null>

async function resolveConfiguratorThumb(model, opts) {
  if (!model?.id) return null;
  // THE BAKED PICTURE SHORT-CIRCUITS EVERYTHING. An image the back-office
  // already rendered is a plain public URL: no three bundle, no mesh download,
  // no GPU pass, no PNG encode, and nothing to cache here (the browser caches it
  // like any other image). This is the one choke point every surface reaches a
  // thumbnail through, so the picker, the drawer, the collection index and the
  // studio all get it from this single check — and anything NOT baked (a piece
  // in the cloth a customer just picked) falls straight through to the renderer
  // exactly as before. By then they have chosen a piece, which is precisely when
  // loading its mesh is worth it.
  const baked = bakedThumbUrl(model, opts);
  if (baked) return baked;
  const memKey = thumbCacheKey(model, opts);
  const cached = lruGet(cache, memKey);
  if (cached !== undefined) return cached;
  const running = inflight.get(memKey);
  if (running) return running;
  const job = (async () => {
    const stored = await readStoredThumb(configuratorThumbStoreKey(model, opts));
    if (stored) {
      // Into the session LRU as an ordinary entry, so it is revoked on evict
      // like any render — a hit is indistinguishable from one downstream.
      lruSet(cache, memKey, stored, THUMB_CACHE_MAX, revokeObjectUrl);
      return stored;
    }
    return enqueueRender(() => _renderConfiguratorThumb(model, opts));
  })();
  inflight.set(memKey, job);
  const clear = () => { if (inflight.get(memKey) === job) inflight.delete(memKey); };
  job.then(clear, clear);
  return job;
}

/** The SESSION key. Keyed on the model's DIMENSIONS (the thumbnail is sized by
 *  widthCm/depthCm — the fit-to-footprint in placeRealModel — so a dims edit
 *  must re-render) and on the render FRAME (the same piece at two frames is two
 *  images). */
function thumbCacheKey(model, { code = '', fab = null, width, height } = {}) {
  const w = frameDim(width, THUMB_W), h = frameDim(height, THUMB_H);
  return `${model.id}:${Number(model.widthCm) || 90}x${Number(model.depthCm) || 90}:${code}:${fab ? 'w' : 'f'}@${w}x${h}`;
}

/** Render ONE model to a PNG data URL, in the given fabric (`opts.code`) or the
 *  default oatmeal body when no code. `opts.fab` is the per-code appearance
 *  descriptor the catalog carries (`{ textureUrl, normalUrl, rgb, tint, pbr }` —
 *  an entry of the configurator's `fabricByCode`): with it the thumbnail gets the
 *  REAL WEAVE the live stage renders, instead of a flat hue sampled off the CDN
 *  swatch photo. Without it the old flat-colour path stands unchanged.
 *  `opts.width/height` ask for a smaller FRAME — the catalogue tiles do, at half
 *  the full frame's width and a quarter of its pixels (see TILE_THUMB); omitted
 *  it renders the full frame exactly as before. Cached by `thumbCacheKey`. */
async function _renderConfiguratorThumb(model, opts = {}) {
  if (!model?.id) return null;
  const { code = '', fab = null } = opts;
  const frameW = frameDim(opts.width, THUMB_W), frameH = frameDim(opts.height, THUMB_H);
  const cacheKey = thumbCacheKey(model, opts);
  // Re-checked HERE and not only in resolveConfiguratorThumb: several tiles can queue the
  // same piece before the first of them renders, and the one that wins must be
  // the only one that draws.
  const cached = lruGet(cache, cacheKey);
  if (cached !== undefined) return cached;
  let eng;
  try { eng = await getEngine(); } catch { return null; }
  const { THREE, deps, renderer, scene, camera, quilt, grain } = eng;
  // With a descriptor, resolve the full appearance (weave + relief + pCon PBR)
  // through the SAME module the live stage and the launch-card turntable use, so
  // a thumbnail can never drift from the piece it stands for. Without one, fall
  // back to sampling the CDN swatch for a flat hue.
  const look = fab ? await loadFabricAppearance(THREE, code, fab, eng.fabricCache) : null;
  const color = look ? look.color : await colorForCode(THREE, code);
  const w = Number(model.widthCm) || 90, d = Number(model.depthCm) || 90;
  const form = inferConfiguratorForm(model.name || model.label || '', w, d);
  const piece = { uid: 't', widthCm: w, depthCm: d, form, x: 0, z: 0, rotationDeg: 0, fabricCode: code, collection: model.collection || null, mesh: model.mesh || null };

  let group = null;
  // The rig is shared, so the frame is set for THIS render and handed back in
  // the `finally` — same contract `_renderConfiguratorSceneThumb` already keeps.
  renderer.setSize(frameW, frameH);
  camera.aspect = frameW / frameH;
  camera.updateProjectionMatrix();
  try {
    const loaded = await loadConfiguratorModels({ pieces: [piece] });
    // Render the preview EXACTLY as the placed piece reads: the standard velvet
    // (terciopelo) finish in the chosen fabric colour (or the oatmeal body when
    // none), so the thumbnail matches what's on the plan and reads its shape.
    group = buildConfiguratorGroup(deps, { pieces: [piece] }, {
      ...STANDARD_CONFIGURATOR_FINISH, normalMap: quilt, grainMap: grain,
      colorFor: () => color,
      textureFor: () => look?.texture || null,
      normalFor: () => look?.normal || null,
      pbrFor: () => look?.pbr || null,
      extrasFor: () => look?.extra || null,
      modelFor: loaded.modelFor,
    });
    scene.add(group);

    // Frame the piece at a flattering low 3/4 angle (open front toward camera),
    // filling the frame.
    //
    // The distance used to come off the bounding SPHERE, which is the radius of
    // the piece's longest diagonal — for a sofa (long, low, shallow) that sphere
    // is nearly as tall as the sofa is wide, so backing the camera off to fit it
    // parked the piece in the middle of the tile with dead air above and below.
    // At 200 px that air is most of what a shopper is given to tell one
    // collection from another. Fit what the camera can actually SEE instead:
    // project the box's eight corners and pull in until the widest of them
    // reaches the edge. Two or three passes converge (NDC extent goes as 1/dist),
    // and it is aspect- and angle-correct by construction rather than by a
    // hand-tuned fudge factor.
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const target = new THREE.Vector3(c.x, c.y + size.y * 0.12, c.z);
    const dir = new THREE.Vector3(0.42, 0.52, 0.86).normalize();
    const corners = [];
    for (let i = 0; i < 8; i++) {
      corners.push(new THREE.Vector3(
        (i & 1) ? box.max.x : box.min.x,
        (i & 2) ? box.max.y : box.min.y,
        (i & 4) ? box.max.z : box.min.z,
      ));
    }
    let dist = (Math.hypot(size.x, size.y, size.z) / 2) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.2;
    for (let pass = 0; pass < 3; pass++) {
      camera.position.copy(target).addScaledVector(dir, dist);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      let worst = 0;
      for (const corner of corners) {
        const v = corner.clone().project(camera);
        worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
      }
      if (!(worst > 0) || !Number.isFinite(worst)) break;
      dist *= worst / THUMB_FILL;
    }
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const img = await canvasImage(renderer.domElement);
    if (img?.url) {
      lruSet(cache, cacheKey, img.url, THUMB_CACHE_MAX, revokeObjectUrl);
      // Write-behind: the tile already has its URL, and a store that refuses the
      // write (quota, denied, absent) costs this visit nothing.
      writeStoredThumb(configuratorThumbStoreKey(model, opts), img.blob);
    }
    return img?.url ?? null;
  } catch {
    return null;
  } finally {
    if (group) { scene.remove(group); disposeGroup(group); }
    renderer.setSize(THUMB_W, THUMB_H);
    camera.aspect = THUMB_W / THUMB_H;
    camera.updateProjectionMatrix();
  }
}

/**
 * Hook: returns `{ [modelId]: pngDataUrl }`, filling in as each model renders
 * (sequentially). Re-runs only when the model set changes. A model that fails
 * to render is simply absent → the caller falls back to its wireframe/svg.
 * `frame` is the surface's own render size (TILE_THUMB, …); omitted it renders
 * the full frame, so an existing caller is never silently downsized.
 */
export function useConfiguratorThumbnails(models, frame = null) {
  const [thumbs, setThumbs] = useState({});
  const size = frameKey(frame);
  const key = (models || []).map((m) => `${m?.id}:${m?.mesh?.url || ''}:${m?.widthCm}x${m?.depthCm}`).join('|');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const m of (models || [])) {
        if (!alive) return;
        const opts = { ...(frame || {}) };
        const url = await renderConfiguratorThumb(m, opts);
        if (!alive) return;
        if (url) setThumbs((prev) => (prev[m.id] === url ? prev : { ...prev, [m.id]: url }));
        // The yield is there to keep a RENDER from monopolising the frame. A
        // baked picture didn't render anything, so pausing after it just paints
        // the list one model per frame for no reason.
        if (!bakedThumbUrl(m, opts)) await breathe();
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);
  return thumbs;
}

/** A render frame as a stable dependency string (the object is rebuilt by the
 *  caller on every render; its SIZE is what an effect must re-run on). */
function frameKey(frame) {
  return frame ? `${frameDim(frame.width, THUMB_W)}x${frameDim(frame.height, THUMB_H)}` : '';
}

/**
 * Hook: renders each placed piece in its CHOSEN fabric and returns
 * `{ [rowKey]: pngDataUrl }` — for the Resumen, where a row must show the model
 * tinted to the fabric the customer picked. `rows` is
 * `[{ key, model, code, fab? }]`; a row with no code is skipped (the caller falls
 * back to the generic render). `fab` carries the catalog's appearance descriptor
 * for that code, so the row renders in the real cloth, not a flat sampled hue.
 * `frame` is the surface's own render size (ROW_THUMB for the 48px Resumen
 * rows); omitted it renders the full frame.
 */
export function useConfiguratorFabricThumbs(rows, frame = null) {
  const [thumbs, setThumbs] = useState({});
  const size = frameKey(frame);
  const key = (rows || []).map((r) => `${r?.key}:${r?.code || ''}:${r?.fab ? 'w' : 'f'}`).join('|');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const r of (rows || [])) {
        if (!alive) return;
        if (!r?.code || !r?.model?.id) continue;
        const url = await renderConfiguratorThumb(r.model, { ...(frame || {}), code: r.code, fab: r.fab || null });
        if (!alive) return;
        if (url) setThumbs((prev) => (prev[r.key] === url ? prev : { ...prev, [r.key]: url }));
        await breathe();
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);
  return thumbs;
}

const SCENE_W = 480, SCENE_H = 300;
const sceneCache = new Map();                 // scene key → object URL (LRU, see lruSet)

function sceneCacheKey(pieces) {
  return pieces.map((p) => `${p.mesh?.url || p.form || ''}:${p.widthCm}x${p.depthCm}:${p.x},${p.z},${p.rotationDeg}:${p.fabricCode || ''}`).join('|');
}

// All scene snapshots share the SAME offscreen renderer/scene as the per-piece
// thumbnails (see the renderChain note above) — so this also chains through it,
// never running alongside a `renderConfiguratorThumb` call.
export function renderConfiguratorSceneThumb(scene3d, opts = {}) {
  const pieces = scene3d?.pieces || [];
  if (!pieces.length) return Promise.resolve(null);
  return enqueueRender(() => _renderConfiguratorSceneThumb(pieces, opts));
}

/** Render an ENTIRE assembled Togo layout (every placed piece, each in its own
 *  chosen fabric colour) to one PNG URL — a hero snapshot of the real
 *  composition, framed to fit the whole build, instead of a flat 2D outline.
 *  `opts.width/height` request a larger frame (the composition snapshot that
 *  becomes a quote line's image); cards use the default. `opts.encode:'dataUrl'`
 *  asks for the BYTES in-band, for the snapshot that leaves the device. */
async function _renderConfiguratorSceneThumb(pieces, opts = {}) {
  const w = Math.min(1600, Math.max(160, Number(opts.width) || SCENE_W));
  const h = Math.min(1000, Math.max(100, Number(opts.height) || SCENE_H));
  const encode = opts.encode === 'dataUrl' ? 'dataUrl' : 'objectUrl';
  // The LRU is the ON-SCREEN cache (object URLs, re-shown many times). A
  // data-URL render is a one-shot ~1 MB string headed for the network, so it
  // neither reads nor writes it — caching it would pin megabytes for a picture
  // nobody looks at twice, and a shared key across encodings would hand a
  // `blob:` handle to the one caller that can't use one.
  const key = `${sceneCacheKey(pieces)}@${w}x${h}`;
  const hit = encode === 'dataUrl' ? undefined : lruGet(sceneCache, key);
  if (hit !== undefined) return hit;
  let eng;
  try { eng = await getEngine(); } catch { return null; }
  const { THREE, deps, renderer, scene, camera, quilt, grain, retarget } = eng;

  const codes = [...new Set(pieces.map((p) => p.fabricCode).filter(Boolean))];
  const colorByCode = new Map();
  for (const code of codes) colorByCode.set(code, await colorForCode(THREE, code));

  renderer.setSize(w, h);
  const prevAspect = camera.aspect, prevFov = camera.fov;
  camera.aspect = w / h;
  camera.fov = 32;

  let group = null;
  try {
    const loaded = await loadConfiguratorModels({ pieces });
    group = buildConfiguratorGroup(deps, { pieces }, {
      ...STANDARD_CONFIGURATOR_FINISH, normalMap: quilt, grainMap: grain,
      colorFor: (code) => colorByCode.get(code) ?? null, modelFor: loaded.modelFor,
    });
    scene.add(group);

    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.hypot(size.x, size.z) / 2 || 60;
    retarget?.(c, r);   // slide the light rig to the layout so a big build stays lit + shadowed
    const dist = (r / Math.tan((camera.fov * Math.PI / 180) / 2)) * 1.35;
    camera.position.set(c.x + dist * 0.55, c.y + dist * 0.62, c.z + dist * 0.78);
    camera.lookAt(c.x, c.y + size.y * 0.15, c.z);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const url = await canvasUrl(renderer.domElement, encode);
    if (url && encode !== 'dataUrl') lruSet(sceneCache, key, url, SCENE_CACHE_MAX, revokeObjectUrl);
    return url;
  } catch {
    return null;
  } finally {
    if (group) { scene.remove(group); disposeGroup(group); }
    retarget?.({ x: 0, z: 0 }, 120);   // restore the default rig for the next per-piece render
    renderer.setSize(THUMB_W, THUMB_H);
    camera.aspect = prevAspect; camera.fov = prevFov;
    camera.updateProjectionMatrix();
  }
}

/** Hook: renders the FULL assembled layout (a `resolveConfiguratorScene` spec — every
 *  placed piece, positioned + coloured) to one PNG data URL. Null while it
 *  renders or on failure — the caller falls back to the flat 2D plan. */
export function useConfiguratorSceneSnapshot(scene3d) {
  const [url, setUrl] = useState(null);
  const pieces = scene3d?.pieces || [];
  const key = pieces.length ? `${sceneCacheKey(pieces)}@${SCENE_W}x${SCENE_H}` : '';
  useEffect(() => {
    let alive = true;
    if (!key) { setUrl(null); return undefined; }
    setUrl((prev) => (sceneCache.has(key) ? prev : null));
    (async () => {
      const u = await renderConfiguratorSceneThumb(scene3d);
      if (alive) setUrl(u);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
