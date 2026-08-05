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

/**
 * WHO may open which brand — one row per (user, brand) grant.
 *
 * This is the table the DATABASE reads to decide what anyone may see: the RLS
 * policies on every scoped table resolve their visible-brand set through it
 * (`veta_visible_brand_ids()`), so it is a security boundary, not a preference.
 * `brandScope.ts` still filters in the browser — that is what keeps the UI
 * coherent and the queries cheap — but it is now the convenience layer over a
 * wall, rather than the wall itself.
 *
 * Membership only matters for a profile whose `brandAccess` is 'assigned'; an
 * 'all' profile (every user on this install today) sees every brand regardless,
 * which is why adding this changed nothing for anyone already signed in.
 *
 * A user may READ its own rows — that is how the switcher knows which brands to
 * offer. Only a whole-install user may WRITE them: a tenant granting itself
 * another brand is the one escalation that would void the whole scheme, so the
 * policy refuses it and `tests/brandIsolation.test.js` proves the refusal.
 */
export interface BrandMember {
  profileId: string;
  brandId: string;
  /** Reserved for a per-brand role (a brand's own admin vs its viewer). No
   *  policy reads it yet — membership alone is what grants sight today. */
  role?: string;
  createdAt?: number;
}
