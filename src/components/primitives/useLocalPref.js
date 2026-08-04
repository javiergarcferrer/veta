import { useCallback, useState } from 'react';

/**
 * A LAYOUT preference that survives reloads — pane density, a collapsed rail, a
 * split width. Device-local (localStorage) and best-effort by contract: quota
 * errors and private mode degrade to in-memory state instead of throwing, so a
 * preference can never break a render.
 *
 * Values round-trip as JSON, so booleans / numbers / strings all work. Chrome
 * only — never park domain data here; that belongs in Supabase.
 */
export default function useLocalPref(key, fallback) {
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  });
  const set = useCallback((next) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota / private mode */ }
      return v;
    });
  }, [key]);
  return [value, set];
}
