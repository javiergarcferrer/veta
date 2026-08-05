/**
 * IMPORT MODULES — the contract a brand's environment is read through.
 *
 * Every manufacturer sells furniture; almost none of them ship it as data the
 * same way. Ligne Roset hands the dealer an ARCHVIZ tree of `.3ds` files filed
 * under <Grupo>/<Categoría>/<Modelo>/, pCon material archives, and SKUs that
 * are 8 digits plus a grade letter. The next manufacturer hands over a folder
 * of `.glb` named after the model and a `sku,grade,price` spreadsheet. The
 * configurator, the studio and the quote are the SAME for both — the ingest is
 * not. So the ingest is the pluggable part.
 *
 * A MODULE SET is three adapters under one id:
 *
 *   geometry   how a dropped 3D library FILES ITSELF (which extensions are
 *              models, and what a path says about a piece's taxonomy)
 *   materials  how a dropped material archive becomes COLORS the 3D can wear,
 *              and WHERE the brand publishes each colour's swatch photo
 *   catalog    the SKU GRAMMAR, the GRADE LADDER and the price-list decode
 *
 * plus ONE optional set-level capability, `seeds` — a brand that ships sample
 * pieces (see the Ligne Roset set) so a fresh environment isn't empty. It is a
 * capability and not a hardcoded check because sample data is A BRAND'S OWN
 * FURNITURE: offering it to another manufacturer would invent their catalog.
 *
 * Nothing here is React, Supabase or three.js: an adapter is a pure reader over
 * strings and Files, so the studio, the brand admin and any future importer all
 * get the same answer for the same drop. The ONE effectful seam is a materials
 * adapter's `parse`, which decodes a bitmap and (given an uploader in its
 * context) parks the texture somewhere public — documented per adapter.
 *
 * EVERY TAXONOMY FIELD IS `string | null`. null means "the drop doesn't say",
 * never a guess: a guessed grupo is a piece the dealer can never find again.
 *
 * ── geometry ────────────────────────────────────────────────────────────────
 *   id            string — stable, stored in `brands.modules.geometry`
 *   label         short human name for the brand admin
 *   summary       one line: what shape of library it reads
 *   extensions    ['.fbx', '.glb', …] — what counts as a MODEL
 *   sidecar       ['.jpg', …] — bitmaps that ride along with a model folder and
 *                 are never content on their own (may be empty)
 *   accept        the `<input accept>` string for `extensions`
 *   accepts(file) true when this file is a model this module can read
 *   resolveShape(relPaths) → an OPAQUE plan for the whole drop. A drop is a
 *                 tree, not a bag of paths: where each level sits is a property
 *                 of the batch, so it is measured once and every sibling is
 *                 filed against the same plan.
 *   parsePath(relPath, shape) → { group, category, collection, model, variant }
 *                 `model` is the piece's own proposed name; `variant` is the
 *                 left/right/2-versions rendering marker when the path carries
 *                 one (it is packaging, never a taxonomy level).
 *
 * ── materials ───────────────────────────────────────────────────────────────
 *   id, label, summary, extensions, accept
 *   accepts(file)  true when this file is a material this module can read
 *   parse(file, ctx) → Promise<ParsedColor | null>
 *                 ctx = { upload?(blob, filename) → Promise<string|null>,
 *                         maxEdge?: number }
 *                 With no `upload` the texture is not stored and `textureUrl`
 *                 comes back null — the colour still carries its exact `rgb`,
 *                 so a caller can dry-run a drop before it writes anything.
 *                 Returns null when the file says nothing this module can use;
 *                 it NEVER throws on junk (a 400-file drop must not die on one).
 *
 *   ParsedColor = {
 *     code        string  — the catalogue code the quote is written in
 *     name        string  — the colour's name ('' when the file doesn't say)
 *     rgb         string|null — '#rrggbb', the exact tone (averaged from the
 *                 scan) — what the 3D tints with when there is no texture
 *     textureUrl  string|null — the stored weave the 3D tiles
 *     normalUrl   string|null — the stored relief map, when the archive has one
 *     pbr         object|null — { dif, rough, spec, tileCm, tileCmY }, the
 *                 shading port when the archive carries one
 *     material    { name, category, grade }|null — which MATERIAL this colour
 *                 belongs to, when the drop says (a folder name, a filename
 *                 prefix). null ⇒ the caller decides.
 *   }
 *
 *   swatch        WHERE THIS BRAND PUBLISHES A COLOUR'S PHOTO — the second half
 *                 of "materials", and the one every screen reads:
 *
 *     urlFor(code) → string|null   the brand's own full-size swatch for a
 *                 catalog colour code. NULL IS A REAL ANSWER: a manufacturer
 *                 with no public CDN has no such URL, and the app must degrade
 *                 (the colour's own stored scan, then an empty plate) rather
 *                 than invent one. Never throws.
 *     codeFor(code) → string       the code as that source FILES it (Ligne
 *                 Roset drops leading zeros); '' when there is no usable code.
 *     proxied     boolean — true when `swatch-proxy`'s `?code=` mode can serve
 *                 this source (it builds the URL server-side, so it only knows
 *                 the sources listed in its own allowlist). False ⇒ callers
 *                 never route a code through the proxy, so they never ask the
 *                 server for a brand it cannot resolve.
 *
 * ── catalog ─────────────────────────────────────────────────────────────────
 *   id, label, summary
 *   skuHint       how a SKU reads, for the brand admin ('15420000A')
 *   grades        the grade ladder, cheapest-first ([] when the brand doesn't
 *                 price by grade)
 *   gradeGroups   the same ladder as the picker groups it —
 *                 [{ label, grades }] ([] when there is no ladder)
 *   specialGrades non-letter grades the brand still quotes ('COM')
 *   legacyGrades  retired spellings a stored value may still carry, so a read
 *                 round-trips instead of silently losing the dealer's data
 *   isGrade(token) → boolean — does this token name a grade for this brand?
 *                 The one question `composeSubtype` asks before writing the
 *                 canonical "Grade C — PAMPA".
 *   fabricKey(name) → string — the fold that matches a fabric NAME across the
 *                 brand's sources (its per-model roster vs. the materials
 *                 catalog). Brand-owned because the collapsing rules are
 *                 (Ligne Roset consolidates "VIDAR" and "VIDAR/FR").
 *   splitSku(ref) → { root, grade } | null — the grammar. `grade` is '' for a
 *                 SKU the brand doesn't grade; null ONLY when `ref` is unusable.
 *   composeSku(root, grade) → string|null — the inverse, for a price row that
 *                 arrives as root + grade in separate columns.
 *   priceColumns  the price-list header this module reads, in order
 *   parsePriceRow(row) → { reference, root, grade, name, priceUsd, currency }
 *                 | null. `row` is one CSV record as an object keyed by its
 *                 (lower-cased) header. null = not a priced row (a blank line, a
 *                 header repeat, a row with no usable price) — never a throw.
 *   fabricLink    OPTIONAL. `{ supported, label, placeholder, hint,
 *                 fetch(url, { invoke }) }` — how a MODEL's offered-fabric
 *                 roster is looked up when the brand publishes one. Absent ⇒
 *                 the studio hides the affordance rather than pointing a
 *                 manufacturer at somebody else's website. `fetch` is handed
 *                 its effect (the function invoker) the same way `materials
 *                 .parse` is handed its uploader, so this layer imports no
 *                 network client.
 *   source        OPTIONAL. WHERE THE PRICED CATALOG COMES FROM WHEN IT IS NOT
 *                 A FILE. Every set shipped so far reads a CSV the dealer was
 *                 handed, and `parsePriceRow` is that reader. A manufacturer on
 *                 a trade data platform (pCon/OFML) hands over no file at all —
 *                 the catalog is a service you authenticate against and sweep.
 *
 *                 `{ supported, label, hint, kind, fetchRows(ctx) }` where
 *                 `fetchRows` resolves to THE SAME ROWS `parsePriceRow` returns
 *                 — `{ reference, root, grade, name, priceUsd, currency }` —
 *                 so nothing downstream (productForGrade, the quote builder,
 *                 the freeze) can tell a swept catalog from an imported one.
 *                 That identity is the whole point: a new SOURCE must not
 *                 become a new PRODUCT SHAPE.
 *
 *                 `ctx` carries the effects, never the clients: `{ credentials,
 *                 onProgress?, signal? }`. A module with a `source` still ships
 *                 `parsePriceRow` — a manufacturer who also emails a CSV is
 *                 normal, and losing that reader to gain a sweep would be a
 *                 downgrade. Absent ⇒ the brand admin offers file import only.
 *
 * ── seeds (set level, OPTIONAL) ─────────────────────────────────────────────
 *   { label, load() → Promise<Array<{ name, model, widthCm, depthCm, svg,
 *     match }>> } — the brand's own sample pieces, loaded on demand (they carry
 *   inline SVG plans and must not sit in every bundle). Absent ⇒ there is no
 *   "import the example pieces" affordance for that brand, which is the honest
 *   empty state.
 */

