/**
 * MODEL MANAGER — the owner's back-office over `togo_models`: one table of every
 * piece the configurador can place, with the facts that decide whether it is
 * SAFE to place it (bound SKU, real GLB, tagged parts, own finish palette) and
 * one lever, activo ↔ borrador.
 *
 * Pure projection, no React / no db (the layering fitness test enforces it): the
 * View fetches `db.configuratorModels`, calls `resolveModelManager` in a useMemo and
 * renders — it derives nothing of its own.
 *
 * THREE THINGS ARE LOAD-BEARING HERE and everything else is display:
 *
 *   1. ESTADO IS `active`, READ THE WAY THE WIDGET READS IT. The public palette
 *      keeps a model when `active !== false` (resolveConfiguratorModels, togo-embed) —
 *      so a NULL `active` is a LIVE model today, on real rows written before the
 *      column existed. «Borrador» therefore means exactly `active === false` and
 *      nothing else: no migration, no new column, and the manager can never
 *      disagree with what the customer sees. Drift this predicate one notch
 *      (`!!active`, `active === true`) and every legacy null flips to borrador —
 *      the board would report a catalog of drafts while the widget serves them,
 *      and one «publicar todo» pass would rewrite rows nobody asked to touch.
 *
 *   2. SORTING BY COLECCIÓN IS THE PALETTE ORDER, not an alphabetical grouping.
 *      The board is where that order gets EDITED (drag a row), and the reorder
 *      plan is fed this very list — so if the table ordered a colección by name
 *      while the configurador serves it by `sortOrder`, every drop would land
 *      the piece somewhere the dealer never pointed at. See `sorterFor`.
 *
 *   3. `parts` IS HAND-WRITTEN JSONB. The Estudio de Partes edits it directly,
 *      so every bag below (`mats`, `roots`, `finishes`) may be absent, null, a
 *      string, an array, or half-typed. Nothing here may throw on one: an
 *      unreadable bag reads as "nothing tagged", which is the truth the manager
 *      wants to SHOW (that row needs work), never a crash that hides the whole
 *      table.
 */
import { PART_ROLES, structureGroupsOf } from '../../../lib/configurator/meshParts.js';
import { canonicalCollection } from '../../../lib/configurator/collections.js';

/** Published to the configurador (`active !== false`) vs held back. */
export type ModelEstado = 'activo' | 'borrador';

/**
 * What the row's `meshUrl` points at — the FIDELITY signal the board sorts its
 * attention by. 'glb' is the servable, converted mesh the configurador renders;
 * 'raw' is a source export (FBX/OBJ/DAE…) sitting in the mesh slot, which loads
 * as nothing in the widget; 'none' is a piece still drawn from its 2D plan.
 */
export type ModelMeshKind = 'glb' | 'raw' | 'none';

/** Where a model's geometry came from — the staleness clock the board shows when
 *  Ligne Roset reissues a piece (`ingestedAt` is JS ms, like every `*At`). */
export type ModelProvenance = {
  sourceName: string | null;
  ingestedAt: number | null;
};

/** One administrable model — exactly what the table renders, nothing derived at
 *  the render site. */
export type ModelManagerRow = {
  id: string;
  name: string;
  /** Modular family (legacy rows carry none → 'Togo', like the rest of the VM layer). */
  collection: string;
  /** LR library category / group, read off a folder import. Null when unknown. */
  category: string | null;
  productGroup: string | null;
  estado: ModelEstado;
  meshKind: ModelMeshKind;
  /** A bound `productRoot` — without one the piece can never price. */
  skuBound: boolean;
  /** The roles tagged on the mesh, deduped, in PART_ROLES (display) order. */
  partsRoles: string[];
  /** How many part roles carry a bound SKU root of their own. */
  partsSkuCount: number;
  /** The row carries a structure palette of ITS OWN — see ownFinishesOf. */
  ownFinishes: boolean;
  /** A drawable 2D plan (the configurador's other renderer + the picker card). */
  svg: boolean;
  widthCm: number;
  depthCm: number;
  /**
   * The row's place in the configurador's palette (`togo_models.sort_order`).
   * Exposed because the board is where that order is EDITED: sorting by
   * colección puts the table in palette order, and dragging a row there hands
   * `planConfiguratorReorder` this very list — see sorterFor's note.
   */
  sortOrder: number;
  provenance: ModelProvenance;
  updatedAt: number | null;
};

