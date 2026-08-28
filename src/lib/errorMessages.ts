/**
 * Convert technical errors (Supabase / fetch / generic) into a single Spanish
 * sentence the user can act on. Falls back to the original message when we
 * can't classify, so we never hide diagnostic information — we just put a
 * friendlier label on top of it for the common cases.
 */
import { captureError } from './errorLog.js';

/** Subset of the fields we look at across Supabase / fetch / generic errors. */
interface ErrorLike {
  code?: string | number;
  status?: string | number;
  message?: string;
}

export function userMessageFor(err: unknown): string {
  // Record the RAW error (with its Response context) for the admin error
  // console — this is the funnel every handled-error toast passes through.
  captureError(err, { type: 'handled' });
  if (!err) return 'Error desconocido.';
  const e = err as ErrorLike;
  const code = e.code || e.status || '';
  const raw = (e.message || String(err)).toLowerCase();

  // A CHUNK THE SHELL CAN NO LONGER FETCH. Must sit ABOVE the network arm: the
  // commonest shape, «Failed to fetch dynamically imported module», contains
  // "failed to fetch" and was therefore answered with «Sin conexión» — a
  // plausible wrong diagnosis, because the wire is fine and the file is gone.
  // The other shapes carry no network words at all and fell through to raw
  // English: «Importing a module script failed» is what /inventario/etiquetas
  // printed on a phone that had kept the PWA open across a deploy. The shapes
  // are `lib/dynamicImport isStaleChunkError`'s, which is also what retries and
  // then cache-busts — so reaching this sentence means that recovery is spent
  // and a reload really is the thing left to do.
  if (raw.includes('dynamically imported module')
    || raw.includes('importing a module script failed')
    || raw.includes('mime type')) {
    return 'No se pudo cargar una parte de la aplicación. Recarga la pantalla para traer la versión nueva.';
  }
  // Network / offline. "failed to send a request" is supabase-js's
  // FunctionsFetchError — functions.invoke has its OWN wording for the same
  // dead wire ("Failed to send a request to the Edge Function"), so without
  // this arm an offline invoke surfaced raw English instead of this sentence.
  if (raw.includes('failed to fetch') || raw.includes('networkerror') || raw.includes('load failed')
    || raw.includes('failed to send a request')) {
    return 'Sin conexión con el servidor. Revisa tu internet y vuelve a intentar.';
  }
  // supabase-js's FunctionsHttpError, when the failing response carried no
  // reason we could read back. The call sites all try `context.json()` first
  // (lib/carlHansenClient `detailFrom`, LrEtiquetteBar's `call`), so reaching
  // here means the body genuinely wasn't JSON — the shape of a 546, the Edge
  // Runtime killing a worker that outran its budget, which answers with no body
  // at all. Without this arm supabase-js's ENGLISH went to the dealer's Spanish
  // screen: «Edge Function returned a non-2xx status code» is what #/admin/
  // catalog/roset printed when the Ligne Roset feed went slow and the probe
  // was killed mid-flight. The raw text stays in the admin console above.
  if (raw.includes('non-2xx status code')) {
    return 'El servidor cortó la operación sin decir por qué. Vuelve a intentar en un momento.';
  }
  if (code === 'PGRST301' || raw.includes('jwt') || raw.includes('expired')) {
    return 'La sesión expiró. Recarga la página para volver a iniciar sesión.';
  }
  // The app is AHEAD of the database: a build shipped a screen whose migration
  // hasn't been applied yet, so PostgREST's schema cache has no table
  // (PGRST205), column (PGRST204), function (PGRST202) or relationship
  // (PGRST200) to answer with. Without this arm the raw English sentence went
  // straight to the dealer's Spanish screen — «Could not find the table
  // 'public.dataset_columns' in the schema cache» is what #/datos printed under
  // its header when the Excel upload landed before the datasets migration did.
  // The raw text is kept in the admin error console by captureError above.
  if (raw.includes('schema cache')
    || code === 'PGRST200' || code === 'PGRST202' || code === 'PGRST204' || code === 'PGRST205') {
    return 'El servidor todavía no tiene esta parte de la base de datos. Vuelve a intentar en unos minutos.';
  }
  if (raw.includes('row-level security') || raw.includes('permission denied') || code === '42501') {
    return 'No tienes permiso para esta acción.';
  }
  if (raw.includes('duplicate key') || raw.includes('unique constraint') || code === '23505') {
    return 'Ya existe un registro con esos datos.';
  }
  if (raw.includes('foreign key') || code === '23503') {
    return 'Hay datos relacionados que impiden esta operación.';
  }
  if (raw.includes('payload too large') || code === 413) {
    return 'El archivo es demasiado grande.';
  }
  if (raw.includes('429') || raw.includes('too many requests')) {
    return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentar.';
  }
  if (raw.includes('502') || raw.includes('503') || raw.includes('504')) {
    return 'El servidor no responde. Vuelve a intentar en un momento.';
  }
  return e.message || String(err);
}
