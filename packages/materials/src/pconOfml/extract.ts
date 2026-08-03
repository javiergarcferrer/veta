/**
 * pCon .matz → texture + exact color (the effectful half of the matz import;
 * the linking decisions live in matchIndex.ts).
 *
 * A .matz is a ZIP: material.mat (plain text) + texture images. We never ship
 * the raw file anywhere — the caller unzips it here (fflate), reads material.mat
 * to pick the DIFFUSE image BY NAME (`tex …`) and the NORMAL map (`bumps …`) —
 * not by size, since a `_map` normal can outweigh the diffuse — downscales each
 * to ≤`MAX_EDGE` px and re-encodes WebP (the 16 MB originals never leave
 * the machine), and averages the diffuse's pixels for the exact fabric RGB.
 * Color-only .matz (no usable image) still yield an RGB when a small swatch
 * image exists; otherwise they're skipped. Defensive throughout: a file that
 * doesn't unzip or decode reports null and the import moves on.
 *
 * DECODING AND RE-ENCODING ARE BROWSER WORK (createImageBitmap / canvas /
 * toBlob), so they arrive as an injected `ImageCodec`. What stays here is the
 * part worth pinning: the ENTRY SELECTION and the pixel average.
 */
import { unzipSync } from 'fflate';
import { ofmlTextureNames, parseOfmlMaterial, type OfmlMaterial } from './material.ts';
import type { Awaitable, ImageLike } from '../types.ts';

const IMAGE_ENTRY = /\.(jpe?g|png|webp|bmp)$/i;

/**
 * The longest edge a stored texture keeps — the 16 MB originals stay home.
 *
 * 2048, was 1024: at close dolly range 1024px over a ~20 cm physical tile is
 * what made the weave read soft next to reference-grade configurators — the
 * per-thread detail IS in the pCon scans, the import was discarding it. Costs
 * ~4× per stored texture (webp, still well under the originals).
 * ALREADY-IMPORTED FABRICS KEEP THEIR 1024 BAKE until they are re-imported:
 * this is the ceiling the extractor asks the codec for, not a migration.
 */
export const MAX_EDGE = 2048;

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// The zip entry whose file stem equals `name` (ext-less, path-stripped) — how
// material.mat's `tex`/`bumps` lines reference their images.
const stemOf = (n: unknown): string => String(n).split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();

/** A decoded image: RGBA bytes plus its dimensions. The codec decodes at most
 *  `maxEdge` on the long side, exactly like the browser import always has, so
 *  the averaged RGB matches the numbers already stored in the catalog. */
export interface DecodedImage extends ImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Encoded texture bytes as the caller's platform produces them. */
export type EncodedImage = Blob | Uint8Array;

/**
 * The injected image capability. `decode` is required (there is no colour and
 * no selection check without it); `resizeToWebp` is optional — omit it and the
 * archive still yields its rgb + material facts (the colour-only path).
 */
export interface ImageCodec {
  decode(bytes: Uint8Array, name: string, opts?: { maxEdge?: number }): Awaitable<DecodedImage | null>;
  resizeToWebp?(
    bytes: Uint8Array,
    name: string,
    opts?: { maxEdge?: number; quality?: number },
  ): Awaitable<EncodedImage | null>;
}

/** One image entry of the archive, as the selection sees it. */
export interface ArchiveEntry {
  name: string;
  size: number;
}

/** Which entry plays which role in the archive. */
export interface ImageSelection {
  /** The tileable fabric image, or null for a colour-only archive. */
  diffuse: string | null;
  /** The pCon `bumps` tangent-space normal map, when one shipped. */
  bump: string | null;
  /** What the RGB is sampled from — the diffuse, else anything non-bump. */
  colorSource: string | null;
}

/**
 * Pick the diffuse / bump / colour-source entries out of an archive listing.
 *
 * The DIFFUSE is chosen by the NAME material.mat binds (`tex …basename`), not
 * by size: newer ALCANTARA exports ship a `_map` normal that weighs MORE than
 * the diffuse, so "largest image" grabbed the normal and rendered it as
 * albedo → the whole sofa went periwinkle-lavender ("not rendering colors").
 *
 * Order: the bound `tex` basename is authoritative; else a diffuse*-named
 * image; else the largest NON-bump NON-preview image. NEVER the `preview` (a
 * rendered-sphere thumbnail) — a .matz whose ONLY image is a preview is a
 * colour-only definition, not a texture. This is size-INDEPENDENT: the older
 * format (ALCANTARA BORDEAUX) ships a tiny ~130px diffuse.jpg that is still a
 * REAL fine-grain fabric — far better than the procedural weave — so it MUST
 * upload regardless of the archive weighing well under a megabyte. Within one
 * predicate the LARGEST match wins, which is the only place size is consulted.
 *
 * Pure: takes the listing, answers names.
 */
