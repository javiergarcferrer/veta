/**
 * pCon.login OAuth 2 — the authorization half of the pCon route.
 *
 * pCon.login is an IDENTITY service, not a data service: nothing in its API
 * returns an article, a price or a mesh (its `manufacturer_catalogs` URL is a
 * web page for humans, and `get_package_groups` names update CHANNELS, not
 * products). What the token it issues is FOR is opening an EAIWS session —
 * `EaiwsSession.open(baseUrl, { userToken })` passes it straight through as
 * `-user-token`, and the Gatekeeper on the other side decides which
 * manufacturer catalogs that user may see. So this module exists to produce one
 * string, and `lib/pcon/eaiws.ts` spends it.
 *
 * ── THE CLIENT ID IS NOT SELF-SERVE ─────────────────────────────────────────
 * There is no registration endpoint. EasternGraphics issues a `client_id` (and,
 * for a confidential client, a secret) by email — until they do, every function
 * here builds a correct request that will be refused. That is why `PCON_CLIENT_ID`
 * is read, never defaulted: a placeholder id would fail at the redirect with an
 * opaque error instead of here, at the call site, with a message that names the
 * missing thing.
 *
 * ── PKCE IS MANDATORY ───────────────────────────────────────────────────────
 * The documented flow requires `code_challenge` / `code_challenge_method=S256`.
 * We generate the verifier with `crypto.getRandomValues` and hash it with
 * WebCrypto, both of which exist in the browser and in Node 18+, so this file
 * runs unmodified in the studio and in the sync script.
 *
 * ── WHERE THE SECRET LIVES ──────────────────────────────────────────────────
 * `exchangeCode` and `refresh` take an optional `basicAuth`. A browser must
 * NEVER pass one — a client secret in a bundle is a published secret. The
 * studio therefore runs the public-client flow (PKCE alone, no secret) and the
 * Node sync script runs the confidential one, reading the secret from its own
 * environment. Both call the same two functions; only the argument differs.
 *
 * Pure except for `fetch` and `crypto`: no React, no Supabase, no wcf. That is
 * what lets `tests/pconOauth.test.js` drive the whole flow with a stub fetch.
 */

/** Where pCon.login lives. Overridable only so a test can point it elsewhere. */
export const PCON_BASE_URL = 'https://login.pcon-solutions.com';

/**
 * The scopes this integration actually needs, and why each one.
 *
 *   query_account   the user/organization read. The docs call it "the most
 *                   common permission"; the Gatekeeper wants a token that can
 *                   answer who the session is for.
 *
 * DELIBERATELY ABSENT: `modify_account` (we never write to their pCon account),
 * `create_service_tokens` (EGR-internal clients only), and
 * `query_receivable_pud_update_channels` (the docs say it is unnecessary when
 * `query_account` is granted). The extended-authorization docs are explicit
 * that only the MINIMUM set should be requested, and a scope we cannot justify
 * here is one more thing for EGR to refuse at registration time.
 */
export const DEFAULT_SCOPES = Object.freeze(['query_account']);

/**
 * `create_longterm_token` — asked for ONLY by the unattended sync.
 *
 * A refresh token with "infinite life time" is what lets a nightly job run with
 * nobody at a keyboard. It is a separate constant, and not part of
 * DEFAULT_SCOPES, because the studio's interactive sign-in has no business
 * holding one: a token that never expires, minted in a browser, is a credential
 * that outlives the session that made it.
 */
export const LONGTERM_SCOPE = 'create_longterm_token';

export interface PconTokens {
  tokenType: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds. The docs return `expires_in`; callers turn it into a deadline. */
  expiresIn: number;
  scope: string;
}

export interface PkceChallenge {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** base64url — RFC 7636's alphabet: no padding, `-` and `_` for `+` and `/`. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE pair. The verifier is 32 random bytes (43 base64url chars, within
 * the 43–128 the RFC allows); the challenge is its SHA-256, which is what
 * `code_challenge_method=S256` means.
 */
export async function createPkce(): Promise<PkceChallenge> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' };
}

/** Random opaque `state`, the CSRF guard the docs recommend. */
export function createState(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return base64url(raw);
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  challenge: PkceChallenge;
  state: string;
  scopes?: readonly string[];
  baseUrl?: string;
}

/**
 * The URL to send the user to. Pure — it builds a string and nothing else, so a
 * test can assert every parameter without a browser.
 */
