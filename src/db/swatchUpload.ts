// A material's SWATCH TEXTURE → the public `togo-textures` bucket, the same one
// the configurator already tiles from (`materials.colors[].textureUrl`, read by
// TogoStage / togoFabricAppearance and served through the togo-embed payload).
//
// Browser-only (it uses the supabase client), so it lives in the db layer beside
// togoMeshUpload.ts and follows the same contract: validate, upload under a
// collision-proof path, hand back the PUBLIC url the row stores.
//
// The bytes arriving here have already been decoded, bounded and re-encoded by
// the brand's materials module (src/brands/modules/swatchPixels.js) — this
// function stores what it is given and nothing else.
import { supabase } from './supabaseClient.js';

const BUCKET = 'togo-textures';
/** A bounded, re-encoded swatch lands far under this; the cap is a guard against
 *  a caller handing over the original 16 MB scan by mistake. */
const MAX_BYTES = 12 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Upload one swatch texture → its public URL.
 *
 * `folder` groups a brand's textures under its own prefix, so a brand's library
 * is inspectable (and deletable) as a unit in the Storage browser.
 */
export async function uploadSwatchTexture(
  blob: Blob,
  { folder = 'shared', name = '' }: { folder?: string; name?: string } = {},
): Promise<string> {
  if (!blob) throw new Error('No se recibió ninguna imagen.');
  if (blob.size > MAX_BYTES) {
    throw new Error(`La muestra es muy grande (${(blob.size / 1048576).toFixed(1)} MB).`);
  }
  const fromName = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  const ext = EXT_BY_TYPE[blob.type] || fromName || 'jpg';
  const safeFolder = String(folder || 'shared').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'shared';
  const path = `${safeFolder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(error.message || 'No se pudo subir la muestra.');
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('No se pudo obtener la URL pública de la muestra.');
  return data.publicUrl;
}

/** Best-effort removal of an uploaded swatch — used to clean up textures whose
 *  material row never made it (a failed import must not leave paid-for bytes
 *  behind). Never throws. */
export async function removeSwatchTexture(url: string | null | undefined): Promise<void> {
  const marker = `/${BUCKET}/`;
  const i = (url || '').indexOf(marker);
  if (i < 0) return;
  const path = url!.slice(i + marker.length).split('?')[0];
  if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}
