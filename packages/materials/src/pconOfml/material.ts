/**
 * pCon material.mat → PBR, VERBATIM PORT (the fidelity contract).
 *
 * Every .matz archive carries `material.mat`, a tiny plain-text OFML "common"
 * material (measured on the dealer's real ALCANTARA SUNSET file):
 *
 *   type common
 *   amb 0.7529 0.7529 0.7529          ← ambient RGB (mirrors dif in practice)
 *   dif 0.7529 0.7529 0.7529          ← diffuse RGB — MULTIPLIES the texture
 *   spe 0.0157 0.0118 0.0118          ← specular RGB (Phong Ks)
 *   shi 29.44                         ← Phong shininess exponent (Ns)
 *   reflection 0.765                  ← mirror term — see note below
 *   tex image jpg diffuse             ← texture slot (basename inside the zip)
 *   scale 5 5 1                       ← REPEATS PER METER → tile = 100/5 = 20 cm
 *
 * The port to a physical material:
 *   • color            = dif (a renderer multiplies material.color × map,
 *                        exactly like pCon modulates the texture by dif)
 *   • roughness        = √(2 / (shi + 2)) — the standard Blinn-Phong→GGX
 *                        α = 2/(n+2) remap (shi 0 → 1.0 fully matte;
 *                        shi 29.44 → 0.252)
 *   • specularIntensity= max(spe) / 0.04 clamped to [0,1] — Phong Ks against
 *                        the 4% dielectric F0 (spe 0.0157 → 0.39: a weak,
 *                        fairly tight suede highlight — what pCon renders)
 *   • tileCm/tileCmY   = 100/scale — the texture's TRUE physical size, which
 *                        the 3D turns into the map repeat ("the right sizes")
 *   • `reflection` is parsed but deliberately NOT mapped: pCon's raster view
 *     renders these fabrics matte — the term only feeds its raytrace
 *     mirror/glass path, and folding 0.765 into envMapIntensity would coat
 *     every sofa in gloss the source look doesn't have ("too much shine").
 *
 * Pure text-in/data-out (no zip, no DOM) so the mapping is unit-testable and
 * shared by the import pipeline. test/pconOfmlMaterial.test.ts pins the real
 * ALCANTARA numbers.
 */

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Matte-fabric roughness for an older Phong "common" material with no explicit
// `roughness` — matches pCon's newer PBR export of the same Alcantara (0.8) and
// the app's DEFAULT_FINISH, so old- and new-format fabrics read as one suede.
const FABRIC_MATTE_ROUGH = 0.85;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const toHex = (rgb: readonly number[]): string =>
  `#${rgb.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;

/** The raw fields of a material.mat. Unknown lines are kept in `extra`
 *  (forward-compat with richer pCon types); missing fields are null. */
export interface OfmlMatText {
  type: string | null;
  amb: number[] | null;
  dif: number[] | null;
  spe: number[] | null;
  shi: number | null;
  reflection: number | null;
  metallic: number | null;
  roughness: number | null;
  scale: (number | null)[] | null;
  tex: string[][];
  bumps: string[][];
  extra: string[];
}

/** Parse the raw material.mat text into its fields. Unknown lines are kept in
 *  `extra` (forward-compat with richer pCon types); missing fields are null.
 *  Newer exports (measured on ALCANTARA B SILVER/SILICA) carry a fuller PBR
 *  profile: explicit `metallic`/`roughness`, a named diffuse `tex`, AND a
 *  `bumps` line pointing at a real tangent-space normal map. */
export function parseOfmlMatText(text: unknown): OfmlMatText {
  const out: OfmlMatText = {
    type: null, amb: null, dif: null, spe: null, shi: null, reflection: null,
    metallic: null, roughness: null, scale: null, tex: [], bumps: [], extra: [],
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    switch (key) {
      case 'type': out.type = rest[0] || null; break;
      case 'amb': case 'dif': case 'spe': {
        const rgb = rest.slice(0, 3).map(num);
        if (rgb.length === 3 && rgb.every((v) => v != null)) out[key] = rgb as number[];
        break;
      }
      case 'shi': out.shi = num(rest[0]); break;
      case 'reflection': out.reflection = num(rest[0]); break;
      case 'metallic': out.metallic = num(rest[0]); break;
      case 'roughness': out.roughness = num(rest[0]); break;
      case 'scale': {
        const s = rest.map(num);
        if (s.length && s[0] != null) out.scale = s;
        break;
      }
      case 'tex': out.tex.push(rest); break;
      case 'bumps': out.bumps.push(rest); break;
      default: out.extra.push(line);
    }
  }
  return out;
}

/** The image basenames a material.mat binds to its diffuse and bump slots. */
export interface OfmlTextureNames {
  texName: string | null;
  bumpName: string | null;
}

/**
 * The image BASENAMES a material.mat binds to its diffuse and its bump/normal
 * slots — the robust way to pick the right entries out of the .matz zip (a
 * `_map` normal can weigh MORE than the diffuse, so "largest image" grabbed
 * the normal and rendered it as albedo → the lavender-sofa bug). The last
 * token of a `tex`/`bumps` line is the file's stem (SUNSET: `tex image jpg
 * diffuse` → "diffuse"; SILVER: `tex image png alcantara___b_silver_129`).
 * Returns { texName, bumpName } (either null when absent). Pure.
 */
export function ofmlTextureNames(textOrParsed: unknown): OfmlTextureNames {
  const m = (typeof textOrParsed === 'string'
    ? parseOfmlMatText(textOrParsed)
    : ((textOrParsed || {}) as Partial<OfmlMatText>));
  const stem = (line: unknown): string | null => (
    Array.isArray(line) && line.length ? String(line[line.length - 1]).trim() || null : null
  );
  return {
    texName: Array.isArray(m.tex) && m.tex.length ? stem(m.tex[0]) : null,
    bumpName: Array.isArray(m.bumps) && m.bumps.length ? stem(m.bumps[0]) : null,
  };
}

/** The renderer-ready PBR facts of a material.mat — every field null when the
 *  source doesn't state it (callers keep their existing defaults). */
export interface OfmlMaterial {
  dif: string | null;
  rough: number | null;
  spec: number | null;
  tileCm: number | null;
  tileCmY: number | null;
}

/**
 * The renderer-ready PBR facts of a material.mat — every field null when the
 * source doesn't state it (callers keep their existing defaults):
 *   { dif: '#rrggbb', rough: 0..1, spec: 0..1, tileCm: n, tileCmY: n }
 */
export function parseOfmlMaterial(textOrParsed: unknown): OfmlMaterial {
  const m = (typeof textOrParsed === 'string'
    ? parseOfmlMatText(textOrParsed)
    : ((textOrParsed || {}) as Partial<OfmlMatText>));
  const out: OfmlMaterial = { dif: null, rough: null, spec: null, tileCm: null, tileCmY: null };
  if (Array.isArray(m.dif)) out.dif = toHex(m.dif);
  // Roughness: trust an EXPLICIT `roughness` (newer full-PBR exports:
  // SILVER/SILICA carry `roughness 0.8`). The older Phong-only profile's `shi`
  // is NOT a usable roughness for upholstery — the Blinn-Phong→GGX remap of
  // pCon's fabric shi (~29) yields a glossy ~0.25 that renders as WET LEATHER
  // (ALCANTARA BORDEAUX), while pCon's OWN newer export of the same Alcantara
  // declares 0.8. So with no explicit roughness we DEFAULT MATTE (fabric),
  // never derive gloss from shi. Applies to any real "common" material (dif
  // present); an empty descriptor stays null.
  if (m.roughness != null && m.roughness >= 0) out.rough = +clamp01(m.roughness).toFixed(3);
  else if (Array.isArray(m.dif) || m.shi != null || Array.isArray(m.spe)) out.rough = FABRIC_MATTE_ROUGH;
  if (Array.isArray(m.spe)) out.spec = +clamp01(Math.max(...m.spe) / 0.04).toFixed(3);
  const sx = Array.isArray(m.scale) ? m.scale[0] : null;
  const sy = Array.isArray(m.scale) ? (m.scale[1] ?? sx) : null;
  if (sx != null && sx > 0) out.tileCm = +(100 / sx).toFixed(2);
  if (sy != null && sy > 0) out.tileCmY = +(100 / sy).toFixed(2);
  else out.tileCmY = out.tileCm;
  return out;
}