export function authorizeUrl(params: AuthorizeParams): string {
  const {
    clientId, redirectUri, challenge, state,
    scopes = DEFAULT_SCOPES, baseUrl = PCON_BASE_URL,
  } = params;
  if (!clientId) throw new Error('pCon: no client_id — EasternGraphics issues one by email (support@easterngraphics.com); it cannot be self-registered');
  if (!redirectUri) throw new Error('pCon: no redirect_uri');

  const url = new URL('/api/oauth2/authorize', baseUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge.challenge);
  url.searchParams.set('code_challenge_method', challenge.method);
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

/**
 * Read the redirect back. Returns the code, or throws with whatever pCon said —
 * an `error` in the query is the ONLY place a registration or scope problem is
 * ever explained, so it must not be swallowed into a generic failure.
 *
 * `expectedState` is compared in full; a mismatch is a failed request, not a
 * warning.
 */
export function readRedirect(search: string, expectedState: string): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const error = q.get('error');
  if (error) {
    const desc = q.get('error_description');
    throw new Error(`pCon authorize refused: ${error}${desc ? ` — ${desc}` : ''}`);
  }
  const state = q.get('state');
  if (!state || state !== expectedState) throw new Error('pCon authorize: state mismatch — the redirect does not belong to this request');
  const code = q.get('code');
  if (!code) throw new Error('pCon authorize: no code in redirect');
  return code;
}

/** `client_id:secret`, base64 — the Basic header the token endpoint wants. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  const b64 = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
  return `Basic ${b64}`;
}

/** What every token response decodes to; throws on the documented error shape. */
function readTokens(body: any): PconTokens {
  if (!body || typeof body !== 'object') throw new Error('pCon token: unreadable response');
  if (body.error) {
    throw new Error(`pCon token refused: ${body.error}${body.error_description ? ` — ${body.error_description}` : ''}`);
  }
  const accessToken = String(body.access_token || '');
  if (!accessToken) throw new Error('pCon token: response carried no access_token');
  return {
    tokenType: String(body.token_type || 'Bearer'),
    accessToken,
    refreshToken: String(body.refresh_token || ''),
    expiresIn: Number(body.expires_in) || 0,
    scope: String(body.scope || ''),
  };
}

/** The one effectful seam, injected so tests never touch the network. */
export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

async function postForm(
  baseUrl: string, path: string, form: Record<string, string>,
  basicAuth: string | null, doFetch: FetchLike,
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (basicAuth) headers.Authorization = basicAuth;
  const res = await doFetch(new URL(path, baseUrl).toString(), {
    method: 'POST', headers, body: new URLSearchParams(form).toString(),
  });
  // A 4xx still carries the OAuth error body, and that body is the only useful
  // diagnostic — so parse before deciding the call failed.
  const body = await res.json().catch(() => null);
  if (body && body.error) return body;
  if (!res.ok) throw new Error(`pCon token endpoint: HTTP ${res.status}`);
  return body;
}

export interface ExchangeParams {
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  /** Confidential clients only. A browser must not pass this. */
  basicAuth?: string | null;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** Authorization code → tokens. */
export async function exchangeCode(params: ExchangeParams): Promise<PconTokens> {
  const {
    clientId, code, redirectUri, verifier,
    basicAuth = null, baseUrl = PCON_BASE_URL,
    fetchImpl = fetch as unknown as FetchLike,
  } = params;
  return readTokens(await postForm(baseUrl, '/api/oauth2/request_token', {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, basicAuth, fetchImpl));
}

export interface RefreshParams {
  clientId: string;
  refreshToken: string;
  /** Must not widen: the docs forbid a scope the refresh token was not given. */
  scopes?: readonly string[];
  basicAuth?: string | null;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Refresh token → a fresh access token.
 *
 * A LONG-TERM refresh token never rotates (the docs are explicit), so the sync
 * script stores the one it was given once and re-spends it. An ordinary refresh
 * token MAY come back changed, which is why the caller gets the whole
 * PconTokens back and must persist `refreshToken` rather than assume it kept
 * the one it sent.
 */
export async function refresh(params: RefreshParams): Promise<PconTokens> {
  const {
    clientId, refreshToken, scopes,
    basicAuth = null, baseUrl = PCON_BASE_URL,
    fetchImpl = fetch as unknown as FetchLike,
  } = params;
  const form: Record<string, string> = {
    client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
  };
  if (scopes?.length) form.scope = scopes.join(' ');
  return readTokens(await postForm(baseUrl, '/api/oauth2/request_token', form, basicAuth, fetchImpl));
}

export interface RevokeParams {
  token: string;
  hint?: 'access_token' | 'refresh_token';
  clientId?: string;
  basicAuth?: string | null;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Hand a token back. Worth calling on sign-out: the docs note that revoking one
 * token may revoke its relatives, which is exactly what you want when a laptop
 * with a long-term token walks out of the building.
 */
export async function revoke(params: RevokeParams): Promise<void> {
  const {
    token, hint = 'refresh_token', basicAuth = null,
    baseUrl = PCON_BASE_URL, fetchImpl = fetch as unknown as FetchLike,
  } = params;
  await postForm(baseUrl, '/api/oauth2/revoke_token', {
    token, token_type_hint: hint,
  }, basicAuth, fetchImpl);
}
