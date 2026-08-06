/**
 * Togo GLB export — the bridge from our live three.js scene to portable 3D
 * formats (GLB) so the configured sofa can be launched into WebAR ("Ver en tu
 * espacio") and, on iOS, auto-converted to USDZ by <model-viewer> for AR Quick
 * Look. three.js is DEPENDENCY-INJECTED (same pattern as togoSceneBuilder) so
 * this carries no static `three` import and stays fully code-split — the AR
 * viewer loads three + the exporter only when a visitor taps AR.
 *
 * The export reuses `buildTogoGroup`, so the GLB is upholstered in the SAME
 * physically-based fabric (sheen lobe + quilt normal map + the chosen swatch)
 * the inline 3D preview shows — GLTFExporter writes the sheen as the standard
 * KHR_materials_sheen extension, so model-viewer (and Scene Viewer / Quick Look)
 * render real Togo upholstery, not flat plastic.
 *
 * Units: the scene is authored in CENTIMETRES; glTF's unit is the METRE, so the
 * exported root is scaled 0.01 — that's what makes AR place the sofa
 * TRUE-TO-SCALE in the customer's room.
 */
import { buildTogoGroup, makeFabricMaps, disposeGroup, sampleSwatchColor, makeTintedWeave, makeWeaveNormal, imageColorfulness, correctScanToSwatch, loadScanExtras } from './togoSceneBuilder.js';

const CM_TO_M = 0.01;

/**
 * Load the distinct fabric swatches in a scene as THREE.Textures, keyed by code.
 * `urlFor(code)` returns a (CORS-safe) image URL or null. Failures are swallowed
 * (a 404 swatch just falls back to the default Togo colour) so one bad code
 * never blocks the export. Returns a Map<code, THREE.Texture>.
 */
export async function loadFabricTextures(THREE, codes, urlFor) {
  const out = new Map();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin?.('anonymous');
  await Promise.all([...new Set((codes || []).filter(Boolean))].map(async (code) => {
    const url = urlFor(code);
    if (!url) return;
    try { out.set(code, await loader.loadAsync(url)); } catch { /* missing → default colour */ }
  }));
  return out;
}

/**
 * Load a scene's COMPLETE fabric appearance — base AND per-part picks — for an
 * export: the REAL tileable textures the dealer's pCon library linked
 * (`fabrics[code].textureUrl`, embedded into the GLB so the file carries the
 * actual cloth) and the exact/sampled colour per code (`fabrics[code].rgb`
 * beats sampling the CDN swatch photo — and skips its network fetch). Returns
 * { fabricTextures: Map<code, THREE.Texture>, colors: Map<code, int>, dispose }.
 * Every failure degrades to the colour fallback; nothing blocks the export.
 */
export async function loadSceneFabrics(THREE, scene3d, fabrics = {}, swatchUrlFor = () => null) {
  const codes = [...new Set((scene3d?.pieces || []).flatMap((p) => [
    p.fabricCode,
    ...Object.values(p.partMaterials || {}).map((m) => m?.code),
  ]).filter(Boolean))];
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin?.('anonymous');
  const fabricTextures = new Map();
  const colors = new Map();
  // The .mat PBR port per code (fabricByCode.pbr) — the export shades the
  // scan with pCon fidelity and GLTFExporter carries it into the GLB.
  const pbr = new Map();
  const normals = new Map();
  // The rest of the scan's measured PBR maps (roughness/metalness/displacement/
  // anisotropy) — so AR / the downloaded GLB carry the SAME upholstery the live
  // stage does, not just diffuse+normal.
  const extras = new Map();
  await Promise.all(codes.map(async (code) => {
    const fab = fabrics?.[code];
    if (fab?.pbr) pbr.set(code, fab.pbr);
    if (fab?.rgb) {
      const n = parseInt(String(fab.rgb).replace('#', ''), 16);
      if (Number.isFinite(n)) colors.set(code, n);
    }
    // The LR SWATCH tone (the customer's reference) — the scan-correction target
    // AND the flat/family-tint fallback colour. Sampled once per used code.
    let swInt = null;
    {
      const url = swatchUrlFor(code);
      if (url) {
        try { const t = await loader.loadAsync(url); swInt = sampleSwatchColor(t.image); t.dispose?.(); } catch { /* no swatch → skip correction */ }
      }
    }
    if (!colors.has(code) && swInt != null) colors.set(code, swInt);
    if (fab?.textureUrl) {
      try {
        const tex = await loader.loadAsync(fab.textureUrl);
        let keep = tex;
        // Same tint rule as the live stage: family fallback (a sibling's
        // weave re-tinted) or a NEUTRAL grayscale detail map whose colour
        // pCon keeps in material.mat's dif — never embed a colourless piece
        // into the GLB. No tone to tint with → colour fallback.
        const col = colors.get(code);
        const neutral = !fab.tint && !fab.pbr?.dif && col != null
          && (imageColorfulness(tex.image) ?? 999) < 14;
        if (fab.tint || neutral) {
          keep = makeTintedWeave(THREE, tex.image, col);
          tex.dispose?.();
        } else if (!fab.tint && fab.rgb && swInt != null) {
          // Anchor a real scan to its LR swatch (mirrors the live stage) so the
          // downloaded GLB / AR render the colour the customer picked.
          const matzInt = parseInt(String(fab.rgb).replace('#', ''), 16);
          const corrected = Number.isFinite(matzInt) ? correctScanToSwatch(THREE, tex.image, matzInt, swInt) : null;
          if (corrected) { keep = corrected; tex.dispose?.(); }
        }
        if (keep) {
          fabricTextures.set(code, keep);
          // Weave RELIEF — the REAL pCon `bumps` normal when present (kept
          // linear), else derived from the diffuse. GLTFExporter embeds it, so
          // AR / the downloaded GLB show tactile cloth, not printed paper.
          let nrm = null;
          if (fab.normalUrl && !fab.tint) {
            try { nrm = await loader.loadAsync(fab.normalUrl); nrm.colorSpace = THREE.NoColorSpace; } catch { nrm = null; }
          }
          if (!nrm) nrm = makeWeaveNormal(THREE, keep.image);
          if (nrm) normals.set(code, nrm);
        }
      } catch { /* colour fallback */ }
    }
    if (fabricTextures.has(code)) {
      const ex = await loadScanExtras(THREE, fab, (u) => loader.loadAsync(u));
      if (ex.roughness || ex.metalness || ex.displacement || ex.anisotropy) extras.set(code, ex);
    }
  }));
  return {
    fabricTextures, colors, pbr, normals, extras,
    dispose: () => {
      fabricTextures.forEach((t) => t.dispose?.());
      normals.forEach((t) => t.dispose?.());
      extras.forEach((e) => { e.roughness?.dispose?.(); e.metalness?.dispose?.(); e.displacement?.dispose?.(); e.anisotropy?.dispose?.(); });
    },
  };
}

