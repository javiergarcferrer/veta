/**
 * Code-splitting, twice over.
 *
 * `safeDynamicImport` — every chunk import goes through here. A visitor whose
 * tab predates the current deploy has a stale chunk manifest, and a raw
 * `import()` strands them on "failed to fetch dynamically imported module"
 * forever. One reload fixes it (the new HTML carries the new manifest), so the
 * helper reloads ONCE per session and re-throws if it happens again — a reload
 * loop is worse than the error it was hiding.
 *
 * `loadOptionalModule` — a module that is NOT a declared dependency of this app
 * (today: `@google/model-viewer` and `qrcode`, which power AR and the phone
 * handoff QR). The specifier is a runtime VARIABLE and marked `@vite-ignore`
 * precisely so the bundler leaves it alone: the app must build and typecheck
 * without those packages installed, and the feature that needs one simply stays
 * hidden until a deploy carries it. Never make this a literal import — that is
 * the line between "AR is unavailable" and "the build fails".
 */

const RELOAD_FLAG = 'veta.chunkReload';

const isChunkError = (err: unknown): boolean => {
  const message = String((err as { message?: unknown })?.message ?? err ?? '');
  return /dynamically imported module|Importing a module script failed|Loading chunk|error loading/i.test(message);
};

/** Import a chunk, recovering ONCE from a stale-deploy manifest. */
export async function safeDynamicImport<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    const scope = globalThis as {
      sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
      location?: { reload(): void };
    };
    if (isChunkError(err) && scope.location?.reload) {
      let alreadyReloaded = false;
      try { alreadyReloaded = scope.sessionStorage?.getItem(RELOAD_FLAG) === '1'; } catch { /* private mode */ }
      if (!alreadyReloaded) {
        try { scope.sessionStorage?.setItem(RELOAD_FLAG, '1'); } catch { /* ignore */ }
        scope.location.reload();
        // The reload is in flight; never resolve into a caller mid-teardown.
        return await new Promise<T>(() => {});
      }
    }
    throw err;
  }
}

/**
 * Load a module this app does not declare. Resolves to `null` when it is not
 * installed, so the caller HIDES the feature rather than failing.
 */
export async function loadOptionalModule<T = unknown>(specifier: string): Promise<T | null> {
  try {
    const mod = await import(/* @vite-ignore */ specifier);
    return (mod as { default?: unknown }).default != null ? ((mod as { default: T }).default) : (mod as T);
  } catch {
    return null;
  }
}
