/**
 * The two INJECTED capabilities of this package, and the data shape they trade.
 *
 * `@veta/materials` owns the DECISIONS (which colour, which map, which relief)
 * and owns none of the machinery that produces pixels: reading an image, tinting
 * it, or re-encoding it is browser work (canvas / OffscreenCanvas), and a Model
 * that reached for `document` could neither be unit-tested nor run on a server.
 * So the pixel half arrives as `ImageOps` and the catalog half as
 * `MaterialSource` — the same dependency-injection idiom that keeps the three.js
 * side out of every engine here.
 */

/** An op may answer synchronously (canvas) or asynchronously (worker/bitmap). */
export type Awaitable<T> = T | Promise<T>;

/**
 * Anything the injected ops can read pixels from — a DOM image/canvas/bitmap in
 * the browser, a plain `{ width, height, data }` bag in a test. Opaque to this
 * package: it only ever hands one back to the ops that made it, or forwards it
 * to the caller in the appearance description.
 */
export interface ImageLike {
  readonly width?: number;
  readonly height?: number;
}

/** The PBR numbers a material states, all optional (a caller keeps its own
 *  defaults for anything the source doesn't say). `dif` is a `#rrggbb`. */
export interface MaterialPbr {
  dif?: string | null;
  rough?: number | null;
  spec?: number | null;
}

/**
 * What one colour code resolves to. Every field optional on purpose — a
 * colour-only definition (no texture) is a legitimate, common answer.
 *
 * `tint` marks a FAMILY FALLBACK: the texture belongs to a SIBLING colour of the
 * same fabric family (one physical weave, different dye), so it must be re-tinted
 * to this colour's tone and its `normalUrl` — a sibling's relief — is not used.
 */
export interface MaterialColor {
  rgb?: string | null;
  textureUrl?: string | null;
  normalUrl?: string | null;
  pbr?: MaterialPbr | null;
  /** The map's TRUE physical size in cm — what the scene turns into a repeat. */
  tileCm?: number | null;
  tileCmY?: number | null;
  tint?: boolean;
}

/**
 * The catalog half: code → material facts. The pCon/OFML adapter implements it
 * (`ofmlMaterialSource`), and so can any other library the configurator grows.
 */
export interface MaterialSource {
  resolveColor(code: string): MaterialColor | null;
}

/**
 * The pixel half. Every op returns null on any failure (unreadable image,
 * tainted canvas, no DOM at all) and the pipeline degrades to the flat colour —
 * that contract is what lets `resolveAppearance` promise it never throws.
 */
export interface ImageOps {
  /**
   * The DOMINANT tone of a swatch photo as a packed 0xRRGGBB int — the
   * customer's own reference colour, and the target a real scan is corrected to.
   */
  sampleAverageColor(image: ImageLike): Awaitable<number | null>;
  /**
   * How COLOURFUL an image is, mean (|R−G| + |G−B|) over a small resample,
   * 0..510. A neutral greyscale detail map scores ~3–6; a real coloured scan
   * ~60+. Null reads as "colourful" at the call site.
   */
  colorfulness(image: ImageLike): Awaitable<number | null>;
  /**
   * A weave re-tinted to `rgb`: grayscale the image, normalize its mean to 1.0
   * (pure relief), multiply by the target colour, bake. Null when there is
   * nothing to bake from.
   */
  tintWeave(image: ImageLike, rgb: number): Awaitable<ImageLike | null>;
  /**
   * Anchor a real scan to a target tone: a per-channel GAIN that moves the
   * image's mean from `fromRgb` onto `toRgb`, KEEPING the weave's own variation.
   * Returns NULL when the shift is negligible — the caller then keeps the RAW
   * scan, which is the higher-fidelity answer.
   */
  correctScanToTone(image: ImageLike, fromRgb: number, toRgb: number): Awaitable<ImageLike | null>;
  /**
   * A tangent-space NORMAL map derived from the diffuse itself (height =
   * luminance, wrapped Sobel slopes) — the relief that keeps cloth from reading
   * as printed paper.
   */
  deriveWeaveNormal(image: ImageLike): Awaitable<ImageLike | null>;
}
