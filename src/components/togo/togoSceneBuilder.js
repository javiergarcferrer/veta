/**
 * Togo 3D scene builder — the three.js half of the preview, with three.js
 * DEPENDENCY-INJECTED so it carries no static `three` import. That keeps the
 * heavy engine fully code-split (the React viewer loads it via safeDynamicImport
 * and passes it in) AND lets the screenshot harness build the identical scene
 * for visual QA off one implementation.
 *
 * It turns a `resolveTogoScene` spec into a furniture THREE.Group: each piece is
 * a pile of RoundedBoxes (lib/togo/togoModel) sized to its real footprint,
 * upholstered in the chosen fabric (a swatch texture, or a tasteful default
 * Togo colour), placed + rotated to match the 2D plan. When real Togo GLBs land
 * (the dealer's pCon/OFML channel), swap the per-piece build for a glTF load —
 * the layout/material wiring here is unchanged.
 */
import { togoParts, autoUnitScale, meshSeamBleed } from '../../lib/togo/togoModel.js';
import {
  PART_ROLES, baseKeyOf, partRoleFor, partKeysFor, hasParts, mergedKeyOf, bodySignature,
  finishSpecOf, finishOptionOf,
} from '../../lib/togo/meshParts.js';
import { traceGridLoops } from '../../lib/togo/meshToPlan.js';
import { createContactShadow } from './togoContactShadow.js';

// sRGB ↔ linear-light transfer (the exact IEC 61966-2-1 curve). Used to average
// swatch pixels in LINEAR light (gamma-correct) so the sampled colour isn't
// biased lighter — averaging sRGB bytes directly is a classic "too light" error.
const S2L = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L2S = (l) => { const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, c)) * 255); };

// Default Togo upholstery when no fabric is picked — a warm OATMEAL, deeper and
// more saturated than the old near-grey. A materialless piece has no swatch
// colour to shade against, so a pale base (the old 0xB8AFA3) lifted almost to
// white under the studio IBL + tone-mapping and the quilted channels washed out
// to a flat cream blob — exactly the "undistinctive shape" that made arranging
// the modular hard. A mid oatmeal keeps tonal headroom so the raking key can
// carve every channel/roll and the iconic ribbed silhouette reads. (A fabricked
// piece always read fine because its sampled swatch tone supplied that range.)
const DEFAULT_COLOR = 0xA28F71;
const DEG = Math.PI / 180;

// The ONE Togo upholstery finish — a standard velvet (terciopelo). The per-finish
// editor (Mate/Lino/Terciopelo/Cuero) is gone: every piece, in every preview and
// the live stage, wears this same plush velvet so the configurator reads
// consistent and the only choice left to the customer is the FABRIC (colour).
//
// MATTE, and matching the live stage's own default exactly. It used to run
// roughness 0.6 with a MAXED, TIGHT sheen lobe (1.0 at sheenRoughness 0.3),
// which is the optical description of satin, not upholstery: it put a wet
// highlight across the top of every piece and the catalogue tiles read as
// polished leather. A fabric with a real scanned weave never showed it, because
// the scan path floors roughness at 0.8 and kills the sheen — so the pieces that
// looked wrong were exactly the colours with NO scan, falling through to these
// numbers. Two materials for one fabric is the bug; there is one now.
//
// (`normalScale` stays 0.8. That is the quilt RELIEF, not gloss — it is what
// makes the channels read as stuffed, and it costs nothing in shine.)
export const STANDARD_TOGO_FINISH = {
  roughness: 0.85, sheen: 0.7, sheenRoughness: 0.6,
  clearcoat: 0, clearcoatRoughness: 0.4, repeat: 3, normalScale: 0.8,
};

/**
 * Procedural fabric TEXTURE maps — what turns the flat sampled swatch colour into
 * cloth you can read the WEAVE of (the big quilt CHANNELS are real geometry, see
 * togoModel.togoParts; these are the fine surface character ON those cushions).
 * Built ONCE on a canvas and SHARED (tiled) by every fabric material:
 *   • normalMap — a plain-weave micro-relief (warp over weft, alternating in a
 *     checker) plus a fine fibre jitter, so the raking key + sheen lobe catch the
 *     individual threads instead of a smooth plastic shell.
 *   • grainMap  — a near-white greyscale ALBEDO weave (subtle thread tone + a slow
 *     mottle) that three MULTIPLIES by the material's colour, so the upholstery has
 *     woven tonal variation rather than one dead-flat fill. The two are generated
 *     from the SAME height field, so the tonal weave and the relief line up.
 * Both are flagged `userData.shared` so disposeGroup leaves them to the owner (the
 * stage/export that created them). Returns nulls under Node (no `document`), so the
 * export path stays test-safe.
 *
 * Deterministic (value-noise from a sin-hash, not Math.random) so re-renders and
 * the thumbnail cache are stable.
 */
// The procedural weave's tile resolution. 96 threads across 256 px put each
// thread on 2.7 px — right at the Nyquist limit, so the weave shimmered and
// mipped straight to flat grey a metre back, which is the "flat colour, no
// texture" look this map exists to prevent. 512 gives every thread 5.3 px and
// a real mip chain to fall down. It is ONE canvas built once and shared by every
// fabric material in the app, so the whole cost is a few ms of generation and
// ~1 MB of VRAM — paid once, for the surface character of every piece on screen.
const WEAVE_TILE_PX = 512;
// The resolution `normalStrength` was tuned at. The normal is a finite
// difference between NEIGHBOURING PIXELS, so its steepness is tied to how far
// apart two pixels are in uv — double the resolution and the same strength
// yields half the slope. Raising the tile from 256 to 512 therefore flattened
// the relief instead of sharpening it (measured: 14% less fine structure on a
// dressed piece). Scaling the strength by the resolution ratio makes the weave
// depth a property of the CLOTH rather than of the texture size, so the tile can
// be re-cut for sharpness without silently re-tuning the look.
const WEAVE_TUNED_PX = 256;

// The generated PIXELS, memoized. They are a pure function of (size, threads,
// normalStrength) and have nothing to do with any renderer — but the app builds
// three engines (the live stage, the offscreen thumbnail renderer, the launch
// card's turntable) and each one used to regenerate this whole field from
// scratch: two nested loops over the tile plus a value-noise call per pixel,
// three times over, on the main thread during boot. At 512² that is four times
// the work it was, so caching it is what pays for the sharper weave. Each caller
// still gets its OWN CanvasTexture (a texture belongs to one GL context); only
// the expensive JS is shared.
const weaveCanvases = new Map();

function buildWeaveCanvases({ size, threads, normalStrength }) {
  const key = `${size}:${threads}:${normalStrength}`;
  const hit = weaveCanvases.get(key);
  if (hit) return hit;
  const made = _buildWeaveCanvases({ size, threads, normalStrength });
  if (made) weaveCanvases.set(key, made);
  return made;
}

export function makeFabricMaps(THREE, {
  size = WEAVE_TILE_PX,
  threads = 96,
  // Slope compensation for the tile resolution, but SQUARE-ROOTED rather than
  // linear. The linear factor preserves the finite-difference slope exactly,
  // which is mathematically right and visually wrong: at 512 it doubled the
  // relief amplitude at the same time as doubling the high-frequency content per
  // screen pixel, and minification turned the pair into moire. The root keeps
  // most of the crispness the sharper tile bought without handing the aliasing
  // twice the amplitude to work with.
  normalStrength = 1.7 * (size / WEAVE_TUNED_PX),
  anisotropy = 1,
} = {}) {
  if (typeof document === 'undefined') return { normalMap: null, grainMap: null };
  const built = buildWeaveCanvases({ size, threads, normalStrength });
  if (!built) return { normalMap: null, grainMap: null };
  const normalMap = new THREE.CanvasTexture(built.nrm);
  const grainMap = new THREE.CanvasTexture(built.grn);
  for (const t of [normalMap, grainMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // Anisotropic filtering keeps the thread relief readable at the grazing
    // angles the low 3/4 camera creates — without it the weave mushes to a blur
    // exactly where the sheen lobe is supposed to catch it. The caller passes
    // the renderer's real capability (capped); default 1 = no-op off-GPU.
    t.anisotropy = Math.max(1, anisotropy);
    t.userData = { shared: true };
  }
  return { normalMap, grainMap };
}

function _buildWeaveCanvases({ size, threads, normalStrength }) {
  if (typeof document === 'undefined') return null;
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const tl = hash(xi, yi), tr = hash(xi + 1, yi), bl = hash(xi, yi + 1), br = hash(xi + 1, yi + 1);
    const u = sm(xf), v = sm(yf);
    return (tl * (1 - u) + tr * u) * (1 - v) + (bl * (1 - u) + br * u) * v;
  };
  const PI = Math.PI;
  // Height field: a plain weave (each cell either warp-over-weft or the reverse,
  // alternating like real cloth) softened by a fine fibre jitter.
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // BREAK THE LATTICE. `over` is a perfect NxN checkerboard, and a perfectly
      // periodic pattern minified across a whole sofa beats against the pixel
      // grid into large diamond blotches — the surface stops reading as cloth and
      // starts reading as a repeated stamp. Real fabric is not on a perfect grid:
      // the threads wander. A slow, low-frequency wobble (well under one thread,
      // and far coarser than the weave itself so it never shows as its own
      // texture) decorrelates the repeat enough that the beat never forms, and it
      // costs one noise lookup per axis. This is the cheap half of "texture
      // randomization" — it fixes the periodicity at the SOURCE rather than
      // needing a stochastic-sampling shader.
      const wobU = (noise(u * 2.7, v * 2.7) - 0.5) * 0.30;
      const wobV = (noise(u * 3.3 + 11.7, v * 3.3 + 4.2) - 0.5) * 0.30;
      const tu = u * threads + wobU;
      const tv = v * threads + wobV;
      const warp = Math.abs(Math.sin(tu * PI));            // vertical threads
      const weft = Math.abs(Math.sin(tv * PI));            // horizontal threads
      const over = (Math.floor(tu) + Math.floor(tv)) & 1;
      const weave = over ? warp * 0.72 + weft * 0.28 : weft * 0.72 + warp * 0.28;
      const fibre = noise(u * threads * 5, v * threads * 5);
      hgt[y * size + x] = weave * 0.8 + fibre * 0.2;
    }
  }
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = size;
  const grn = document.createElement('canvas'); grn.width = grn.height = size;
  const nctx = nrm.getContext('2d'), gctx = grn.getContext('2d');
  const nimg = nctx.createImageData(size, size), gimg = gctx.createImageData(size, size);
  const nd = nimg.data, gd = gimg.data;
  const at = (x, y) => hgt[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normal = finite-difference of the (wrapped) height field.
      const hL = at(x - 1, y), hR = at(x + 1, y), hD = at(x, y - 1), hU = at(x, y + 1);
      let nx = (hL - hR) * normalStrength, ny = (hD - hU) * normalStrength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      nd[i] = (nx * 0.5 + 0.5) * 255; nd[i + 1] = (ny * 0.5 + 0.5) * 255; nd[i + 2] = (nz * 0.5 + 0.5) * 255; nd[i + 3] = 255;
      // Albedo grain = near-white, threads a touch brighter than valleys + a slow
      // mottle. Mean ≈ 0.93 so it textures the colour without muddying it.
      const u = x / size, v = y / size;
      const mottle = noise(u * 4, v * 4);
      let a = 0.93 + (hgt[y * size + x] - 0.5) * 0.10 + (mottle - 0.5) * 0.07;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      const g = Math.round(a * 255);
      gd[i] = g; gd[i + 1] = g; gd[i + 2] = g; gd[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0); gctx.putImageData(gimg, 0, 0);
  return { nrm, grn };
}

