// LEADS on the API-key plane.
//
// THE LAW, carried over verbatim: a lead is NEVER rejected for being a bad
// configuration. A violating build is stored FLAGGED (its server-derived verdict
// rides the row and surfaces to the dealer as "configuración con avisos");
// losing a marketing signal is survivable, losing the lead is not. The strict
// save gate lives on configurations and stops there.
//
// The estimate and verdict are server-derived exactly as on a save — a payload
// that asserts a price or `ok:true` contributes nothing but noise — and the org
// and brand are resolved INSIDE the statement from `veta.api_org()`, so no body
// field can point the row at another tenant.
//
// Reads are the OTHER plane: `GET /v1/leads` is secret-key only. There is no
// publishable policy on this table, so the pk plane would read nothing anyway;
// the explicit refusal here is so a widget author gets an answer instead of an
// empty list they might mistake for "no leads yet".

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { buildTooLarge, modelIdsOf, piecesOf, UUID_RE } from '../build.ts';
import { loadCollectionById, loadCollectionBySlug, loadCollectionContext } from '../context.ts';
import { priceBuild } from '../pricing.ts';
import { deriveVerdict } from '../verdict.ts';
import type { PricingSnapshot } from '../pricing.ts';
import type { StoredVerdict } from '../verdict.ts';

interface LeadBody {
  contact?: Record<string, unknown>;
  note?: string;
  collectionSlug?: string;
  collectionId?: string;
  build?: unknown;
  configurationId?: string;
  dedupeKey?: string;
  source?: Record<string, unknown>;
}

const LEAD_STATUSES = new Set(['pending', 'contacted', 'converted', 'dismissed']);
const MAX_LEADS_PAGE = 100;

export const leadRoutes = new Hono<AuthEnv>()
  .post('/', requireScope('leads:write'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as LeadBody;
    if (!body.contact || typeof body.contact !== 'object') {
      return c.json({ error: 'contact_required' }, 400);
    }
    if (buildTooLarge(body.build)) return c.json({ error: 'build_too_large' }, 413);

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
      let estimate: PricingSnapshot | null = null;
      let verdict: StoredVerdict | null = null;
      if (body.build !== undefined) {
        const slug = typeof body.collectionSlug === 'string' ? body.collectionSlug.trim() : '';
        const collectionId =
          typeof body.collectionId === 'string' && UUID_RE.test(body.collectionId) ? body.collectionId : '';
        const collection = collectionId
          ? await loadCollectionById(client, collectionId)
          : slug
            ? await loadCollectionBySlug(client, slug)
            : null;
        // A lead whose collection we cannot resolve is still a lead: it is
        // judged by the engine alone (the COUNT_MAX cap) and priced at nothing.
        const ctx = collection
          ? await loadCollectionContext(client, collection, { modelIds: modelIdsOf(piecesOf(body.build)) })
          : null;
        verdict = deriveVerdict(body.build, ctx);
        if (ctx) estimate = priceBuild(body.build, ctx);
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
  })

  .get('/', requireScope('leads:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    if (kind !== 'secret') return c.json({ error: 'secret_key_required' }, 403);

    const limitRaw = Number(c.req.query('limit') ?? MAX_LEADS_PAGE);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LEADS_PAGE) : MAX_LEADS_PAGE;
    const offsetRaw = Number(c.req.query('offset') ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const statusRaw = (c.req.query('status') ?? '').trim();
    const status = LEAD_STATUSES.has(statusRaw) ? statusRaw : null;

    const leads = await withTenant(orgId, kind, async (client) => {
      const r = await client.query(
        `select id, brand_id, dealer_id, configuration_id, contact, note, estimate, verdict,
                dedupe_key, status, source, created_at, updated_at
           from public.leads
          where ($1::text is null or status = $1)
          order by created_at desc
          limit $2 offset $3`,
        [status, limit, offset],
      );
      return r.rows;
    });
    return c.json({ leads, limit, offset });
  });
