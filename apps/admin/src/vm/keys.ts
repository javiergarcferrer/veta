/**
 * API KEYS — the view that CANNOT hold a credential.
 *
 * Migration 0001 already makes the hash unreadable on every plane (members read
 * `api_keys_public`, a view without it; writes go through security-definer
 * RPCs). This layer is the second wall, and it is a wall of TYPE: `AdminApiKey`
 * has no field a hash or a token could land in, and `redactKey` is an explicit
 * pick — it copies the eight fields it knows and drops everything else, so a
 * row that grows a `key_hash` column tomorrow cannot start flowing into the UI
 * because someone spread `...row` somewhere.
 *
 * The ONE exception is the issue RPC's reply: a secret exists exactly once, in
 * the response that created it. It is typed as `IssuedApiKey` — a DIFFERENT
 * type, deliberately not assignable to the list's element type — so it can be
 * shown and dropped, and cannot be stored in the list by accident.
 *
 * A revoked key is never deleted from the list. "Which key was that, and when
 * did we kill it" is the question an incident asks.
 */
import type { AdminApiKey, ApiKeyKind, IssuedApiKey } from './types.ts';

export type { AdminApiKey, IssuedApiKey };

export const API_KEY_KINDS: readonly ApiKeyKind[] = ['publishable', 'secret'];

/**
 * What each kind of key may be issued with. A publishable key ships in a page,
 * so it gets the write-only visitor scopes and NEVER `leads:read`; a secret key
 * is server-to-server and is the only thing that may read a lead back.
 */
export const SCOPES_BY_KIND: Record<ApiKeyKind, readonly string[]> = {
  publishable: ['catalog:read', 'configurations:write', 'leads:write', 'events:write'],
  secret: ['catalog:read', 'leads:read', 'leads:write'],
};

export const DEFAULT_SCOPES: Record<ApiKeyKind, readonly string[]> = {
  publishable: ['catalog:read', 'configurations:write', 'leads:write', 'events:write'],
  secret: ['catalog:read', 'leads:read'],
};

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * A stored row → the admin's view of it. An EXPLICIT PICK, never a spread:
 * whatever else the row carries (a hash, a plaintext token, an internal note)
 * stops here, by construction.
 */
export function redactKey(row: unknown): AdminApiKey | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = trim(r.id);
  if (!id) return null;
  const kind = r.kind === 'secret' ? 'secret' : 'publishable';
  const scopes = Array.isArray(r.scopes) ? r.scopes.map((s) => String(s)).filter(Boolean) : [];
  const origins = Array.isArray(r.allowedOrigins)
    ? r.allowedOrigins
    : Array.isArray(r.allowed_origins)
      ? r.allowed_origins
      : [];
  return {
    id,
    kind,
    // The prefix is the handle a human recognises (`pk_live_a1b2…`). If the row
    // carried a whole token instead, only the head of it survives — a full key
    // must not be reconstructible from a list nobody thought was sensitive.
    prefix: trim(r.prefix) || trim(r.token).slice(0, 12),
    scopes,
    allowedOrigins: origins.map((o) => String(o)).filter(Boolean),
    createdAt: ms(r.createdAt ?? r.created_at) ?? 0,
    lastUsedAt: ms(r.lastUsedAt ?? r.last_used_at),
    revokedAt: ms(r.revokedAt ?? r.revoked_at),
  };
}

export type KeyState = 'active' | 'revoked';

export interface KeyRow {
  key: AdminApiKey;
  state: KeyState;
  scopeLabel: string;
  originLabel: string;
  /** True when a publishable key accepts ANY origin — worth flagging, not
   *  blocking: an unrestricted pk is normal while a site is being built. */
  openOrigins: boolean;
}

export interface KeyListFilter {
  kind?: ApiKeyKind | 'all';
  includeRevoked?: boolean;
}

