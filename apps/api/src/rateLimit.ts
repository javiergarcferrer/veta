// PER-KEY RATE LIMITING — a token bucket, in this process's memory.
//
// Scoped to the API KEY, never to an IP: the widget's publishable key ships in
// the page, so the tenant is the only thing a request reliably identifies, and a
// noisy embed must not be able to spend another tenant's budget.
//
// In-memory ON PURPOSE for v1 (a Postgres round-trip per request to protect a
// Postgres round-trip is a worse trade), which means the budget is per PROCESS:
// N instances give a tenant N buckets. That is a stated approximation, not an
// oversight — the limit exists to blunt runaway loops and scrapers, and the
// authoritative refusals (auth, scopes, RLS) never depend on it.
//
// The clock is INJECTED so the tests are deterministic: a limiter that can only
// be tested by sleeping is a limiter nobody re-tests.

export interface RateLimitConfig {
  /** Burst size — tokens a key may spend at once. */
  capacity: number;
  /** Sustained rate, tokens per second. */
  refillPerSec: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Buckets idle this long are forgotten (memory is not a ledger). */
  idleTtlMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this decision. */
  remaining: number;
  /** ms until one token is available again (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  take(key: string, cost?: number): RateLimitDecision;
  /** Drop idle buckets. Called opportunistically by `take`. */
  sweep(): void;
  readonly config: Required<Omit<RateLimitConfig, 'now'>>;
}

/** Generous by design: it catches runaway loops, not real usage. */
export const DEFAULT_RATE_LIMIT: Required<Omit<RateLimitConfig, 'now'>> = {
  capacity: 600,
  refillPerSec: 10,
  idleTtlMs: 10 * 60_000,
};

interface Bucket {
  tokens: number;
  at: number;
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}): RateLimiter {
  const capacity = Math.max(1, Number(config.capacity ?? DEFAULT_RATE_LIMIT.capacity));
  const refillPerSec = Math.max(0, Number(config.refillPerSec ?? DEFAULT_RATE_LIMIT.refillPerSec));
  const idleTtlMs = Math.max(1000, Number(config.idleTtlMs ?? DEFAULT_RATE_LIMIT.idleTtlMs));
  const now = config.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();
  let lastSweep = now();

  const sweep = (): void => {
    const t = now();
    for (const [key, bucket] of buckets) {
      if (t - bucket.at > idleTtlMs) buckets.delete(key);
    }
    lastSweep = t;
  };

  const take = (key: string, cost = 1): RateLimitDecision => {
    const t = now();
    if (t - lastSweep > idleTtlMs) sweep();
    const bucket = buckets.get(key) ?? { tokens: capacity, at: t };
    // Refill for the elapsed time, then spend. Clamped at capacity so an idle
    // key gets a full burst and never a saved-up flood.
    const elapsed = Math.max(0, t - bucket.at) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.at = t;

    const want = Math.max(1, cost);
    if (bucket.tokens >= want) {
      bucket.tokens -= want;
      buckets.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    buckets.set(key, bucket);
    const deficit = want - bucket.tokens;
    const retryAfterMs = refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : Number.MAX_SAFE_INTEGER;
    return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
  };

  return { take, sweep, config: { capacity, refillPerSec, idleTtlMs } };
}
