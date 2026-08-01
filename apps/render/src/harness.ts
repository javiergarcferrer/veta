/**
 * THE HARNESS — the browser half of the render service.
 *
 * This file does NOT run in node. It is bundled by `scripts/bundleHarness.ts`
 * (esbuild, IIFE) straight into `dist/harness.html`, which a headless chromium
 * opens over `file://`; the node side then calls `window.__vetaRender(job)` over
 * CDP and gets a data URL back. That is the whole wall: JSON crosses it, code
 * does not — the same discipline the monorepo already applies between Deno edge
 * functions and the Vite app.
 *
 * ONE SELF-CONTAINED FILE ON PURPOSE. `file://` refuses ES-module `<script src>`
 * (cross-origin by CORS), and any second request would be a second failure mode
 * in a service whose whole job is to always produce an image. Everything the
 * page needs — three, its addons, `@veta/scene`, the pose table — is inlined.
 *
 * NOTHING IS DECIDED HERE. The scene comes from `@veta/scene`
 * (`buildSceneGroup`), the lighting from its `setupStage` presentation rig, the
 * camera from `jobs.ts`'s pose table. A rendering rule that lived only in this
 * file would be a rule the widget's own preview could not honour — and the
 * whole point of a server render is that it shows the customer's configuration,
 * not a second interpretation of it.
 *
 * Excluded from the default `tsc` program (see tsconfig.json): its imports are
 * the BROWSER dependency graph (three + addons), a different graph from the
 * service's. `npm run typecheck:harness` checks it once three is installed.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  buildSceneGroup,
  disposeGroup,
  extOf,
  fabricAnisotropy,
  loadModels,
  makeFabricMaps,
  setupStage,
} from '@veta/scene';
import type { LoadedModel, ModelDescriptor, ScenePiece, SceneSpec, StageHandle } from '@veta/scene';

import {
  resolveCameraPose,
  sanitizeJob,
  type JobMaterial,
  type RenderJob,
} from './jobs.ts';

/** What one `__vetaRender` call answers. */
export interface HarnessResult {
  ok: boolean;
  /** `data:image/png;base64,…` — absent when `ok` is false. */
  dataUrl?: string;
  width: number;
  height: number;
  /** Non-fatal problems: a texture that never loaded, an unsupported format. */
  warnings: string[];
  /** Wall time inside the page, ms. */
  ms: number;
  error?: string;
}

/** How long one remote asset may hold up an image before we render without it. */
const ASSET_TIMEOUT_MS = 15_000;

/**
 * A missing map must never cost the render. The customer's configuration is
 * still true without a scan (the resolved colour carries it), and an image that
 * never arrives is worth strictly less than one that arrives slightly plainer.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── The renderer, kept alive across jobs ────────────────────────────────────
//
// Creating a WebGL context is by far the most expensive thing on this page —
// on swiftshader it dwarfs the draw. A pooled page renders many jobs, so the
// renderer (and the shared procedural weave maps, which are canvas work) live
// for the life of the page; everything job-scoped is built and disposed per
// call.

let renderer: THREE.WebGLRenderer | null = null;
let weave: { normalMap: THREE.Texture | null; grainMap: THREE.Texture | null } | null = null;

function getRenderer(): THREE.WebGLRenderer {
  if (renderer) return renderer;
  const r = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    // The data-URL path reads the drawing buffer AFTER the draw call returns,
    // so the buffer has to survive the frame. Without this the canvas reads
    // back empty on some drivers and every render is a silent blank.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  r.setPixelRatio(1);                 // size is stated in the job, never scaled
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.outputColorSpace = THREE.SRGBColorSpace;
  // NEUTRAL, not ACES. This service's images are what a customer judges a
  // FABRIC COLOUR by, and ACES visibly re-saturates and darkens mid-tones — the
  // exact drift the stage rig's neutral key exists to avoid. Khronos' PBR
  // Neutral tone maps highlights without moving the diffuse tone.
  r.toneMapping = ((THREE as unknown as Record<string, unknown>).NeutralToneMapping ?? THREE.NoToneMapping) as THREE.ToneMapping;
  r.toneMappingExposure = 1;
  const el = r.domElement;
  el.style.position = 'fixed';
  el.style.top = '0';
  el.style.left = '0';
  // In the DOM so the node side's screenshot FALLBACK has something to clip to
  // when a driver refuses `toDataURL`.
  document.body.appendChild(el);
  renderer = r;
  return r;
}

function getWeave(r: THREE.WebGLRenderer) {
  if (!weave) weave = makeFabricMaps(THREE, { anisotropy: fabricAnisotropy(r) });
  return weave;
}

// ── Job → scene spec ────────────────────────────────────────────────────────

/**
 * The job's placements → `@veta/scene`'s own `SceneSpec`, centred on the layout.
 *
 * Plan y becomes world Z (the engine's convention), and the whole layout is
 * recentred so the camera maths never has to know where in an unbounded plan
 * the customer happened to drag their build.
 */