/**
 * The generated-UV convention: ONE uv unit = this many centimetres on a real
 * model (generateBoxUvs divides positions by it). Everything that turns a
 * texture's physical size into a repeat count MUST use this same constant —
 * repeat = FABRIC_UV_CM / tileCm — or the cloth renders at the wrong size.
 */
export const FABRIC_UV_CM = 54;

/**
 * Anisotropic filtering level for every fabric map — the weave's sharpness at
 * grazing angles, which on this stage is nearly all of them: the piece is framed
 * from a low 3/4, so the seat and the cushion tops are seen at a hard slant and
 * that is exactly where isotropic mip filtering collapses a woven texture into
 * grey. It was pinned at 8 while asking the GPU for its real maximum, which on
 * anything current is 16 — half the sharpness available, for free, on the
 * surfaces the customer is judging the cloth by. Anisotropy costs texture
 * bandwidth only where the slant is steep, and these maps are small.
 */
export const FABRIC_ANISOTROPY = 16;

// ── HOW MUCH THE WEAVE READS ───────────────────────────────────────────────
// The four numbers that decide whether a fabric scan looks like cloth or like
// printed paper. They are together, named, because they only work as a SET: the
// relief (`SCAN_NORMAL_SCALE`, and `strength`/`size` in makeWeaveNormal) is
// modulated by the light the finish lets through (`SCAN_SHEEN*`,
// `SCAN_ENV_INTENSITY`), so turning one up while another is at zero does
// nothing at all — which is exactly how every scan ended up flat.
// Raising these is the ONLY lever: the depth is DERIVED from the scan
// (makeWeaveNormal), so no fabric ever needs re-uploading to gain relief.
export const SCAN_SHEEN = 0.3;            // no .mat — our own cloth lobe
export const SCAN_SHEEN_PBR = 0.22;       // a pCon .mat is authoritative on colour, not on cloth
export const SCAN_ENV_INTENSITY = 0.62;   // IBL the relief has to catch
export const SCAN_NORMAL_SCALE = 1.0;     // how deep the derived weave sits

/** The level to actually use on a renderer — its real capability, never above
 *  what we ask for. Older/mobile GPUs report 4 or 2 and get that. */
export const fabricAnisotropy = (renderer) => Math.max(
  1,
  Math.min(FABRIC_ANISOTROPY, renderer?.capabilities?.getMaxAnisotropy?.() || 1),
);

/**
 * A physically-based fabric material — the single biggest fidelity lever for
 * upholstery. MeshPhysicalMaterial adds a SHEEN lobe (the soft retro-reflective
 * glow real fabric has at grazing angles), tuned by the material editor. Takes
 * the swatch texture (tiled, sRGB) or a neutral colour, plus an optional weave
 * normal map. `tex` is an already-loaded THREE.Texture or null.
 * `opts.scanPbr` is a .matz material.mat port ({ dif, rough, spec, tileCm,
 * tileCmY } — matzMaterial.js) applied verbatim when `tex` is a real scan.
 */
export function makeFabricMaterial(THREE, tex, opts = {}) {
  // Materialless = the default-colour fallback (no swatch tex, no resolved colour).
  // It gets a FORM-FIRST finish: a lower IBL fill so the directional key throws
  // real shadow into every channel valley (a high fill flattened the quilting to
  // a blob), and a gentler sheen so the pale oatmeal body isn't glazed back over
  // by a velvet film. A fabricked piece keeps the full soft-velvet rig.
  const materialless = !tex && opts.color == null;
  const base = new THREE.Color(opts.color ?? (tex ? 0xffffff : DEFAULT_COLOR));
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: opts.roughness ?? 0.85,             // matte cloth
    metalness: 0,                                  // dielectric — never plastic/metal
    // A moderate sheen lobe tinted to the FABRIC's own hue (NOT white): velvet
    // glow at grazing angles without washing the colour to a pale film. Kept
    // moderate (not maxed) so it reads as velvet but doesn't lighten the body.
    sheen: opts.sheen ?? (materialless ? 0.35 : 0.7),
    sheenRoughness: opts.sheenRoughness ?? 0.6,
    sheenColor: new THREE.Color(opts.sheenColor ?? base),
    // A thin clearcoat lobe for coated finishes (leather) — off by default so
    // matte/cloth finishes pay nothing. Layers on top of the sheen.
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: opts.clearcoatRoughness ?? 0.4,
    // Lower the IBL fill when materialless so the raking key carves the channels
    // (form reads); the full 0.7 keeps a fabricked body from going pale.
    envMapIntensity: opts.envMapIntensity ?? (materialless ? 0.42 : 0.7),
  });
  const rep = opts.repeat || 3;
  const pbr = tex ? (opts.scanPbr || null) : null;
  // Albedo = the swatch PHOTO if one's supplied (legacy), else the procedural
  // woven grain (shared) MULTIPLIED by the sampled colour → textured cloth.
  // A MATERIALLESS piece (no fabric chosen yet) stays SMOOTH — a blank canvas,
  // no grain and no quilt relief (below) — so "sin tela" reads as unfinished,
  // not as a mystery burlap weave.
  const albedo = tex || (materialless ? null : opts.grainMap) || null;
  if (albedo) {
    albedo.colorSpace = THREE.SRGBColorSpace;        // colour map is sRGB
    albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
    // THE RIGHT SIZE for the map: the .mat's `scale` states the texture's
    // physical footprint (repeats per meter → tileCm) — with the generated
    // UVs at FABRIC_UV_CM per uv unit, repeat = UV_CM / tileCm lands the
    // cloth at its TRUE size (ALCANTARA: scale 5 → 20 cm). No .mat data →
    // today's calibrated default (rep 3 ≈ 18 cm).
    if (pbr?.tileCm > 0) albedo.repeat.set(FABRIC_UV_CM / pbr.tileCm, FABRIC_UV_CM / (pbr.tileCmY > 0 ? pbr.tileCmY : pbr.tileCm));
    else albedo.repeat.set(rep, rep);
    albedo.anisotropy = opts.anisotropy || FABRIC_ANISOTROPY;
    mat.map = albedo;
  }
  if (tex) {
    // THE SCAN IS THE MATERIAL — and when its .matz shipped a material.mat,
    // this is the VERBATIM pCon port (matzMaterial.js): the diffuse
    // multiplier tints the map exactly as pCon modulates it, Phong shi→GGX
    // roughness, Phong Ks→specularIntensity, and NO synthetic sheen or quilt
    // relief (pCon renders neither). Without a .mat, pCon's GLB exports still
    // declare every fabric fully matte (metallic 0, roughness 1.0), so the
    // velvet gloss stays off scans either way ("too much shine"); the finish
    // knobs (dealer editor / DEFAULT_FINISH) style the PROCEDURAL velvet
    // only — reskin() skips scanFinish materials for the same reason.
    // A real scanned diffuse IS the albedo — render it at FULL (white base),
    // exactly like pCon binds the `tex` map. It must NOT be re-multiplied by
    // `dif`: measured on ALCANTARA SILVER, `dif` (≈#909090) equals the map's
    // own average, so multiplying double-darkened silver into charcoal. `dif`
    // is pCon's flat FALLBACK colour for the no-texture case (handled in the
    // colour branch above); a tint BAKE already carries its own tone. Leaving
    // mat.color at its white default keeps the scan true to the swatch.
    // Roughness FLOORED matte: upholstery is never wet-shiny. The floor also
    // rescues data imported before the shi-derivation was dropped — a stored
    // glossy 0.25 (ALCANTARA BORDEAUX's older Phong `shi` → wet-leather look)
    // renders matte with NO re-import. pCon's own PBR export declares these
    // fabrics ~0.8, so 0.8 is a true floor, not a distortion.
    if (pbr?.spec != null) mat.specularIntensity = pbr.spec;
    // SHEEN IS NOT GLOSS, and killing it is what made every scan read flat.
    // A normal map is only visible through a surface's specular/sheen response
    // and its IBL: with sheen 0, clearcoat 0 and envMapIntensity halved, the
    // weave relief below was computed and then rendered invisible — «se ven
    // todas planas». The gloss complaint this came from («too much shine») was
    // about the CLEARCOAT/roughness pair, which stays exactly as it was: matte,
    // never wet. Sheen is the cloth lobe — the soft retro-reflective glow real
    // upholstery has at grazing angles — and it is precisely what lets a woven
    // surface show its threads. Tinted to the fabric's own hue (sheenColor =
    // base, set above), so it glows in the cloth's colour rather than glazing a
    // white film over it.
    mat.roughness = Math.max(pbr?.rough ?? 0.85, 0.8);
    mat.sheen = pbr ? SCAN_SHEEN_PBR : SCAN_SHEEN;
    mat.sheenRoughness = 0.85;
    mat.clearcoat = 0;                                    // no wet coat, ever
    mat.envMapIntensity = Math.min(SCAN_ENV_INTENSITY, mat.envMapIntensity);
    mat.userData.scanFinish = true;
  }
  if (tex && opts.scanNormal) {
    // The scan's OWN weave relief (makeWeaveNormal) — tiled in LOCKSTEP with
    // the albedo so every ridge sits exactly on the thread that casts it.
    // This is what keeps a matte scan from reading as printed paper in
    // raking light (the photorealism ask) while staying texture-true.
    mat.normalMap = opts.scanNormal;
    opts.scanNormal.wrapS = opts.scanNormal.wrapT = THREE.RepeatWrapping;
    opts.scanNormal.repeat.copy(mat.map.repeat);
    opts.scanNormal.anisotropy = opts.anisotropy || FABRIC_ANISOTROPY;
    const ns = opts.scanNormalScale ?? SCAN_NORMAL_SCALE;
    mat.normalScale = new THREE.Vector2(ns, ns);
  } else if (opts.normalMap && !pbr && !materialless) {
    // The procedural quilt relief — skipped when materialless (a blank-canvas
    // "sin tela" piece stays smooth, no woven waffle).
    mat.normalMap = opts.normalMap;
    // Tile the weave normal at the SAME repeat as the grain so the relief lines up
    // with the tonal weave (both are derived from one height field).
    opts.normalMap.wrapS = opts.normalMap.wrapT = THREE.RepeatWrapping;
    opts.normalMap.repeat.set(rep, rep);
    const ns = opts.normalScale ?? 0.5;
    mat.normalScale = new THREE.Vector2(ns, ns);
  }
  // ── The rest of the scan's MEASURED PBR (colormass ships eight maps; pCon
  // shipped none of these). Each is linear data, tiled in LOCKSTEP with the
  // albedo, and bound ONLY for a real scan that carries it — a fabric without
  // the map (every pCon/LR colour) is byte-for-byte unchanged.
  if (tex && mat.map) {
    const tileLike = (t) => {
      if (!t) return;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.copy(mat.map.repeat);
      t.anisotropy = opts.anisotropy || FABRIC_ANISOTROPY;
    };
    if (opts.scanRoughness) {
      // The MAP drives roughness per texel (a two-tone or boucle weave stops
      // reading uniformly matte); mat.roughness becomes the multiplier at 1.
      mat.roughnessMap = opts.scanRoughness;
      mat.roughness = 1;
      tileLike(opts.scanRoughness);
    }
    if (opts.scanMetalness) {
      // ≈black on cloth → dielectric, but bound faithfully rather than assumed.
      mat.metalnessMap = opts.scanMetalness;
      mat.metalness = 1;
      tileLike(opts.scanMetalness);
    }
    if (opts.scanAnisotropy && 'anisotropy' in mat) {
      // THE velvet lobe: RG direction + B strength (the packed map the import
      // built). This is what makes Asator read as velvet, not flat matte.
      mat.anisotropy = 1;
      mat.anisotropyMap = opts.scanAnisotropy;
      tileLike(opts.scanAnisotropy);
    }
    const dispCm = opts.scanPbr?.dispCm;
    if (opts.scanDisplacement && dispCm > 0) {
      // Real height, scaled from the manifest (cm→m). Sub-millimetre on cloth
      // and only visible where the mesh is tessellated — bound for faithfulness,
      // harmless where it isn't.
      mat.displacementMap = opts.scanDisplacement;
      mat.displacementScale = dispCm / 100;
      tileLike(opts.scanDisplacement);
    }
  }
  return mat;
}

