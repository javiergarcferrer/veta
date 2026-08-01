// Configurations on the API-key plane.
//
// Two directions are load-bearing:
//  - the payload's own `pricing_snapshot` / `verdict` are DROPPED; both are
//    recomputed server-side before the row exists;
//  - the row's org comes from `veta.api_org()` inside the SQL, never from the
//    body, so a widget cannot file into another tenant even if it says so.
// The id and share token are minted here rather than with RETURNING, because
// the publishable plane has no SELECT policy on this table — by design.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { priceBuild } from '../pricing.ts';
import { deriveVerdict } from '../verdict.ts';

interface CreateBody {
  collectionSlug?: string;
  build?: unknown;
}

function shareToken(): string {
  return `cfg_${randomUUID().replace(/-/g, '')}`;
}

export const configurationRoutes = new Hono<AuthEnv>()
  .post('/', requireScope('configurations:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateBody;
    const slug = typeof body.collectionSlug === 'string' ? body.collectionSlug : '';
    if (!slug) return c.json({ error: 'collection_required' }, 400);

    const { orgId, kind } = c.get('identity');
    const id = randomUUID();
    const token = shareToken();

    const created = await withTenant(orgId, kind, async (client) => {
      const found = await client.query<{ id: string }>(
        'select id from public.collections where slug = $1 limit 1',
        [slug],
      );
      const collectionId = found.rows[0]?.id;
      if (!collectionId) return null;

      const pricing = await priceBuild(client, collectionId, body.build);
      const verdict = deriveVerdict(body.build);

      await client.query(
        `insert into public.configurations
           (id, org_id, collection_id, build, verdict, ruleset_version, pricing_snapshot, share_token, status)
         values ($1, veta.api_org(), $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, 'saved')`,
        [
          id,
          collectionId,
          JSON.stringify(body.build ?? {}),
          JSON.stringify(verdict),
          verdict.schema,
          JSON.stringify(pricing),
          token,
        ],
      );
      return { pricing, verdict };
    });

    if (!created) return c.json({ error: 'collection_not_found' }, 404);
    return c.json({ id, shareToken: token, pricing: created.pricing, verdict: created.verdict }, 201);
  })
  // A share link grants ONE design and zero PII, and only within the calling
  // plane's own org — the scoping lives in the security-definer function.
  .get('/share/:token', async (c) => {
    const { orgId, kind } = c.get('identity');
    const row = await withTenant(orgId, kind, async (client) => {
      const r = await client.query(
        'select * from veta.configuration_by_share_token($1)',
        [c.req.param('token')],
      );
      return r.rows[0] ?? null;
    });
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json({ configuration: row });
  });
