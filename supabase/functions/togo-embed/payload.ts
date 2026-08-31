// togo-embed/payload.ts — WHAT LEAVES THIS FUNCTION, and how it may be cached.
// Pure like dealer.ts (no Deno globals, no URL imports, no supabase client), so
// `node --import tsx` imports it straight across the Deno↔Vite wall and pins
// both rules in tests/configuratorDealer.test.js.
//
// Two projections + one policy, together because they answer the same question —
// what bytes go out, to whom, and for how long:
//
//   • catalogModelShape — the PUBLIC per-model entry (buildCatalog). It carries
//     NO `svg`. The CAD outline is ~1 KB of path data per model and, at 605
//     models, HALF the catalog payload every visitor downloads (589 KB of 1.16
//     MB, measured 2026-08-01) — for a field exactly ONE surface reads: the
//     plan → DXF export, over the handful of pieces actually placed. The plan
//     tile and the 3D both derive from the MESH (useMeshPlans → meshToPlan),
//     and 604 of 605 models carry one, so the stored outline never renders. It
//     is fetched on demand instead (`GET ?svg=<ids>` → parseSvgIds).
//   • inboxModelShape — the PRIVATE, token-gated lead inbox entry (loadInbox).
//     It KEEPS `svg`: DealerInbox renders that outline directly
//     (dangerouslySetInnerHTML) as the lead's plan, and it has no mesh pipeline
//     to derive one from.
//   • cacheHeadersFor — public branches (catalog, svg) are shared-cacheable with
//     an ETag; the token-gated inbox and every POST are `no-store`. A shared
//     `public` header on the inbox would let a CDN hand one dealer's leads to
//     the next caller — so an UNKNOWN branch falls to no-store, never the other
//     way round.
//
// Plus the one rule about what comes IN, since it decides whether any of the
// above is even complete: readAllPages — a PostgREST read is only finished when
// a SHORT page says so (see its doc).

import { baseProductFor, familyFor, PART_ROLES, partCount } from './dealer.ts';

type Row = Record<string, unknown>;

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* ------------------------------ the catalog model ------------------------------ */

export interface CatalogShapeContext {
  products: Row[];
  /** list USD → retail USD (the dealer's default margin baked in). */
  retail: (n: number) => number;
  /** family root → the fabric keys that root is offered in (model_fabrics). */
  offeredByRoot: Map<string, string[]>;
  /** The brand's grade ladder (`brands.ladder`, resolved by index.ts). Passed
   *  rather than read: this module and dealer.ts are pure. */
  ladder: ReadonlySet<string>;
}

/**
 * One `togo_models` row → the public catalog entry the widget renders.
 *
 * Deliberately WITHOUT `svg` (see the file header). Everything else is the shape
 * the configurator has always consumed; the per-dealer helpers (applyDealerPricing
 * / applyPricingMode) then re-price this object in place of the raw catalog.
 */
export function catalogModelShape(m: Row, ctx: CatalogShapeContext) {
  const { products, retail, offeredByRoot, ladder } = ctx;
  const root = (m.product_root as string | null) || null;
  const base = baseProductFor(root, products);
  const list = base ? num(base.price_usd) : null;
  const family = familyFor(root, products, retail, ladder);
  // Tagged parts (shared cushion/bolster SKUs): each non-base role with
  // billed units + a bound root ships its OWN retail-priced family. The
  // model's priceUsd stays BASE-only — the client folds parts in at render
  // (placementTotalUsd), so shipping them here too would double-count.
  const parts = (m.parts ?? null) as Row | null;
  const partRoots = (parts?.roots ?? null) as Row | null;
  let partFamilies: Record<string, unknown> | null = null;
  if (partRoots) {
    for (const role of PART_ROLES) {
      if (role === 'base') continue;
      const count = partCount(parts, role);
      const pRoot = partRoots[role] ? String(partRoots[role]) : null;
      if (!count || !pRoot) continue;
      const fam = familyFor(pRoot, products, retail, ladder);
      if (fam) (partFamilies ??= {})[role] = fam;
    }
  }
  return {
    id: m.id,
    name: m.name,
    // Modular family the piece belongs to (Togo, Prado, …); the public
    // configurator's collection picker groups by this. Null (legacy rows) ⇒
    // 'Togo'. Raw snake_case row, but the column is the same word either case.
    collection: (m.collection as string | null) || 'Togo',
    widthCm: num(m.width_cm),
    depthCm: num(m.depth_cm),
    priceUsd: list != null ? retail(list) : null,
    bound: !!base,
    root,
    family,                                                  // { root, name, graded, grades, byGrade } | null
    // Per-part editing: the dealer's tagging + each role's own priced family.
    parts: parts || null,
    partFamilies,
    // Default spawn rotation (deg, clockwise) — a corner piece drops
    // pre-turned so its open face meets the run, not its backrest.
    defaultRot: Number(m.default_rot) || 0,
    mount: (m.mount as string | null) || null,
    mountHeightCm: m.mount_height_cm == null ? null : num(m.mount_height_cm),
    offeredFabricKeys: root ? (offeredByRoot.get(root) || []) : [],
    // Real 3D model (a dealer-uploaded mesh in the public togo-models bucket);
    // null ⇒ the configurator draws the procedural Togo.
    mesh: m.mesh_url
      ? { url: String(m.mesh_url), scale: Number(m.mesh_scale) || null, upAxis: (m.mesh_up_axis as string) || 'y', rotateY: Number(m.mesh_rotate_y) || 0 }
      : null,
    // THE BAKED PICTURE, and the store key it was baked under. With them the
    // widget's piece list is plain <img>s and the three bundle + this piece's
    // mesh are never fetched to draw a tile nobody has selected yet; the client
    // re-derives that key from the very fields above and only trusts the image
    // when the two agree, so a piece edited since the bake renders live instead
    // of showing an old photo. Shipped raw — the freshness rule has ONE home,
    // client-side (`bakedThumbUrl`), rather than a second copy over here.
    thumbUrl: m.thumb_url ? String(m.thumb_url) : null,
    thumbStamp: m.thumb_stamp ? String(m.thumb_stamp) : null,
    heroThumbUrl: m.hero_thumb_url ? String(m.hero_thumb_url) : null,
    heroThumbStamp: m.hero_thumb_stamp ? String(m.hero_thumb_stamp) : null,
  };
}

