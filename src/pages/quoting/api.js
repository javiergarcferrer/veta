// The quoting surface's TRANSPORT — every call this product's quote screens make
// to the `togo-embed` Edge Function, in one place.
//
// Two kinds of caller, two kinds of key, and the difference is the whole
// security model:
//
//   • the manufacturer's screens (`quoteOp`) ride `functions.invoke`, which
//     attaches the SIGNED-IN user's JWT. The function verifies that token itself
//     and requires an active profile before it will price a lead, freeze a quote
//     or mint a customer link.
//   • the customer's page (`fetchPublicQuote`) is logged OUT, so it calls with
//     the public anon key exactly like the widget does — and carries the share
//     TOKEN, which is the only thing that authorizes it. It can read one quote:
//     the one whose token it holds.
//
// The browser never sends a price, a total or a status transition it computed
// itself: every op names a row and an intent, and the server owns what happens
// to the money (frozen at creation — see functions/togo-embed/quotes.ts).
//
// It lives next to the pages it serves rather than in `lib/` because it is the
// quoting surface's own wiring; `lib/configuratorEmbed.js` is the same idea for the
// widget and the dealer inbox, and this deliberately mirrors its idioms
// (`?apikey=` on the URL so the logged-out call needs no custom header, an
// Error carrying `.status`).

import { supabase } from '../../db/supabaseClient.js';

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/** The server's OWN message, when it sent one. `functions.invoke` reports a
 *  non-2xx as an opaque "Edge Function returned a non-2xx status code" and hides
 *  the body on `error.context` — which is where every message worth showing the
 *  dealer lives ("ninguna pieza tiene precio…"). */
async function messageFrom(error, fallback) {
  try {
    const res = error?.context;
    if (res && typeof res.json === 'function') {
      const body = await res.json();
      if (body?.error) return String(body.error);
    }
  } catch { /* not a JSON body — fall through */ }
  return error?.message || fallback;
}

/** One authenticated quote op. Throws an Error carrying the server's message
 *  (and `.status` when the response gave one). */
async function quoteOp(op, payload = {}, fallback = 'No se pudo completar la operación.') {
  const { data, error } = await supabase.functions.invoke('togo-embed', {
    body: { quoteOp: op, ...payload },
  });
  if (error) {
    const e = new Error(await messageFrom(error, fallback));
    e.status = error?.context?.status || 0;
    throw e;
  }
  if (data && data.error) throw new Error(String(data.error));
  return data;
}

/* ------------------------------- solicitudes ------------------------------- */

/** ONE lead, priced by the server's shared pricer:
 *  `{ request, models, dealer, currency, quote }`. */
export function fetchRequestDetail(id) {
  return quoteOp('requestDetail', { id }, 'No se pudo abrir la solicitud.');
}

/** FREEZE a lead into a quote → `{ quote, reused? }`. Idempotent server-side:
 *  a lead that already became a quote returns that quote instead of a second. */
export function createQuoteFromRequest(requestId) {
  return quoteOp('create', { requestId }, 'No se pudo crear la cotización.');
}

/** COMPOSE a quote directly — the signed-in configurator's door, no lead
 *  charade. `payload` = { contact:{name, phone?, email?}, items, note?,
 *  snapshot?, dealerSlug? }; the server sanitizes the build, prices it through
 *  the same pricer every other surface reads, and freezes → `{ quote, reused? }`.
 *  Refused (409) when nothing prices — nothing is written in that case. */
export function createQuoteFromBuild(payload) {
  return quoteOp('createFromBuild', payload, 'No se pudo crear la cotización.');
}

/* -------------------------------- cotizaciones ------------------------------ */

/** The manufacturer's quote list → `{ quotes: [...] }` (list shapes, no lines). */
export function fetchQuotes() {
  return quoteOp('list', {}, 'No se pudieron cargar las cotizaciones.');
}

/** One quote, whole → `{ quote, models }`. */
export function fetchQuote(id) {
  return quoteOp('get', { id }, 'No se pudo abrir la cotización.');
}

/** Advance the document's state (draft · sent · accepted · declined). The money
 *  is untouched by construction — the server writes only the status + its stamp,
 *  and the database refuses anything else. */
export function setQuoteStatus(id, status) {
  return quoteOp('setStatus', { id, status }, 'No se pudo cambiar el estado.');
}

/** Open or revoke the customer link. Revoking keeps the token, so re-enabling
 *  restores the SAME URL. */
export function setQuoteShare(id, enabled) {
  return quoteOp('share', { id, enabled }, 'No se pudo cambiar el enlace.');
}

/* ------------------------------- the customer ------------------------------ */

function publicEndpoint() {
  const base = `${SUPABASE_URL}/functions/v1/togo-embed`;
  return SUPABASE_ANON_KEY ? `${base}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/**
 * The login-less quote page's read: `?quote=<share token>` → the whitelisted
 * public bundle `{ quote, brand, models }`. The token is the only key; an
 * unknown or revoked one answers 404 (indistinguishable on purpose).
 */
export async function fetchPublicQuote(token) {
  const r = await fetch(`${publicEndpoint()}&quote=${encodeURIComponent(token || '')}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