/**
 * The DOMINANT colour of a Ligne Roset swatch image (a packed 0xRRGGBB int) or
 * null. LR swatches are a folded fabric photo with an A–F letter strip down the
 * LEFT edge, so we average the right ~75% and drop near-white/near-black pixels
 * (the strip, blown highlights, fold shadows) for a true, saturated velvet
 * colour. Reading the pixels needs a CORS-clean image — the swatch-proxy gives
 * that; a direct (tainted) load throws on getImageData → null → default colour.
 * Returns null under Node (no `document`) so the export path stays test-safe.
 */
export function sampleSwatchColor(image) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const cv = document.createElement('canvas');
    const w = (cv.width = 96), h = (cv.height = 96);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const x0 = Math.floor(w * 0.18), x1 = Math.floor(w * 0.97);
    const y0 = Math.floor(h * 0.06), y1 = Math.floor(h * 0.94);
    // Pass 1 — gather opaque-pixel luminances to find the swatch's MEDIAN tone.
    const lums = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 8) continue;
        lums.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
    }
    if (!lums.length) return null;
    lums.sort((a, b) => a - b);
    const med = lums[lums.length >> 1];
    // Pass 2 — average (in LINEAR light) only the MATTE MIDTONES around the median.
    // Velvet swatches are shot with a bright diagonal sheen fold; that fold is a
    // specular highlight, NOT the fabric colour, and averaging it in is exactly
    // what made deep colours sample out pale. Reject it (and the deep shadow
    // folds) by keeping a band around the median → the true diffuse colour.
    const lo = Math.max(14, med * 0.5), hi = Math.min(240, med * 1.28);
    let lr = 0, lg = 0, lb = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 8) continue;
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (lum < lo || lum > hi) continue;
        lr += S2L(R); lg += S2L(G); lb += S2L(B); n++;
      }
    }
    if (!n) return null;
    // Encode the linear average back to an sRGB hex; THREE.Color reads it as sRGB
    // and decodes once → the material's working colour is the true linear mean.
    return (L2S(lr / n) << 16) | (L2S(lg / n) << 8) | L2S(lb / n);
  } catch { return null; }
}

/**
 * A colour's FAMILY-WEAVE texture: the sibling swatch scan re-tinted to this
 * colour's own RGB. Every colour of a fabric family (ALCANTARA, TONA, …) shares
 * ONE physical weave — only the dye differs — so a colour whose .matz carried
 * no usable texture inherits a linked sibling's scan: grayscale it, normalize
 * to its own mean (pure weave relief, mean 1.0), then multiply by the target
 * colour and bake the result into a CanvasTexture. Baking (instead of a
 * white-material × neutral-map trick) keeps the material path identical to a
 * real scan — textured fabrics always render with a white base colour — and
 * gives exact control of the resulting tone. Returns null under Node / on a
 * tainted image / without a target colour, so callers fall back to flat colour.
 */
export function makeTintedWeave(THREE, image, colorInt) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const c = Number(colorInt);
    if (!Number.isFinite(c)) return null;
    const tr = (c >> 16) & 255, tg = (c >> 8) & 255, tb = c & 255;
    const cv = document.createElement('canvas');
    const w = (cv.width = Math.min(1024, image.width));
    const h = (cv.height = Math.min(1024, image.height));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);   // throws on a tainted canvas → null
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const mean = sum / (d.length / 4);
    if (!(mean > 0)) return null;
    // Bake at the fabric's TRUE tone: normalize the weave's mean to 1.0 and
    // multiply by the target rgb, so the tinted piece renders at exactly its
    // own colour — the SAME "full albedo" key a real scan now uses (the
    // material no longer darkens either by `dif`). Keeps a tinted-fallback
    // colour and a real scan of a sibling at one brightness.
    for (let i = 0; i < d.length; i += 4) {
      const g = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / mean;
      d[i] = Math.min(255, Math.round(g * tr));
      d[i + 1] = Math.min(255, Math.round(g * tg));
      d[i + 2] = Math.min(255, Math.round(g * tb));
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    // The bake already carries its tone — the material must NOT re-tint it.
    tex.userData.tinted = true;
    return tex;
  } catch { return null; }
}

/**
 * Anchor a real scan to its LR SWATCH tone. The .matz diffuse is a SEPARATE
 * capture from the Ligne Roset swatch the customer actually picks (shown in the
 * card), and the two disagree — measured: VIOLINE's .matz averages a cool
 * near-black (#1b1a25) and renders BLACK, while its swatch is a lighter warm
 * aubergine (#2b1e22); ROSE's .matz is a lighter desaturated dusty rose than its
 * richer swatch. A single lighting tweak can't fix both (opposite directions).
 *
 * The fix is a per-channel GAIN that moves the texture's MEAN (= its stored
 * `rgb`, verified equal to the pixel mean) onto the swatch tone, KEEPING the
 * weave's own luminance/colour variation (unlike makeTintedWeave, which
 * neutralizes). Where the .matz already matches its swatch (e.g. SILVER — the
 * gain is ~1) it returns NULL so the caller keeps the raw scan (pCon fidelity
 * preserved). Gains are clamped so one channel can't blow out or vanish.
 * `matzInt`/`swatchInt` are 0xRRGGBB; both were sampled in sRGB byte space, so
 * the gain is applied there too (consistent with how they were measured).
 */
export function correctScanToSwatch(THREE, image, matzInt, swatchInt) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const m = Number(matzInt), s = Number(swatchInt);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    const mr = (m >> 16) & 255, mg = (m >> 8) & 255, mb = m & 255;
    const sr = (s >> 16) & 255, sg = (s >> 8) & 255, sb = s & 255;
    const gainOf = (t, f) => Math.max(0.2, Math.min(4, (t + 1) / (f + 1)));
    const gr = gainOf(sr, mr), gg = gainOf(sg, mg), gb = gainOf(sb, mb);
    // Negligible shift → keep the raw scan (the .matz already IS its swatch tone).
    if (Math.abs(gr - 1) < 0.06 && Math.abs(gg - 1) < 0.06 && Math.abs(gb - 1) < 0.06) return null;
    const cv = document.createElement('canvas');
    const w = (cv.width = Math.min(1024, image.width));
    const h = (cv.height = Math.min(1024, image.height));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);   // throws on a tainted canvas → null
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, Math.round(d[i] * gr));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * gg));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * gb));
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.userData.tinted = true;   // carries its own tone — the material renders it full-albedo
    return tex;
  } catch { return null; }
}

/**
 * A NORMAL MAP derived from a fabric scan itself — the photorealism lever for
 * upholstery: real cloth shows its weave RELIEF in raking light, and a flat
 * albedo (however sharp) reads as printed paper. Height = luminance, slopes =
 * a 3×3 Sobel with WRAP-AROUND sampling (the scan tiles, so the derived map
 * must tile seamlessly too), encoded as a tangent-space normal texture. This
 * is texture-TRUE relief — the scan's own weave, not a synthetic quilt — so
 * it composes with the pCon material port instead of fighting it. Returns a
 * CanvasTexture (caller flags/caches/disposes) or null under Node / on a
 * tainted image.
 */
export function makeWeaveNormal(THREE, image, { size = 768, strength = 2.4 } = {}) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const cv = document.createElement('canvas');
    const w = (cv.width = Math.min(size, image.width));
    const h = (cv.height = Math.min(size, image.height));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const src = ctx.getImageData(0, 0, w, h).data;   // throws on tainted → null
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      lum[p] = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
    }
    const out = ctx.createImageData(w, h);
    const d = out.data;
    const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sobel slopes (wrapped) → surface normal. +Y up (OpenGL convention,
        // what three expects); z dominates so the relief stays cloth-subtle.
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        let nx = -dx * strength, ny = -dy * strength, nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
        const i = (y * w + x) * 4;
        d[i] = Math.round((nx * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return new THREE.CanvasTexture(cv);
  } catch { return null; }
}

/**
 * How COLORFUL an image is: mean (|R−G| + |G−B|) over a small resample,
 * 0..510. pCon ships some diffuses as NEUTRAL grayscale detail maps whose
 * colour lives in material.mat's `dif` (the silver-sparkle alcantaras ≈ 3–6;
 * a real colored scan ≈ 60+) — the 3D uses this to catch a neutral map and
 * tint it with the fabric's own tone instead of rendering a colourless piece.
 * Null under Node or on a tainted image (callers treat null as colourful).
 */
export function imageColorfulness(image) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const cv = document.createElement('canvas');
    const w = (cv.width = 48), h = (cv.height = 48);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]);
    return sum / (data.length / 4);
  } catch { return null; }
}

/**
 * Drop a loaded REAL model (a pCon export — GLB/OBJ/FBX/DAE/3DS, already
 * tessellated) into a piece group: clone it, upholster every mesh in the piece's
 * fabric material (so "drag a fabric" works exactly like in pCon), apply the
 * descriptor's axis/facing fixups, scale it UNIFORMLY (true to the FBX — never a
 * per-axis squash), then recentre on its footprint and sit it on the floor — so the
 * export's own origin/scale/up-axis don't matter and the piece lands EXACTLY where
 * the 2D plan shows it.
 *
 * Not every mesh is upholstery. A part GROUP the dealer gave FINISH options
 * (`parts.finishes` — metal legs, a wooden base) renders the picked option's own
 * colour/metalness instead of the fabric, and is skipped by the fabric UV
 * projection + quilt normal wiring below: a leg must never wear the weave
 * relief. The footprint carries the picks (`partFinishes: { groupKey: optionId }`)
 * and the build-scoped material factory (`finishMaterialFor`).
 *
 * BACK-COMPAT INVARIANT: with no `finishes` on the model — which is the WHOLE
 * catalogue today — `finishSpecOf` yields nothing, every mesh takes the fabric
 * branch, and the output is byte-for-byte what it was before finishes existed.
 * `merges` is the same shape of no-op: absent, the group key IS the mesh's own
 * part key, so `userData.partKey` is purely additive.
 */
