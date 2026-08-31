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
  /** Fabricante (aislamiento) o casa de materiales (distribucion) — ver
   *  `BrandKind`. Ausente en filas escritas antes de que existiera la columna;
   *  el default de la base es 'manufacturer', que es lo que toda marca era. */
  kind?: BrandKind;
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
/**
 * QUE CLASE DE MARCA. Las dos quieren cosas opuestas de la plataforma y por eso
 * la distincion es una columna y no una convencion:
 *
 *   manufacturer  vende piezas. Quiere AISLAMIENTO — sus modelos, distribuidores,
 *                 leads y precios no los ve nadie.
 *   materials     publica una biblioteca de telas. Quiere DISTRIBUCION — que
 *                 aparezca en el configurador de cuantos mas fabricantes mejor.
 */
export type BrandKind = 'manufacturer' | 'materials';

/**
 * Una casa de materiales que un fabricante OFRECE. Sin fila no ve nada de esa
 * casa: la distribucion se acepta, no se impone.
 *
 * La arista es de UNA DIRECCION. El fabricante decide a quien ofrece y con que
 * nombre; la casa no ve quien la distribuye ni entra en su entorno. Publicar no
 * da acceso a quien te publica.
 */
export interface BrandMaterialSource {
  /** El FABRICANTE. Suyas son la fila y la decision. */
  brandId: string;
  /** La CASA cuya biblioteca ofrece. */
  sourceBrandId: string;
  active: boolean;
  createdAt?: number;
}

/**
 * La capa de un fabricante sobre UNA tela publicada por una casa.
 *
 * SU AUSENCIA SIGNIFICA «ofrecida y tal cual como la publico la casa», y eso es
 * deliberado: suscribirse tiene que bastar para empezar a vender, o dar de alta
 * una casa de 4.000 telas exigiria 4.000 clics antes de la primera. La capa solo
 * existe donde el fabricante decidio algo distinto.
 *
 * Una tela que el fabricante AÑADE atribuida a la misma casa no usa esto: es una
 * fila de `materials` suya, con `house` puesto. La capa es para tapar lo que
 * publico otro; lo propio es propio.
 */
export interface BrandMaterialOverride {
  brandId: string;
  /** `materials.id` de la fila publicada por la casa. */
  materialId: string;
  /** LA SELECCION. false = esta tela no entra en mi libro. */
  offered: boolean;
  /** EL RENOMBRE. null = el nombre de la casa. Se IMPRIME en la cotizacion, asi
   *  que manda sobre el de la casa en cuanto existe. */
  name?: string | null;
  /** LAS FOTOS. null = los colores de la casa. Con valor SUSTITUYE la lista
   *  entera — media lista seria una tela distinta segun quien la mire. */
  colors?: MaterialColorLike[] | null;
  createdAt?: number;
  updatedAt?: number;
}

/** La forma de un color tal como viaja en la capa — el mismo `{ name, code,
 *  imageId }` que `Material.colors`, repetido aqui para no atar este archivo al
 *  arbol de tipos del dominio por una sola propiedad. */
export interface MaterialColorLike {
  name: string;
  code: string;
  imageId?: string | null;
}

/**
 * QUÉ MARCA REPRESENTA UN DISTRIBUIDOR. La arista, no una entidad: su clave es
 * el par, y por eso no tiene id propio.
 *
 * No confundir con `BrandMember`, que es lo mismo para un USUARIO de la casa.
 * Aquí el sujeto es un negocio de fuera que embebe nuestro configurador en su
 * propio sitio, y la asignación decide qué catálogo puede servir bajo su
 * margen y su bandeja.
 */
export interface DealerBrand {
  dealerId: string;
  brandId: string;
  /** Suspender UNA marca sin borrar la relación ni tocar las otras. */
  active?: boolean;
  createdAt?: number;
}

export interface BrandMember {
  profileId: string;
  brandId: string;
  /** Reserved for a per-brand role (a brand's own admin vs its viewer). No
   *  policy reads it yet — membership alone is what grants sight today. */
  role?: string;
  createdAt?: number;
}

/**
 * Una corrida de un módulo de importación — la fila que deja
 * `supabase/functions/_shared/importRun.ts`. READ-ONLY desde el navegador:
 * sólo las Edge Functions la escriben (service role), así que ninguna
 * superficie puede falsificar una corrida verde. `ok` null = todavía en vuelo
 * (o una corrida que MURIÓ, si lleva abierta más de lo esperable).
 */
export interface ImportRun {
  id: string;
  profileId: string;
  /** El módulo que corrió: 'lr-catalog', 'anthom-catalog', … */
  module: string;
  /** La marca sobre cuyos datos reclama autoridad; null si no aplica. */
  brand?: string | null;
  trigger?: 'cron' | 'manual' | 'webhook';
  startedAt?: number;
  finishedAt?: number | null;
  ok?: boolean | null;
  rowsWritten?: number | null;
  rowsFlagged?: number | null;
  error?: string | null;
  createdAt?: number;
}
