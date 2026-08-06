/**
 * A SWATCH BITMAP → the two things the 3D actually needs: a bounded texture and
 * the cloth's exact tone.
 *
 * Shared by every materials adapter, because the requirement is the same
 * whatever the archive around the bitmap looks like: the configurator tiles
 * `textureUrl` when there is a real scan and tints with `rgb` when there is
 * not (see TogoStage / togoFabricAppearance), so a colour that carries neither
 * cannot be upholstered at all.
 *
 * Four rules, all measured rather than tasteful:
 *
 *   • BOUND THE EDGE. A manufacturer's swatch scan is routinely 3–5k for a
 *     weave that renders 300 px wide, and the file is re-downloaded by every
 *     visitor who opens the configurator. 2048 keeps per-thread detail legible
 *     at close dolly range (1024 read soft next to reference configurators) and
 *     still bounds the file.
 *   • RE-ENCODE. WebP at 0.9 turns a 16 MB scan into ~150–300 KB with no
 *     visible loss on cloth; a browser without WebP encoding falls back to JPEG
 *     and the import carries on.
 *   • BOUND THE FILE TOO. The edge is a proxy for the weight and it is not a
 *     reliable one — a browser that quietly answers with PNG blows straight
 *     through it (see MAX_STORED_BYTES). So the bytes are measured, and the
 *     encoder walks down quality and then down size until they fit.
 *   • AVERAGE ON A GRID, not every pixel. A fabric's tone is flat; sampling
 *     ~4096 points answers it exactly and keeps a 400-file drop responsive.
 *     Transparent pixels are skipped — a swatch cut out on alpha would
 *     otherwise average toward black.
 *
 * Browser-only by nature (createImageBitmap + canvas). `averageRgb` is split out
 * as pure math over an RGBA buffer so the tone rule can be exercised without a
 * DOM.
 */

/** Longest edge of a stored texture, in pixels. */
export const MAX_EDGE = 2048;

/**
 * Ceiling on the STORED FILE, in bytes — the rule the edge alone didn't enforce.
 *
 * Bounding the edge bounds the pixels, not the weight, and the two came apart
 * exactly where `canvasBlob` fell through: a browser that answers `toBlob(…,
 * 'image/webp')` with a PNG produces a perfectly valid 2048-px texture that
 * happens to weigh 8 MB. Two of those reached the bucket (8346 kB and 7719 kB,
 * against a ~150–300 KB WebP for the same cloth) and between them accounted for
 * most of what `togo-textures` held. They are also the files most likely to
 * defeat the thumbnail baker downstream, which has an Edge Function's memory to
 * work in — so an unbounded original quietly costs the tile its small version
 * too.
 */
export const MAX_STORED_BYTES = 1_200_000;

/** Never shrink a weave past this to meet the ceiling: below ~768 the thread
 *  stops reading at close dolly range, and a soft texture is a worse answer
 *  than a heavy one. */
const MIN_EDGE = 768;

/** JPEG quality ladder, walked only when WebP is unavailable or still too big.
 *  0.6 is where cloth starts to show blocking on a flat weave. */
const JPEG_STEPS = [0.85, 0.72, 0.6];

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** '#rrggbb' from three 0-255 channels. */
export const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/**
 * Average colour of an RGBA buffer, '#rrggbb' — or null when every sampled
 * pixel was transparent (nothing to average is not a black swatch).
 *
 * Pure: `data` is any indexable RGBA sequence (a canvas ImageData.data, a
 * Uint8ClampedArray, a plain array).
 */
export function averageRgb(data, width, height) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!w || !h || !data) return null;
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
  }
  if (!n) return null;
  return toHex(r / n, g / n, b / n);
}

/**
 * Decode a bitmap File → `{ blob, rgb, width, height }`, downscaled to
 * `maxEdge` and re-encoded, or null when it can't be decoded (a .jpg that is
 * really a PDF, a truncated download). NEVER throws: one bad file in a folder
 * of four hundred must cost that file and nothing else.
 *
 * `blob` is what a caller uploads; `rgb` is the tone the 3D tints with. A
 * caller that only wants the tone can ignore the blob — nothing is stored here.
 */
export async function readSwatchBitmap(file, { maxEdge = MAX_EDGE, quality = 0.9 } = {}) {
  if (!file || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    // The tone is read ONCE, off the first and largest draw: a fabric's colour
    // is flat (that is the whole premise of `averageRgb`), so re-reading it at
    // each rung of the shrink ladder would cost a getImageData for an answer
    // that cannot change.
    let rgb;
    let best = null;
    // The floor never overrides the CALLER: a brand that configures a 512-px
    // texture asked for 512, and a ceiling-chasing ladder must not hand it back
    // something bigger than it wanted.
    const floor = Math.min(MIN_EDGE, maxEdge);
    for (let step = 0; step < 3; step += 1) {
      const edge = Math.max(floor, Math.round(maxEdge / 2 ** step));
      const drawn = drawTo(bitmap, edge);
      if (!drawn) return null;
      if (rgb === undefined) {
        rgb = averageRgb(
          drawn.ctx.getImageData(0, 0, drawn.width, drawn.height).data,
          drawn.width,
          drawn.height,
        );
      }
      const blob = await boundedBlob(drawn.canvas, quality);
      if (!blob) return null;
      if (!best || blob.size < best.blob.size) {
        best = { blob, rgb, width: drawn.width, height: drawn.height };
      }
      // Under the ceiling, or as small as we are willing to go: either way this
      // is the answer. A weave that is STILL heavy at MIN_EDGE ships heavy —
      // the upload guard is the backstop, and no-vanish beats no-texture.
      if (blob.size <= MAX_STORED_BYTES || edge === floor) break;
    }
    return best;
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/** The bitmap drawn into a fresh canvas whose longest edge is `edge` (never
 *  upscaled), or null when this browser gives us no 2D context. */
function drawTo(bitmap, edge) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { canvas, ctx, width, height };
}

/**
 * canvas → the lightest Blob this browser will give us: WebP where it encodes
 * one, JPEG down a quality ladder where it doesn't or where WebP still lands
 * over the ceiling.
 *
 * `toBlob` hands back a PNG when it doesn't know the type asked for, and the
 * old version trusted the JPEG retry to be a JPEG — which is how 8 MB PNGs
 * reached the bucket. Now the TYPE only buys the fast path and the SIZE is what
 * actually decides: whatever a browser hands back, the smallest bounded answer
 * wins. A PNG that fits the ceiling is a fine texture; an 8 MB one is the bug.
 * And if nothing meets the ceiling the smallest thing seen still ships —
 * returning null over a few hundred stray kilobytes would cost the colour its
 * texture entirely.
 */
async function boundedBlob(canvas, quality) {
  const webp = await toBlob(canvas, 'image/webp', quality);
  if (webp?.type === 'image/webp' && webp.size <= MAX_STORED_BYTES) return webp;
  let best = webp || null;
  for (const q of JPEG_STEPS) {
    const jpeg = await toBlob(canvas, 'image/jpeg', q);
    if (!jpeg) break;
    if (!best || jpeg.size < best.size) best = jpeg;
    if (jpeg.size <= MAX_STORED_BYTES) return best;
  }
  return best;
}

/** One `toBlob` attempt as a promise. Never throws, never resolves undefined. */
function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), type, quality);
    } catch {
      resolve(null);
    }
  });
}
