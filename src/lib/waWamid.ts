/**
 * WhatsApp message ids (`wamid.<base64>`) and why matching them by string is
 * not enough.
 *
 * A wamid packs TWO things: the ADDRESS the message was routed by, and the
 * message's own HASH. WhatsApp is migrating addressing from the plain phone
 * number to a LID (a privacy-preserving "linked id"), so the SAME message can
 * surface under two different wamids:
 *
 *   ...DO.1033248185924926...2A4C27213B8663F18F49   ← the client's reply cites this
 *   ...18097050110..........2A4C27213B8663F18F49   ← what our echo/send stored
 *
 * The address differs, the hash does not. A quoted reply (`context.id`) that
 * arrives LID-addressed therefore never string-matches the phone-addressed id
 * we logged, and the quote silently renders as nothing — measured on prod:
 * every unresolved reply since 2026-07-13 was this, and the hash matched a
 * message we already had in all of them.
 *
 * `wamidHash` extracts that stable hash so resolution can fall back to it.
 * Pure + defensive: anything unparseable resolves to null, and the caller
 * keeps its exact-id match as the primary key (the hash is only the fallback).
 */

/** The stable message hash inside a wamid, or null when it can't be read. */
export function wamidHash(waId: string | null | undefined): string | null {
  const s = String(waId || '').trim();
  if (!s.startsWith('wamid.')) return null;
  const b64 = s.slice('wamid.'.length);
  if (!b64) return null;
  let raw: string;
  try {
    // The payload is standard base64; url-safe chars are normalized first so a
    // re-encoded id (some gateways swap +/ for -_) still parses.
    raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  // The decoded blob is length-prefixed binary around printable ASCII runs.
  // Split on the non-printables and keep the LAST all-hex run — the address
  // (a phone or "DO.<lid>") is never pure hex of that length, the hash always
  // is, and it sits at the end.
  const tokens = raw
    .split(/[^\x20-\x7E]+/)
    .filter((t) => /^[0-9A-F]{16,64}$/.test(t));
  return tokens.length ? tokens[tokens.length - 1] : null;
}

/**
 * Does `a` refer to the same message as `b`? Exact id first (the common case),
 * then the cross-namespace hash. Never true on a null/unparseable pair.
 */
export function sameWaMessage(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const hx = wamidHash(x);
  return !!hx && hx === wamidHash(y);
}
