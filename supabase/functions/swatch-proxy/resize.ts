/**
 * BAKING A THUMBNAIL, ONCE — the impure half of the derivative mirror.
 *
 * Supabase Storage will happily resize an image on the fly, and we no longer
 * ask it to: that endpoint is billed per DISTINCT ORIGIN IMAGE (Pro: 100 per
 * month) and a fabric catalog is thousands of distinct images by construction.
 * See the long note over `MIRROR_BUCKET` in allow.ts. So the resize happens
 * here, in the function, exactly once per (image, width), and the result is
 * stored as an ordinary object that costs ordinary egress forever after.
 *
 * magick-wasm is the only real option: Edge Functions run WASM but not native
 * modules, so Sharp is out, and ImageMagick is the port Supabase itself
 * documents for this.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *   • It does not CROP to a square. Every caller paints the result under CSS
 *     `object-cover`, which crops for free and on the element's real aspect —
 *     so cropping here would only throw away pixels the browser might have
 *     wanted, and add an API surface (gravity/geometry offsets) for nothing.
 *     Scaling so the SHORT edge meets the target is what "cover" needs.
 *   • It does not upscale. An original already smaller than the tile is
 *     re-encoded (WebP is worth it on its own) but never stretched.
 */

/**
 * The ceiling on what we will hand to the decoder. Hosted Edge Functions have
 * a memory limit and ImageMagick wants several times the pixel buffer; Supabase
 * warns about images past ~5 MB. A handful of early scans slipped past the
 * intake encoder as 8 MB PNGs (fixed at the source in
 * src/brands/modules/swatchPixels.js) — for those, refusing here and letting
 * the caller serve the original beats an OOM that takes the whole invocation
 * down, tile and all.
 */
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024;

/** WebP quality. 82 is where cloth stops improving and the file keeps growing. */
const QUALITY = 82;

type Magick = {
  ImageMagick: {
    read: <T>(bytes: Uint8Array, cb: (img: MagickImage) => T) => T;
  };
  MagickFormat: { WebP: unknown };
  MagickGeometry: new (w: number, h: number) => { ignoreAspectRatio: boolean };
  initializeImageMagick: (wasm: Uint8Array) => Promise<void>;
};

type MagickImage = {
  width: number;
  height: number;
  quality: number;
  resize: (geometry: unknown) => void;
  write: <T>(format: unknown, cb: (data: Uint8Array) => T) => T;
};

/**
 * The initialised module, loaded AT MOST ONCE per isolate and NOT AT ALL on the
 * hot path.
 *
 * This matters more than it looks: the wasm binary is megabytes, and the
 * overwhelming majority of requests to this function are either a cache-warm
 * 302 (the derivative already exists) or the PDF generator's byte passthrough —
 * neither of which decodes anything. Loading ImageMagick at module scope, the
 * way the docs' example does, would put that cost on every cold start of every
 * one of those. So: dynamic import, first time someone actually needs to
 * resize.
 *
 * A failed init is not cached — it would otherwise poison the isolate for as
 * long as it lives.
 */
let ready: Promise<Magick> | null = null;

function magick(): Promise<Magick> {
  if (!ready) {
    ready = (async () => {
      // The specifier is written out IN FULL, twice, rather than shared through
      // a const: the deploy bundler finds a function's npm dependencies by
      // reading the import specifiers statically, and a variable it has to
      // evaluate is one it cannot follow — the package would simply not be
      // bundled, and the first resize would fail at runtime in production with
      // nothing failing at build time to warn us. Version pinned to the one
      // Supabase's own image-manipulation example ships.
      const mod = (await import('npm:@imagemagick/magick-wasm@0.0.30')) as unknown as Magick;
      const wasm = await Deno.readFile(
        new URL('magick.wasm', import.meta.resolve('npm:@imagemagick/magick-wasm@0.0.30')),
      );
      await mod.initializeImageMagick(wasm);
      return mod;
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/**
 * `bytes` re-encoded as WebP, scaled so its SHORT edge is `width` — or null
 * when it can't be done (undecodable bytes, a source past the ceiling, an
 * isolate that can't load the wasm).
 *
 * Null is never fatal to a tile: every caller falls through to the original,
 * which is heavier but correct. A swatch that costs too much still beats a
 * swatch that doesn't load.
 */
export async function coverWebp(
  bytes: Uint8Array,
  width: number,
): Promise<Uint8Array | null> {
  if (!bytes?.length || bytes.length > MAX_SOURCE_BYTES) return null;
  if (!Number.isFinite(width) || width <= 0) return null;
  try {
    const { ImageMagick, MagickFormat, MagickGeometry } = await magick();
    return ImageMagick.read(bytes, (img) => {
      const w = img.width;
      const h = img.height;
      if (!w || !h) return null;
      // Short edge to the target — `object-cover` does the rest.
      const scale = width / Math.min(w, h);
      if (scale < 1) {
        const geo = new MagickGeometry(
          Math.max(1, Math.round(w * scale)),
          Math.max(1, Math.round(h * scale)),
        );
        // The dimensions above already preserve the ratio; say so explicitly
        // rather than let ImageMagick re-derive a "best fit" of its own.
        geo.ignoreAspectRatio = true;
        img.resize(geo);
      }
      img.quality = QUALITY;
      // The buffer handed to this callback is a view into wasm memory and is
      // invalid the moment `read` returns — copy before it does.
      return img.write(MagickFormat.WebP, (data) => new Uint8Array(data));
    });
  } catch {
    return null;
  }
}