// Box-projected UVs for a geometry that has none — pCon exports carry ONLY
// POSITION + NORMAL (measured on the real GLBs), so without this no texture
// (fabric map, weave grain) can ever appear on a real model: three.js needs a
// `uv` attribute to sample a map. Per vertex, project onto the plane
// orthogonal to the dominant normal axis (the standard box unwrap — seams land
// on the crease between faces, invisible on fabric) and scale so ONE uv unit
// is `tileLocal` model units; makeFabricMaterial's repeat then tiles the cloth
// at a true physical size.
function generateBoxUvs(THREE, geometry, tileLocal) {
  const src = geometry?.attributes?.position;
  if (!src || !(tileLocal > 0)) return geometry;
  // Project per FACE, not per vertex: these are smooth rounded shapes, so
  // vertex normals rotate continuously — projecting by them mixes axes INSIDE
  // a triangle and smears the map into grey mush. Per-face needs each triangle
  // to own its vertices → de-index first (the geometry is already a per-piece
  // clone, so the duplication touches nothing shared).
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t);
    const bx = pos.getX(t + 1), by = pos.getY(t + 1), bz = pos.getZ(t + 1);
    const cx = pos.getX(t + 2), cy = pos.getY(t + 2), cz = pos.getZ(t + 2);
    // Face normal (unnormalized cross product is enough for axis dominance).
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = Math.abs(e1y * e2z - e1z * e2y);
    const ny = Math.abs(e1z * e2x - e1x * e2z);
    const nz = Math.abs(e1x * e2y - e1y * e2x);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let u, v;
      if (nx >= ny && nx >= nz) { u = z; v = y; }         // lateral faces → ZY
      else if (ny >= nx && ny >= nz) { u = x; v = z; }    // top/bottom → XZ
      else { u = x; v = y; }                               // front/back → XY
      uv[i * 2] = u / tileLocal;
      uv[i * 2 + 1] = v / tileLocal;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Whether the dealer TAGGED this part group HIMSELF — the exact lookup
 * `partRoleFor` does, minus its 'base' fallback. The distinction the fallback
 * erases is the one the factory rule turns on: an explicit `base` is a decision
 * ("this IS upholstery"), an ABSENT entry is silence.
 */
function isTaggedPart(parts, key) {
  const mats = parts?.mats;
  if (!mats || !key) return false;
  return PART_ROLES.includes(mats[key]) || PART_ROLES.includes(mats[baseKeyOf(key)]);
}

/**
 * The mesh's OWN finish, when it brought one — the material an LR product folder
 * shipped, baked into the GLB at import (sceneImport's bundled maps). Null for
 * every model that carries no texture of its own, which is every pCon export.
 *
 * The map has to have real IMAGE data: a texture whose image never decoded
 * renders black, and "black" is a worse answer than the base fabric.
 *
 * A multi-material mesh is ALL-OR-NOTHING: one textured slot makes the whole
 * array factory. Splitting it would mean fabric on some geometry groups and the
 * export's own UVs on others, of one mesh, off one UV set — the two texturings
 * are mutually exclusive per geometry, so the mesh answers as a unit.
 *
 * The material is CLONED. `object.clone(true)` shares materials with the model
 * CACHE (one parsed object per URL, reused by the stage, the thumbnails and the
 * launch card at once), and `disposeGroup` frees every material it can reach
 * from the built group — keeping the cached one by reference would hand the next
 * build an already-disposed material. The clone shares the TEXTURE, so the
 * images are still loaded exactly once; flagging them `shared` is what stops
 * disposeGroup freeing the cache's pixels along with the clone.
 */
function factoryMaterialFor(source, cache, anisotropy = FABRIC_ANISOTROPY) {
  const mats = Array.isArray(source) ? source : (source ? [source] : []);
  if (!mats.some((m) => m?.map?.isTexture && (m.map.image || m.map.source?.data))) return null;
  const clones = mats.map((m) => {
    const hit = cache.get(m);
    if (hit) return hit;
    const c = m.clone();
    if (c.map) c.map.userData.shared = true;
    // ANISOTROPY, the same lever the fabric path already pulls (makeFabricMaterial).
    // A GLB's own maps arrive at three's default of 1, and a factory finish is
    // exactly the surface that default ruins: a table top or a lacquered plinth
    // is seen at a RAKING angle, where isotropic mip selection has to pick a mip
    // for the compressed axis and blurs the other one with it — the oak reads as
    // a soft smear next to the source bitmap. It costs nothing but a sampler
    // flag, and it's per-map (not per-material) so every slot follows the
    // albedo. Textures are cached/shared, hence set on the clone's maps once.
    const aniso = Math.max(1, anisotropy || 1);
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'anisotropyMap', 'displacementMap']) {
      const t = c[slot];
      if (t?.isTexture && t.anisotropy !== aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
    }
    c.userData.factoryFinish = true;
    cache.set(m, c);
    return c;
  });
  return Array.isArray(source) ? clones : clones[0];
}

