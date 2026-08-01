/**
 * THE appearance pipeline — one fabric code → the description a renderer
 * upholsters a piece with. This is the UNIFICATION: the same ordered decision
 * lived THREE times (the live stage's rebuild, the single-code turntable
 * loader, and the GLB export's scene loader), which is three chances for the
 * screen, the AR file and the launch card to render the same cloth differently.
 * Now they all read this.
 *
 * The order matters, and each step exists because of a real fabric in the
 * dealer's library:
 *   • the SWATCH tone is sampled first — it's both the fallback flat colour
 *     AND the correction target a real pCon scan is anchored to;
 *   • a linked `.matz` rgb BEATS the sampled photo (it IS the exact tone);
 *   • a linked texture is TINTED when it's a sibling's weave (family fallback)
 *     or a neutral greyscale detail map, and otherwise gain-corrected onto the
 *     swatch tone so a scan captured dark doesn't upholster the piece black;
 *   • the weave RELIEF is pCon's own `bumps` map where one shipped, else one
 *     derived from the (possibly tinted) diffuse.
 *
 * What comes back is a plain DESCRIPTION — packed rgb, which map to use and how
 * to obtain it, which relief, the PBR numbers, the physical tile. No three.js
 * objects: `@veta/scene` consumes this and builds the material (binding a URL,
 * wrapping a baked image in a CanvasTexture, turning `tileCm` into a repeat,
 * flagging shared textures for its own disposal rules). That split is what lets
 * the decision be unit-tested with pixel doubles instead of a GPU.
 *
 * Every failure degrades to the flat colour; nothing here throws.
 */
import type { Awaitable, ImageLike, ImageOps, MaterialColor, MaterialPbr, MaterialSource } from './types.ts';

/** Below this, a diffuse is a NEUTRAL greyscale detail map whose colour pCon
 *  keeps in material.mat's `dif` — the silver-sparkle alcantaras measure 3–6,
 *  a real coloured scan 60+. Rendering one verbatim gives a colourless silver
 *  piece instead of the fabric the customer picked. */
export const NEUTRAL_COLORFULNESS = 14;

/** The images the caller already loaded for this code. Both optional: with
 *  neither, the pipeline still answers with the material's own facts. */
export interface AppearanceInput {
  code: string;
  /** The swatch photo — the customer's reference colour. */
  swatchImage?: ImageLike | null;
  /** The diffuse loaded from the material's `textureUrl`. Absent (or a failed
   *  load) reads exactly like "no texture": the flat colour carries the piece. */
  textureImage?: ImageLike | null;
}

export interface AppearanceDeps {
  source: MaterialSource;
  imageOps: ImageOps;
}

/**
 * WHICH albedo map, and how to obtain it.
 *   none      — no usable texture; the flat `rgb` upholsters the piece.
 *   raw       — bind `url` as-is (pCon fidelity preserved).
 *   tinted    — `image` is a BAKED weave at this colour's tone.
 *   corrected — `image` is the real scan, gain-moved onto the swatch tone.
 * `tinted: true` means the bake already carries its tone: the material must
 * render it FULL-ALBEDO and never re-multiply it by the colour.
 */
export type MapChoice =
  | { kind: 'none' }
  | { kind: 'raw'; url: string; image: null; tinted: false }
  | { kind: 'tinted'; url: string; image: ImageLike; tinted: true }
  | { kind: 'corrected'; url: string; image: ImageLike; tinted: true };

/**
 * WHICH relief.
 *   none    — smooth (nothing to derive from).
 *   pcon    — the archive's own `bumps` map at `url`. NORMAL DATA IS LINEAR,
 *             never sRGB, and never re-tinted. `fallback: 'derived'` is the
 *             caller's instruction for a failed load: derive from the map.
 *   derived — `image` is a normal derived from the (possibly tinted) diffuse.
 */
export type NormalChoice =
  | { kind: 'none' }
  | { kind: 'pcon'; url: string; image: null; colorSpace: 'linear'; fallback: 'derived' }
  | { kind: 'derived'; image: ImageLike };

/** Everything one code renders as. */
export interface Appearance {
  code: string;
  /** The flat colour, packed 0xRRGGBB — null when nothing said one. */
  rgb: number | null;
  /** Which source won it: the material's exact tone, or the sampled swatch. */
  rgbSource: 'material' | 'swatch' | null;
  map: MapChoice;
  normal: NormalChoice;
  pbr: MaterialPbr | null;
  /** The map's TRUE physical size in cm — the scene turns it into a repeat. */
  tileCm: number | null;
  tileCmY: number | null;
}

