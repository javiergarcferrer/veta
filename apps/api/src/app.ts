import { Hono } from 'hono';
import { apiKeyAuth, type AuthEnv } from './auth.ts';
import { healthRoutes } from './routes/health.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { configurationRoutes } from './routes/configurations.ts';
import { leadRoutes } from './routes/leads.ts';

export function createApp() {
  const app = new Hono<AuthEnv>();

  app.route('/', healthRoutes);

  // Every /v1 surface is key-authenticated; the key establishes the TENANT and
  // RLS establishes the rows. No route below re-implements either.
  app.use('/v1/*', apiKeyAuth);
  app.route('/v1/catalog', catalogRoutes);
  app.route('/v1/configurations', configurationRoutes);
  app.route('/v1/leads', leadRoutes);

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