function placeRealModel(THREE, object, material, desc, pieceGroup, footprint) {
  const clone = object.clone(true);
  // The unit scale is needed BEFORE the material pass so generated UVs come out
  // at true fabric size (~25 cm per tile after the material's ×3 repeat),
  // whatever unit the export was authored in. Rotation fixups don't change the
  // largest extent, so measuring the raw clone is equivalent.
  const preSize = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());
  const unit = Number(desc?.scale) > 0 ? Number(desc.scale) : autoUnitScale(Math.max(preSize.x, preSize.y, preSize.z));
  // FABRIC_UV_CM (54 cm) per uv unit. A fabric whose .matz shipped a
  // material.mat renders at its EXACT physical size (repeat = 54 / tileCm in
  // makeFabricMaterial — the .mat's `scale` is repeats-per-meter); fabrics
  // without .mat data ride the ×3 default repeat ≈ 18 cm per tile —
  // essentially true cloth scale (a TONA fleck ~6 mm, procedural threads
  // ~2 mm), owner-calibrated: realism beats forced legibility at distance
  // ("son muy grandes… esto es tela" — 36 cm tiles read like terrazzo).
  const tileOuterLocal = FABRIC_UV_CM / Math.max(1e-6, unit);
  // World matrices must be current so each mesh's ACCUMULATED node scale is
  // readable below — pCon exports often author geometry in cm and carry the
  // cm→m conversion as a NODE scale in the scene graph, so raw geometry
  // coordinates are NOT in the object's outer unit. UVs generated from those
  // raw coordinates must divide out that node scale, or the tile lands a
  // power of ten too small and the weave mipmaps back to flat grey.
  clone.updateMatrixWorld(true);
  const nodeScaleV = new THREE.Vector3();
  // Per-PART upholstery: each mesh node keeps the export's material NAME (the
  // stable pCon UUID shared across models) — that name keys the dealer's parts
  // tagging, so a tagged cushion/bolster gets its OWN fabric material while
  // untagged nodes ride the piece's base fabric. The role is stashed on the
  // mesh for the stage's raycast (tap a cushion → edit that part).
  // Part keys first, in one pre-pass, because a key can depend on the OTHER
  // meshes sharing its material: an export that upholsters the back cushions and
  // the bolster in one material splits into shape clusters (see partKeysFor), and
  // that split can only be seen with every box in hand. Boxes are remapped for a
  // Z-up export exactly as the admin tagger remaps them, so both sides cluster
  // the same meshes the same way — the tagging the dealer confirmed is the
  // tagging the stage renders.
  // A geometry's congruence signature, memoised ON the geometry: it is a pure
  // function of buffers that never change after load, and a rebuild happens on
  // every drag — recomputing an area/volume sweep per frame is the one way this
  // could cost anything. Shared geometry pays once.
  const cachedBodySignature = (g) => {
    if (!g?.attributes?.position) return '';
    if (typeof g.userData?.bodySig === 'string') return g.userData.bodySig;
    const sig = bodySignature(g.attributes.position.array, g.index?.array || null);
    try { (g.userData ||= {}).bodySig = sig; } catch { /* frozen userData — just don't cache */ }
    return sig;
  };
  const zUpSrc = desc?.upAxis === 'z';
  const partNodes = [];
  const boxV = new THREE.Box3();
  const sizeV = new THREE.Vector3();
  clone.traverse((o) => {
    if (!o.isMesh) return;
    const nm = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
    boxV.setFromObject(o).getSize(sizeV);
    const s = zUpSrc ? [sizeV.x, sizeV.z, sizeV.y] : [sizeV.x, sizeV.y, sizeV.z];
    partNodes.push({ materialName: nm, size: s, signature: cachedBodySignature(o.geometry) });
  });
  const partKeys = partKeysFor(partNodes);
  // The FINISH material for a group, or null when the group has no finish spec
  // (every group in today's catalogue). Resolution is pure data: the model's
  // spec picks the option set, the piece's own pick (or the spec's default)
  // picks the option, and the build-scoped factory hands back the ONE material
  // instance every mesh in that group shares.
  const finishMatFor = (groupKey) => {
    const spec = finishSpecOf(footprint?.parts, groupKey);
    if (!spec) return null;
    const option = finishOptionOf(spec, footprint?.partFinishes?.[groupKey]);
    if (!option) return null;
    return footprint?.finishMaterialFor?.(groupKey, option) || null;
  };
  let meshIdx = 0;
  // ONE clone per SOURCE material for this placement: an export splits a single
  // walnut into a dozen nodes, and cloning per mesh would upload the same
  // bitmap a dozen times.
  const factoryMats = new Map();
  clone.traverse((o) => {
    if (o.isMesh) {
      const srcName = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
      const rawKey = partKeys[meshIdx];
      const role = partRoleFor(footprint?.parts, srcName, meshIdx, rawKey);
      // The GROUP key, not the raw mesh key: the dealer's `merges` fold a stray
      // child key into the key it belongs to (four legs exported as four
      // materials are ONE leg group), so this is the key a finish is chosen by
      // AND the key the pickers raycast off the mesh. No merge entry ⇒ the raw
      // part key, so stamping it changes nothing for an untouched model.
      const groupKey = mergedKeyOf(footprint?.parts, rawKey);
      meshIdx += 1;
      o.userData.partRole = role;
      o.userData.partKey = groupKey;
      // ── MATERIAL PRECEDENCE, highest first. Pinned, because three different
      // things can claim the same mesh and only one order is defensible:
      //
      //   1. FINISH  — the group has an authored palette (metal legs, a lacquered
      //      base). Explicit dealer work, and the client may even be picking it.
      //   2. EXPLICIT TAG — the dealer put a role on this group in `parts.mats`.
      //      He looked at the mesh and said what it is, so it upholsters: a
      //      fabric role binds fabric, and an explicit `base` binds the base
      //      fabric. This is what OVERRIDES a factory finish.
      //   3. FACTORY FINISH — untagged, and the GLB material carries its OWN
      //      texture map (an LR product folder shipped its bitmaps and the
      //      import baked them in). It renders AS-IS: walnut stays walnut.
      //   4. the role's fabric — untagged and untextured, i.e. every pCon
      //      export there has ever been. Unchanged.
      //
      // Silence is the hinge. An untagged mesh used to mean "base fabric"
      // because there was nothing else it could mean; a mesh that brought its
      // own finish is the case where that default is simply wrong, and the
      // dealer's escape hatch is to tag it (rule 2) — never to un-texture it.
      const finishMat = finishMatFor(groupKey);
      const factoryMat = (finishMat || isTaggedPart(footprint?.parts, rawKey))
        ? null
        : factoryMaterialFor(o.material, factoryMats, footprint?.anisotropy);
      o.material = finishMat || factoryMat
        || (footprint?.materialForRole ? footprint.materialForRole(role) : material);
      // clone(true) shares the source geometry by reference; clone it so the group
      // OWNS its buffers and disposeGroup never frees the cached model's. This is
      // an OWNERSHIP rule, not a texturing one — a finished mesh needs it just as
      // much, so the clone stays outside the fabric branch.
      if (o.geometry) {
        o.geometry = o.geometry.clone();
        // ALWAYS project our OWN fabric UVs — never tile over the export's baked
        // set. We just replaced the export's material (above) with our uniform,
        // tileable cloth; a pCon FBX's baked UVs were unwrapped for ITS material
        // atlas (per-island, arbitrary scale), so tiling our weave over them
        // stretches it to invisibility — the "flat colour, no texture" Kashima and
        // Noka showed (both ship baked UVs; the models that render right ship none
        // and already fell through to this path). Box-projecting at true fabric
        // scale — outer tile ÷ the node's own composed scale (pCon carries the
        // cm→m as a node scale; max guards a degenerate 0) — tiles the cloth
        // correctly on EVERY real model, baked UVs or not.
        // Skipped for a finished mesh: its material carries no map and no normal
        // map, so generated fabric UVs would be dead weight — and de-indexing the
        // geometry to make them (generateBoxUvs) would cost the buffers for
        // nothing.
        // Skipped for a FACTORY finish for the opposite reason: those baked UVs
        // are the only thing that makes its own bitmaps land where the product
        // designer put them. Box-projecting over them is exactly the "stretched
        // to invisibility" failure above, aimed at the map we kept on purpose.
        if (!finishMat && !factoryMat) {
          const ns = o.getWorldScale(nodeScaleV);
          const nodeScale = Math.max(ns.x, ns.y, ns.z) || 1;
          o.geometry = generateBoxUvs(THREE, o.geometry, tileOuterLocal / nodeScale);
        }
      }
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // Orientation fixups. The loader ALREADY applies the file's up-axis, so these are
  // MANUAL overrides: stand up a mis-tagged Z-up export, then spin the open front
  // toward the viewer.
  if (desc?.upAxis === 'z') clone.rotation.x = -Math.PI / 2;
  if (desc?.rotateY) clone.rotation.y += (desc.rotateY * Math.PI) / 180;
  clone.updateMatrixWorld(true);

  // ONE uniform scale — the FBX keeps its TRUE size and proportions (a square corner
  // stays square; a per-axis "fit to tile" is what once turned it rectangular). A
  // dealer-set desc.scale wins (a manual override); otherwise the auto-unit guard
  // only corrects a gross mm/cm/m export (a power of ten off the real ~72 cm Togo
  // height), so the model renders at its real modelled size — true to the FBX.
  const wrap = new THREE.Group();
  wrap.add(clone);
  // Unit guard off the LARGEST extent (not height) — a short bolster/arm cushion is
  // ~1 m long, so its span pins the unit; keying off height blew it up ×10.
  // `unit` was measured above (pre-fixup — rotations don't change the largest
  // extent), and the UV generation already used the SAME value.
  const base = unit;
  wrap.scale.setScalar(base);
  wrap.updateMatrixWorld(true);

  // FIT THE FOOTPRINT — Togo overfills the whole mesh, structured collections
  // fit their PLATFORM. Togo's soft cushions are modelled INSIDE their
  // catalogue footprint, so two pieces snapped flush left a visible strip
  // between the cushions — "the white space"; Togo slightly OVERFILLS (BLEED)
  // so they squish together at the seam. STRUCTURED collections (Prado) fit
  // the tile by their platform/base box instead (see anchorBoxOf below). A
  // grossly wrong mesh is never warped — per-axis ratios stay near-equal so
  // it doesn't visibly distort. Height (Y) is untouched (~72 cm).
  // The ANCHOR box a structured module fits/centres by: its PLATFORM, not its
  // whole AABB. A Prado module's back cushions LEAN past the platform (the
  // settee's mesh runs 18.6 cm deeper than its 160 cm platform), and the tile
  // (from floorTriangles) is platform-true — fitting the whole AABB into that
  // tile squashed the mesh and mis-centred the platform, and two "joined"
  // modules could never touch platform-to-platform. Tagged parts give the
  // exact answer (the base-role meshes); untagged models approximate it with
  // the FLOOR BODY (meshes starting in the lower 40% — the same cut the 2D
  // plan uses, so tile and 3D agree by construction). Falls back to the full
  // box when the anchor degenerates.
  const anchorBoxOf = () => {
    const full = new THREE.Box3().setFromObject(wrap);
    const tagged = hasParts(footprint?.parts);
    const cut = full.min.y + (full.max.y - full.min.y) * 0.4;
    const anchor = new THREE.Box3();
    wrap.traverse((o) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      if (!Number.isFinite(b.min.y)) return;
      if (tagged ? o.userData.partRole === 'base' : b.min.y <= cut) anchor.union(b);
    });
    const size = anchor.getSize(new THREE.Vector3());
    return size.x > 1e-3 && size.z > 1e-3 ? { anchor, full } : { anchor: full, full };
  };

  const sz = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
  const w = Number(footprint?.widthCm) || 0, d = Number(footprint?.depthCm) || 0;
  const structured = meshSeamBleed(footprint?.collection) < 1;
  if (w > 0 && d > 0 && sz.x > 1e-3 && sz.z > 1e-3) {
    if (!structured) {
      // Togo (soft cushions): overfill toward the footprint so neighbours squish
      // flush; a gentle clamp keeps a slightly-off export from distorting.
      const BLEED = meshSeamBleed(footprint?.collection);
      const clamp = (r) => Math.max(0.85, Math.min(1.35, r));
      wrap.scale.x = base * clamp((w * BLEED) / sz.x);
      wrap.scale.z = base * clamp((d * BLEED) / sz.z);
    } else {
      // Structured (Prado, Kashima, …): fit the FULL mesh to the catalogue W×D
      // so the rendered model IS its catalogue size. The old platform-fit sized
      // only the seat base and let the loose back cushions lean ~27 cm PAST the
      // catalogue depth, so a "240×120" sofa rendered 240×147 (the mesh seat is
      // exactly 240×120, but the thrown-back cushions pushed the AABB deeper).
      // Per-axis (like Togo) so both dimensions land on catalogue exactly; the
      // clamp guards a grossly-off export from distorting. Height (Y) untouched.
      const clamp = (r) => Math.max(0.4, Math.min(1.35, r));
      wrap.scale.x = base * clamp(w / sz.x);
      wrap.scale.z = base * clamp(d / sz.z);
    }
    wrap.updateMatrixWorld(true);
  }

  // Recentre and sit on the floor — the export's own origin and up-axis stop
  // mattering, and the piece lands where the 2D plan shows it. The whole mesh
  // (now catalogue-sized) is centred on its tile, so the 2D box and the 3D
  // model occupy exactly the same footprint.
  const { full } = anchorBoxOf();
  const c = full.getCenter(new THREE.Vector3());
  wrap.position.set(-c.x, -full.min.y, -c.z);
  pieceGroup.add(wrap);
}

/**
 * Build the furniture group from a scene spec. `textureFor(fabricCode)` returns
 * a THREE.Texture or null (the caller owns loading/caching). `modelFor(piece)`
 * returns `{ object, desc }` for a real loaded model (or null to fall back to
 * procedural geometry) — so the SAME scene shows real Togo models the moment
 * they're wired and generated cushions until then. Pieces share one material
 * each (one per piece), so a fabric swap is a single `.map` change.
 */
export function buildTogoGroup(deps, scene3d, opts = {}) {
  const { THREE, RoundedBoxGeometry } = deps;
  const colorFor = opts.colorFor || (() => null);
  const textureFor = opts.textureFor || (() => null);
  const pbrFor = opts.pbrFor || (() => null);
  const normalFor = opts.normalFor || (() => null);
  // The rest of the scan's PBR maps, per code: `{ roughness, metalness,
  // displacement, anisotropy }` or null. A caller that resolves none (or an old
  // caller that doesn't pass this) leaves every fabric exactly as it was.
  const extrasFor = opts.extrasFor || (() => null);
  const modelFor = opts.modelFor || (() => null);
  const group = new THREE.Group();

  // ONE fabric material for a color code: the REAL texture when the dealer's
  // pCon library linked one (the map carries the color; the sheen still tints
  // to the fabric tone), shaded by its .mat PBR port when the archive shipped
  // one (scanPbr — diffuse multiplier, roughness, specular, physical tile
  // size), else the flat sampled/exact color as always.
  const fabricMaterialFor = (code, fallbackColor) => {
    const tex = code ? textureFor(code) : null;
    const col = (code ? colorFor(code) : null) ?? fallbackColor;
    const extras = code ? extrasFor(code) : null;
    return tex
      ? makeFabricMaterial(THREE, tex, {
        ...opts, color: null, sheenColor: col ?? undefined,
        scanPbr: code ? pbrFor(code) : null,
        scanNormal: code ? normalFor(code) : null,
        scanRoughness: extras?.roughness || null,
        scanMetalness: extras?.metalness || null,
        scanDisplacement: extras?.displacement || null,
        scanAnisotropy: extras?.anisotropy || null,
      })
      : makeFabricMaterial(THREE, null, { ...opts, color: col });
  };

  // ONE finish material per (part group + picked option), for THIS build. A
  // model's four leg meshes — and every piece in the scene wearing that same
  // finish — end up sharing one instance, so a finished group costs one
  // material however many nodes the export split it into.
  //
  // The cache is BUILD-scoped on purpose (never module-level): disposeGroup
  // frees every material reachable from the group's meshes, so a cache that
  // outlived the build would hand the next build an already-disposed material.
  // Assigning the material to a mesh IS the disposal registration — nothing
  // else to wire — and these must NOT carry `userData.shared`, which means
  // "someone else owns this" and would leak them past disposeGroup.
  //
  // The key folds in the option's APPEARANCE, not just its id: two different
  // models may both name a group "Metal" with an option "negro" and paint them
  // differently, and a name-only key would silently serve the first one's
  // material to the second.
  const finishMats = new Map();
  const finishMaterialFor = (groupKey, option) => {
    const key = [groupKey, option.id, option.rgb, option.metal ?? '', option.rough ?? ''].join('\0');
    const hit = finishMats.get(key);
    if (hit) return hit;
    // `metal` is the Model's continuous 0–1 knob (finishSpecOf clamps it;
    // absent = dielectric) — honored as-is so a brushed 0.5 doesn't silently
    // render as full chrome. The stage's reskin() skips partFinish materials,
    // so a fabric change can't push cloth roughness/sheen onto a metal leg.
    const mat = new THREE.MeshPhysicalMaterial({
      color: option.rgb,
      metalness: option.metal ?? 0,
      roughness: option.rough ?? (option.metal ? 0.35 : 0.6),
      envMapIntensity: 0.9,
    });
    mat.userData.partFinish = true;
    finishMats.set(key, mat);
    return mat;
  };

  for (const piece of (scene3d?.pieces || [])) {
    const pieceGroup = new THREE.Group();
    // The MOUNT group: everything the piece renders lives one level down, so a
    // seat-mounted accessory (loose cushion/bolster) rides at its platform
    // height while the stage's gesture/animation code keeps owning the OUTER
    // group's y (lift, drop-in, settle) without fighting the mount offset.
    const inner = new THREE.Group();
    inner.position.y = Number(piece.mountHeightCm) || 0;
    // Upholster with the linked REAL texture when the pCon library provides
    // one, else the swatch's DOMINANT colour (sampled from the LR swatch, the
    // A–F letter strip skipped) — never the folded swatch PHOTO, which repeats
    // its letters/folds/seams; the quilt normal supplies the micro-weave.
    const material = fabricMaterialFor(piece.fabricCode, opts.color);
    const real = modelFor(piece);
    if (real && real.object) {
      // EVERY tagged role gets its OWN material instance (one per role, shared
      // by that role's meshes): the part's own texture/color pick, else the
      // piece's base appearance. Own instances even when unpicked, so the
      // raycast part-hover glow lights exactly one part — never the base
      // upholstery that would otherwise share the material.
      const partMats = new Map();
      const materialForRole = (role) => {
        if (role === 'base') return material;
        if (!partMats.has(role)) {
          const code = piece.partMaterials?.[role]?.code;
          partMats.set(role, fabricMaterialFor(code || piece.fabricCode, colorFor(piece.fabricCode) ?? opts.color));
        }
        return partMats.get(role);
      };
      placeRealModel(THREE, real.object, material, real.desc, inner, {
        widthCm: piece.widthCm, depthCm: piece.depthCm, collection: piece.collection,
        parts: piece.parts, materialForRole, anisotropy: opts.anisotropy,
        // The piece's own finish picks (group key → option id). Absent on every
        // piece today, which resolves to each spec's default — and with no spec
        // at all, to today's fabric-everywhere render, unchanged.
        partFinishes: piece.partFinishes, finishMaterialFor,
      });
    } else {
      for (const part of togoParts(piece.widthCm, piece.depthCm, piece.form)) {
        let mesh;
        if (part.shape === 'ridge') {
          // A channel: a capsule laid along the width (x) or depth (z).
          mesh = new THREE.Mesh(new THREE.CapsuleGeometry(part.radius, part.length, 8, 18), material);
          mesh.rotation[part.axis === 'x' ? 'z' : 'x'] = Math.PI / 2;
        } else {
          const seg = Math.max(2, Math.round(part.r / 4));
          mesh = new THREE.Mesh(new RoundedBoxGeometry(part.w, part.h, part.d, seg, part.r), material);
        }
        mesh.position.set(part.x, part.y, part.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        inner.add(mesh);
      }
    }
    pieceGroup.add(inner);
    // Plan x→world x, plan y→world z; the plan's clockwise screen rotation is a
    // negative rotation about the up axis in three's right-handed XZ floor.
    pieceGroup.position.set(piece.x, 0, piece.z);
    pieceGroup.rotation.y = -(piece.rotationDeg || 0) * DEG;
    group.add(pieceGroup);
  }
  return group;
}

// Offset a closed loop from `traceGridLoops` a hair OUTWARD along its own edge
// normals. The tracer walks outer loops with the filled region on the LEFT (in
// y-down screen coords), so "outward" is the RIGHT of travel: n̂ = (−t̂y, t̂x)
// with t̂ = next − prev (check against the tracer's top edge: travel (−1,0),
// filled below, outward (0,−1) ✓). Normal-based (not centroid-radial) so a
// CONCAVE notch offsets away from the piece too — a radial push points the wrong
// way inside a notch.
function offsetLoopOutward(poly, dist) {
  const n = poly.length;
  if (n < 3 || !(dist > 0)) return poly;
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
    const tx = b.x - a.x, ty = b.y - a.y;
    const L = Math.hypot(tx, ty) || 1;
    return { x: p.x - (ty / L) * dist, y: p.y + (tx / L) * dist };
  });
}

