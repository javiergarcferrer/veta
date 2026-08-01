// EVENT INGEST — append-only, by absence of any other verb.
//
// `events` has no UPDATE and no DELETE policy on any request plane, and the API
// role holds no such privilege either, so "append-only" is a property of the
// database rather than a promise made by this file. All this route does is admit
// a bounded batch and let the insert's WITH CHECK bind the org.
//
// A batch is capped because an analytics beacon is exactly the surface someone
// points a loop at; beyond the cap the request is refused rather than truncated,
// so a client can tell the difference between "sent" and "dropped".

import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';

export const MAX_EVENT_BATCH = 100;
const MAX_KIND = 64;
const MAX_SESSION = 128;

interface EventInput {
  kind?: unknown;
  sessionId?: unknown;
  occurredAt?: unknown;
  payload?: unknown;
}

interface EventRow {
  kind: string;
  sessionId: string | null;
  occurredAt: Date | null;
  payload: Record<string, unknown>;
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * One event, or nothing. A row without a `kind` names no event — it would land
 * as an untyped blob nobody can query later, so it is dropped rather than
 * stored. A junk timestamp falls back to the server's own clock (`now()`), which
 * is also what a missing one does.
 */
export function normalizeEvent(raw: unknown): EventRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as EventInput;
  const kind = text(input.kind, MAX_KIND);
  if (!kind) return null;
  const session = text(input.sessionId, MAX_SESSION);
  let occurredAt: Date | null = null;
  if (input.occurredAt !== undefined && input.occurredAt !== null) {
    const stamp = new Date(input.occurredAt as string | number);
    if (!Number.isNaN(stamp.getTime())) occurredAt = stamp;
  }
  const payload =
    input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  return { kind, sessionId: session || null, occurredAt, payload };
}

/** The batch a body carries: `{events:[…]}`, `[…]`, or one bare event. */
export function eventsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const batch = (body as { events?: unknown } | null)?.events;
  if (Array.isArray(batch)) return batch;
  return body && typeof body === 'object' ? [body] : [];
}

export const eventRoutes = new Hono<AuthEnv>().post('/', requireScope('events:write'), async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  const raw = eventsOf(body);
  if (!raw.length) return c.json({ error: 'events_required' }, 400);
  if (raw.length > MAX_EVENT_BATCH) {
    return c.json({ error: 'batch_too_large', max: MAX_EVENT_BATCH }, 413);
  }

  const rows = raw.map(normalizeEvent).filter((row): row is EventRow => row !== null);
  if (!rows.length) return c.json({ error: 'events_required' }, 400);

  const { orgId, kind } = c.get('identity');
  await withTenant(orgId, kind, async (client) => {
    // One statement for the batch: the org is bound by the policy's WITH CHECK,
    // and `coalesce(occurred_at, now())` keeps a missing stamp honest.
    const values: string[] = [];
    const params: unknown[] = [];
    for (const row of rows) {
      const at = params.push(row.occurredAt);
      const session = params.push(row.sessionId);
      const kindIdx = params.push(row.kind);
      const payload = params.push(JSON.stringify(row.payload));
      values.push(
        `(veta.api_org(), coalesce($${at}::timestamptz, now()), $${session}, $${kindIdx}, $${payload}::jsonb)`,
      );
    }
    await client.query(
      `insert into public.events (org_id, occurred_at, session_id, kind, payload) values ${values.join(', ')}`,
      params,
    );
  });

  return c.json({ ok: true, accepted: rows.length, dropped: raw.length - rows.length }, 202);
});
