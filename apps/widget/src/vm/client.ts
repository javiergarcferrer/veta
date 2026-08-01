/**
 * THE API CLIENT — the widget's only door to the platform.
 *
 * `fetch` is injected (defaulting to the ambient one) so every branch below is
 * unit-tested against a stub instead of a network. Three rules:
 *
 *   • the PUBLISHABLE key rides as `Authorization: Bearer pk_…`. It is tenant
 *     identity, not a secret (it ships in the page like a pixel id), so nothing
 *     here treats it as proof of anything but "which brand";
 *   • ONE bootstrap read. `GET /v1/catalog` returns the whole tenant catalogue
 *     — collections, models (priced for this dealer), materials, rulesets — in
 *     a single payload, because the catalog round-trip is the first thing the
 *     visitor waits on and a per-collection waterfall doubles it;
 *   • money crosses the wire in MINOR units with its currency; the projection
 *     (`vm/catalog`) converts once, at that boundary.
 *
 * A LEAD IS NEVER LOST: `submitLead` reports failure to the caller, which keeps
 * the visitor's typed contact on screen to retry — the one payload in this file
 * whose loss is not survivable. The lead's estimate and verdict are derived
 * SERVER-side; nothing here asserts either.
 */

/** The slice of `fetch` this module uses. */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: any;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Money on the wire: an integer in the currency's minor units. */
export interface MoneyView {
  amountMinor: number;
  currency: string;
}

export interface FamilyView {
  root: string;
  graded: boolean;
  grades: string[];
  byGrade: Record<string, { amountMinor: number; currency: string; reference: string }>;
}

export interface CollectionView {
  id: string;
  slug: string;
  name: string;
  status: string;
  renderParams: Record<string, unknown>;
  taxonomy: Record<string, unknown>;
  sortOrder: number;
}

export interface ModelView {
  id: string;
  collectionId: string;
  slug: string;
  name: string;
  status: string;
  tags: string[];
  widthCm: number;
  depthCm: number;
  heightCm: number | null;
  meshPath: string | null;
  meshParams: Record<string, unknown>;
  mount: 'seat' | null;
  defaultRot: number;
  sku: string | null;
  sortOrder: number;
  price: MoneyView | null;
  family: FamilyView | null;
  partFamilies: Record<string, FamilyView | null> | null;
}

export interface MaterialView {
  id: string;
  name: string;
  category: string | null;
  sourceAdapter: string;
  params: Record<string, unknown>;
  colors: Array<{
    id: string;
    name: string;
    code: string;
    grade: string;
    rgb: string | null;
    texturePath: string | null;
    normalPath: string | null;
    sortOrder: number;
  }>;
}

export interface RulesetView {
  collectionId: string;
  version: number;
  status: string;
  rules: unknown;
}

/** What the dealer's pricing presentation was — ALREADY APPLIED server-side.
 *  The widget reads `mode` to decide whether to show money at all, and must
 *  never re-apply the multiplier (that would mark the catalogue up twice). */
export interface DealerView {
  slug: string | null;
  mode: string;
  multiplier: number;
}

export interface CatalogPayload {
  currency: string;
  dealer: DealerView;
  collections: CollectionView[];
  models: ModelView[];
  materials: MaterialView[];
  rulesets: RulesetView[];
  partRoles: Array<{ key: string; label: Record<string, unknown>; billing: string; sortOrder: number }>;
}

export interface LeadBody {
  contact: { name?: string; phone?: string; email?: string };
  note?: string;
  collectionSlug?: string;
  build?: unknown;
  dedupeKey?: string;
  source?: Record<string, unknown>;
}

export interface LeadResult {
  ok: boolean;
  id?: string | null;
  deduped?: boolean;
  estimate?: unknown;
  verdict?: unknown;
}

export interface ApiClientOptions {
  apiBase: string;
  publishableKey: string;
  /** A dealer slug, when the embed serves one of the brand's dealers. */
  dealer?: string | null;
  fetch?: FetchLike | null;
  /** Aborts every request (the app's unmount signal). */
  signal?: any;
}

export interface ApiClient {
  readonly apiBase: string;
  /** The whole tenant catalogue, priced for this embed's dealer. */
  catalog(): Promise<CatalogPayload>;
  submitLead(body: LeadBody): Promise<LeadResult>;
}

const trimBase = (base: string): string => String(base ?? '').trim().replace(/\/+$/, '');

const ambientFetch = (): FetchLike | null => {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f.bind(globalThis) as FetchLike) : null;
};

const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const base = trimBase(opts.apiBase);
  const doFetch = opts.fetch ?? ambientFetch();
  const dealer = String(opts.dealer ?? '').trim();

  async function request(path: string, init?: { method?: string; body?: unknown }): Promise<{ ok: boolean; status: number; body: any }> {
    if (!doFetch) throw new ApiError('no fetch available', 0, 'no_fetch');
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${opts.publishableKey}`,
    };
    if (init?.body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: opts.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  return {
    apiBase: base,

    async catalog() {
      const path = `/v1/catalog${dealer ? `?dealer=${encodeURIComponent(dealer)}` : ''}`;
      const { ok, status, body } = await request(path);
      if (!ok) throw new ApiError(String(body?.error ?? `HTTP ${status}`), status, String(body?.error ?? ''));
      // Every list is normalized here so no consumer has to guard: a tenant
      // with no materials or no rulesets is ordinary, not exceptional.
      return {
        currency: String(body?.currency ?? 'USD').toUpperCase(),
        dealer: {
          slug: body?.dealer?.slug ?? null,
          mode: String(body?.dealer?.mode ?? 'full'),
          multiplier: Number(body?.dealer?.multiplier ?? 1) || 1,
        },
        collections: array<CollectionView>(body?.collections),
        models: array<ModelView>(body?.models),
        materials: array<MaterialView>(body?.materials),
        rulesets: array<RulesetView>(body?.rulesets),
        partRoles: array<CatalogPayload['partRoles'][number]>(body?.partRoles),
      };
    },

    async submitLead(body) {
      const { ok, status, body: res } = await request('/v1/leads', { method: 'POST', body });
      if (!ok || res?.ok !== true) {
        throw new ApiError(String(res?.error ?? `HTTP ${status}`), status, String(res?.error ?? ''));
      }
      return { ok: true, id: res.id ?? null, deduped: !!res.deduped, estimate: res.estimate, verdict: res.verdict };
    },
  };
}