/** Table controls. Every one is optional — no opts = the whole catalog, sorted
 *  by colección. */
export type ModelManagerOpts = {
  /** Free text over name / colección / id, case- and diacritic-insensitive. */
  q?: string;
  /** A colección name; '' or 'all' = no filter. */
  collection?: string;
  estado?: 'all' | ModelEstado;
  sort?: 'name' | 'collection' | 'updated';
  /**
   * Which way the chosen sort runs. Omitted = each key's NATURAL direction
   * (`defaultDirFor`), which is what every caller predating the header's
   * asc/desc control was already getting.
   */
  dir?: 'asc' | 'desc';
  /**
   * The BACKLOG filter — the THREE facts the estado tabs can't express, which
   * are exactly the three publish gates a piece can fail: no servable mesh (the
   * configurador draws the generic shape instead of the model), no SKU bound
   * (no price, so it cannot be quoted), and no part roles tagged (it cannot bill
   * its own cushions). Each is exactly the predicate `counts.sinMesh` /
   * `counts.sinSku` / `counts.sinPartes` counts, so the number the board prints
   * and the rows it shows can never disagree.
   */
  pendiente?: 'mesh' | 'sku' | 'partes' | null;
};

/** The board's KPI strip — over ALL models, never the filtered slice, so
 *  narrowing the table can't make the catalog look healthier than it is. */
export type ModelManagerCounts = {
  total: number;
  activos: number;
  borradores: number;
  sinMesh: number;
  sinSku: number;
  /**
   * Pieces whose mesh IS there and that nobody has said what they are made of.
   *
   * The mesh gate is folded in on purpose, and it is the one asymmetry in this
   * strip: part roles are tagged ON mesh groups, so a piece with no mesh has no
   * parts to tag and counting it here would advertise work that cannot be
   * started — where a SKU binds to a piece with or without geometry, which is
   * why `sinSku` counts every row. The three chips are the backlog IN THE ORDER
   * YOU FIX IT, each counting only what is actionable at that step; a mesh-less
   * piece is one piece of work («sube el 3D»), counted once, under `sinMesh`.
   *
   * It is also the gate that dominates a fresh pCon import — thirty pieces land
   * with geometry, no SKU and no roles — and the only one the board never
   * counted: the strip read «1 sin malla · 2 sin SKU» over a «Completar» button
   * offering to fix 49, and nothing on screen said where the other 47 were.
   */
  sinPartes: number;
};

export type ModelManagerResult = {
  rows: ModelManagerRow[];
  /**
   * The WHOLE catalog in the configurador's own palette order — global
   * `sortOrder`, exactly how `resolveConfiguratorModelCards` and the `togo-embed`
   * payload read it. This is the list `planConfiguratorReorder` renumbers when the board
   * drags a row, and it is a separate projection from `rows` on purpose: `rows`
   * is FILTERED and re-sorted by the owner, while a reorder must be planned over
   * everything, in the sequence the numbering actually runs. Hand the planner
   * the alphabetically-grouped table instead and one drag renumbers every
   * colección in the catalog — hundreds of writes, and a fresh `updatedAt` on
   * rows nobody touched.
   *
   * Its per-colección subsequence is IDENTICAL to what the table shows under the
   * colección sort (same tiebreaks), which is what makes a drop land where the
   * dealer pointed.
   */
  palette: ModelManagerRow[];
  collections: string[];
  counts: ModelManagerCounts;
};

/** Locale-aware, accent-folding, digit-aware ordering — so «Prado 2» sorts
 *  before «Prado 10» and «Ángulo» files with the A's. Built once: a Collator is
 *  expensive and the comparator runs O(n log n) times per keystroke. */
const COLLATOR = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const byText = (a: string, b: string): number => COLLATOR.compare(a, b);

/** Case- and diacritic-insensitive search key ("Cojín" → "cojin"), the same
 *  normalization the ⌘K palette uses. */