export function selectOfmlImages(
  entries: readonly ArchiveEntry[] | null | undefined,
  names?: { texName?: string | null; bumpName?: string | null } | null,
): ImageSelection {
  const texName = names?.texName ? String(names.texName).toLowerCase() : null;
  const bumpName = names?.bumpName ? String(names.bumpName).toLowerCase() : null;
  const list = (entries || []).filter((e) => e && IMAGE_ENTRY.test(e.name));

  const pick = (pred: (name: string) => boolean): string | null => {
    let name: string | null = null;
    let size = -1;
    for (const e of list) {
      if (!pred(e.name)) continue;
      if (name === null || e.size > size) { name = e.name; size = e.size; }
    }
    return name;
  };
  const isBump = (n: string): boolean => (
    bumpName ? stemOf(n) === bumpName : /(_map|_normal|_nrm|_bump)\.[^.]+$/i.test(n)
  );

  const diffuse = (texName ? pick((n) => stemOf(n) === texName) : null)
    || pick((n) => /diffuse/i.test(n) && !isBump(n))
    || pick((n) => !isBump(n) && !/preview|thumb/i.test(n));
  // Colour still samples from SOMETHING when there's no diffuse (a genuine
  // colour-only .matz) — usually the preview — so the rgb is never lost.
  const colorSource = diffuse || pick((n) => !isBump(n));
  const bumpPick = pick((n) => isBump(n));
  // Relief hangs off an albedo: with no diffuse there is nothing to upholster
  // and the normal is never used. And a single-image archive must never bind
  // its diffuse as its own normal map.
  const bump = diffuse && bumpPick && bumpPick !== diffuse ? bumpPick : null;
  return { diffuse, bump, colorSource };
}

/**
 * Average color of a decoded image, as '#rrggbb' (linear-ish enough for
 * upholstery tinting). Samples a GRID rather than every pixel — plenty for a
 * fabric's flat tone — and skips near-transparent pixels. Null when nothing
 * opaque was found. Pure.
 */
export function averageRgb(image: DecodedImage | null | undefined): string | null {
  const w = Number(image?.width) || 0;
  const h = Number(image?.height) || 0;
  const data = image?.data;
  if (!data || !(w > 0) || !(h > 0)) return null;
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
  }
  return n ? toHex(r / n, g / n, b / n) : null;
}

/** What one .matz yields. Every field null when absent / on any failure. */
export interface OfmlArchive {
  /** The downscaled diffuse (WebP) — null for a colour-only archive. */
  texture: EncodedImage | null;
  /** The pCon `bumps` tangent-space normal map (WebP) when one shipped. */
  normal: EncodedImage | null;
  /** The diffuse's average tone, '#rrggbb'. */
  rgb: string | null;
  /** The material.mat port. */
  pbr: OfmlMaterial | null;
  /** Which entries were picked — useful for reporting, free to ignore. */
  selection: ImageSelection;
}

export interface ExtractOptions {
  codec: ImageCodec;
  /** False for a colour-only pass (the RGB still comes back). */
  wantTexture?: boolean;
  maxEdge?: number;
}

/**
 * Extract `{ texture, normal, rgb, pbr }` from one .matz archive's bytes.
 * `texture` is the downscaled diffuse; `normal` the pCon `bumps` map when the
 * archive ships one — real weave relief, better than a derived map. `rgb` is
 * the diffuse's average tone; `pbr` the material.mat port. All null when absent
 * / on any decode failure — never throws for content problems.
 */
export async function extractOfmlArchive(
  input: Uint8Array | ArrayBuffer | null | undefined,
  { codec, wantTexture = true, maxEdge = MAX_EDGE }: ExtractOptions,
): Promise<OfmlArchive> {
  const none: OfmlArchive = {
    texture: null, normal: null, rgb: null, pbr: null,
    selection: { diffuse: null, bump: null, colorSource: null },
  };
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
    const entries = unzipSync(bytes);
    // The pCon material DESCRIPTOR (plain text): diffuse multiplier, roughness/
    // specular, physical scale, AND the exact basenames of the diffuse (`tex`)
    // and normal (`bumps`) images. The whole fidelity port + correct image
    // selection ride on it.
    let pbr: OfmlMaterial | null = null;
    let texName: string | null = null;
    let bumpName: string | null = null;
    try {
      const matName = Object.keys(entries).find((n) => /(^|\/)material\.mat$/i.test(n))
        || Object.keys(entries).find((n) => /\.mat$/i.test(n));
      if (matName) {
        const text = new TextDecoder().decode(entries[matName]);
        const parsed = parseOfmlMaterial(text);
        if (Object.values(parsed).some((v) => v != null)) pbr = parsed;
        const names = ofmlTextureNames(text);
        texName = names.texName ? names.texName.toLowerCase() : null;
        bumpName = names.bumpName ? names.bumpName.toLowerCase() : null;
      }
    } catch { /* descriptor unreadable → fall back to name/size heuristics */ }

    const listing: ArchiveEntry[] = Object.entries(entries).map(([name, b]) => ({ name, size: b.length }));
    const selection = selectOfmlImages(listing, { texName, bumpName });
    if (!selection.colorSource) return { ...none, pbr, selection };

    const decoded = await codec.decode(entries[selection.colorSource], selection.colorSource, { maxEdge });
    const rgb = averageRgb(decoded);
    // Upload a texture ONLY when there's a real diffuse (never a preview) and
    // the caller wants one. A colour-only archive yields just rgb + pbr.
    if (!wantTexture || !selection.diffuse || !codec.resizeToWebp) {
      return { texture: null, normal: null, rgb, pbr, selection };
    }
    const texture = await codec.resizeToWebp(
      entries[selection.diffuse], selection.diffuse, { maxEdge, quality: 0.85 },
    );

    // NORMAL: the `bumps` image, downscaled the same way (WebP is lossy but a
    // tangent-space normal survives it well enough for cloth relief). Only the
    // newer full-PBR exports ship one; the older format derives it from the
    // diffuse downstream instead.
    let normal: EncodedImage | null = null;
    if (selection.bump) {
      try {
        normal = await codec.resizeToWebp!(
          entries[selection.bump], selection.bump, { maxEdge, quality: 0.9 },
        ) || null;
      } catch { /* normal is optional — the derived map still gives relief */ }
    }
    return { texture: texture || null, normal, rgb, pbr, selection };
  } catch {
    return none;
  }
}