/** Extensions → the `<input accept>` string every intake wants. */
export const acceptOf = (extensions) => (extensions || []).join(',');

/** `.glb` from 'a/b/Model.GLB' — lower-cased, '' when there is none. */
export function extOf(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}

/** A dropped File's path inside the library. `relPath` is what useFileIntake
 *  stamps on every walked/picked file; a loose file carries its bare name. ONE
 *  reader, so a batch's shape pass and its per-file read can never disagree
 *  about what string a file's path even is. */
export const relPathOf = (file) =>
  String(file?.relPath || file?.webkitRelativePath || file?.name || '');

/** Path → its segments, separators unified, empties and `.` hops dropped. The
 *  filename is the last one. */
export function splitPath(relPath) {
  return typeof relPath !== 'string' ? [] : relPath
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.');
}

/** 'Coffee-Tables' / 'coffee_tables' → 'Coffee Tables'. Each word's first
 *  letter is upper-cased and THE REST IS LEFT ALONE, which is what preserves an
 *  acronym that was already all-caps (LED, MDF). Always a string. */
export function prettify(raw) {
  const s = String(raw == null ? '' : raw).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** '' → null, so every taxonomy field honours "null means the drop doesn't say". */
export const orNull = (s) => (s ? s : null);

/** The all-null taxonomy — what an unreadable path answers instead of throwing. */
export const NO_TAXONOMY = Object.freeze({
  group: null, category: null, collection: null, model: null, variant: null,
});

/**
 * Freeze a module set and fail loudly on a half-written one. Called by every
 * module file at definition time, so a set that is missing an adapter can never
 * reach the registry (and a brand can never be pointed at one).
 */
export function defineModuleSet(set) {
  const need = ['id', 'label', 'geometry', 'materials', 'catalog'];
  for (const k of need) {
    if (!set?.[k]) throw new Error(`module set: missing '${k}'`);
  }
  for (const fn of ['resolveShape', 'parsePath', 'accepts']) {
    if (typeof set.geometry[fn] !== 'function') throw new Error(`module set ${set.id}: geometry.${fn} missing`);
  }
  for (const fn of ['accepts', 'parse']) {
    if (typeof set.materials[fn] !== 'function') throw new Error(`module set ${set.id}: materials.${fn} missing`);
  }
  for (const fn of ['urlFor', 'codeFor']) {
    if (typeof set.materials.swatch?.[fn] !== 'function') throw new Error(`module set ${set.id}: materials.swatch.${fn} missing`);
  }
  for (const fn of ['splitSku', 'parsePriceRow', 'isGrade', 'fabricKey']) {
    if (typeof set.catalog[fn] !== 'function') throw new Error(`module set ${set.id}: catalog.${fn} missing`);
  }
  // `source` is optional, but a HALF-WRITTEN one is worse than none: the brand
  // admin would offer a "sync catalog" button that resolves to undefined at the
  // one moment somebody is waiting on a price list. Checked here, at definition
  // time, exactly like the required adapters.
  if (set.catalog.source && typeof set.catalog.source.fetchRows !== 'function') {
    throw new Error(`module set ${set.id}: catalog.source.fetchRows missing`);
  }
  return Object.freeze({
    ...set,
    geometry: Object.freeze(set.geometry),
    materials: Object.freeze({ ...set.materials, swatch: Object.freeze(set.materials.swatch) }),
    catalog: Object.freeze(set.catalog),
  });
}
