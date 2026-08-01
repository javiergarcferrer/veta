/**
 * The pCon/OFML adapter's `MaterialSource`: the dealer's imported .matz library,
 * keyed by colour code, answering the appearance pipeline.
 *
 * It is a thin SHAPE adapter on purpose. `parseOfmlMaterial` keeps material.mat's
 * flat fidelity shape (`{ dif, rough, spec, tileCm, tileCmY }` — the port test
 * pins those exact numbers), while `MaterialColor` separates the PBR knobs from
 * the physical TILE, which is what the scene needs to compute a map repeat. This
 * is the one place that translation happens, so a second library (a fabric CDN,
 * a manufacturer feed) plugs in by implementing the same interface rather than
 * by teaching the pipeline about pCon.
 */
import type { MaterialColor, MaterialSource } from '../types.ts';
import type { OfmlMaterial } from './material.ts';

/** One imported colour of the library. */
export interface OfmlColorEntry {
  /** The manufacturer colour code the whole app keys fabrics on. */
  code: string | number;
  /** The archive's averaged tone, '#rrggbb'. */
  rgb?: string | null;
  textureUrl?: string | null;
  normalUrl?: string | null;
  /** `parseOfmlMaterial`'s flat output (tile included). */
  pbr?: OfmlMaterial | Partial<OfmlMaterial> | null;
  /** True when the texture is a SIBLING colour's weave (family fallback). */
  tint?: boolean;
}

/** Split material.mat's flat port into the pipeline's shape. */
export function ofmlColorOf(entry: OfmlColorEntry): MaterialColor {
  const pbr = entry.pbr || null;
  const has = pbr && (pbr.dif != null || pbr.rough != null || pbr.spec != null);
  return {
    rgb: entry.rgb ?? null,
    textureUrl: entry.textureUrl ?? null,
    normalUrl: entry.normalUrl ?? null,
    pbr: has ? { dif: pbr!.dif ?? null, rough: pbr!.rough ?? null, spec: pbr!.spec ?? null } : null,
    tileCm: pbr?.tileCm ?? null,
    tileCmY: pbr?.tileCmY ?? null,
    tint: entry.tint === true,
  };
}

/**
 * Build a `MaterialSource` over the imported library. Codes are compared as
 * TRIMMED STRINGS — the catalog stores some as numbers — so a numeric `855` and
 * the filename's `'855'` are one colour. An unknown code answers null, which the
 * pipeline reads as "swatch only", never as an error.
 */
export function ofmlMaterialSource(entries: Iterable<OfmlColorEntry> | null | undefined): MaterialSource {
  const byCode = new Map<string, MaterialColor>();
  for (const e of entries || []) {
    const code = String(e?.code ?? '').trim();
    if (!code || byCode.has(code)) continue;   // first row wins — the import order is the dealer's
    byCode.set(code, ofmlColorOf(e));
  }
  return {
    resolveColor(code: string): MaterialColor | null {
      return byCode.get(String(code ?? '').trim()) ?? null;
    },
  };
}