function norm(v: unknown): string {
  return String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** A row field as trimmed display text; anything non-string (a number, a bag)
 *  still answers with something printable rather than throwing. */
function text(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** A measurement — a malformed one reads 0 (the board's "sin medidas" state),
 *  never NaN, which would render as literal "NaN cm" and sort unpredictably. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A `*At` stamp in JS ms, or null. Empty string ≠ epoch: `Number('')` is 0, and
 *  a 1970 date on a "nunca tocado" row is a lie the timestamp column can't tell. */
function msOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A jsonb sub-bag as a plain record. An array is NOT a bag here (it has no
 *  group keys to mean anything) — it reads empty, exactly like null. */
function bagOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * What the mesh slot holds. The suffix is read off the PATH, not the whole URL:
 * `removeConfiguratorMesh` already splits on '?' for the same reason — a cache-buster or
 * a signed query says nothing about the format, and a real GLB must not file as
 * a raw export because someone appended `?v=2`.
 */
function meshKindOf(meshUrl: unknown): ModelMeshKind {
  const url = text(meshUrl);
  if (!url) return 'none';
  return /\.glb$/i.test(url.split(/[?#]/)[0]) ? 'glb' : 'raw';
}

/** The roles tagged on this model, deduped and in PART_ROLES order — walking the
 *  canonical list (rather than the bag's own key order) gives both properties for
 *  free, and silently drops whatever a hand-edit left in there that isn't a role. */
function partsRolesOf(parts: unknown): string[] {
  const mats = bagOf(bagOf(parts).mats);
  const present = new Set(Object.values(mats));
  return PART_ROLES.filter((role) => present.has(role));
}

/** Part roles bound to a SKU root of their own (the shared cushion/bolster
 *  families). An empty or non-string root binds nothing — the Estudio deletes the
 *  key rather than storing '' — so it doesn't count as a binding here either. */
function partsSkuCountOf(parts: unknown): number {
  const roots = bagOf(bagOf(parts).roots);
  return Object.values(roots).filter((r) => typeof r === 'string' && r.trim() !== '').length;
}

/**
 * Does the ROW ITSELF carry a structure palette?
 *
 * It matters because `resolveConfiguratorModels` INJECTS the colección's estructura at
 * read time, so the configurador can show acabados on a row that stores none —
 * which is the right behaviour there and the wrong thing to report here. The
 * manager is looking at storage, so it asks the Model's own gate
 * (`structureGroupsOf`: a group tagged `structure` whose merged group carries a
 * palette `finishSpecOf` accepts) against the RAW `parts`, exactly like the
 * Estudio's own screen does.
 */
function ownFinishesOf(parts: unknown): boolean {
  return structureGroupsOf(parts).length > 0;
}

/** One db row → one table row. Total: every field answers for a bag of nulls. */
function toRow(m: Record<string, unknown>): ModelManagerRow {
  const parts = m.parts;
  return {
    id: text(m.id),
    name: text(m.name),
    // Canonical, so a drifted spelling can't split one collection in two:
    // the live catalog held «Exclusif» (12) and «EXCLUSIF» (38) side by side.
    collection: canonicalCollection(m.collection),
    category: text(m.category) || null,
    productGroup: text(m.productGroup) || null,
    // THE widget predicate, verbatim. See the header note (1).
    estado: m.active === false ? 'borrador' : 'activo',
    meshKind: meshKindOf(m.meshUrl),
    skuBound: !!text(m.productRoot),
    partsRoles: partsRolesOf(parts),
    partsSkuCount: partsSkuCountOf(parts),
    ownFinishes: ownFinishesOf(parts),
    svg: !!text(m.svg),
    widthCm: num(m.widthCm),
    depthCm: num(m.depthCm),
    // Legacy rows all default to 0 — a tie, not a missing value (see sorterFor).
    sortOrder: num(m.sortOrder),
    provenance: {
      sourceName: text(m.meshSourceName) || null,
      ingestedAt: msOrNull(m.ingestedAt),
    },
    updatedAt: msOrNull(m.updatedAt),
  };
}

/**
 * Every order ends on `id`, so a sort is a TOTAL order: two pieces with the same
 * name in the same colección can't swap places between renders (the table is
 * re-resolved on every keystroke, and rows that reshuffle under the cursor is how
 * an owner toggles the wrong model).
 *
 * Each comparator is written ASCENDING; `dir: 'desc'` flips the whole thing
 * (tiebreaks included, so it stays total). Only «updated» reads naturally the
 * other way round — see `defaultDirFor`.
 *
 * ⚠️ THE COLECCIÓN SORT IS THE PALETTE ORDER. Within a colección it orders by
 * `sortOrder` — exactly what `resolveConfiguratorModelCards` / the `togo-embed` payload
 * serve the configurador — and NOT by name. That is what makes the board's
 * drag-to-reorder honest: the dealer drags rows in the order the customer sees,
 * and the plan (`planConfiguratorReorder`, fed THIS list) renumbers the same sequence.
 * Order by name here and a drop would land the piece somewhere the dealer never
 * pointed at. Legacy rows all sit on `sortOrder` 0 — a tie — so the name is the
 * tiebreak, and the first move defragments the colección gaplessly.
 */
function sorterFor(sort: ModelManagerOpts['sort']): (a: ModelManagerRow, b: ModelManagerRow) => number {
  if (sort === 'name') {
    return (a, b) => byText(a.name, b.name) || byText(a.collection, b.collection) || byText(a.id, b.id);
  }
  if (sort === 'updated') {
    return (a, b) => {
      // Oldest first ascending; a never-stamped row IS the oldest thing there is
      // (and `null - null` would hand sort() a NaN, which orders nothing).
      if (a.updatedAt !== b.updatedAt) {
        if (a.updatedAt == null) return -1;
        if (b.updatedAt == null) return 1;
        return a.updatedAt - b.updatedAt;
      }
      return byText(a.name, b.name) || byText(a.id, b.id);
    };
  }
  return (a, b) => (
    byText(a.collection, b.collection)
    || (a.sortOrder - b.sortOrder)
    || byText(a.name, b.name)
    || byText(a.id, b.id)
  );
}

/**
 * A sort key's natural direction — what a caller that names no `dir` gets.
 * «Actualizado» means newest first (nobody opens a catalog to read its oldest
 * edit); everything else reads A→Z / palette order top-down.
 */
function defaultDirFor(sort: ModelManagerOpts['sort']): 'asc' | 'desc' {
  return sort === 'updated' ? 'desc' : 'asc';
}

/**
 * The Model Manager table: normalize every row, count over ALL of them, then
 * filter + sort the slice the owner is looking at.
 *
 * `models` is the raw `togo_models` read (camelCase, `*At` already ms). Entries
 * that aren't objects are dropped outright — there is no model to administer in
 * a null — and they're dropped BEFORE the counts, so the KPI strip and the table
 * are always talking about the same population.
 */
export function resolveModelManager(models: unknown[], opts: ModelManagerOpts = {}): ModelManagerResult {
  const all = (Array.isArray(models) ? models : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m))
    .map(toRow);

  const counts: ModelManagerCounts = {
    total: all.length,
    activos: all.filter((r) => r.estado === 'activo').length,
    borradores: all.filter((r) => r.estado === 'borrador').length,
    sinMesh: all.filter((r) => r.meshKind === 'none').length,
    sinSku: all.filter((r) => !r.skuBound).length,
    sinPartes: all.filter((r) => r.meshKind !== 'none' && !r.partsRoles.length).length,
  };

  // The colección picker's options come from the WHOLE catalog: a filter that
  // narrowed its own option list could never be widened back.
  const collections = [...new Set(all.map((r) => r.collection))].sort(byText);

  // The palette (see the type). `sortOrder` first — that IS the numbering — then
  // the SAME tiebreaks the colección sort uses, so the two can't disagree about
  // a colección's internal order even on legacy rows that all share `sortOrder`
  // 0. Total, like every order here.
  const palette = all.slice().sort((a, b) => (
    (a.sortOrder - b.sortOrder)
    || byText(a.collection, b.collection)
    || byText(a.name, b.name)
    || byText(a.id, b.id)
  ));

  const q = norm(text(opts.q));
  const wanted = norm(opts.collection);
  const collectionKey = wanted && wanted !== 'all' ? wanted : '';
  const estado = opts.estado && opts.estado !== 'all' ? opts.estado : null;
  const pendiente = opts.pendiente === 'mesh' || opts.pendiente === 'sku' || opts.pendiente === 'partes'
    ? opts.pendiente
    : null;

  const asc = sorterFor(opts.sort);
  const dir = opts.dir === 'asc' || opts.dir === 'desc' ? opts.dir : defaultDirFor(opts.sort);
  // Flipping the comparator (rather than reversing the array) keeps the order
  // TOTAL in both directions: `.reverse()` would rank equal rows by input order.
  const cmp = dir === 'desc' ? (a: ModelManagerRow, b: ModelManagerRow) => asc(b, a) : asc;

  const rows = all
    .filter((r) => {
      if (estado && r.estado !== estado) return false;
      // Compared normalized so a hand-typed filter ("prado") still lands on the
      // stored casing; the picker itself always hands back an exact value.
      if (collectionKey && norm(r.collection) !== collectionKey) return false;
      if (pendiente === 'mesh' && r.meshKind !== 'none') return false;
      if (pendiente === 'sku' && r.skuBound) return false;
      // Same predicate as `counts.sinPartes`, mesh gate included — see the type.
      if (pendiente === 'partes' && (r.meshKind === 'none' || r.partsRoles.length)) return false;
      if (!q) return true;
      return norm(r.name).includes(q) || norm(r.collection).includes(q) || norm(r.id).includes(q);
    })
    .sort(cmp);

  return { rows, palette, collections, counts };
}

/**
 * The one write the board plans: flip a row's estado.
 *
 * It returns a PATCH rather than performing one — the VM stays pure and the View
 * hands it to `db.configuratorModels.update(id, patch)`. `active: false` is precisely
 * today's hide-from-the-widget semantics, which is why «borrador» needed no
 * migration and cannot change what the configurador serves for any other row.
 *
 * Only an explicit 'borrador' publishes. Anything else de-publishes, so a row
 * that somehow arrives with an unreadable estado is held back rather than pushed
 * live to customers on a single click.
 */
export function planEstadoToggle(
  row: { id: string; estado: ModelEstado },
): { id: string; patch: { active: boolean } } {
  return { id: text(row?.id), patch: { active: row?.estado === 'borrador' } };
}

/**
 * The MASS estado write: one patch over many rows, shaped for `bulkUpdate`
 * (one round-trip, one invalidate — never a per-row update loop).
 *
 * Only rows whose estado actually DIFFERS from the target are included: a
 * «publicar» over a mixed selection must not re-write (and re-stamp nothing on)
 * the rows already live — and the returned ids are exactly the rows whose pill
 * the View should overlay optimistically.
 */
export function planBulkEstado(
  rows: { id: string; estado: ModelEstado }[] | null | undefined,
  target: ModelEstado,
): { ids: string[]; patch: { active: boolean } } {
  const patch = { active: target === 'activo' };
  const ids = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && text(r.id) && r.estado !== target)
    .map((r) => text(r.id));
  return { ids, patch };
}

/**
 * The MASS delete plan («eliminar los borradores archivados», a bad batch
 * import, …): which rows go, and which STORAGE objects go with them.
 *
 * Deleting the rows alone leaks the bucket: every model carries up to two
 * uploads (`meshUrl` — the servable GLB — and `meshSourceUrl` — the original
 * export). But an upload may be SHARED: a batch-imported scene stores ONE
 * source file across all its pieces, and a duplicated model copies its mesh
 * URL. So `removeUrls` is refcounted against the SURVIVORS: an upload is
 * scheduled for removal only when NO remaining row still references it —
 * removing a shared source under a surviving sibling would silently break its
 * provenance (and a shared GLB would break its 3D outright).
 *
 * Pure planning: the View performs `bulkDelete(ids)` first, then best-effort
 * storage removal — a failed storage cleanup is an orphan file, never a
 * half-deleted catalog.
 */
export function planModelDelete(
  models: unknown[] | null | undefined,
  ids: string[] | null | undefined,
): { ids: string[]; removeUrls: string[] } {
  const rows = (Array.isArray(models) ? models : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m));
  const byId = new Map(rows.map((m) => [text(m.id), m]));
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(text))].filter((id) => id && byId.has(id));
  if (!wanted.length) return { ids: [], removeUrls: [] };

  const doomed = new Set(wanted);
  const survivorUrls = new Set<string>();
  for (const m of rows) {
    if (doomed.has(text(m.id))) continue;
    for (const u of [text(m.meshUrl), text(m.meshSourceUrl)]) if (u) survivorUrls.add(u);
  }
  const removeUrls = new Set<string>();
  for (const id of wanted) {
    const m = byId.get(id)!;
    for (const u of [text(m.meshUrl), text(m.meshSourceUrl)]) {
      if (u && !survivorUrls.has(u)) removeUrls.add(u);
    }
  }
  return { ids: wanted, removeUrls: [...removeUrls] };
}
