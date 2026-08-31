/**
 * THE BRAND SCOPE — how a brand microenvironment reaches every read and write.
 *
 * A brand is an ISOLATED ENVIRONMENT: its models, materials, fabric links,
 * dealers and leads are its own, and opening a brand must never show another
 * brand's rows. The naive way to enforce that is to add `.where('brandId')` to
 * every call site — which is precisely how one gets missed, and a missed one
 * doesn't fail loudly: it quietly shows the wrong manufacturer's catalog.
 *
 * So the scope lives HERE, one level below the call sites, and the Dexie-shaped
 * query layer applies it structurally:
 *
 *   • READS  every query against a brand-scoped table gains the brand filter,
 *            UNLESS the caller already filtered that field itself (an explicit
 *            `.where('brandId')` is a deliberate cross-brand read — the brand
 *            admin's per-brand counts are exactly that).
 *   • WRITES every `put`/`bulkPut` into a brand-scoped table is STAMPED with the
 *            active brand when the row doesn't carry one, so a model imported
 *            in brand B can never land in brand A.
 *
 * TWO KINDS OF SCOPE, because the two halves of a brand's data are keyed
 * differently:
 *
 *   brand_id      the five environment tables the migration added the column to.
 *   products.brand  the price list, which already discriminated by its own
 *                 `brand` column long before brands existed (27k rows carry
 *                 'ligne-roset'). A brand points at one through
 *                 `settings.catalogBrand`; a brand that points at NOTHING has no
 *                 catalog yet, and its reads answer EMPTY rather than falling
 *                 through to every brand's SKUs — an honest empty state, never
 *                 another manufacturer's prices.
 *
 * DEPLOY WINDOW: the scope is only ever set by the app once it has actually read
 * the `brands` table (AppContext). Before the migration lands there are no
 * brands to read, the scope stays null, and every query behaves exactly as it
 * did before this feature existed.
 */

export interface BrandScope {
  /** `brands.id` — the environment tables' key. */
  brandId: string;
  /** `products.brand` this environment's catalog lives under; null = none yet. */
  catalogBrand: string | null;
}

/**
 * What a table's read/write must do under the active scope.
 *   filter → add (or stamp) this field
 *   empty  → this brand owns nothing in this table; the read answers [] without
 *            a round-trip
 *   null   → unscoped (no active brand, or a table brands don't partition)
 */
export type TableScope =
  | { kind: 'filter'; field: string; value: string }
  | { kind: 'empty' }
  | null;

/** The five tables the brands migration added `brand_id` to. */
export const BRAND_ID_TABLES: ReadonlySet<string> = new Set([
  'configuratorModels', 'materials', 'modelFabrics', 'dealers', 'configuratorRequests',
]);

/** Tables partitioned by the catalog discriminator instead. */
export const CATALOG_BRAND_TABLES: ReadonlySet<string> = new Set(['products']);

let current: BrandScope | null = null;
const listeners = new Set<(scope: BrandScope | null) => void>();

/** Install (or clear) the active brand. Returns true when it actually changed —
 *  the caller invalidates the query caches on a change and nothing on a no-op. */
export function setBrandScope(next: BrandScope | null): boolean {
  const same = (current?.brandId ?? null) === (next?.brandId ?? null)
    && (current?.catalogBrand ?? null) === (next?.catalogBrand ?? null);
  if (same) return false;
  current = next ? { brandId: next.brandId, catalogBrand: next.catalogBrand ?? null } : null;
  for (const cb of [...listeners]) {
    try { cb(current); } catch (e) { console.error(e); }
  }
  return true;
}

export function getBrandScope(): BrandScope | null {
  return current;
}

/** The active brand's id, or '' — the cache-key ingredient every layer that
 *  memoizes a result set must fold in, or a brand switch would repaint the
 *  previous brand's rows from cache. */
export function brandScopeKey(): string {
  return current?.brandId || '';
}

export function subscribeBrandScope(cb: (scope: BrandScope | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** What the query layer must do for one table under the active scope. */
export function tableScopeFor(table: string): TableScope {
  if (!current) return null;
  if (BRAND_ID_TABLES.has(table)) return { kind: 'filter', field: 'brandId', value: current.brandId };
  if (CATALOG_BRAND_TABLES.has(table)) {
    return current.catalogBrand
      ? { kind: 'filter', field: 'brand', value: current.catalogBrand }
      : { kind: 'empty' };
  }
  return null;
}

/**
 * The fields a row written into `table` must carry. Returns null when nothing
 * needs stamping. A row that ALREADY names its brand is left alone — an import
 * that deliberately writes into another environment (the brand admin's own
 * cross-brand tools) stays possible.
 */
export function brandStampFor(table: string, row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const scope = tableScopeFor(table);
  if (!scope || scope.kind !== 'filter') return null;
  if (row && row[scope.field] != null && row[scope.field] !== '') return null;
  return { [scope.field]: scope.value };
}

/** The catalog discriminator a product-catalog helper should default to. */
export function catalogBrandScope(): string | undefined {
  return current?.catalogBrand || undefined;
}