/**
 * Trace a rendered coverage MASK into the selection outline, in CSS pixels — the
 * PURE half of the GPU-silhouette pipeline (TogoStage renders the GL half).
 *
 * The outline the user asks for is the OUTER ENVELOPE of the piece's projection:
 * ∂(P(S)) — the boundary of the set of screen points the 3D surface covers. The
 * one authority on that set is the rasterizer itself, so the stage renders the
 * SELECTED PIECE ALONE (white, unlit, double-sided) through the LIVE camera into
 * an offscreen target and hands the readback here. Tracing that mask IS the
 * outermost projection of the figure — every concavity included, exact at cell
 * resolution, with zero geometric assumptions (any triangle soup, open meshes,
 * self-intersecting parts all rasterise correctly).
 *
 * `pixels` is the RGBA readback (WebGL row order: row 0 = the BOTTOM row — the
 * rows are flipped here), `gw`×`gh` cells of `cell` CSS px each, the mask's
 * top-left corner at CSS (`x`,`y`). Filled = red channel > 127 (the mask renders
 * white on black). The traced boundary keeps only its LARGEST loop (a speck of
 * geometry — a floating tassel — must not steal the outline), is smoothed within
 * the quantisation band (`smoothLoopConstrained` — the curve analogue of the
 * mesh facet smoothing), and offsets `bias` px outward along its normals.
 * Returns `[{x,y}, …]` CSS px, or null when the mask is empty/degenerate.
 */
export function maskToOutline(pixels, gw, gh, { x = 0, y = 0, cell = 1, bias = 1.4, smoothPx = 2.2, allLoops = false } = {}) {
  if (!pixels || !(gw > 1) || !(gh > 1) || !(cell > 0)) return null;
  const occ = new Uint8Array(gw * gh);
  let any = false;
  for (let r = 0; r < gh; r++) {
    const src = r * gw * 4, dst = (gh - 1 - r) * gw;   // flip WebGL's bottom-up rows
    for (let c = 0; c < gw; c++) {
      if (pixels[src + c * 4] > 127) { occ[dst + c] = 1; any = true; }
    }
  }
  if (!any) return null;
  // eps 0 = RAW pixel-true boundary. The default DP compaction trades the
  // stairs' high-frequency ±half-cell error for ±eps endpoint error at 20–50 px
  // segment wavelengths — a gentle UNDULATION the band-limited smoother below
  // preserves (low frequencies pass by design), which read as a wavy outline
  // on straight sofa edges. The raw stairs carry only high-frequency error,
  // which the smoother removes completely — truer AND smoother.
  const loops = traceGridLoops(occ, gw, gh, cell, cell, 0);
  if (!loops.length) return null;
  let best = loops[0], bestA = Math.abs(loopArea(best));
  for (let i = 1; i < loops.length; i++) {
    const a = Math.abs(loopArea(loops[i]));
    if (a > bestA) { bestA = a; best = loops[i]; }
  }
  if (best.length < 3) return null;
  // One traced loop → its final screen polygon. The smoothing band is sized
  // from the loop's OWN extent, which is why this runs per loop rather than
  // once for the set: a small leg must not be smoothed with a seat's band.
  const finish = (loop) => {
    const abs = loop.map((p) => ({ x: p.x + x, y: p.y + y }));
    // With the raw trace the only noise is the ±half-cell stair — the tube can
    // sit just past it (1.25·cell), so the taut string is pixel-true. Capped by
    // the loop's own extent: a TINY loop (a small piece, far zoom) would
    // otherwise fit entirely inside the tube and the string would eat it.
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of abs) { if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y; }
    const band = Math.min(Math.max(smoothPx, cell * 1.25), Math.max(1, Math.min(mxx - mnx, mxy - mny) / 6));
    const smoothed = smoothPx > 0
      ? smoothLoopConstrained(resampleUniform(abs, Math.max(1, cell)), { clampPx: band })
      : abs;
    return offsetLoopOutward(smoothed, bias);
  };
  if (!allLoops) return finish(best);
  // EVERY island, not just the biggest — a selection can be several disjoint
  // solids (four legs, a pair of cushions), and outlining only the largest
  // says the others aren't selected when they are. Loops winding against the
  // largest are HOLES (offsetting one outward would push it the wrong way),
  // and sub-cell loops are rasterizer speckle; both are dropped.
  //
  // The floor is the LARGER of two, because "noise" means two different things.
  // Absolute (4 cells) catches the rasterizer's own grazing slivers — a mesh
  // edge clipping the pixel grid. RELATIVE (0.2% of the biggest island) catches
  // the other kind: a joined part whose meshes throw off a constellation of
  // specks around a solid, each big enough in cells to survive but far too small
  // to read as anything but grit around the outline. Real companions are never
  // near it — a sofa's leg is percent-scale against its own seat — and with a
  // selection that is ONLY small solids the largest of them sets the scale, so
  // nothing that matters is ever measured against something it isn't part of.
  const sign = Math.sign(loopArea(best)) || 1;
  const minArea = Math.max(cell * cell * 4, bestA * 0.002);
  const out = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const a = loopArea(loop);
    if (Math.sign(a) !== sign || Math.abs(a) < minArea) continue;
    const poly = finish(loop);
    if (poly && poly.length >= 3) out.push(poly);
  }
  return out.length ? out : [finish(best)];
}

function loopArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}

// Uniform arc-length resample of a CLOSED loop to ~`spacing` px between points.
// The smoother below assumes an even parameterisation (its Laplacian weights are
// uniform), and even spacing means no boundary feature is under- or over-weighted.
function resampleUniform(pts, spacing = 2) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const seg = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    seg[i] = Math.hypot(b.x - a.x, b.y - a.y);
    total += seg[i];
  }
  if (!(total > 0)) return pts.slice();
  const count = Math.max(12, Math.round(total / spacing));
  const step = total / count;
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const t = k * step;
    while (i < n - 1 && acc + seg[i] < t) { acc += seg[i]; i++; }
    const a = pts[i], b = pts[(i + 1) % n];
    const f = seg[i] > 1e-9 ? (t - acc) / seg[i] : 0;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

