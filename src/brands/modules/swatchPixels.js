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
 * Three rules, all measured rather than tasteful:
 *
 *   • BOUND THE EDGE. A manufacturer's swatch scan is routinely 3–5k for a
 *     weave that renders 300 px wide, and the file is re-downloaded by every
 *     visitor who opens the configurator. 2048 keeps per-thread detail legible
 *     at close dolly range (1024 read soft next to reference configurators) and
 *     still bounds the file.
 *   • RE-ENCODE. WebP at 0.9 turns a 16 MB scan into ~150–300 KB with no
 *     visible loss on cloth; a browser without WebP encoding falls back to JPEG
 *     and the import carries on.
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
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgb = averageRgb(ctx.getImageData(0, 0, width, height).data, width, height);
    const blob = await canvasBlob(canvas, quality);
    return { blob, rgb, width, height };
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/** canvas → Blob, WebP where the browser encodes it, JPEG where it doesn't.
 *  `toBlob` hands back a PNG when it doesn't know the type asked for, so the
 *  answer is checked rather than trusted. */
function canvasBlob(canvas, quality) {
  return new Promise((resolve) => {
    const finish = (blob) => resolve(blob || null);
    try {
      canvas.toBlob((webp) => {
        if (webp && webp.type === 'image/webp') { finish(webp); return; }
        try { canvas.toBlob(finish, 'image/jpeg', quality); } catch { finish(webp); }
      }, 'image/webp', quality);
    } catch {
      resolve(null);
    }
  });
}
