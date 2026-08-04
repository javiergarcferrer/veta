/**
 * Safe dynamic-import wrapper for code-split chunks (every lazyPage route,
 * the pdf-lib bundle behind Export PDF, Leaflet, …).
 *
 * Two failure modes, two layers of defense:
 *
 * 1. TRANSIENT fetch failure — the chunk EXISTS but this one request died
 *    (LTE hiccup, an edge PoP mid-deploy-flip). Seen in prod as a burst of
 *    "Failed to fetch dynamically imported module" crashes minutes after a
 *    deploy, on chunk URLs that served 200 moments later. Defense: retry the
 *    import in place a couple of times with a short backoff. Modern browsers
 *    no longer cache a FAILED module fetch in the module map, so re-running
 *    the same import() re-hits the network; on an engine that does cache the
 *    failure the retries just fail fast and we fall through to layer 2 —
 *    never worse than before.
 *
 * 2. STALE DEPLOY — the dealer keeps the SPA open across a deploy, so their
 *    cached index.html references old hashed chunk filenames that no longer
 *    exist. The request 404s (post the vercel.json fix that stops rewriting
 *    asset paths to index.html) or, on pre-fix deploys, returns the SPA
 *    fallback HTML with a `text/html` content type. Either way the dynamic
 *    `import()` rejects. Retrying the same URL can't help (the file is gone);
 *    the only recovery is reloading the entry document so the browser sees
 *    the new chunk URLs. Defense: set a sessionStorage flag so a permanent
 *    outage doesn't loop reloads, then hard cache-bust to a NEW versioned URL.
 *
 * Why navigate to a versioned URL instead of `location.reload()`? Same
 * reason `startVersionWatcher` (lib/liveReload.js) does: an installed iOS
 * PWA serves its start_url shell (index.html) from the WebKit app-shell
 * cache, and a plain `reload()` can hand back that SAME stale HTML — so
 * the tab reloads, re-requests the very chunk hash that just 404'd, fails
 * again, and the second failure surfaces to the user as the dreaded
 * "Failed to fetch dynamically imported module" crash. Navigating to a
 * brand-new `?cb=` URL has no cache entry, so the browser MUST hit the
 * network and pull the fresh index.html + hashed bundle. HashRouter keeps
 * the route in the hash, so the search param is inert for routing.
 */
const STALE_CHUNK_KEY = 'roset-stale-chunk-reload';

/**
 * The recovery-reload guard is TIME-based, not once-per-session. The binary
 * flag assumed one stale-chunk event per session, but a deploy BURST (several
 * `main` pushes in one evening — 2026-07-30 had ~a dozen) crosses several
 * flips in one open tab: the first flip consumed the session's only recovery,
 * and the next one surfaced the crash screen ("Algo salió mal") even though
 * the chunk was servable seconds later. What actually distinguishes a flip
 * from a real outage is WHEN the failure happens: right after a recovery
 * reload ⇒ the reload didn't help, surface it; later ⇒ a NEW stale event,
 * recover again. So the key stores the epoch-ms of the last recovery reload
 * (the legacy '1' parses as ancient and permits recovery), failures within
 * the cooldown surface, and anything older gets a fresh reload — at most one
 * auto-reload per minute, so a genuinely broken deploy still can't loop.
 */
const RECOVERY_COOLDOWN_MS = 60_000;

// In-place retry schedule (layer 1) before escalating to a reload. Short on
// purpose: a genuine stale deploy burns through these in ~1.6s and still gets
// the reload, while a network blip usually clears within the first retry.
export const RETRY_DELAYS_MS = [400, 1200];

/**
 * The schedule used when a recovery reload is OFF THE TABLE — we already
 * reloaded within the cooldown, so reloading again demonstrably won't help.
 *
 * It used to surface the crash right here, which is wrong for the failure that
 * actually happens most: a TRANSIENT fetch error on a chunk that EXISTS.
 * Observed 2026-07-31 — `QuoteBuilder-<hash>.js` failed to fetch, hit the
 * cooldown, and reached the ErrorBoundary; that exact URL, and the shell that
 * requested it, both answered 200 minutes later. The chunk was never missing.
 * An edge PoP mid-deploy-flip refuses a URL for a few seconds and then serves
 * it fine, and with `main` taking a push every few minutes those windows are
 * frequent.
 *
 * Reloading can't fix that, but WAITING can — so before surfacing anything we
 * keep trying in place on a longer backoff. Worst case the dealer waits ~14s
 * for a section instead of meeting a crash screen; the reload-loop guard is
 * untouched, because none of these attempts reload.
 */
export const COOLDOWN_RETRY_DELAYS_MS = [2000, 4000, 8000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isStaleChunkError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as { message?: unknown })?.message || err).toLowerCase();
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('mime type') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch')
  );
}

/**
 * The recovery navigation (see header): hard cache-bust to a NEW URL so even
 * an installed iOS PWA must re-fetch index.html + hashed bundles from the
 * network. Exported so the ErrorBoundary's "Recargar" uses the SAME recovery
 * for a surfaced chunk error — a plain reload() there can re-serve the stale
 * shell and land the user right back on the crash screen.
 */
export function recoveryReload(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('cb', String(Date.now()));
    // `replace` so we don't grow the history stack on every recovery.
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

export async function safeDynamicImport<T>(
  loader: () => Promise<T>,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
  cooldownRetryDelaysMs: number[] = COOLDOWN_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // A success NEVER clears the recovery stamp — it ages out on its own
      // (RECOVERY_COOLDOWN_MS). Clearing it here dates from the binary-flag
      // era, and with SEVERAL callers per boot (App.jsx, push.js, the route
      // chunk all load through this) it became the loop: after a recovery
      // reload the healthy shell chunks loaded first, wiped the stamp, and
      // the still-failing route chunk saw "no recent recovery" → reloaded →
      // repeat every ~2s. That was the 2026-08-01 Facturación infinite ?cb=
      // reload loop. The stamp is shared state across callers; only time may
      // retire it.
      return await loader();
    } catch (err) {
      if (!isStaleChunkError(err)) throw err;
      if (attempt < retryDelaysMs.length) {
        await wait(retryDelaysMs[attempt]);
        continue;
      }
      let lastRecoveryAt = 0;
      try { lastRecoveryAt = Number(sessionStorage.getItem(STALE_CHUNK_KEY)) || 0; } catch {}
      if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
        // We reloaded for this MOMENTS ago, so ANOTHER reload cannot help.
        // But the chunk may well exist and simply be unservable for a few
        // seconds (an edge PoP mid-flip) — so keep trying IN PLACE on the
        // longer schedule before surfacing anything. No reload happens here,
        // so the loop guard is untouched and the stamp stays: it ages out on
        // its own, and a LATER stale event still gets its own recovery.
        for (const delay of cooldownRetryDelaysMs) {
          await wait(delay);
          try {
            // Same rule as above: success leaves the stamp; it ages out.
            return await loader();
          } catch (retryErr) {
            // A non-chunk error is a real bug in the module — surface it as-is
            // rather than burning the rest of the schedule on it.
            if (!isStaleChunkError(retryErr)) throw retryErr;
          }
        }
        // Still failing after the long wait: a real outage, a broken deploy,
        // or offline. Surface it so the UI shows the banner.
        throw err;
      }
      try { sessionStorage.setItem(STALE_CHUNK_KEY, String(Date.now())); } catch {}
      recoveryReload();
      // Hang the promise — the reload tears down the JS context
      // before this ever resolves, so callers don't continue with a
      // half-loaded module.
      return new Promise<T>(() => {});
    }
  }
}