// The TAUT STRING through the error tube — smoothing inside a FIDELITY BAND.
// The traced boundary only knows the silhouette to ±half a cell, so every curve
// within `clampPx` of it is an equally valid trace; this picks the one a string
// pulled tight through that tube would take. Mechanism: plain Laplacian
// relaxation (each point moves toward its neighbours' midpoint), iterated to
// CONVERGENCE, with every point clamped back into the tube after each pass.
// Run to equilibrium — not a small fixed budget — because stair noise is NOT
// always high-frequency: a nearly axis-aligned edge steps sideways only every
// cell/slope px (slope 0.05 → one jog per ~60 px), and a band-limited smoother
// (the previous few-iteration Taubin) preserves exactly those long waves — the
// residual "jagged" read. The taut string is straight wherever the tube allows
// AT ANY WAVELENGTH; real corners survive because the clamp arrests the pull at
// ~clampPx — corner rounding is capped at the band, never proportional. Typed-
// array ping-pong keeps 300 passes over ~1k points around a millisecond.
function smoothLoopConstrained(pts, { iters = 300, lambda = 0.5, clampPx = 2.2 } = {}) {
  const n = pts.length;
  if (n < 8) return pts;
  const ax = new Float64Array(n), ay = new Float64Array(n);   // the tube's anchors
  let px = new Float64Array(n), py = new Float64Array(n);
  let qx = new Float64Array(n), qy = new Float64Array(n);
  for (let i = 0; i < n; i++) { ax[i] = pts[i].x; ay[i] = pts[i].y; px[i] = pts[i].x; py[i] = pts[i].y; }
  const c2 = clampPx * clampPx;
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n; i++) {
      const l = i ? i - 1 : n - 1, r = i + 1 < n ? i + 1 : 0;
      let x = px[i] + lambda * ((px[l] + px[r]) / 2 - px[i]);
      let y = py[i] + lambda * ((py[l] + py[r]) / 2 - py[i]);
      const dx = x - ax[i], dy = y - ay[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > c2) { const s = clampPx / Math.sqrt(d2); x = ax[i] + dx * s; y = ay[i] + dy * s; }
      qx[i] = x; qy[i] = y;
    }
    let t = px; px = qx; qx = t;
    t = py; py = qy; qy = t;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: px[i], y: py[i] };
  return out;
}

// ── Room boundary ────────────────────────────────────────────────────────────
// The client's space, drawn on the floor: a WHITE-OAK plank floor filling the
// area (so the drawn room reads as a real room), plus a real-width OUTLINE
// ribbon so its walls read crisply in both the top-down plan and the 3D vista.
// Corners are plan cm (room.js); world = plan cm 1:1, plan-y → world-Z, so a
// corner {x,y} drops onto the floor at (x, 0, y) with no conversion — the same
// transform every piece uses. Visual reference only (no walls, no collision) —
// furniture rests ON TOP of it.
const ROOM_FILL_COLOR = 0x9a8f7d;   // warm grey — the tint while the wood loads
const ROOM_LINE_COLOR = 0x4a463e;   // graphite ink — reads on the #F4F1EC floor
const ROOM_LINE_HALF_CM = 1.4;      // half the outline ribbon's width (~2.8 cm)
const ROOM_WOOD_TILE_CM = 170;      // the oak photo's true physical size (Poly Haven)

// The room floor's white-oak texture — loaded ONCE per page and shared by every
// room rebuild (the room group is torn down on each edit; the texture must not
// be). Poly Haven's "Laminate Floor 02" (CC0), graded to white oak, photographed
// at 170×170 cm — with the fill's UVs in plan CENTIMETRES, repeat 1/170 lays the
// planks at true physical scale, world-anchored by construction (the corners are
// absolute plan coords, so redrawing or resizing the room never slides the wood).
let roomWoodTex = null;         // THREE.Texture once loaded
let roomWoodWaiters = null;     // callbacks queued while the JPEG is in flight
function roomWoodTexture(THREE, anisotropy, onReady) {
  if (roomWoodTex) return roomWoodTex;
  if (roomWoodWaiters) { roomWoodWaiters.push(onReady); return null; }
  roomWoodWaiters = [onReady];
  new THREE.TextureLoader().load('/textures/white-oak.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / ROOM_WOOD_TILE_CM, 1 / ROOM_WOOD_TILE_CM);
    tex.anisotropy = anisotropy || 1;
    roomWoodTex = tex;
    const waiters = roomWoodWaiters; roomWoodWaiters = null;
    for (const cb of waiters) cb?.(tex);
  }, undefined, () => { roomWoodWaiters = null; /* offline → the tint stands */ });
  return null;
}

// Positions for the outline ribbon: each polygon edge becomes a floor-flat quad
// offset by ±ROOM_LINE_HALF_CM along its perpendicular, so the boundary has a
// real, device-independent width (a LineLoop renders 1px thin on most GPUs).
function roomOutlinePositions(corners) {
  const pos = [];
  const n = corners.length;
  for (let i = 0; i < n; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * ROOM_LINE_HALF_CM;
    const pz = (dx / len) * ROOM_LINE_HALF_CM;
    const a1 = [a.x + px, a.y + pz];
    const a2 = [a.x - px, a.y - pz];
    const b1 = [b.x + px, b.y + pz];
    const b2 = [b.x - px, b.y - pz];
    for (const [x, z] of [a1, a2, b2, a1, b2, b1]) pos.push(x, 0, z);
  }
  return pos;
}

/**
 * Build the room-boundary group (fill + outline) from a `{shape, corners}` room
 * (plan cm). Returns a THREE.Group ready to add to the scene, or null when the
 * room is degenerate. The caller owns disposal (`disposeRoomGroup`). Kept OUT of
 * the per-edit `l.group` (which is rebuilt on every drag) — it lives beside it.
 */