function sceneSpecOf(job: RenderJob): SceneSpec {
  const pieces: ScenePiece[] = job.build.map((p) => {
    const model = job.models[p.pieceId] ?? {};
    const partMaterials = p.partMaterials
      ? Object.fromEntries(Object.entries(p.partMaterials).map(([role, code]) => [role, { code }]))
      : null;
    return {
      // `modelId` is read back by `descFor` below; the engine ignores it.
      modelId: p.pieceId,
      x: p.x,
      z: p.y,
      rotationDeg: p.rot,
      widthCm: model.widthCm ?? null,
      depthCm: model.depthCm ?? null,
      mountHeightCm: model.mountHeightCm ?? null,
      collection: model.collection ?? null,
      fabricCode: p.fabricCode ?? null,
      parts: (model.parts as ScenePiece['parts']) ?? null,
      partFinishes: p.partFinishes ?? null,
      partMaterials,
    } satisfies ScenePiece;
  });
  // Recentre on the placements' own centroid box.
  if (pieces.length) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pieces) {
      const x = Number(p.x) || 0, z = Number(p.z) || 0;
      const hw = (Number(p.widthCm) || 0) / 2, hd = (Number(p.depthCm) || 0) / 2;
      minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
      minZ = Math.min(minZ, z - hd); maxZ = Math.max(maxZ, z + hd);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (const p of pieces) {
      p.x = (Number(p.x) || 0) - cx;
      p.z = (Number(p.z) || 0) - cz;
    }
  }
  return { pieces };
}

function descriptorOf(model: RenderJob['models'][string] | undefined): ModelDescriptor | null {
  if (!model?.url) return null;
  const d: ModelDescriptor = { url: model.url };
  if (model.upAxis) d.upAxis = model.upAxis;
  if (model.rotateY != null) d.rotateY = model.rotateY;
  if (model.scale != null) d.scale = model.scale;
  return d;
}

// ── Materials ───────────────────────────────────────────────────────────────

async function loadTextures(
  job: RenderJob,
  anisotropy: number,
  warnings: string[],
): Promise<{ maps: Map<string, THREE.Texture>; normals: Map<string, THREE.Texture> }> {
  const maps = new Map<string, THREE.Texture>();
  const normals = new Map<string, THREE.Texture>();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const jobs: Promise<void>[] = [];
  for (const [code, mat] of Object.entries(job.materials)) {
    const m = mat as JobMaterial;
    if (m.textureUrl) {
      jobs.push(withTimeout(loader.loadAsync(m.textureUrl), ASSET_TIMEOUT_MS, 'texture')
        .then((t) => {
          t.anisotropy = anisotropy;
          maps.set(code, t);
        })
        .catch((e) => { warnings.push(`texture:${code}:${(e as Error).message}`); }));
    }
    if (m.normalUrl) {
      jobs.push(withTimeout(loader.loadAsync(m.normalUrl), ASSET_TIMEOUT_MS, 'normal')
        .then((t) => {
          t.anisotropy = anisotropy;
          normals.set(code, t);
        })
        .catch((e) => { warnings.push(`normal:${code}:${(e as Error).message}`); }));
    }
  }
  await Promise.all(jobs);
  return { maps, normals };
}

/**
 * The loaders this bundle carries: glTF only.
 *
 * `@veta/scene`'s `LOADER_MODULES` names five formats, and pulling all five in
 * (FBX and Collada are the heavy ones) would roughly triple a bundle that has
 * to be parsed by every pooled page at boot. The publish pipeline
 * (`@veta/mesh-pipeline`) emits GLB, so a job pointing at anything else is a
 * job whose model was never published — it takes the engine's neutral
 * placeholder and SAYS SO in `warnings`, rather than rendering nothing.
 */
function loaderFor(ext: string, warnings: string[]): { loadAsync(url: string): Promise<unknown> } | null {
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    return {
      // `loadModels` swallows a rejection (the piece simply takes its fallback,
      // which is the right behaviour) — so the warning is raised HERE, on the
      // way past. A mesh that silently never loaded is a PDP image that is
      // quietly wrong, which is worse than one that is obviously a placeholder.
      loadAsync: (url: string) => withTimeout(loader.loadAsync(url), ASSET_TIMEOUT_MS, 'model')
        .catch((e: Error) => {
          warnings.push(`model:${url}:${e.message}`);
          throw e;
        }),
    };
  }
  warnings.push(`unsupported_model_format:${ext}`);
  return null;
}

// ── The render ──────────────────────────────────────────────────────────────

