/**
 * The `brands` row — a MANUFACTURER's whole environment in one record.
 *
 * It lives beside the data layer rather than in `types/domain.ts` because the
 * brand IS the data layer's partition key: `brandScope.ts` reads it, every
 * scoped query is filtered by its `id`, and every scoped write is stamped with
 * it. Anything above (the admin page, the studio) takes it as a plain row.
 *
 * `modules` is the import-module selection resolved by `src/brands/modules`:
 * `{ set, geometry, materials, catalog }`, all optional, all falling back to the
 * Ligne Roset set — see that registry for why an unknown id degrades instead of
 * failing.
 */
export interface BrandBranding {
  logoUrl?: string | null;
  primaryColor?: string | null;
}

export interface BrandModules {
  /** A registered module-set id ('ligne-roset' | 'generic'). */
  set?: string | null;
  /** Per-slot overrides — a brand may mix one set's reader with another's. */
  geometry?: string | null;
  materials?: string | null;
  catalog?: string | null;
}

export interface BrandSettings {
  /** `products.brand` this environment's price list lives under. null = the
   *  brand has no catalog yet, and its catalog reads answer EMPTY. */
  catalogBrand?: string | null;
  [key: string]: unknown;
}

export interface Brand {
  id: string;
  slug: string;
  name: string;
  locale: string;
  currency: string;
  active: boolean;
  branding?: BrandBranding | null;
  modules?: BrandModules | null;
  settings?: BrandSettings | null;
  createdAt?: number;
  updatedAt?: number;
}
