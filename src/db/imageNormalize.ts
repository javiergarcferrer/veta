/**
 * normalizeImageForUpload — make every uploaded photo web- and Shopify-safe at
 * the ONE chokepoint (saveImage), so "take a photo on the iPhone, tap, done"
 * works end-to-end.
 *
 * Why this exists: iPhones shoot HEIC by default, and the images bucket
 * accepted HEIC/HEIF/AVIF verbatim. Those bytes then break downstream in two
 * places at once — Shopify's productSet file fetch (the inventory mirror sends
 * our public URL; Shopify supports JPEG/PNG/WEBP/GIF, NOT HEIC/AVIF, so the
 * listing silently loses its photo) and every non-Apple browser (<img> can't
 * decode HEIC, so the same photo reads as broken on the office desktop).
 * Oversized camera output (48 MP JPEGs) also tripped the 10 MB cap.
 *
 * Rules:
 *   • svg / gif pass through untouched (vector · animation).
 *   • HEIC / HEIF / AVIF are ALWAYS re-encoded to JPEG — on the device that
 *     picked them (an iPhone decodes its own photos natively). If THIS device
 *     can't decode the format (e.g. a HEIC file dropped on desktop Chrome),
 *     throw the dealer-readable error instead of storing bytes that render
 *     broken everywhere else.
 *   • JPEG / PNG / WEBP re-encode only when heavy (> KEEP_BYTES): downscale to
 *     MAX_EDGE on the long side, JPEG for photos, PNG stays PNG (transparency
 *     — logos, knockouts). If the re-encode comes out larger, keep the
 *     original.
 *
 * Decode rides an <img> element (EXIF orientation is honored by default in
 * every modern engine), draw → canvas → toBlob. Browser-only, like the rest
 * of the db layer.
 */

/** Long-edge cap for stored photos — plenty for the Tienda, Shopify listings
 *  and the PDFs, and it keeps flaky-LTE uploads fast. */
const MAX_EDGE = 2048;
/** Web-safe rasters at or under this size skip the re-encode entirely. */
const KEEP_BYTES = 2.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

const PASS_THROUGH = /^image\/(svg\+xml|gif)$/i;
const MUST_CONVERT = /^image\/(heic|heif|avif)$/i;
const WEB_RASTER = /^image\/(png|jpe?g|webp)$/i;

function decodeToImage(blob: Blob): Promise<{ img: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('undecodable'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function normalizeImageForUpload(blob: Blob): Promise<Blob> {
  const mime = (blob.type || '').toLowerCase();
  if (PASS_THROUGH.test(mime)) return blob;
  const mustConvert = MUST_CONVERT.test(mime);
  // Unknown / non-image types fall through untouched — saveImage's MIME gate
  // is the one that rejects them, with its established message.
  if (!mustConvert && !WEB_RASTER.test(mime)) return blob;
  // Small web-safe rasters are already fine everywhere — don't touch the bytes
  // (re-encoding a hand-tuned product JPEG only loses quality).
  if (!mustConvert && blob.size <= KEEP_BYTES) return blob;

  let decoded: { img: HTMLImageElement; release: () => void };
  try {
    decoded = await decodeToImage(blob);
  } catch {
    if (mustConvert) {
      throw new Error(
        'Este equipo no puede leer fotos HEIC/AVIF. Súbela directo desde el iPhone (que sí las convierte), o expórtala como JPG/PNG.',
      );
    }
    // A web-safe raster that merely failed to decode here: keep the original
    // rather than block the upload on a local decode hiccup.
    return blob;
  }

  try {
    const { img } = decoded;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return mustConvert ? failConvert() : blob;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return mustConvert ? failConvert() : blob;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNG keeps PNG (alpha); everything else lands as JPEG. (Safari can't
    // encode WEBP from a canvas, so an oversized WEBP photo becomes JPEG too.)
    const outType = mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = await canvasToBlob(canvas, outType, outType === 'image/jpeg' ? JPEG_QUALITY : undefined);
    if (!out || !out.size) return mustConvert ? failConvert() : blob;
    // Only swap when converting formats or when the re-encode actually helped.
    if (mustConvert || out.size < blob.size) return out;
    return blob;
  } finally {
    decoded.release();
  }
}

function failConvert(): never {
  throw new Error(
    'No se pudo convertir la foto HEIC/AVIF en este equipo. Súbela directo desde el iPhone, o expórtala como JPG/PNG.',
  );
}