export async function renderJobInPage(rawJob: unknown): Promise<HarnessResult> {
  const started = Date.now();
  const warnings: string[] = [];
  // Sanitized AGAIN on this side. The node service already did it, but this
  // page is reachable by anything that can call the function and the cost is
  // microseconds — a renderer that trusts its input is a renderer that hangs
  // on a hostile one.
  const { job, dropped } = sanitizeJob(rawJob as Record<string, unknown>);
  for (const d of dropped) warnings.push(`dropped:${d.path || '<root>'}:${d.reason}`);

  const { width, height } = job.size;
  const r = getRenderer();
  r.setSize(width, height, false);

  const scene = new THREE.Scene();
  let group: THREE.Object3D | null = null;
  let stage: StageHandle | null = null;
  const owned: THREE.Texture[] = [];

  try {
    const spec = sceneSpecOf(job);
    const anisotropy = fabricAnisotropy(r);
    const { maps, normals } = await loadTextures(job, anisotropy, warnings);
    for (const t of maps.values()) owned.push(t);
    for (const t of normals.values()) owned.push(t);

    // One parsed model per URL, exactly like every other surface in the
    // platform — the loader cache is `@veta/scene`'s, so a pooled page that
    // renders the same collection all day parses each mesh once.
    const { modelFor } = await loadModels(spec, {
      THREE,
      loaderFor: (ext: string) => loaderFor(ext, warnings),
      descFor: (piece: ScenePiece) => descriptorOf(job.models[String(piece.modelId ?? '')]),
      toCreasedNormals,
    });

    const { normalMap, grainMap } = getWeave(r);
    // `buildSceneGroup` returns the injected namespace's own Object3D, typed
    // loosely by contract (three is dependency-injected, so the engine cannot
    // name three's types). Pinning it here is what lets the outer `group` stay
    // nullable for the `finally` without every use needing a guard.
    const built: THREE.Object3D = buildSceneGroup(THREE, spec, {
      RoundedBoxGeometry,
      params: job.renderParams,
      normalMap,
      grainMap,
      anisotropy,
      colorFor: (code: string) => {
        const rgb = job.materials[code]?.rgb;
        return typeof rgb === 'number' ? rgb : null;
      },
      textureFor: (code: string) => maps.get(code) ?? null,
      normalFor: (code: string) => normals.get(code) ?? null,
      pbrFor: (code: string) => {
        const tile = job.materials[code]?.tileCm;
        return tile ? { tileCm: tile } : null;
      },
      modelFor: (piece: ScenePiece): LoadedModel | null => modelFor(piece),
    });
    group = built;
    scene.add(built);

    // MEASURED before the rig goes in: `setupStage` adds a floor 12 radii wide,
    // and framing to that would push every piece to a speck in the middle.
    const box = new THREE.Box3().setFromObject(built);
    const bounds = box.isEmpty()
      ? { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 50, z: 50 } }
      : { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
    if (box.isEmpty()) warnings.push('empty_scene');

    const cam = resolveCameraPose(job.angle, {
      bounds,
      aspect: width / height,
      params: job.renderParams,
      override: job.poseOverride ?? null,
    });

    const transparent = job.transparent && job.format === 'png';
    stage = setupStage(THREE, r, scene, cam.radius, {
      RoomEnvironment,
      grid: false,                      // a product image is not a plan
      presentation: true,               // the white-page rig: a piece rendered ALONE
      ...(job.background != null ? { ground: job.background } : {}),
    });
    stage.retarget({ x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 }, cam.radius);
    stage.setShadow(cam.shadow);
    // A cut-out for a PDP/feed: the rig's floor still CATCHES the shadow (it is
    // a ShadowMaterial), so the piece keeps its contact shadow over alpha.
    if (transparent) scene.background = null;
    r.setClearColor(0x000000, transparent ? 0 : 1);

    const camera = new THREE.PerspectiveCamera(cam.fovDeg, width / height, cam.near, cam.far);
    camera.up.set(cam.up.x, cam.up.y, cam.up.z);
    camera.position.set(cam.position.x, cam.position.y, cam.position.z);
    camera.lookAt(cam.target.x, cam.target.y, cam.target.z);
    camera.updateProjectionMatrix();

    // The rig moved, so every cached shadow map is stale (the shadows-dirty
    // discipline `setupStage` documents). One frame, one map — this is a
    // single-shot renderer, so simply forcing the update is the whole answer.
    r.shadowMap.needsUpdate = true;
    r.render(scene, camera);

    const mime = job.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = r.domElement.toDataURL(mime, job.format === 'jpeg' ? job.quality : undefined);
    return { ok: true, dataUrl, width, height, warnings, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, width, height, warnings, ms: Date.now() - started, error: (err as Error).message || String(err) };
  } finally {
    if (group) { scene.remove(group); disposeGroup(group); }
    stage?.dispose();
    for (const t of owned) t.dispose();
  }
}

declare global {
  interface Window {
    __vetaRender: (job: unknown) => Promise<HarnessResult>;
    __vetaHarnessReady: boolean;
  }
}

window.__vetaRender = renderJobInPage;
// The node side waits on this rather than on `load`: the bundle is inline, so
// the page can be "loaded" a tick before the IIFE has defined the function.
window.__vetaHarnessReady = true;
