// API-key plane authentication.
//
// The widget embeds a PUBLISHABLE key (`pk_live_…`) — tenant identity, not a
// secret, exactly like a pixel id: it ships in the page by design, so it is
// never treated as proof of anything but "which tenant". SECRET keys (`sk_…`)
// are server-to-server; only their sha256 is ever stored, and only the sha256
// ever reaches the database — the presented secret stays in this process.
//
// What this middleware establishes is the TENANT, not a user. Everything the
// resulting identity may see is then decided by RLS (see db.ts / migration
// 0001), which is why a scope bug here cannot become a cross-tenant read.

import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { withApiRole, type KeyKind } from './db.ts';

export interface ApiIdentity {
  keyId: string;
  orgId: string;
  kind: KeyKind;
  scopes: string[];
}

export interface ApiKeyRow {
  key_id: string;
  org_id: string;
  kind: KeyKind;
  scopes: string[];
  allowed_origins: string[];
  revoked_at: Date | null;
  org_status: string;
}

export type AuthEnv = { Variables: { identity: ApiIdentity } };

export function keyKindOf(token: string): KeyKind | null {
  if (token.startsWith('pk_')) return 'publishable';
  if (token.startsWith('sk_')) return 'secret';
  return null;
}

/** What the database is asked to match: the pk verbatim, an sk only as a digest. */
export function lookupValueFor(token: string, kind: KeyKind): string {
  return kind === 'publishable' ? token : createHash('sha256').update(token, 'utf8').digest('hex');
}

export function extractKey(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (m?.[1]) return m[1];
  }
  return c.req.header('x-veta-key')?.trim() || null;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * An empty allowlist means "not restricted" (a key can be locked down after
 * issue). A NON-empty allowlist is strict: a request with no Origin header
 * fails it, which is the entire point of pinning a browser key to a site.
 */
export function originAllowed(origin: string | null | undefined, allowed: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  const got = normalizeOrigin(origin);
  return allowed.some((entry) => normalizeOrigin(entry) === got);
}

export async function resolveApiKey(token: string): Promise<ApiKeyRow | null> {
  const kind = keyKindOf(token);
  if (!kind) return null;
  const lookup = lookupValueFor(token, kind);
  const rows = await withApiRole(async (c) => {
    const r = await c.query<ApiKeyRow>('select * from veta.resolve_api_key($1, $2)', [kind, lookup]);
    return r.rows;
  });
  return rows[0] ?? null;
}

export const apiKeyAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = extractKey(c);
  if (!token) return c.json({ error: 'missing_api_key' }, 401);
  if (!keyKindOf(token)) return c.json({ error: 'invalid_api_key' }, 401);

  const row = await resolveApiKey(token);
  if (!row) return c.json({ error: 'invalid_api_key' }, 401);
  // Revocation fails closed at the door — before any tenant transaction opens.
  if (row.revoked_at) return c.json({ error: 'key_revoked' }, 401);
  if (row.org_status !== 'active') return c.json({ error: 'org_suspended' }, 403);
  if (row.kind === 'publishable' && !originAllowed(c.req.header('origin'), row.allowed_origins)) {
    return c.json({ error: 'origin_not_allowed' }, 403);
  }

  c.set('identity', {
    keyId: row.key_id,
    orgId: row.org_id,
    kind: row.kind,
    scopes: row.scopes ?? [],
  });
  await next();
};

/** Scopes are a second, coarser gate on top of RLS — absent means denied. */
export function requireScope(scope: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const identity = c.get('identity');
    if (!identity) return c.json({ error: 'unauthenticated' }, 401);
    if (!identity.scopes.includes(scope) && !identity.scopes.includes('*')) {
      return c.json({ error: 'missing_scope', scope }, 403);
    }
    await next();
  };
}
