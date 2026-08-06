// kvadrat-zip/allow.ts — THE ALLOWLIST, pinned by tests/kvadratCollection.test.js.
//
// The pure half of `kvadrat-zip`, function-local (the same idiom as
// swatch-proxy/allow.ts and lr-catalog/merge.ts: the shell does I/O, the Model
// decides). Kept here rather than imported from kvadrat-collection so each
// function deploys as a self-contained unit.

const KVADRAT_BLOB_HOST = 'kvadratimageresizer.blob.core.windows.net';

/**
 * The one blob URL the zip proxy is allowed to stream, or null. Locks the exact
 * Azure host + `/bynderresources/` prefix + `.zip`, rebuilt from origin +
 * pathname so userinfo/port/fragment tricks can't reach `fetch` (the SSRF wall
 * swatch-proxy keeps). Only the exports our own enumeration produces pass.
 */
export function kvadratBlobUrl(input: string): string | null {
  const s = String(input || '').trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== KVADRAT_BLOB_HOST) return null;
  if (!/^\/bynderresources\/[A-Za-z0-9-]+\.zip$/i.test(u.pathname)) return null;
  if (/%2e/i.test(u.pathname)) return null;
  return `https://${u.hostname}${u.pathname}`;
}
