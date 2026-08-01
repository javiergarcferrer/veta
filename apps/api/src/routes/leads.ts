// Lead submission on the API-key plane.
//
// Laws carried over verbatim: a lead is NEVER rejected for being a bad
// configuration (a flagged lead is stored, a lost lead is gone), and the
// estimate/verdict stored on it are server-derived — a payload that asserts a
// price or `ok:true` contributes nothing but noise.
//
// The org and brand are resolved inside the statement from `veta.api_org()`, so
// there is no body field that could point the row at another tenant.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { priceBuild } from '../pricing.ts';
import { deriveVerdict } from '../verdict.ts';

interface LeadBody {
  contact?: Record<string, unknown>;
  note?: string;
  collectionSlug?: string;
  build?: unknown;
  configurationId?: string;
  dedupeKey?: string;
  source?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const leadRoutes = new Hono<AuthEnv>().post('/', requireScope('leads:write'), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as LeadBody;
  if (!body.contact || typeof body.contact !== 'object') {
    return c.json({ error: 'contact_required' }, 400);
  }

  const { orgId, kind } = c.get('identity');
  const id = randomUUID();
  const configurationId =
    typeof body.configurationId === 'string' && UUID_RE.test(body.configurationId)
      ? body.configurationId
      : null;

  const result = await withTenant(orgId, kind, async (client) => {
    // NOTE: no ON CONFLICT here. Conflict arbitration makes Postgres read the
    // existing row, which needs a SELECT policy the publishable plane must not
    // have — the duplicate is caught as a unique violation below instead.
    let estimate: unknown = null;
    let verdict: unknown = null;
    if (body.build !== undefined) {
      verdict = deriveVerdict(body.build);
      const slug = typeof body.collectionSlug === 'string' ? body.collectionSlug : '';
      if (slug) {
        const found = await client.query<{ id: string }>(
          'select id from public.collections where slug = $1 limit 1',
          [slug],
        );
        const collectionId = found.rows[0]?.id;
        if (collectionId) estimate = await priceBuild(client, collectionId, body.build);
      }
    }

    const inserted = await client.query(
      `insert into public.leads
         (id, org_id, brand_id, configuration_id, contact, note, estimate, verdict, dedupe_key, source)
       select $1,
              veta.api_org(),
              b.id,
              $2::uuid,
              $3::jsonb,
              $4,
              $5::jsonb,
              $6::jsonb,
              $7,
              $8::jsonb
         from public.brands b
        where b.org_id = veta.api_org()
        limit 1`,
      [
        id,
        configurationId,
        JSON.stringify(body.contact),
        typeof body.note === 'string' ? body.note : null,
        estimate === null ? null : JSON.stringify(estimate),
        verdict === null ? null : JSON.stringify(verdict),
        typeof body.dedupeKey === 'string' && body.dedupeKey ? body.dedupeKey : null,
        JSON.stringify(body.source ?? {}),
      ],
    );
    return { stored: (inserted.rowCount ?? 0) > 0, estimate, verdict };
  }).catch((err: unknown) => {
    // A repeated dedupe key inside its window is the same visitor, not an
    // error the widget must show. Anything else still surfaces.
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  });

  if (!result || !result.stored) {
    // The dedupe key already covered this visitor, or the tenant has no brand
    // row yet: both are "already handled" — a lead is never rejected outright.
    return c.json({ ok: true, deduped: true }, 200);
  }
  return c.json({ ok: true, id, estimate: result.estimate, verdict: result.verdict }, 201);
});
