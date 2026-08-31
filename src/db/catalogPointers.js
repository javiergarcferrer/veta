/**
 * PUNTEROS DE FOTO DE CATÁLOGO — la misma jugada, ya para tres marcas.
 *
 * A supplier's photos live on the supplier's CDN. We do not copy the bytes: we
 * write a POINTER — an `images` row carrying `externalUrl` and nothing else —
 * and the product row references it by id. That is what makes a quote line show
 * a photo, because every surface downstream (the line item, the client preview,
 * the PDF) resolves an `imageId`, never a raw url.
 *
 * ── POR QUÉ ESTE MÓDULO EXISTE ──────────────────────────────────────────────
 * LifestyleGarden mints `lsgimg-…`, Carl Hansen mints `chimg-…`, and Fredericia
 * minted NOTHING — its importer wrote `imageSrc`/`imageSrcs` (raw CDN urls) and
 * stopped there. The catalog grid was fine, because it falls back to the url;
 * the QUOTE was not, because the line seed copies `imageId` and there was none.
 * A Spanish Chair with eighteen photographs on file quoted blank.
 *
 * The fix could have been a fourth copy of the same twenty lines. It is one
 * copy instead, because the next brand will need it too.
 *
 * ── CONTENT-ADDRESSED, Y ESO ES LO QUE LO HACE SEGURO ───────────────────────
 * The id is the hash of the url, so the SAME photo always mints the SAME row: a
 * re-import is idempotent, and two variants sharing a shot share one row rather
 * than duplicating it. That sharing is exactly why every prefix here is
 * registered in `isSharedCatalogImage` — a quote line clearing its cover must
 * UNLINK, never delete, or it blanks the photo everywhere it appears.
 *
 * A pointer holds NO BYTES. `storagePath`, `contentType` and `size` are nulled
 * explicitly so a row can never look half-stored.
 */

import { db } from './database.js';

/** `crypto.subtle` needs a secure context. Without it the caller still writes
 *  its products — the on-screen photo resolves off `imageSrc` — and says so,
 *  rather than losing a whole import over the byte path for the PDF. */
export const canMintPointers = () => !!globalThis.crypto?.subtle;

/**
 * The pointer id for one url: `<prefix>-<sha1[0..20]>`.
 *
 * The truncation matches the Shopify catalog pull that established the scheme.
 * 80 bits over a few thousand supplier urls is not a collision anybody will
 * meet, and the ids stay short enough to read in a row.
 */
export async function pointerIdFor(prefix, url) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(url)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex.slice(0, 20)}`;
}

/**
 * Ensure every url in `rows[].imageSrcs` has its pointer row; answer with
 * `url → id` so the caller can stamp `imageId` / `extraImageIds`.
 *
 * `skipped: true` means no secure context — not a failure, and the caller is
 * expected to carry on and report it.
 */
export async function mintCatalogPointers(rows, { prefix, kind, ownerId }) {
  const urls = [...new Set((rows || []).flatMap((r) => r?.imageSrcs || []).filter(Boolean))];
  const byUrl = new Map();
  if (!urls.length) return { byUrl, skipped: false, minted: 0 };
  if (!canMintPointers()) return { byUrl, skipped: true, minted: 0 };

  const ids = await Promise.all(urls.map((url) => pointerIdFor(prefix, url)));
  urls.forEach((url, i) => byUrl.set(url, ids[i]));

  const CHUNK = 200;
  const pointers = urls.map((url) => ({
    id: byUrl.get(url),
    kind,
    ownerId,
    label: url,
    externalUrl: url,
    storagePath: null,
    contentType: null,
    size: null,
  }));
  for (let i = 0; i < pointers.length; i += CHUNK) {
    await db.images.bulkPut(pointers.slice(i, i + CHUNK));
  }
  return { byUrl, skipped: false, minted: pointers.length };
}

/**
 * The whole batch, stamped — or the whole batch left alone.
 *
 * PGRST102 IS WHY THIS TAKES THE BATCH AND NOT A ROW. PostgREST refuses a bulk
 * upsert whose objects disagree about their keys, so the pointer columns are
 * decided for ALL the rows at once: minted ⇒ every row carries them, and a
 * photo-less variant legitimately writes null; not minted (no secure context)
 * ⇒ NO row carries them, so an earlier import's good pointer survives untouched
 * instead of being blanked by a pass that simply could not hash a url.
 *
 * COVER FIRST, THE REST AS EXTRAS — the order the source published them in,
 * which is the supplier's own answer to "which photo IS this product".
 */
export function stampPointerIds(rows, byUrl, skipped = false) {
  if (skipped) return rows || [];
  return (rows || []).map((row) => {
    const ids = (row?.imageSrcs || []).map((u) => byUrl.get(u)).filter(Boolean);
    return { ...row, imageId: ids[0] ?? null, extraImageIds: ids.length > 1 ? ids.slice(1) : null };
  });
}