export function buildRoomGroup(THREE, room, { onAsset, anisotropy } = {}) {
  const corners = room?.corners;
  if (!Array.isArray(corners) || corners.length < 3) return null;
  const group = new THREE.Group();
  group.name = 'roomBoundary';
  group.renderOrder = -0.5; // above the grid (-1), below pieces

  // Fill — a THREE.Shape in XY, laid flat onto XZ (rotateX +90°: (x,y)→(x,0,y)).
  // ShapeGeometry emits UVs equal to the shape's raw XY — plan centimetres — so
  // the shared oak texture (repeat 1/170) tiles at true plank scale. The fill
  // sits BELOW the y=0 shadow catcher: the piece's contact shadow draws over the
  // wood, and the dot lattice (further down) disappears inside the room — it's a
  // floor now, not paper. Until the JPEG arrives the barely-there tint stands;
  // `onAsset` lets the render-on-demand stage repaint the moment the wood lands.
  const shape = new THREE.Shape();
  corners.forEach((c, i) => (i === 0 ? shape.moveTo(c.x, c.y) : shape.lineTo(c.x, c.y)));
  shape.closePath();
  const fillGeo = new THREE.ShapeGeometry(shape);
  fillGeo.rotateX(Math.PI / 2);
  const fillMat = new THREE.MeshBasicMaterial({ color: ROOM_FILL_COLOR, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const dressInOak = (tex) => {
    fillMat.map = tex;
    fillMat.color.set(0xffffff);
    fillMat.opacity = 1;
    fillMat.needsUpdate = true;
  };
  const ready = roomWoodTexture(THREE, anisotropy, (tex) => { dressInOak(tex); onAsset?.(); });
  if (ready) dressInOak(ready);
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.y = -0.3;
  fill.renderOrder = -0.5;
  group.add(fill);

  // Outline ribbon.
  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.Float32BufferAttribute(roomOutlinePositions(corners), 3));
  const outline = new THREE.Mesh(
    outGeo,
    new THREE.MeshBasicMaterial({ color: ROOM_LINE_COLOR, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  );
  outline.position.y = 0.12;
  outline.renderOrder = -0.4;
  group.add(outline);

  return group;
}

/** Dispose a room group's geometries + materials (idempotent). */
export function disposeRoomGroup(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
  });
  group.parent?.remove(group);
}

/**
 * Studio rig: a neutral image-based environment (RoomEnvironment — no HDR asset
 * to ship) for soft realistic fabric shading, a key light that casts a soft
 * ground shadow, fill, and a large floor that only catches shadow. Mutates
 * `scene` and returns `{ dispose, retarget }` — `retarget(center, radius)` slides
 * the whole rig (key + target + shadow frustum + rim + floor) to follow the
 * layout, because the plan is an UNBOUNDED sandbox: a build dragged far from the
 * world origin would otherwise walk out of the shadow camera's box and lose its
 * ground shadow. The light DIRECTION is held constant (the raking ratio
 * 1.2 : 0.95 : 0.5 relative to a floor distance never below the stage radius),
 * so the fold-carving angle the rig was tuned around never steepens on a small
 * single-piece layout.
 */
// The stage's default ground — the app's warm paper. The PUBLIC configurator
// overrides it to a neutral near-white (`ground`), because there it is the
// largest surface on a page whose whole skin is the distributor inbox's
// monochrome; a cream floor under white hairline panels is the one thing that
// reads as "not designed". Internal surfaces pass nothing and keep the warmth.
const STAGE_GROUND = 0xF4F1EC;

export function setupTogoStage(deps, renderer, scene, radius, { grid = false, ground = STAGE_GROUND, presentation = false } = {}) {
  const { THREE, RoomEnvironment } = deps;
  scene.background = new THREE.Color(ground);

  // Showroom floor grid — a quiet 50 cm dot lattice under the build (live stage
  // only; thumbnails stay clean). It turns the empty canvas from a bare void
  // into a floor with SCALE the visitor can read, exactly like graph paper
  // under a plan. Drawn once into a tiled CanvasTexture; sits just below the
  // shadow catcher so contact shadows darken over the dots.
  let gridMesh = null;
  if (grid && typeof document !== 'undefined') {
    const TILE_CM = 50, PX = 64;
    const cv = document.createElement('canvas');
    cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, PX, PX);
      ctx.fillStyle = 'rgba(59, 56, 48, 0.42)';   // warm ink, kept faint by material opacity
      ctx.beginPath();
      ctx.arc(PX / 2, PX / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const size = radius * 12;
    tex.repeat.set(size / TILE_CM, size / TILE_CM);
    tex.anisotropy = fabricAnisotropy(renderer);
    gridMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false }),
    );
    gridMesh.rotation.x = -Math.PI / 2;
    gridMesh.position.y = -0.5;             // under the y=0 shadow catcher (transparent, so dots show through)
    gridMesh.renderOrder = -1;
    scene.add(gridMesh);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  // PRESENTATION rig — for a piece rendered ALONE on a white page (the catalogue
  // thumbnails, the launch card's turntable), not for the live plan.
  //
  // On the plan a piece sits on a warm floor, casts its own contact shadow and
  // the visitor can orbit it, so the soft colour-true wash is exactly right. A
  // 200 px tile on WHITE has none of that support, and the same wash flattens
  // every piece into a coloured silhouette — a Ploum and an Ottoman become two
  // blobs and the collection index stops telling you what the collections are.
  //
  // What buys the FORM back is contrast, not exposure. The IBL is the fill, and
  // a full-strength one lights the shadow side almost as brightly as the key
  // lights the front, so the gradient that describes a curve is filled straight
  // back in. Dimming it deepens every shaded plane while leaving the KEY — and
  // therefore the lit face's colour, which is what a fabric pick is judged on —
  // exactly where it was tuned. The rim comes up to keep the shadow side from
  // going muddy, and a back light draws the piece's far edge away from the page.
  if (presentation && 'environmentIntensity' in scene) scene.environmentIntensity = 0.62;

  // Colour-accurate AND fold-accentuating product lighting. The IBL still does
  // the fill (so a dark/saturated swatch keeps its TRUE depth — a hot key once
  // washed deep velvets pale), but the KEY now comes in at a LOW, RAKING angle so
  // it skims ACROSS the Togo's channels and throws a shadow into every fold
  // valley — the contrast that makes the quilting read plush instead of flat. A
  // steep top-down key (what we had) lit the fold crests and floors equally and
  // flattened them. Slightly warm + a touch stronger to deepen those shadows.
  // NEUTRAL white key/rim — pCon lights neutral, and the old warm key + cool
  // rim tinted every fabric ~1.5% red/blue (measured on the TONA seat vs the
  // scan's own channel ratios): on a page whose job is selling EXACT colours,
  // the raking geometry carves the folds, never a colour cast.
  // INTENSITY 1.2 (was 1.55): a hotter key over-lit the FACING panels well past
  // the fabric's own albedo — a mid-rose scan (PARADE ROSE, diffuse mean
  // #b68a76) washed to pale peach on the lit side while its SHADOW side rendered
  // the true tone. pCon's softer studio light shows the real colour across the
  // whole piece; dropping the key settles the lit faces toward that true tone.
  // The RAKING ANGLE (fold-carving) is unchanged — only the wash comes down, and
  // the rim/hemi/IBL still hold the shadow side, so the quilting keeps its depth.
  // Presentation raises the KEY as it dims the IBL: the ratio between them is
  // what carves form, and lifting the key restores on the lit face the exposure
  // the dimmer fill took away. Net on a tile: the same brightness, far more of
  // it spent describing the shape.
  // Presentation keeps the LIVE key, 1.2. Raising it to 1.5 was measured moving
  // the median tone by a single unit — the IBL owns the diffuse here — so it
  // bought no form and only lifted the specular lobe. Upholstery is matte
  // (roughness floored at 0.8) but not mirror-free: nearly doubling the total
  // directional light made a scanned leather-ish fabric read as POLISHED, which
  // is the one thing a fabric render must never do.
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(radius * 1.2, radius * 0.95, radius * 0.5);   // low & to the side → grazes the folds
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const d = radius * 2.2;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 6 });
  // An OrthographicCamera computes its projection in the CONSTRUCTOR only, and
  // LightShadow.updateMatrices() reuses camera.projectionMatrix verbatim — so
  // assigning the frustum bounds without this leaves the DEFAULT ±5/far-500 box
  // live: the key sits ~1.6×radius from its target, PAST that stale far plane,
  // and the whole ground shadow silently culls away. This line is what makes
  // the shadow rig actually exist.
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.radius = 3.5;     // a touch crisper → the channel/contact shadows read
  scene.add(key);
  scene.add(key.target);       // in the graph so retarget can move the aim point
  // A dim, low rim from the opposite side carves the shadow-side folds (so they
  // don't go to mush) WITHOUT lifting the body — keeps the deep-crease contrast.
  const rim = new THREE.DirectionalLight(0xffffff, presentation ? 0.42 : 0.34);
  rim.position.set(-radius * 0.95, radius * 0.45, -radius * 0.85);
  scene.add(rim);
  scene.add(rim.target);
  // Lower hemisphere fill so the channel valleys stay genuinely shadowed — drives
  // most of the seat's depth (a high fill is what flattened the quilting).
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 0.1));
  // Presentation only: a high BACK light that runs a bright line along the
  // piece's top-far edge. That edge is the whole of what separates a form from
  // the white behind it — without one a deep velvet reads as a hole punched in
  // the page rather than a sofa. It sits behind and above, so it grazes the
  // silhouette and puts almost nothing on the faces the camera sees (the key
  // still owns those, and with them the colour).
  // Enough to draw the far edge off the white page, and no more: at 0.7 this was
  // a second key raking the tops and it is what put the wet shine on them.
  const back = presentation ? new THREE.DirectionalLight(0xffffff, 0.26) : null;
  if (back) {
    back.position.set(-radius * 0.35, radius * 1.5, -radius * 1.25);
    scene.add(back);
    scene.add(back.target);
  }

  // THE GROUND SHADOW — a baked contact shadow, not the key's shadow map.
  //
  // The key rakes in low to carve the folds, and from that angle its map threw
  // the piece's silhouette ~90 cm ACROSS the floor: a second, blurry sofa lying
  // beside the real one, hard-edged and grainy (three's PCF is five jittered
  // taps — see togoContactShadow for why no dial on it could ever soften). 2D
  // used to dodge it with a zero-intensity overhead caster whose only job was to
  // fake a contact shadow; that hack is gone, because this is the real thing and
  // it is right in BOTH views.
  //
  // The key keeps `castShadow` — the meshes still receive it, so one module
  // still shadows the next and the channels still self-shadow. Short-range
  // detail is the one regime those five taps are honest in. What the key no
  // longer does is touch the floor.
  //
  // 256 on the presentation surfaces: those bake per FRAME (the turntable spins
  // the group, not the camera, so the shadow has to turn with it) and a contact
  // shadow is blurred past the point where its buffer resolution shows.
  const contact = createContactShadow(THREE, {
    height: 95, blurCm: 12, falloff: 1.35, resolution: presentation ? 256 : 512,
  });
  scene.add(contact.plane);

  const retarget = (center, layoutRadius = radius) => {
    const cx = Number(center?.x) || 0, cz = Number(center?.z) || 0;
    // Never let the rig distance fall below the stage radius: the DIRECTION
    // ratio stays the shipped raking angle at any layout size.
    const LR = Math.max(radius, Number(layoutRadius) || 0);
    key.position.set(cx + LR * 1.2, LR * 0.95, cz + LR * 0.5);
    key.target.position.set(cx, 0, cz);
    rim.position.set(cx - LR * 0.95, LR * 0.45, cz - LR * 0.85);
    rim.target.position.set(cx, 0, cz);
    if (back) {
      back.position.set(cx - LR * 0.35, LR * 1.5, cz - LR * 1.25);
      back.target.position.set(cx, 0, cz);
    }
    const dd = Math.max(radius * 2.2, LR * 2.2);
    Object.assign(key.shadow.camera, { left: -dd, right: dd, top: dd, bottom: -dd, near: 1, far: LR * 6 });
    key.shadow.camera.updateProjectionMatrix();
    // Frame the contact buffer on the layout with room for the penumbra to fade
    // out inside it — a shadow clipped at the buffer edge smears along it
    // (the texture clamps), which reads as a straight grey line across the floor.
    contact.setFrame(cx, cz, LR * 2.6);
    if (gridMesh) {
      // Slide the (finite) grid plane with the rig but keep the DOTS anchored to
      // the world by counter-shifting the texture phase — the lattice reads as
      // the floor itself, never as a decal glued to the layout.
      gridMesh.position.x = cx;
      gridMesh.position.z = cz;
      const t = gridMesh.material.map;
      if (t) {
        t.offset.x = ((cx / 50) % 1 + 1) % 1;
        t.offset.y = ((-cz / 50) % 1 + 1) % 1;
      }
    }
    // Re-bake on the spot. Every caller — the turntable, the thumbnail baker,
    // the model studio — already calls `retarget` immediately before it renders,
    // so hanging the bake here is what gets all three a ground shadow without a
    // line of wiring each. The live stage additionally drives `updateShadow`
    // off its own dirty flag, since a DRAG moves a piece without moving the rig.
    contact.update(renderer, scene);
  };

  // The ground shadow no longer changes CASTER with the view — the contact
  // buffer is right in both. Only its weight moves: the plan is read as a
  // drawing (a heavy shadow fights the footprints and the dimension lines),
  // while the vista is read as a photograph and wants the piece properly sat
  // down. The key keeps carving folds and shadowing module onto module in both.
  const setShadow = (mode) => {
    contact.setOpacity(mode === '2d' ? 0.34 : 0.62);
  };

  const dispose = () => {
    envRT.texture.dispose();
    pmrem.dispose();
    if (typeof envScene.dispose === 'function') envScene.dispose();
    contact.dispose();
    if (gridMesh) {
      gridMesh.geometry.dispose();
      gridMesh.material.map?.dispose();
      gridMesh.material.dispose();
    }
  };
  return { dispose, retarget, setShadow, updateShadow: () => contact.update(renderer, scene) };
}

/** Dispose every geometry/material/(swatch) texture under a group (free GPU
 *  memory). Idempotent per object via a seen-set, so a material/geometry shared
 *  across many meshes (the real-model path) is disposed exactly ONCE. The shared
 *  fabric maps (the woven normal + grain, flagged `userData.shared`) are
 *  intentionally NOT touched — their owner (the stage/export) disposes them. */
export function disposeGroup(group) {
  const seen = new Set();
  const once = (o, fn) => { if (o && !seen.has(o)) { seen.add(o); fn(); } };
  group?.traverse?.((o) => {
    once(o.geometry, () => o.geometry.dispose());
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      // A per-swatch photo map is owned by the material; the shared grain map is not.
      once(m.map, () => { if (!m.map.userData?.shared) m.map.dispose(); });
      once(m, () => m.dispose());
    }
  });
}

/**
 * Load the scan's EXTRA PBR maps for one fabric descriptor — the four beyond
 * diffuse+normal that colormass ships and pCon never did: `{ roughness,
 * metalness, displacement, anisotropy }`, each a linear texture or null.
 *
 * One reader, injected its loader (`loadTexture(url) → Promise<Texture>`), so
 * every surface — the live stage, the turntable, the AR/GLB export, the bake —
 * resolves them identically instead of drifting four ways. Skipped for a `tint`
 * (family-fallback) colour, exactly like the normal map is: those inherit the
 * sibling's weave and are re-tinted, and the maps ride separately. Every failure
 * degrades to null, and a null map simply isn't bound (today's look).
 */
export async function loadScanExtras(THREE, fab, loadTexture) {
  const out = { roughness: null, metalness: null, displacement: null, anisotropy: null };
  if (!fab || fab.tint || typeof loadTexture !== 'function') return out;
  const want = [
    ['roughness', 'roughnessUrl'], ['metalness', 'metalnessUrl'],
    ['displacement', 'displacementUrl'], ['anisotropy', 'anisotropyUrl'],
  ];
  await Promise.all(want.map(async ([slot, key]) => {
    const url = fab[key];
    if (!url) return;
    try {
      const t = await loadTexture(url);
      if (t) { t.colorSpace = THREE.NoColorSpace; t.userData.shared = true; out[slot] = t; }
    } catch { /* a broken extra map just isn't bound */ }
  }));
  return out;
}
