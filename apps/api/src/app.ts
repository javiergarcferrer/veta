import { Hono } from 'hono';
import { apiKeyAuth, type AuthEnv } from './auth.ts';
import { createRateLimiter, type RateLimitConfig, type RateLimiter } from './rateLimit.ts';
import { healthRoutes } from './routes/health.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { dealerRoutes } from './routes/dealers.ts';
import { configurationRoutes } from './routes/configurations.ts';
import { eventRoutes } from './routes/events.ts';
import { leadRoutes } from './routes/leads.ts';

export interface AppOptions {
  /** Per-key budget. Each app gets its OWN limiter, so tests never share state. */
  rateLimit?: Partial<RateLimitConfig> | RateLimiter | false;
}

function limiterFrom(option: AppOptions['rateLimit']): RateLimiter | null {
  if (option === false) return null;
  if (option && typeof (option as RateLimiter).take === 'function') return option as RateLimiter;
  return createRateLimiter((option ?? {}) as Partial<RateLimitConfig>);
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AuthEnv>();
  const limiter = limiterFrom(options.rateLimit);

  app.route('/', healthRoutes);

  // Every /v1 surface is key-authenticated; the key establishes the TENANT and
  // RLS establishes the rows. No route below re-implements either.
  app.use('/v1/*', apiKeyAuth);

  // …and the budget is spent per KEY, after the key is known: an unauthenticated
  // request is refused at the door and never touches a bucket, so a flood of
  // junk keys cannot evict a real tenant's.
  if (limiter) {
    app.use('/v1/*', async (c, next) => {
      const identity = c.get('identity');
      const decision = limiter.take(identity.keyId);
      if (!decision.allowed) {
        c.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        return c.json({ error: 'rate_limited', retry_after_ms: decision.retryAfterMs }, 429);
      }
      c.header('X-RateLimit-Remaining', String(decision.remaining));
      await next();
    });
  }

  app.route('/v1/catalog', catalogRoutes);
  app.route('/v1/dealers', dealerRoutes);
  app.route('/v1/configurations', configurationRoutes);
  app.route('/v1/leads', leadRoutes);
  app.route('/v1/events', eventRoutes);

  app.onError((err, c) => {
    const code = (err as { code?: string }).code;
    // 42501 = insufficient privilege, which under RLS also covers a WITH CHECK
    // refusal. Report it as a refusal, never with the offending row's shape.
    if (code === '42501') return c.json({ error: 'forbidden' }, 403);
    if (code === '23505') return c.json({ error: 'conflict' }, 409);
    console.error('[veta-api]', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}
