import { Hono } from 'hono';
import { withApiRole } from '../db.ts';

export const healthRoutes = new Hono()
  // Static by design: a liveness probe must not depend on the database.
  .get('/health', (c) => c.json({ ok: true, service: 'veta-api' }))
  .get('/health/db', async (c) => {
    try {
      const now = await withApiRole(async (client) => {
        const r = await client.query<{ now: Date }>('select now() as now');
        return r.rows[0]?.now ?? null;
      });
      return c.json({ ok: true, now });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 503);
    }
  });
