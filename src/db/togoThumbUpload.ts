// Upload a BAKED catalogue thumbnail (the studio-rig render of one Togo model)
// to the PUBLIC `togo-models` bucket and hand back its public URL — which the
// dealer's row carries so the configurator, used logged-out on the embed, paints
// its piece list from plain <img> instead of downloading three + every mesh to
// draw tiles nobody has selected yet.
//
// Browser-only (uses the supabase client) and deliberately the sibling of
// togoMeshUpload.ts: same bucket, same public-URL shape, same best-effort
// cleanup on replace. The bytes come from the SAME renderer the widget would
// have used (`renderTogoThumb`), so a baked tile and a live one are the same
// picture — this only decides WHO pays for it, and how often.
import { supabase } from './supabaseClient.js';

const BUCKET = 'togo-models';
const PREFIX = 'thumbs';
// A 512×384 PNG of a soft-shaded piece on a white plate runs ~60–120 KB. The
// ceiling is a guard against uploading something that is not a thumbnail at all.
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload one baked thumbnail → its public URL.
 *
 * The object is named for the model AND the stamp it was baked from, so a
 * re-bake after an edit writes a DIFFERENT path: the previous file stays valid
 * for anyone still holding its URL (the storefront CDN caches it immutably for
 * a year), and nothing has to be purged for the new one to be seen. The caller
 * clears the old object once the row points at the new one.
 */
export async function uploadTogoThumb(modelId: string, stamp: string, blob: Blob): Promise<string> {
  if (!modelId) throw new Error('Falta el modelo.');
  if (!blob?.size) throw new Error('La miniatura salió vacía.');
  if (blob.size > MAX_BYTES) throw new Error(`La miniatura es muy grande (${Math.round(blob.size / 1024)} KB).`);
  // Both halves are ours (a uuid row id and a base-36 digest), but this string
  // becomes a storage path — so anything that isn't those characters is folded
  // out rather than reasoned about.
  const safe = (s: string) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const path = `${PREFIX}/${safe(modelId)}-${safe(stamp) || 'x'}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/png',
    cacheControl: '31536000',
    // The path already carries the stamp, so the same content always writes to
    // the same name — an interrupted pass re-running is a no-op, not a conflict.
    upsert: true,
  });
  if (error) throw new Error(error.message || 'No se pudo subir la miniatura.');
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('No se pudo obtener la URL pública.');
  return data.publicUrl;
}

/** Best-effort removal of a superseded thumbnail. Never throws: an orphaned
 *  100 KB png is not worth failing a bake over. */
export async function removeTogoThumb(url: string | null | undefined): Promise<void> {
  const marker = `/${BUCKET}/`;
  const i = (url || '').indexOf(marker);
  if (i < 0) return;
  const path = url!.slice(i + marker.length).split('?')[0];
  // Only ever our own prefix — this takes a URL off a row, and a row is not a
  // licence to delete a MESH.
  if (!path.startsWith(`${PREFIX}/`)) return;
  await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}
