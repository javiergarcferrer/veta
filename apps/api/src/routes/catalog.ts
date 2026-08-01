// Catalog reads on the API-key plane.
//
// Thin on purpose (WP-1.4 owns the real surface, including dealer pricing modes
// via `@veta/catalog`). What matters here is that neither route filters by
// tenant: `withTenant` declares the org and RLS does the rest, so there is no
// query an executor could forget to scope. The publishable plane additionally
// never sees a draft — that gate lives in the policy, not in this SQL.

import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';

export const catalogRoutes = new Hono<AuthEnv>()
  .get('/collections', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const collections = await withTenant(orgId, kind, async (client) => {
      const r = await client.query(
        `select id, slug, name, status, render_params, taxonomy, sort_order
           from public.collections
          order by sort_order, name`,
      );
      return r.rows;
    });
    return c.json({ collections });
  })
  .get('/collections/:slug/models', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const slug = c.req.param('slug');
    const models = await withTenant(orgId, kind, async (client) => {
      const r = await client.query(
        `select m.id, m.slug, m.name, m.status, m.tags, m.width_cm, m.depth_cm, m.height_cm,
                m.mesh_path, m.mesh_params, m.mount, m.default_rot, m.sku
           from public.models m
           join public.collections col on col.id = m.collection_id
          where col.slug = $1
          order by m.sort_order, m.name`,
        [slug],
      );
      return r.rows;
    });
    return c.json({ models });
  });