export function resolveKeyList(
  rows: readonly unknown[],
  filter: KeyListFilter = {},
): { rows: KeyRow[]; active: number; revoked: number } {
  const keys = rows.map(redactKey).filter((k): k is AdminApiKey => k !== null);
  const wanted = filter.kind && filter.kind !== 'all' ? filter.kind : null;

  const all = keys.map((key): KeyRow => ({
    key,
    state: key.revokedAt ? 'revoked' : 'active',
    scopeLabel: key.scopes.length ? key.scopes.join(', ') : 'no scopes',
    originLabel: key.allowedOrigins.length ? key.allowedOrigins.join(', ') : 'any origin',
    openOrigins: key.kind === 'publishable' && key.allowedOrigins.length === 0,
  }));

  const visible = all
    .filter((row) => (wanted ? row.key.kind === wanted : true))
    .filter((row) => (filter.includeRevoked === false ? row.state === 'active' : true))
    .sort((a, b) => b.key.createdAt - a.key.createdAt || a.key.id.localeCompare(b.key.id));

  return {
    rows: visible,
    active: all.filter((r) => r.state === 'active').length,
    revoked: all.filter((r) => r.state === 'revoked').length,
  };
}

/* --------------------------------- issuing --------------------------------- */

export interface IssueKeyDraft {
  kind: ApiKeyKind;
  scopes: string[];
  /** One origin per line, as the form collects them. */
  origins: string;
}

export interface IssueKeyRequest {
  kind: ApiKeyKind;
  scopes: string[];
  allowedOrigins: string[];
}

export interface IssueValidation {
  ok: boolean;
  errors: Record<string, string>;
  warnings: string[];
  value: IssueKeyRequest | null;
}

export function emptyIssueDraft(kind: ApiKeyKind = 'publishable'): IssueKeyDraft {
  return { kind, scopes: [...DEFAULT_SCOPES[kind]], origins: '' };
}

/** An origin is a scheme + host, no path — that is what the API compares. */
export function normalizeOrigin(raw: string): string | null {
  const text = trim(raw).replace(/\/+$/, '').toLowerCase();
  if (!text) return null;
  if (text === '*') return '*';
  return /^https?:\/\/[^/\s]+$/.test(text) ? text : null;
}

export function planIssueKey(draft: IssueKeyDraft): IssueValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  const kind: ApiKeyKind = draft.kind === 'secret' ? 'secret' : 'publishable';
  const allowed = SCOPES_BY_KIND[kind];
  const scopes = [...new Set((draft.scopes ?? []).map((s) => trim(s)).filter(Boolean))];
  const rejected = scopes.filter((s) => !allowed.includes(s));
  if (!scopes.length) errors.scopes = 'A key with no scope can do nothing — pick at least one.';
  else if (rejected.length) {
    // Not silently dropped: `leads:read` on a publishable key is someone
    // reaching for PII in a page, and they should be told no in words.
    errors.scopes = `A ${kind} key cannot carry ${rejected.join(', ')}.`;
  }

  const origins: string[] = [];
  const badLines: number[] = [];
  trim(draft.origins).split(/[\n,]+/).forEach((line, index) => {
    if (!trim(line)) return;
    const origin = normalizeOrigin(line);
    if (!origin) badLines.push(index + 1);
    else origins.push(origin);
  });
  if (badLines.length) errors.origins = `Line ${badLines.join(', ')}: an origin looks like https://shop.example.`;

  if (kind === 'publishable' && !origins.length) {
    warnings.push('This key will be accepted from any site until an origin list is set.');
  }
  if (kind === 'secret' && origins.length) {
    warnings.push('Origins are a browser guard; a secret key is used server-to-server.');
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    warnings,
    value: ok ? { kind, scopes, allowedOrigins: origins } : null,
  };
}

/**
 * What the UI is allowed to do with an issue RESULT: show the token once, and
 * hold on to nothing but the redacted key. The token is returned for display
 * and is deliberately not part of `AdminApiKey`.
 */
export function revealOnce(issued: IssuedApiKey): { token: string; key: AdminApiKey; notice: string } {
  return {
    token: issued.token,
    key: issued.key,
    notice: issued.key.kind === 'secret'
      ? 'Copy this secret now — it is stored only as a hash and can never be shown again.'
      : 'This publishable key ships in your page; it identifies the tenant and is not a secret.',
  };
}
