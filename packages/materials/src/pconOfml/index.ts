/**
 * The pCon/OFML ADAPTER — everything that knows what a `.matz` archive is.
 *
 * Kept behind its own namespace so the appearance pipeline never learns pCon:
 * it talks to a `MaterialSource`, and this is one implementation of it. A second
 * library plugs in beside this folder, not through it.
 */

// ── material.mat → PBR (the fidelity port) ───────────────────────────────
export { parseOfmlMaterial, parseOfmlMatText, ofmlTextureNames } from './material.ts';
export type { OfmlMaterial, OfmlMatText, OfmlTextureNames } from './material.ts';

// ── .matz archive → texture + exact colour ───────────────────────────────
export { extractOfmlArchive, selectOfmlImages, averageRgb, MAX_EDGE } from './extract.ts';
export type {
  ImageCodec,
  DecodedImage,
  EncodedImage,
  ArchiveEntry,
  ImageSelection,
  OfmlArchive,
  ExtractOptions,
} from './extract.ts';

// ── library → catalog linking + coverage ─────────────────────────────────
export {
  parseMatzName,
  buildTextureMatches,
  textureCoverage,
  TEXTURE_MIN_BYTES,
} from './matchIndex.ts';
export type {
  MatzName,
  MatzFile,
  CatalogColor,
  CatalogMaterial,
  TextureMatch,
  TextureMatches,
  CoverageFamily,
  TextureCoverage,
} from './matchIndex.ts';

// ── the adapter's MaterialSource ─────────────────────────────────────────
export { ofmlMaterialSource, ofmlColorOf } from './source.ts';
export type { OfmlColorEntry } from './source.ts';
