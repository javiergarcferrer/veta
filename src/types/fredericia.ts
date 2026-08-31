/**
 * EL 3D DE FREDERICIA — el estado de usuario de `fredericia_assets`.
 *
 * Calcado de `ChAsset` al lado, con una diferencia que es un hecho del
 * dominio y no una opción: el .obj del fabricante llega SIN nombres de
 * material (`usemtl 191,191,191`) y sin .mtl, así que aquí nunca existirá un
 * tier 'a' automático — el binding malla→eje es siempre trabajo humano, el
 * equivalente permanente del tier B de Carl Hansen.
 *
 * `id` = el código del fabricante (`externalId` de su página, 2226 = Spanish
 * Chair) — el mismo `familyCode` del catálogo de Anthom, así que las dos
 * fuentes se juntan sin tabla de mapeo.
 */
export interface FredericiaAsset {
  id: string;
  profileId: string;
  /** La página de producto de la que salió la extracción. */
  slug?: string;
  name?: string;
  /** La FUENTE: el .obj tal cual lo publica el fabricante (Cloudinary raw). */
  sourceUrl?: string | null;
  sourceName?: string;
  /** Del HEAD, antes de bajar un byte — el rango real medido va de 4.7 MB al
   *  Calmo Elements de 165 MB, y un monstruo se rechaza por el precio de una
   *  cabecera. */
  sourceBytes?: number | null;
  meshTier?: 'a' | 'b' | 'none';
  meshUrl?: string | null;
  meshV?: number | null;
  binding?: unknown;
  bindingReviewedAt?: number | null;
  ingestedAt?: number | null;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}