const NO_MAP: MapChoice = { kind: 'none' };
const NO_NORMAL: NormalChoice = { kind: 'none' };

/** '#rrggbb' → packed int, null for anything else. */
export function hexToInt(hex: unknown): number | null {
  const n = parseInt(String(hex ?? '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Run one injected op. Any failure — a tainted canvas, no DOM, a throw — is
 *  null, which every branch below already treats as "this step gave nothing". */
async function op<T>(run: () => Awaitable<T | null | undefined>): Promise<T | null> {
  try {
    const v = await run();
    return v == null ? null : v;
  } catch { return null; }
}

/**
 * Resolve ONE code into its appearance. See the module header for why the four
 * steps run in this order; the decision table is pinned in
 * test/appearance.test.ts.
 */
export async function resolveAppearance(
  input: AppearanceInput,
  { source, imageOps }: AppearanceDeps,
): Promise<Appearance> {
  const code = str(input?.code);
  const fab: MaterialColor | null = code ? await op(() => source?.resolveColor?.(code)) : null;
  const tint = fab?.tint === true;

  // ── 1. The SWATCH tone: the customer's own reference colour. Sampled first
  // because it is BOTH the fallback flat colour and the correction target.
  const swatch = input?.swatchImage
    ? await op(() => imageOps?.sampleAverageColor?.(input.swatchImage as ImageLike))
    : null;

  // ── 2. The COLOUR. A linked material rgb WINS over the sampled photo: it IS
  // the exact tone (no photo sampling, no network).
  const exact = hexToInt(fab?.rgb);
  const rgb = exact ?? swatch ?? null;
  const rgbSource: Appearance['rgbSource'] = exact != null ? 'material' : (swatch != null ? 'swatch' : null);

  const out: Appearance = {
    code,
    rgb,
    rgbSource,
    map: NO_MAP,
    normal: NO_NORMAL,
    pbr: fab?.pbr ?? null,
    tileCm: fab?.tileCm ?? null,
    tileCmY: fab?.tileCmY ?? null,
  };

  // ── 3. The MAP — the real weave, when the library linked one AND the caller
  // loaded it. Exactly ONE of the three branches runs.
  const url = str(fab?.textureUrl);
  const image = input?.textureImage ?? null;
  if (!url || !image) return out;

  // A NEUTRAL greyscale detail map keeps its colour in material.mat's `dif`;
  // until that is imported, tinting with the fabric's own tone beats rendering
  // a colourless silver piece ("no color, just a texture map"). A `dif`, once
  // imported, colours the raw map directly (exactly what pCon computes).
  const neutral = !tint && !fab?.pbr?.dif && rgb != null
    && ((await op(() => imageOps?.colorfulness?.(image))) ?? 999) < NEUTRAL_COLORFULNESS;

  let map: MapChoice;
  if (tint || neutral) {
    // FAMILY FALLBACK or neutral map → bake this colour's tone into the weave.
    // No tone to tint with → colour fallback (there is nothing to bake from).
    const baked = rgb != null ? await op(() => imageOps?.tintWeave?.(image, rgb)) : null;
    map = baked ? { kind: 'tinted', url, image: baked, tinted: true } : NO_MAP;
  } else if (exact != null && swatch != null) {
    // A REAL scan → anchor it to its swatch: the .matz diffuse is a different
    // capture (VIOLINE reads near-black, ROSE washed), so a per-channel gain
    // moves the texture's mean onto the swatch tone, keeping the weave. Null
    // when it already matches (SILVER) → the RAW scan, which is truer.
    const corrected = await op(() => imageOps?.correctScanToTone?.(image, exact, swatch));
    map = corrected
      ? { kind: 'corrected', url, image: corrected, tinted: true }
      : { kind: 'raw', url, image: null, tinted: false };
  } else {
    map = { kind: 'raw', url, image: null, tinted: false };
  }
  out.map = map;
  if (map.kind === 'none') return out;

  // ── 4. The RELIEF. pCon's OWN `bumps` normal wins whenever the archive
  // shipped one — real measured weave beats anything derived. Never on a TINTED
  // map: that texture is a SIBLING's weave, so the sibling's relief is not this
  // colour's. Otherwise derive from the (possibly tinted) diffuse we just chose.
  const normalUrl = str(fab?.normalUrl);
  if (normalUrl && !tint) {
    out.normal = { kind: 'pcon', url: normalUrl, image: null, colorSpace: 'linear', fallback: 'derived' };
    return out;
  }
  const derived = await op(() => imageOps?.deriveWeaveNormal?.(map.image ?? image));
  out.normal = derived ? { kind: 'derived', image: derived } : NO_NORMAL;
  return out;
}
