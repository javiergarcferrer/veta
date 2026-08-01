/**
 * THE PIXEL HALF of `@veta/materials` — the browser implementation of `ImageOps`.
 *
 * `@veta/materials` owns the appearance DECISIONS and none of the machinery that
 * produces pixels, because a Model that reached for `document` could neither be
 * unit-tested nor run on a server. This file is where that machinery now lives:
 * the five canvas operations ported from the reference scene builder, each of
 * them the answer to a real fabric in a real library.
 *
 *   sampleAverageColor  — the swatch photo's TRUE tone. Averaged over the right
 *                         ~75% (the left strip is the printed colour card),
 *                         in LINEAR light, and only across the matte MIDTONES
 *                         around the median: velvet swatches are shot with a
 *                         bright diagonal sheen fold, and averaging that
 *                         specular highlight in is exactly what made deep
 *                         colours sample out pale.
 *   colorfulness        — is this diffuse a NEUTRAL greyscale detail map (whose
 *                         colour lives in the material definition) or a real
 *                         coloured scan? Neutral maps measure ~3–6, real scans
 *                         60+. Rendering a neutral one verbatim gives a
 *                         colourless piece instead of the fabric picked.
 *   tintWeave           — the family fallback: grayscale a sibling's weave,
 *                         normalize its mean to 1.0 (pure relief), multiply by
 *                         the target colour, bake. Baking (rather than a
 *                         white-material × neutral-map trick) keeps the material
 *                         path identical to a real scan.
 *   correctScanToTone   — a real scan is a SEPARATE capture from the swatch the
 *                         customer picked, and the two disagree (one measured
 *                         pair: a cool near-black scan against a warm aubergine
 *                         swatch). A per-channel GAIN moves the scan's mean onto
 *                         the swatch tone while KEEPING the weave's own
 *                         variation. Where they already agree it returns null,
 *                         so the raw scan's fidelity is preserved.
 *   deriveWeaveNormal   — real cloth shows its weave RELIEF in raking light; a
 *                         flat albedo reads as printed paper. Height =
 *                         luminance, slopes = a WRAP-AROUND Sobel (the scan
 *                         tiles, so the derived map must tile too).
 *
 * EVERY op returns null on any failure — an unreadable image, a tainted canvas,
 * no DOM at all — which is the contract that lets `resolveAppearance` promise it
 * never throws: each null simply degrades to the flat colour.
 *
 * The canvas factory is INJECTED (`createCanvas`), so the ops are tested against
 * a plain in-memory canvas double in `node --test` — these are the most
 * numerically delicate functions in the app and deserve better than a browser.
 */

import type { ImageLike, ImageOps } from '@veta/materials';

/** The slice of `ImageData` these ops use. */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

/** The slice of `CanvasRenderingContext2D` these ops use. */
export interface Context2DLike {
  drawImage(image: any, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
  putImageData(data: ImageDataLike, dx: number, dy: number): void;
  createImageData(width: number, height: number): ImageDataLike;
}

/** The slice of `HTMLCanvasElement` these ops use. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d', opts?: Record<string, unknown>): Context2DLike | null;
}

export interface ImageOpsDeps {
  /** Make a drawing surface. Defaults to `document.createElement('canvas')`. */
  createCanvas?: (width: number, height: number) => CanvasLike | null;
}