/**
 * Build the AR-ready group from a `resolveTogoScene` spec: the furniture group
 * (no studio rig — model-viewer lights it), upholstered, then wrapped in a root
 * scaled cm→m. Returns { root, quilt, dispose } — the caller owns disposal.
 * `opts` carries the fabric finish (sheen/roughness/repeat/normalScale) + a
 * `textures` Map from loadFabricTextures.
 */
export function buildArGroup(deps, scene3d, opts = {}) {
  const { THREE } = deps;
  const textures = opts.textures instanceof Map ? opts.textures : new Map();
  // The same woven fabric maps as the live preview, so AR carries the texture too
  // (buildTogoGroup/makeFabricMaterial tile them to opts.repeat).
  const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE);

  // Fabric appearance: prefer the caller's resolved maps (loadSceneFabrics —
  // exact pCon colours + REAL tileable textures that GLTFExporter embeds into
  // the file), else sample each loaded swatch photo's DOMINANT colour, the
  // legacy path. KHR_materials_sheen carries the velvet sheen either way
  // (Scene Viewer / Quick Look render real upholstery, not flat plastic).
  const colors = opts.colors instanceof Map ? new Map(opts.colors) : new Map();
  if (!(opts.colors instanceof Map)) {
    textures.forEach((t, code) => { const c = sampleSwatchColor(t?.image); if (c != null) colors.set(code, c); });
  }
  const fabricTextures = opts.fabricTextures instanceof Map ? opts.fabricTextures : new Map();
  const pbr = opts.pbr instanceof Map ? opts.pbr : new Map();
  const scanNormals = opts.normals instanceof Map ? opts.normals : new Map();
  const extras = opts.extras instanceof Map ? opts.extras : new Map();

  const group = buildTogoGroup(deps, scene3d, {
    ...opts,
    normalMap: quilt, grainMap: grain,
    colorFor: (code) => (colors.has(code) ? colors.get(code) : null),
    textureFor: (code) => fabricTextures.get(code) || null,
    pbrFor: (code) => pbr.get(code) || null,
    normalFor: (code) => scanNormals.get(code) || null,
    extrasFor: (code) => extras.get(code) || null,
  });

  const root = new THREE.Group();
  root.add(group);
  root.scale.setScalar(CM_TO_M);     // centimetres → metres (AR true-to-scale)
  root.updateMatrixWorld(true);

  const dispose = () => {
    disposeGroup(root);                      // geometries, materials, cloned swatch maps
    quilt?.dispose?.();                      // the shared fabric maps (disposeGroup skips them)
    grain?.dispose?.();
    textures.forEach((t) => t.dispose?.());  // the original loaded swatches
    fabricTextures.forEach((t) => t.dispose?.());
  };
  return { root, quilt, dispose };
}

/**
 * Export a three.js Object3D to a binary glTF (GLB) Blob via GLTFExporter
 * (dependency-injected). Resolves to a Blob of type model/gltf-binary the View
 * wraps in an object URL for <model-viewer>.
 */
export function exportGlbBlob(deps, object) {
  const { GLTFExporter } = deps;
  return new Promise((resolve, reject) => {
    try {
      const exporter = new GLTFExporter();
      exporter.parse(
        object,
        (result) => {
          const buf = result instanceof ArrayBuffer ? result : new TextEncoder().encode(JSON.stringify(result));
          resolve(new Blob([buf], { type: 'model/gltf-binary' }));
        },
        (err) => reject(err instanceof Error ? err : new Error('GLB export failed')),
        { binary: true },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