/* ------------------------------- the inbox model ------------------------------- */

/**
 * One `togo_models` row → the entry the token-gated dealer inbox draws a lead
 * from. KEEPS `svg` (null when absent): DealerInbox renders it as the plan.
 */
export function inboxModelShape(m: Row) {
  return {
    name: String(m.name || ''),
    // Legacy rows (null) file under Togo — same rule as the configurator payload;
    // carried so the inbox 3D snapshot applies the collection-correct seam bleed.
    collection: (m.collection as string | null) || 'Togo',
    widthCm: num(m.width_cm),
    depthCm: num(m.depth_cm),
    svg: m.svg ? String(m.svg) : null,
    // Part tagging + seat mount ride so the inbox 3D snapshot upholsters parts
    // and floats loose cushions exactly like the widget did.
    parts: (m.parts ?? null) as Row | null,
    mount: (m.mount as string | null) || null,
    mountHeightCm: m.mount_height_cm == null ? null : num(m.mount_height_cm),
    mesh: m.mesh_url
      ? { url: String(m.mesh_url), scale: Number(m.mesh_scale) || null, upAxis: (m.mesh_up_axis as string) || 'y', rotateY: Number(m.mesh_rotate_y) || 0 }
      : null,
  };
}

/* --------------------------- the on-demand svg request --------------------------- */

/** How many outlines one `?svg=` call may ask for. A plan is a handful of
 *  pieces; the cap is what keeps a public, unauthenticated endpoint from being
 *  asked to serialize the whole 605-model outline library in one request. */
export const SVG_IDS_MAX = 40;

/**
 * `?svg=<id,id,…>` → the sanitized, deduped, bounded id list.
 *
 * Model ids are app-generated (`newId()`: a uuid, or base36 on the legacy path),
 * so anything outside `[A-Za-z0-9_-]` is not an id and is dropped rather than
 * reaching PostgREST. Deduped BEFORE the cap, so 40 means 40 distinct models.
 */
export function parseSvgIds(raw: unknown, max = SVG_IDS_MAX): string[] {
  const seen = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
  return [...new Set(seen)].slice(0, Math.max(0, max));
}

/* --------------------------------- cache policy --------------------------------- */

export type PayloadBranch = 'catalog' | 'svg' | 'inbox' | 'post';

/** Shared-cacheable, but briefly: a catalogue edit (a price, a new piece) must
 *  reach the storefront in a minute, and the stale-while-revalidate window then
 *  serves the old bytes instantly while the refresh happens behind it. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

/** The token-gated inbox and every write. `no-store` is EXPLICIT, never
 *  defaulted: a shared cache holding one dealer's leads under a URL another
 *  caller can reach is a disclosure bug, not a performance regression. */
export const PRIVATE_CACHE_CONTROL = 'no-store';

/**
 * The cache headers a branch's response may carry. `etag` is honoured on the
 * public branches only (there is nothing to revalidate against on a no-store
 * answer). An UNKNOWN branch falls to no-store — new surfaces are private until
 * someone deliberately makes them public.
 */
export function cacheHeadersFor(branch: PayloadBranch | string, etag?: string | null): Record<string, string> {
  if (branch === 'catalog' || branch === 'svg') {
    return { 'Cache-Control': PUBLIC_CACHE_CONTROL, ...(etag ? { ETag: etag } : {}) };
  }
  return { 'Cache-Control': PRIVATE_CACHE_CONTROL };
}

/**
 * The response body's CONTENT hash, as a strong ETag.
 *
 * A content hash by design: `materials` has no `updated_at`, so a
 * max-updated_at key would happily serve a stale fabric book after a colour
 * edit. Hashing what we are about to send can't drift from it.
 */
export async function etagOf(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(body ?? ''));
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return `"${hex}"`;
}

/**
 * Does the client's `If-None-Match` cover our ETag? WEAK comparison (RFC 7232
 * §2.3.2 — the right one for a conditional GET): a CDN that gzips our answer may
 * hand the tag back weakened to `W/"…"`, and a strong comparison would then miss
 * every revalidation and re-send the whole payload. `*` matches anything we have.
 */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  const h = String(header ?? '').trim();
  if (!h || !etag) return false;
  if (h === '*') return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const mine = bare(etag);
  return h.split(',').some((tag) => bare(tag) === mine);
}

/* ------------------------------ reading it all ------------------------------ */

/* `readAllPages` now lives in `_shared/` — sixteen reads across nine functions
   needed the same drain (the bounded-reads sweep, 2026-08-22), and a second
   copy is how one rule becomes two. Re-exported here so this module's callers
   and its pin (tests/configuratorDealer.test.js:1089) keep importing it from where it
   was written. */
export { READ_PAGE, readAllPages } from '../_shared/readAllPages.ts';
export type { PageResult } from '../_shared/readAllPages.ts';