// sRGB ⇄ linear. The swatch average is taken in LINEAR light (that is what
// "average colour" physically means) and encoded back to sRGB for the renderer,
// which decodes it once — so the material's working colour is the true mean.
const S2L = (b: number): number => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const L2S = (l: number): number => {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

const LUM = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const defaultCanvas = (width: number, height: number): CanvasLike | null => {
  const doc = (globalThis as { document?: { createElement?(tag: string): unknown } }).document;
  if (!doc?.createElement) return null;
  const canvas = doc.createElement('canvas') as CanvasLike;
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** Draw `image` into a fresh w×h surface and hand back its pixels + the surface.
 *  Any failure (no DOM, no 2d context, a TAINTED canvas) is a null. */
function rasterize(
  make: (w: number, h: number) => CanvasLike | null,
  image: ImageLike | null | undefined,
  maxW: number,
  maxH: number,
): { canvas: CanvasLike; ctx: Context2DLike; img: ImageDataLike } | null {
  try {
    const sw = Number(image?.width);
    const sh = Number(image?.height);
    if (!image || !(sw > 0) || !(sh > 0)) return null;
    const w = Math.max(1, Math.min(maxW, Math.round(sw)));
    const h = Math.max(1, Math.min(maxH, Math.round(sh)));
    const canvas = make(w, h);
    if (!canvas) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    // getImageData is what throws on a cross-origin (tainted) canvas.
    const img = ctx.getImageData(0, 0, w, h);
    return { canvas, ctx, img };
  } catch { return null; }
}

/**
 * Build the browser `ImageOps`. The returned images are the CANVASES themselves
 * (`CanvasLike`), which is what `@veta/scene` wraps in a texture — the package
 * treats them as opaque, exactly as its `ImageLike` contract says.
 */
export function createImageOps(deps: ImageOpsDeps = {}): ImageOps {
  const make = deps.createCanvas ?? defaultCanvas;

  return {
    sampleAverageColor(image) {
      const r = rasterize(make, image, 96, 96);
      if (!r) return null;
      try {
        const { img } = r;
        const { data } = img;
        const w = img.width;
        const h = img.height;
        // Skip the printed colour strip down the LEFT edge and the outer frame.
        const x0 = Math.floor(w * 0.18);
        const x1 = Math.floor(w * 0.97);
        const y0 = Math.floor(h * 0.06);
        const y1 = Math.floor(h * 0.94);

        // Pass 1 — the swatch's MEDIAN tone, over opaque pixels only.
        const lums: number[] = [];
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (data[i + 3] < 8) continue;
            lums.push(LUM(data[i], data[i + 1], data[i + 2]));
          }
        }
        if (!lums.length) return null;
        lums.sort((a, b) => a - b);
        const median = lums[lums.length >> 1];

        // Pass 2 — average, in LINEAR light, only the matte MIDTONES around the
        // median: the sheen fold above and the deep fold shadows below are
        // lighting, not colour.
        const lo = Math.max(14, median * 0.5);
        const hi = Math.min(240, median * 1.28);
        let lr = 0; let lg = 0; let lb = 0; let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (data[i + 3] < 8) continue;
            const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
            const lum = LUM(R, G, B);
            if (lum < lo || lum > hi) continue;
            lr += S2L(R); lg += S2L(G); lb += S2L(B); n++;
          }
        }
        if (!n) return null;
        return (L2S(lr / n) << 16) | (L2S(lg / n) << 8) | L2S(lb / n);
      } catch { return null; }
    },

    colorfulness(image) {
      const r = rasterize(make, image, 48, 48);
      if (!r) return null;
      try {
        const { data } = r.img;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]);
        }
        return sum / (data.length / 4);
      } catch { return null; }
    },

    tintWeave(image, rgb) {
      const target = Number(rgb);
      if (!Number.isFinite(target)) return null;
      const r = rasterize(make, image, 1024, 1024);
      if (!r) return null;
      try {
        const tr = (target >> 16) & 255;
        const tg = (target >> 8) & 255;
        const tb = target & 255;
        const { img, ctx, canvas } = r;
        const d = img.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += LUM(d[i], d[i + 1], d[i + 2]);
        const mean = sum / (d.length / 4);
        if (!(mean > 0)) return null;
        // Normalize the weave's mean to 1.0 (pure relief) and multiply by the
        // target: the bake carries its own tone, so the material renders it
        // FULL-ALBEDO and must never re-multiply it by the colour.
        for (let i = 0; i < d.length; i += 4) {
          const g = LUM(d[i], d[i + 1], d[i + 2]) / mean;
          d[i] = Math.min(255, Math.round(g * tr));
          d[i + 1] = Math.min(255, Math.round(g * tg));
          d[i + 2] = Math.min(255, Math.round(g * tb));
          d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas as unknown as ImageLike;
      } catch { return null; }
    },

    correctScanToTone(image, fromRgb, toRgb) {
      const from = Number(fromRgb);
      const to = Number(toRgb);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      const fr = (from >> 16) & 255; const fg = (from >> 8) & 255; const fb = from & 255;
      const sr = (to >> 16) & 255; const sg = (to >> 8) & 255; const sb = to & 255;
      // Clamped so one channel can neither blow out nor vanish.
      const gainOf = (t: number, f: number): number => Math.max(0.2, Math.min(4, (t + 1) / (f + 1)));
      const gr = gainOf(sr, fr); const gg = gainOf(sg, fg); const gb = gainOf(sb, fb);
      // A negligible shift → NULL, and the caller keeps the RAW scan: where the
      // capture already IS its swatch tone, correcting it can only lose fidelity.
      if (Math.abs(gr - 1) < 0.06 && Math.abs(gg - 1) < 0.06 && Math.abs(gb - 1) < 0.06) return null;

      const r = rasterize(make, image, 1024, 1024);
      if (!r) return null;
      try {
        const { img, ctx, canvas } = r;
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.min(255, Math.round(d[i] * gr));
          d[i + 1] = Math.min(255, Math.round(d[i + 1] * gg));
          d[i + 2] = Math.min(255, Math.round(d[i + 2] * gb));
          d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas as unknown as ImageLike;
      } catch { return null; }
    },

    deriveWeaveNormal(image) {
      const r = rasterize(make, image, 512, 512);
      if (!r) return null;
      try {
        const { img, ctx, canvas } = r;
        const w = img.width;
        const h = img.height;
        const src = img.data;
        const lum = new Float32Array(w * h);
        for (let i = 0, p = 0; i < src.length; i += 4, p++) {
          lum[p] = LUM(src[i], src[i + 1], src[i + 2]) / 255;
        }
        const out = ctx.createImageData(w, h);
        const d = out.data;
        // WRAP-AROUND sampling: the scan tiles, so its relief must tile too.
        const at = (x: number, y: number): number => lum[((y + h) % h) * w + ((x + w) % w)];
        const strength = 2.0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
              - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
            const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
              - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
            // +Y up (the OpenGL convention three expects); z dominates so the
            // relief stays cloth-subtle rather than embossed.
            let nx = -dx * strength; let ny = -dy * strength; let nz = 1;
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
        return canvas as unknown as ImageLike;
      } catch { return null; }
    },
  };
}

/** The app's shared instance (browser canvases). */
export const browserImageOps: ImageOps = createImageOps();
