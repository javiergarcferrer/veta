/**
 * EL REGISTRO DE CONFIGURADORES — una marca, su propio configurador.
 *
 * This product had exactly one configurator for its whole life, and its name
 * says so: `TogoEmbed`. That was never a shortcut — it was correct while there
 * was one brand. It stops being correct the moment a second manufacturer needs
 * to be configured, because the two do not answer the same question:
 *
 *   TOGO (Ligne Roset)  composes GEOMETRY. You place modules on a floor plan,
 *                       drag them, rotate them, and the price is the sum of
 *                       the pieces you placed. The instrument is a canvas.
 *   CARL HANSEN         composes ONE PIECE. A Wishbone Chair is one chair;
 *                       what you choose is its wood, its finish, its seat —
 *                       AXES, not modules — and the answer is a single
 *                       composed SKU at a single list price. The instrument is
 *                       a set of pickers.
 *
 * A floor-plan canvas is the wrong instrument for a chair, and an axis picker
 * is the wrong instrument for a modular sofa. Generalising one into the other
 * would produce a configurator that is bad at both. So each brand brings its
 * own, and this file is the only place that knows which is which.
 *
 * ── WHY THIS FILE HOLDS NO COMPONENTS ───────────────────────────────────────
 * Only DATA lives here — id, slug, the paths that reach it, what to call it.
 * The React component is resolved in `main.jsx`, deliberately: the public
 * configurator boots through that entry, and a registry that imported pages
 * would drag every brand's configurator graph into the render-blocking entry
 * chunk that the visitor never renders. One brand's widget must not pay for
 * another brand's. `main.jsx` already guards this for the admin shell; the
 * registry keeps the same discipline.
 *
 * ── THE BARE PATHS BELONG TO TOGO, PERMANENTLY ──────────────────────────────
 * `/configurador` and `/configurator` are printed on things, pasted into
 * dealers' websites and shared as links. They resolve to Togo and always will.
 * A new brand gets a suffix (`/configurador/carl-hansen`); it never gets to
 * take the bare path, whatever ends up being the "main" brand later.
 *
 * Pure: no React, no db, no network.
 */

/** Both spellings of the stem. `/configurador` is what the public site points
 *  at; `/configurator` is the original, and links carrying it are already out
 *  in the world. */
export const CONFIGURATOR_STEMS = Object.freeze(['configurador', 'configurator']);

/**
 * One brand's configurator.
 *
 *  id          what `main.jsx` switches on to pick a component.
 *  slug        the path suffix, and '' for the brand that owns the bare paths.
 *  brandSlug   the `brands.slug` row this configures — how the widget knows
 *              which catalog, materials and branding to load.
 *  label       what a human calls it, in the language the app speaks.
 *  composes    the ONE-WORD answer to "what does this instrument build". It is
 *              in the data rather than in a comment because the launcher shows
 *              it, and a picker that says "Sillas" next to "Planta" is how a
 *              dealer knows which one they want without opening both.
 */
export const CONFIGURATORS = Object.freeze([
  Object.freeze({
    id: 'togo',
    slug: '',
    brandSlug: 'ligne-roset',
    label: 'Configurador de planta',
    brandName: 'Ligne Roset',
    composes: 'Módulos sobre una planta',
  }),
  Object.freeze({
    id: 'carl-hansen',
    slug: 'carl-hansen',
    brandSlug: 'carl-hansen',
    label: 'Configurador Carl Hansen',
    brandName: 'Carl Hansen & Søn',
    composes: 'Una pieza por sus ejes',
  }),
  Object.freeze({
    id: 'fredericia',
    slug: 'fredericia',
    brandSlug: 'fredericia',
    label: 'Configurador Fredericia',
    brandName: 'Fredericia',
    // Ejes también — pero su verdad es NUESTRO catálogo (el import de Anthom,
    // enriquecido por fredericia-catalog), no el sitio del fabricante al vuelo.
    composes: 'Una pieza por sus ejes',
  }),
]);

/** The one that owns the bare paths. */
export const DEFAULT_CONFIGURATOR = CONFIGURATORS.find((c) => !c.slug) || CONFIGURATORS[0];

const BY_ID = new Map(CONFIGURATORS.map((c) => [c.id, c]));
const BY_SLUG = new Map(CONFIGURATORS.filter((c) => c.slug).map((c) => [c.slug, c]));

/** A registered configurator by id, or null. */
export const configuratorById = (id) => BY_ID.get(String(id || '')) || null;

/**
 * `pathname` → the configurator it names, or null when it names none.
 *
 * ONE DEFINITION, because the last time this was a regex it was THREE of them:
 * the entry that mounts the widget, the widget's own "am I standalone?" check,
 * and the forced-light public-route test each carried a copy, and adding the
 * Spanish spelling to two of them left the third behind — `/configurador`
 * booted the app and then showed the tap-to-open card instead of the
 * configurator. Every caller comes through here now.
 *
 * A stem with an UNKNOWN suffix returns null rather than falling back to Togo.
 * `/configurador/carl-hanson` (a typo, or a brand that was removed) must not
 * silently open a different manufacturer's product — the visitor would
 * configure a sofa believing it was a chair.
 */
export function configuratorForPathname(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (!parts.length || !CONFIGURATOR_STEMS.includes(parts[0].toLowerCase())) return null;
  if (parts.length === 1) return DEFAULT_CONFIGURATOR;
  if (parts.length > 2) return null;
  return BY_SLUG.get(parts[1].toLowerCase()) || null;
}

/** The public path that reaches one configurator, in the Spanish spelling the
 *  site links with. */
export function configuratorPath(configurator) {
  const slug = String(configurator?.slug || '');
  return slug ? `/configurador/${slug}` : '/configurador';
}
