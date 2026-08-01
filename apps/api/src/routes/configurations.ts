// CONFIGURATIONS on the API-key plane.
//
// Three directions are load-bearing:
//
//   · The payload's own `pricing_snapshot` / `verdict` / `ruleset_version` are
//     DROPPED. Both are recomputed from the tenant's rows before the row exists,
//     which is why a client-asserted number cannot appear in storage.
//
//   · The row's org comes from `veta.api_org()` INSIDE the statement, never from
//     the body, so a widget cannot file into another tenant even if it says so.
//
//   · THE STRICT SAVE GATE (design §1.6): on a collection whose ruleset carries
//     an error rule, an error violation — or a rule type this engine version
//     doesn't know — refuses the save with 422 and the FULL Verdict in the body,
//     in the same shape the widget already renders. A free-form collection saves
//     the flagged build instead: rules report, they don't prevent.
//
// The id and share token are minted here rather than with RETURNING, because the
// publishable plane has no SELECT policy on this table — by design.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { buildTooLarge, modelIdsOf, piecesOf, UUID_RE } from '../build.ts';
import { loadCollectionById, loadCollectionBySlug, loadCollectionContext } from '../context.ts';
import { priceBuild } from '../pricing.ts';
import { blocksSave, deriveVerdict } from '../verdict.ts';

interface CreateBody {
  collectionSlug?: string;
  collectionId?: string;
  build?: unknown;
}

interface ShareRow {
  id: string;
  collection_id: string;
  build: unknown;
  verdict: unknown;
  ruleset_version: number | null;
  pricing_snapshot: unknown;
  snapshot_path: string | null;
  status: string;
}

function shareToken(): string {
  return `cfg_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The share projection. PII-free BY CONSTRUCTION: the security-definer function
 * selects the columns, so this handler cannot widen the surface even by mistake,
 * and a token from another tenant simply resolves nothing (404, never a
 * 403-with-shape).
 */
async function shared(c: Context<AuthEnv>) {
  const { orgId, kind } = c.get('identity');
  const row = await withTenant(orgId, kind, async (client) => {
    const r = await client.query<ShareRow>(
      'select * from veta.configuration_by_share_token($1)',
      [c.req.param('token')],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({
    configuration: {
      id: row.id,
      collectionId: row.collection_id,
      build: row.build,
      verdict: row.verdict,
      rulesetVersion: row.ruleset_version,
      pricing: row.pricing_snapshot,
      snapshotPath: row.snapshot_path,
      status: row.status,
    },
  });
}

export const configurationRoutes = new Hono<AuthEnv>()
  .post('/', requireScope('configurations:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateBody;
    const slug = typeof body.collectionSlug === 'string' ? body.collectionSlug.trim() : '';
    const collectionId =
      typeof body.collectionId === 'string' && UUID_RE.test(body.collectionId) ? body.collectionId : '';
    if (!slug && !collectionId) return c.json({ error: 'collection_required' }, 400);
    // The engine's COUNT_MAX is a VERDICT, so it cannot also be the thing that
    // stops a fabricated body from being priced piece by piece.
    if (buildTooLarge(body.build)) return c.json({ error: 'build_too_large' }, 413);

    const { orgId, kind } = c.get('identity');
    const id = randomUUID();
    const token = shareToken();

    const outcome = await withTenant(orgId, kind, async (client) => {
      const collection = collectionId
        ? await loadCollectionById(client, collectionId)
        : await loadCollectionBySlug(client, slug);
      if (!collection) return null;

      const ctx = await loadCollectionContext(client, collection, {
        modelIds: modelIdsOf(piecesOf(body.build)),
      });
      const pricing = priceBuild(body.build, ctx);
      const verdict = deriveVerdict(body.build, ctx);
      // Judged BEFORE the row exists: a refused save leaves nothing behind.
      if (blocksSave(verdict, ctx)) return { blocked: true as const, verdict, pricing };

      await client.query(
        `insert into public.configurations
           (id, org_id, collection_id, build, verdict, ruleset_version, pricing_snapshot, share_token, status)
         values ($1, veta.api_org(), $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, 'saved')`,
        [
          id,
          collection.id,
          JSON.stringify(body.build ?? {}),
          JSON.stringify(verdict),
          verdict.rulesetVersion,
          JSON.stringify(pricing),
          token,
        ],
      );
      return { blocked: false as const, verdict, pricing };
    });

    if (!outcome) return c.json({ error: 'collection_not_found' }, 404);
    if (outcome.blocked) {
      return c.json({ error: 'rules_violation', verdict: outcome.verdict, pricing: outcome.pricing }, 422);
    }
    return c.json({ id, shareToken: token, pricing: outcome.pricing, verdict: outcome.verdict }, 201);
  })

  // A share link grants ONE design and zero PII, and only within the calling
  // plane's own org. `/shared/:token` is the contract path; `/share/:token` is
  // the WP-1.2 spelling, kept as an alias so an embed in the wild keeps working.
  .get('/shared/:token', shared)
  .get('/share/:token', shared);
