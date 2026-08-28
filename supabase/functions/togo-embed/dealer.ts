// togo-embed/dealer.ts — the PURE per-dealer helpers (the Model), the shared
// half of the multi-dealer Togo distribution feature. Like quote-share/pick.ts,
// this file crosses the Deno↔Vite wall only as CODE the Node test can import:
// NO Deno globals, NO URL imports, NO supabase client — just types + pure
// functions over plain rows. The imperative shell (index.ts) does the auth,
// reads and writes, then calls these to shape/reprice.
//
// Four axes vary per dealer, the catalog itself does NOT:
//   • BRANDING/LOCALE — dealerPublicShape() projects the DB row down to the
//     public-safe fields the widget renders (name, locale, currency, logo).
//   • CATALOG SCOPE — filterModelsForDealer() serves only the colecciones the
//     dealer carries (`dealers.collections`); NULL/empty = the whole catalog,
//     which is every dealer that predates the column and Alcover's own embed.
//   • PRICING PRESENTATION — applyDealerPricing() scales the shared USD catalog
//     by the dealer's ONE price factor (markup × FX, dealerPriceFactor);
//     applyPricingMode() then decides how much of the priced shape reaches the
//     browser at all ('full'/'from'/'hidden').
//   • LEAD ROUTING — shapeInboxRequest() projects a stored togo_requests row to
//     the public-safe lead the dealer's token-gated inbox lists;
//     INBOX_SETTABLE_STATUSES gates which statuses that inbox may set. The
//     token-gated inbox also PRICES its leads: buildPriceIndex() distills the
//     shared catalog (togo_models + products, at the settings margin) into a
//     per-model retail lookup, and priceInboxItems() applies that lookup + the
//     dealer's price factor to each stored item — the SAME machinery
//     buildCatalog uses, so the inbox and the widget agree to the cent. The
//     inbox is NOT scoped by `collections`: a lead already captured stays
//     readable even after the dealer stops carrying that colección.
//
// The grade LADDER is no longer a constant here: it arrives from the brand's own
// row (`brands.ladder`, loaded by index.ts) as a `ReadonlySet<string>`, and the
// SKU split it feeds lives once in `_shared/brandGrades`. This file stays pure —
// it receives the ladder, it never reads it.
import { gradeSet, splitRootGrade } from '../_shared/brandGrades.ts';

export type PricingMode = 'full' | 'from' | 'hidden';

type Row = Record<string, unknown>;

// A per-model catalog entry, the shape index.ts buildCatalog() emits. Only the
// price-bearing fields matter to the pricing helpers; everything else rides
// through untouched (…rest).
type PricedFamily = { byGrade?: Record<string, { priceUsd?: unknown; reference?: unknown }> } | null;
interface CatalogModel {
  priceUsd: number | null;
  family: PricedFamily;
  partFamilies?: Record<string, PricedFamily> | null;
  [k: string]: unknown;
}

/* ------------------------------ mesh parts (per-part SKUs) ------------------------------ */
// The Deno half of src/lib/togo/meshParts.js — the Deno↔Vite wall forbids
// importing it, so the DATA rules live at two layers on purpose (like the
// quote-pick reducer). tests/meshParts.test.js pins the two in agreement.

// The taggable roles. `base` prices via the model's own product_root;
// cushion/bolster/armCushion via parts.roots[role] (the shared SKUs);
// exterior/interior are MATERIALIZATION ZONES of the base SKU (the Prado
// ottomans' mono/bicolor split) — they never price as their own lines.

// The slot kinds + the three lists they derive live in ONE Deno home so the two
// functions cannot drift from each other: `_shared/partKinds`. Canonical side and
// reasoning: src/lib/togo/meshParts.js. Welded by tests/meshParts.test.js.
import {
  PART_KINDS, PART_ROLES, MATERIALIZATION_ROLES, UNPRICED_ROLES, BILLED_ROLES,
} from '../_shared/partKinds.ts';
// Re-exported: the tests and the sibling modules read these names from here, as
// they did when the lists were declared in this file.
export { PART_KINDS, PART_ROLES, MATERIALIZATION_ROLES, UNPRICED_ROLES, BILLED_ROLES };

// Materialization zones: the ottoman's single graded SKU covers the COMPLETE
// materialization; a bicolor pick can only re-grade that SKU (dearest zone
// wins in priceInboxItems), never add a billed part.

// Roles that NEVER bill, for two different reasons that reach the same answer:
// a zone is already inside the base SKU, and a `structure` is a finish on metal
// (lacado negro, acero) the customer picks for free. One list, so "does this
// bill?" is asked ONCE. (Mirror of lib/togo/meshParts.js — the wall pin in
// tests/meshParts.test.js compares them.)

// The CEILING on a typed billed count — mirror of lib/togo/meshParts.js
// `COUNT_MAX` (the wall forbids importing it; tests/meshParts.test.js pins the
// two in agreement). `counts` is the one dealer-typed number that rides straight
// into a price as a QUANTITY: a fat-fingered 100000 multiplied the part SKU by
// 100000 ($30M on an ordinary bicolor build), and this half is the number the
// PUBLIC widget shows a visitor.
export const COUNT_MAX = 20;

// BILLED units of a role's bound SKU. The catalog sells cushions/bolsters as
// singles or SETS (juego de 2/3): the dealer binds the set that covers the
// module, so a tagged role bills ONCE by default; counts[role] overrides
// (2 × a single SKU when no set exists), an explicit 0 disables billing.
// Materialization zones ALWAYS bill 0 (the base SKU is the whole price).
export function partCount(parts: Row | null | undefined, role: string): number {
  if (UNPRICED_ROLES.includes(role)) return 0;
  const counts = (parts?.counts ?? null) as Row | null;
  const explicit = Number(counts?.[role]);
  // OUT OF RANGE FALLS BACK — it never saturates, exactly as a NEGATIVE count
  // always has here: a garbage count bills the ONE set SKU the tagging implies,
  // where clamping to twenty would read as a quantity somebody meant to type.
  if (Number.isFinite(explicit) && explicit >= 0) {
    const n = Math.round(explicit);
    if (n <= COUNT_MAX) return n;
  }
  const mats = (parts?.mats ?? null) as Row | null;
  return Object.values(mats || {}).some((r) => r === role) ? 1 : 0;
}

// Per-part FINISH picks — the metal/wood variant a part is built in (legs in
// 'acero' vs 'acero-negro', …). A FLAT { groupKey: optionId } map, PRICE-NEUTRAL
// in v1: a finish names the variant the factory builds, it never re-grades or
// re-prices the SKU, so nothing here touches priceInboxItems.
//
// The FROZEN contract, shared verbatim with the client twin
// (src/lib/togo/meshParts.js — the Deno↔Vite wall forbids importing it, so the
// rule lives at TWO layers on purpose, exactly like sanitizePartMaterials below;
// tests/meshParts.test.js pins the two in agreement): key trimmed to ≤64 chars,
// optionId trimmed to a ≤32-char string, at most MAX_PART_FINISHES entries (the
// excess dropped by insertion order), null when nothing survives. Pure and
// throw-free — junk finishes cost the finishes, never the lead.
const MAX_PART_FINISHES = 12;

export function sanitizePartFinishes(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Row = {};
  for (const [key, value] of Object.entries(raw as Row)) {
    // Counted by the object itself: two keys that collide once trimmed are one
    // group, and must not eat two of the twelve slots.
    if (Object.keys(out).length >= MAX_PART_FINISHES) break;
    const k = String(key).trim().slice(0, 64);
    // An option id is a SCALAR. Coercing a nested object would store the string
    // '[object Object]' as a perfectly valid-looking pick (the itemsBatch
    // lesson: refuse the shape, never coerce it).
    const optionId = typeof value === 'string' || typeof value === 'number'
      ? String(value).trim().slice(0, 32)
      : '';
    if (!k || !optionId) continue;
    out[k] = optionId;
  }
  return Object.keys(out).length ? out : null;
}

// Sanitize a lead item's per-part fabric picks: known non-base roles only, each
// trimmed to {grade, fabric, code}; null when nothing survives.
export function sanitizePartMaterials(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Row = {};
  for (const role of PART_ROLES) {
    // A structure wears a FINISH (partFinishes), never cloth — keeping a fabric
    // pick the app drops would hand the worker a materialization nothing else
    // in the chain believes in.
    if (role === 'base' || role === 'structure') continue;
    const m = (raw as Row)[role];
    if (!m || typeof m !== 'object') continue;
    const grade = String((m as Row).grade ?? '').slice(0, 8);
    const fabric = String((m as Row).fabric ?? '').slice(0, 200);
    const code = String((m as Row).code ?? '').slice(0, 32);
    if (grade || fabric) out[role] = { grade, fabric, code };
  }
  return Object.keys(out).length ? out : null;
}

/* ------------------------------ colección ESTRUCTURA (the shared palette) ------------------------------ */
// The Deno half of src/lib/togo/collectionFinishes.js — plus the two
// src/lib/togo/meshParts.js helpers it reasons through (`mergedKeyOf`,
// `partRoleFor`) and the `finishSpecOf` normalizer it gates on. Same wall, same
// reason as the block above: only DATA crosses, so the rule lives at TWO layers
// on purpose and tests/togoQuote.test.js pins the two in agreement.
//
// WHY THE SERVER NEEDS IT AT ALL. An estructura palette (patas, marcos, bases en
// acero o acero lacado negro) is a COLECCIÓN-level parameter, but storage is per
// MODEL: it reaches a sibling by fanning out ON SAVE, which leaves a hole
// nothing downstream can close — a group MARKED Estructura whose own row carries
// no palette offers the client NOTHING, because `structureGroupsOf` reads that
// model's own `parts`. The app closes it in its VM (`resolveTogoModels` injects
// the colección's palette at read time, on a copy), and the two consumers that
// never pass through that VM are both served from here: the PUBLIC WIDGET builds
// its `resolvedById` straight out of this function's payload, and the AUTO-QUOTE
// WORKER seeds `plan.parts` from `resolveSeedModels`. Without the mirror the
// visitor is offered no acabado at all, and a worker-created quote replays the
// finish the customer did pick as bare fabric.
//
// PRICE-BLIND BY SHAPE, which is the whole safety of it: the injection only ever
// ADDS keys to `parts.finishes`. `mats`, `roots`, `counts`, `labels` and `merges`
// ride through untouched (by reference), and those are everything `partCount`,
// `buildPriceIndex` and the worker's `resolveCompleteSku` can see. A finish has
// never moved a price and this is not the first thing that does.

/** A palette option once normalized — the shape every consumer may trust. */
export interface FinishOption { id: string; label: string; rgb: string; metal?: number; rough?: number }
export interface FinishSpec { label: string | null; options: FinishOption[]; default: string | null }

// A plain jsonb bag, or an empty one — `parts`, `finishes` and friends are
// dealer-authored jsonb, so an array or a string is possible and is nothing.
const bagOf = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

/** The group a part key really belongs to, after following `merges`. The map is
    dealer-authored, so a chain can be hand-edited into a LOOP (a→b→a): we stop
    the moment we revisit a key and return the LAST SAFE one — always a real
    group, never a hang. */
export function mergedKeyOf(parts: Row | null | undefined, key: unknown): string {
  const merges = parts?.merges;
  let cur = key == null ? '' : String(key);
  if (!cur || !merges || typeof merges !== 'object') return cur;
  const seen = new Set([cur]);
  for (;;) {                                   // bounded: `seen` grows every hop
    const raw = (merges as Row)[cur];
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/** The material key a (possibly split) part key belongs to — "Fabric~2" →
    "Fabric". Only a trailing `~<digits>` counts. */
function baseKeyOf(partKey: unknown): string {
  const s = String(partKey || '');
  const m = /^(.*)~\d+$/.exec(s);
  return m ? m[1] : s;
}

/** The stable part key for a mesh node: its material name, else positional. */
function partKeyFor(materialName: unknown, nodeIndex: unknown): string {
  const n = (materialName == null ? '' : String(materialName)).trim();
  return n || `#${Number(nodeIndex) || 0}`;
}

/** The role a part plays, from the dealer-confirmed map. Untagged reads as
    'base'; a SPLIT cluster with no tag of its own inherits its material's tag. */
export function partRoleFor(
  parts: Row | null | undefined,
  materialName: unknown,
  nodeIndex: unknown,
  partKey?: string,
): string {
  const mats = (parts?.mats || {}) as Row;
  const key = partKey || partKeyFor(materialName, nodeIndex);
  if (PART_ROLES.includes(mats[key] as string)) return mats[key] as string;
  const base = baseKeyOf(key);
  if (base !== key && PART_ROLES.includes(mats[base] as string)) return mats[base] as string;
  return 'base';
}

const FINISH_HEX = /^#[0-9a-f]{6}$/i;

// A PBR 0–1 knob, only when one was really given: `Number(null)` is 0, so a
// coerce-everything read would hand the scene a hard metal:0 for a field the
// dealer simply left blank.
function finishUnit(v: unknown): number | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/** The finish palette for a group (its MERGED group), normalized: an option
    needs a non-empty `id`, a non-empty `label` and a real `#rrggbb`, a duplicate
    id keeps its FIRST row, `default` survives only if it names a survivor. Null
    when nothing valid is left — which is the same thing as "this group has no
    finishes", and here it is exactly the gate the injection asks. */
export function finishSpecOf(parts: Row | null | undefined, key: unknown): FinishSpec | null {
  const finishes = parts?.finishes;
  const spec = finishes && typeof finishes === 'object'
    ? (finishes as Row)[mergedKeyOf(parts, key)]
    : undefined;
  if (!spec || typeof spec !== 'object') return null;
  const options: FinishOption[] = [];
  const ids = new Set<string>();
  const rawOptions = (spec as Row).options;
  for (const raw of Array.isArray(rawOptions) ? rawOptions as Row[] : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const rgb = typeof raw.rgb === 'string' ? raw.rgb.trim() : '';
    if (!id || !label || !FINISH_HEX.test(rgb) || ids.has(id)) continue;
    ids.add(id);
    const opt: FinishOption = { id, label, rgb: rgb.toLowerCase() };
    const metal = finishUnit(raw.metal), rough = finishUnit(raw.rough);
    if (metal != null) opt.metal = metal;
    if (rough != null) opt.rough = rough;
    options.push(opt);
  }
  if (!options.length) return null;
  const label = typeof (spec as Row).label === 'string' ? ((spec as Row).label as string).trim() : '';
  const def = typeof (spec as Row).default === 'string' ? ((spec as Row).default as string).trim() : '';
  return { label: label || null, options, default: ids.has(def) ? def : null };
}

// A spec that COUNTS as DEFINED — what the dealer said, before asking what
// renders. The studio only ever stores a palette with at least one option
// (emptying it deletes the key), so an options-less object is not a definition:
// it never enters the union and is never inherited.
function definedSpec(spec: unknown): Row | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const options = (spec as Row).options;
  return Array.isArray(options) && options.length ? (spec as Row) : null;
}

// Every part key a stored `parts` object knows about — the tagged materials,
// BOTH ends of every merge, and the keys already labelled or given a palette. A
// model that folded its legs into another group still HAS those legs.
function partKeysOf(parts: Row | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const bag of [parts?.mats, parts?.labels, parts?.finishes]) {
    for (const k of Object.keys(bagOf(bag))) out.add(k);
  }
  for (const [k, v] of Object.entries(bagOf(parts?.merges))) {
    out.add(k);
    const target = typeof v === 'string' ? v.trim() : '';
    if (target) out.add(target);
  }
  return out;
}

// Whether a group key plays the `structure` role — resolved on the MERGED group
// (a folded child wears its target's identity) and through `partRoleFor`, so an
// untagged SPLIT cluster ("patas~2") still inherits its material's tag.
function isStructureKey(parts: Row | null | undefined, key: string): boolean {
  const group = mergedKeyOf(parts, key) || key;
  return partRoleFor(parts, group, 0, group) === 'structure';
}

/** ONE model's ESTRUCTURA groups. SORTED, not in order of appearance: jsonb key
    order is not meaning, and a model with two structure groups must not answer
    "which palette is mine" differently on the next read. */
export function structureKeysOf(parts: Row | null | undefined): string[] {
  const out = new Set<string>();
  for (const key of partKeysOf(parts)) {
    const group = mergedKeyOf(parts, key) || key;
    if (isStructureKey(parts, group)) out.add(group);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// Legacy rows carry a null collection and read as 'Togo' — the same default the
// catalog payload projects, so a row and its card can't land in two colecciones.
function collectionOf(model: Row | null | undefined): string {
  const raw = model?.collection;
  const name = typeof raw === 'string' ? raw.trim() : '';
  return name || 'Togo';
}

// The row's last-write clock. The app sees `updatedAt` as JS ms (rowMapping
// converts on the way in); the service role reads the RAW column, so the same
// instant arrives here as an ISO `updated_at` string — parsed back to ms rather
// than read as 0, or every server-side row would tie and the two sides of the
// wall could pick DIFFERENT palettes from the same colección.
function stampOf(model: Row | null | undefined): number {
  const raw = model?.updatedAt ?? model?.updated_at;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

// The colección's rows, FRESHEST FIRST — the conflict rule of every read here.
// Two models can disagree about the same key (the dealer edited the settee, then
// the armchair before the first save fanned out); the LAST WORD WINS. A tie
// falls back to the model id, so the union is DETERMINISTIC under row order.
function rankedRows(models: Row[] | null | undefined, collection: unknown): Row[] {
  const want = collectionOf({ collection } as Row);
  return (models || [])
    .filter((m) => m?.id && collectionOf(m) === want)
    .sort((a, b) => stampOf(b) - stampOf(a) || String(a.id).localeCompare(String(b.id)));
}

/** THE COLECCIÓN'S ONE ESTRUCTURA PALETTE, or null — the union over every
    model's structure groups (whatever key each one happens to carry), freshest
    row first. Mirror of `structureFinishesOf`: it answers with the STORED spec,
    not a normalized one, because that is exactly what the VM injects. */
export function collectionStructureFinishes(
  models: Row[] | null | undefined,
  collection: unknown,
): Row | null {
  for (const model of rankedRows(models, collection)) {
    const parts = bagOf(model?.parts);
    const finishes = bagOf(parts.finishes);
    for (const key of structureKeysOf(parts)) {
      const spec = definedSpec(finishes[key]);
      if (spec) return spec;
    }
  }
  return null;
}

// ONE model's parts with every structure group that lacks a palette the Model
// ACCEPTS (`finishSpecOf` — the same gate the configurador lists a group by, so
// an injected group and a saved one are indistinguishable downstream) carrying
// the colección's. A COPY; the caller's row is never mutated.
function withCollectionStructure(parts: Row | null, spec: Row | null): Row | null {
  if (!spec) return parts;
  const keys = structureKeysOf(parts).filter((k) => !finishSpecOf(parts, k));
  if (!keys.length) return parts;
  const own = parts?.finishes;
  const finishes: Row = { ...(own && typeof own === 'object' && !Array.isArray(own) ? own as Row : {}) };
  for (const k of keys) finishes[k] = spec;
  return { ...parts, finishes };
}

/** THE READ-TIME INJECTION — mirror of `resolveTogoModels`'s: the same rows,
    each group MARKED Estructura that carries no valid palette of its own filled
    from its colección's. The union is resolved ONCE per colección and over EVERY
    row (the palette belongs to the family, not to whichever of its pieces
    happens to be active), so this must run BEFORE any active/drawable filter.
    Nothing applies ⇒ the very array that came in, row objects and all. */
export function injectCollectionStructure(models: Row[] | null | undefined): Row[] {
  const rows = models || [];
  const cache = new Map<string, Row | null>();
  const specFor = (collection: string): Row | null => {
    if (!cache.has(collection)) cache.set(collection, collectionStructureFinishes(rows, collection));
    return cache.get(collection) || null;
  };
  let touched = false;
  const out = rows.map((m) => {
    const parts = (m?.parts ?? null) as Row | null;
    const next = withCollectionStructure(parts, specFor(collectionOf(m)));
    if (next === parts) return m;
    touched = true;
    return { ...m, parts: next };
  });
  return touched ? out : rows;
}

/** Max decoded bytes for a visitor-captured composition snapshot (a 960×600
    PNG lands well under this; anything bigger is refused, never resized). */
export const SNAPSHOT_MAX_BYTES = 1_500_000;

/** Decode the widget's composition snapshot (a PNG data URL) to bytes —
    STRICT: png only, base64 only, bounded size; anything else → null (the
    lead still lands, just without a picture). Pure (atob exists in Deno and
    Node alike) so tests/togoQuote.test.js pins it. */
export function snapshotBytesFromDataUrl(raw: unknown, maxBytes = SNAPSHOT_MAX_BYTES): Uint8Array | null {
  const s = typeof raw === 'string' ? raw : '';
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    if (!bin.length || bin.length > maxBytes) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // PNG magic — refuse anything mislabeled.
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
    return bytes;
  } catch {
    return null;
  }
}

const PRICING_MODES = new Set<PricingMode>(['full', 'from', 'hidden']);

// The only statuses a dealer may set through the inbox token — a lead is either
// still open ('pending') or acknowledged ('contacted'). 'converted'/'dismissed'
// are app-side transitions (promotion to a quote / triage), never reachable from
// the public inbox.
export const INBOX_SETTABLE_STATUSES: readonly string[] = ['pending', 'contacted'];

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Coerce a stored timestamp to an ISO string, guarding an unparseable value (an
// invalid Date's toISOString() throws) → null rather than crashing the inbox.
function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A valid, finite, positive scale — anything else (0, negative, NaN, junk)
// falls back to 1 (identity: the dealer's prices == the base retail). NEVER 0:
// a zero factor prices the whole catalog at nothing, which reads as a free sofa
// rather than as a broken configuration.
function safeFactor(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** THE DEALER'S ONE PRICE FACTOR. Two knobs, one meaning each:
 *
 *    price_multiplier — the dealer's MARKUP over Alcover's retail USD
 *    usd_rate         — the FX: USD → the dealer's display `currency`
 *
 *  so a displayed price is `retail USD × multiplier × rate`, labelled with the
 *  dealer's `currency`. They compose into ONE number on purpose: the widget
 *  catalog (applyDealerPricing) and the dealer's own inbox (priceInboxItems)
 *  both scale through this, so what the visitor was shown and what the dealer
 *  quotes from agree to the cent BY CONSTRUCTION — the same reason the monocolor
 *  fold had to be mirrored here.
 *
 *  `usd_rate` was stored, projected and DEAD until now: a EUR dealer's widget
 *  printed Alcover's dollar figure with a € on it, and neither surface could
 *  tell. Each knob guards INDEPENDENTLY (safeFactor), so a dealer may set either
 *  one alone, and the product is guarded again — two enormous knobs multiplying
 *  to Infinity fall back to identity like any other junk. */
export function dealerPriceFactor(dealer: Row | null | undefined): number {
  const d = dealer || {};
  return safeFactor(safeFactor(d.price_multiplier) * safeFactor(d.usd_rate));
}

function validPricingMode(v: unknown): PricingMode {
  return PRICING_MODES.has(v as PricingMode) ? (v as PricingMode) : 'full';
}

/* --------------------------- per-dealer catalog scope --------------------------- */
// THE ONBOARDING KNOB: a dealer carries SOME of the shared catalog, not all of
// it. Offering a visitor a colección their dealer does not sell produces a lead
// that ends in an apology, so `dealers.collections` names what that dealer
// carries — NULL, absent or empty means the WHOLE catalog, which is every dealer
// that predates the column AND Alcover's own no-dealer embed (both must stay
// byte-identical; pinned).
//
// Matching is CASE-FOLDED + TRIMMED against `togo_models.collection`, with a
// legacy null/'' collection reading as 'Togo' — the same default `collectionOf`
// (and the catalog payload, and the inbox shape) already applies, so a row and
// its card can never land in two colecciones.
//
// It gates what is OFFERED, never what was already captured: the catalog payload
// and the lead's known-model filter are scoped, the token-gated INBOX is not.

/** A model row's colección, reduced to its match key (legacy null/'' ⇒ togo). */
function collectionKey(collection: unknown): string {
  return collectionOf({ collection } as Row).toLowerCase();
}

/** The colecciones a dealer carries, as match keys — or null for "everything".
    A blank entry is dropped rather than read as the Togo default: an unnamed
    colección is nothing, where an unnamed MODEL is a legacy Togo. All-blank (or
    a non-array) therefore lands on null — an empty scope has never meant an
    empty catalog, and a bad write must not silently un-stock a dealer. */
export function dealerCollectionScope(dealer: Row | null | undefined): Set<string> | null {
  const raw = dealer?.collections;
  if (!Array.isArray(raw)) return null;
  const out = new Set<string>();
  for (const v of raw) {
    // A scalar name or nothing — coercing an object would add the collection
    // '[object object]', a perfectly valid-looking scope nothing matches.
    const name = typeof v === 'string' ? v.trim() : '';
    if (name) out.add(name.toLowerCase());
  }
  return out.size ? out : null;
}

/** Is this model inside the scope? A null scope carries everything. */
export function isModelInDealerScope(model: Row | null | undefined, scope: Set<string> | null): boolean {
  if (!scope) return true;
  return scope.has(collectionKey(model?.collection));
}

/** The models this dealer's widget may see. Returns the VERY array it was handed
    when the dealer carries the whole catalog (identity, like
    injectCollectionStructure) — the unscoped path cannot diverge by a copy. */
export function filterModelsForDealer(
  models: Row[] | null | undefined,
  dealer: Row | null | undefined,
): Row[] {
  const rows = models || [];
  const scope = dealerCollectionScope(dealer);
  if (!scope) return rows;
  return rows.filter((m) => isModelInDealerScope(m, scope));
}

// The public-safe dealer object the widget receives (camelCase). Numbers are
// coerced, locale defaults 'es', pricingMode is validated with a 'full' fallback.
// NEVER leaks inbox_token, contact_email, notes, the raw multiplier or the
// dealer's catalog scope.
//
// `usdRate` is INFORMATIONAL — every price in the payload is ALREADY converted
// (dealerPriceFactor bakes markup × FX in server-side, so the two halves of the
// wall can never disagree). A consumer that multiplied by it again would double
// the whole catalog; the widget formats the number it is given and only LABELS
// it with `currency`.
export function dealerPublicShape(row: Row | null | undefined): {
  slug: string;
  name: string;
  locale: string;
  currency: string;
  usdRate: number;
  pricingMode: PricingMode;
  logoUrl: string | null;
} {
  const r = row || {};
  return {
    slug: String(r.slug ?? ''),
    name: String(r.name ?? ''),
    locale: String(r.locale || 'es'),
    currency: String(r.currency || 'USD'),
    // The SAME guard the factor applies — one meaning for the knob, so the
    // projected rate can never disagree with the rate the prices were built at.
    usdRate: safeFactor(r.usd_rate),
    pricingMode: validPricingMode(r.pricing_mode),
    logoUrl: r.logo_url ? String(r.logo_url) : null,
  };
}

// Scale a catalog model's USD prices for a dealer — priceUsd and every
// family.byGrade[*].priceUsd × the dealer's PRICE FACTOR (markup × FX, see
// dealerPriceFactor), rounded to 2dp ONCE at the end so the two knobs can't
// drift apart by a rounding step. Takes the DEALER ROW, never a loose number:
// a caller that could pass one knob would eventually pass only one.
// Returns a COPY (never mutates the input, so the shared catalog can be
// re-priced per dealer). No dealer / junk knobs ⇒ identity.
export function applyDealerPricing(model: CatalogModel, dealer: Row | null | undefined): CatalogModel {
  const m = dealerPriceFactor(dealer);
  const scaleFamily = (fam: PricedFamily): PricedFamily => {
    if (!fam || !fam.byGrade || typeof fam.byGrade !== 'object') return fam;
    const byGrade: Record<string, { priceUsd: number; reference?: unknown }> = {};
    for (const [grade, info] of Object.entries(fam.byGrade)) {
      const g = (info || {}) as { priceUsd?: unknown; reference?: unknown };
      byGrade[grade] = { ...g, priceUsd: round2(num(g.priceUsd) * m) };
    }
    return { ...fam, byGrade };
  };
  const price = model.priceUsd;
  const next: CatalogModel = {
    ...model,
    priceUsd: price == null ? null : round2(num(price) * m),
    family: scaleFamily(model.family),
  };
  // Part SKU families (shared cushions/bolsters) scale exactly like the base.
  if (model.partFamilies && typeof model.partFamilies === 'object') {
    next.partFamilies = Object.fromEntries(
      Object.entries(model.partFamilies).map(([role, fam]) => [role, scaleFamily(fam)]),
    );
  }
  return next;
}

// How much of the priced shape reaches the browser:
//   • 'full'   — unchanged (the client reprices per grade, as the internal
//                configurator does).
//   • 'from'   — keep priceUsd (a base "from …" price) but family → null, so the
//                client can't reprice per grade (only the anchor price shows).
//   • 'hidden' — priceUsd → null AND family → null: no price ever reaches the
//                browser (a "request a quote" dealer).
// Returns a COPY; never mutates the input.
export function applyPricingMode(model: CatalogModel, mode: unknown): CatalogModel {
  const m = validPricingMode(mode);
  if (m === 'full') return { ...model };
  // 'from'/'hidden' strip per-grade repricing — the part families go with the
  // base family (they're the same "reprice client-side" capability).
  if (m === 'from') return { ...model, family: null, partFamilies: null };
  return { ...model, priceUsd: null, family: null, partFamilies: null }; // 'hidden'
}

// A stored togo_requests row → the public-safe lead the dealer's inbox lists
// (camelCase). Defensive: contact fields coerced to strings, estimate coerced to
// a number-or-null, createdAt normalized to an ISO string, items passed through
// as-is (already the widget's JSONB shape). NEVER leaks profile_id / dealer_id /
// quote_id.
export function shapeInboxRequest(row: Row | null | undefined): {
  id: string;
  status: string;
  contact: { name: string; phone: string; email: string };
  note: string | null;
  estimateUsd: number | null;
  createdAt: string | null;
  items: unknown[];
} {
  const r = row || {};
  const contact = (r.contact && typeof r.contact === 'object' ? r.contact : {}) as Row;
  const est = Number(r.estimate_usd);
  return {
    id: String(r.id ?? ''),
    status: String(r.status || 'pending'),
    contact: {
      name: String(contact.name ?? ''),
      phone: String(contact.phone ?? ''),
      email: String(contact.email ?? ''),
    },
    note: r.note == null ? null : String(r.note),
    estimateUsd: Number.isFinite(est) && est > 0 ? est : null,
    createdAt: toIso(r.created_at),
    items: Array.isArray(r.items) ? (r.items as unknown[]) : [],
  };
}

/* ------------------------------ inbox item pricing ------------------------------ */

// The catalog pricing machinery (moved here from index.ts so the imperative
// shell — buildCatalog — AND the pure inbox pricer share ONE implementation;
// index.ts imports baseProductFor/familyFor). It mirrors lib/catalog + lib/subtype:
// a graded model's SKUs share an 8-digit family root; the grade letter is the
// trailing char; the cheapest priced SKU under a root is the quoted base.

// A SKU "8 digits + grade letter" is a graded variant → { root, grade };
// anything else is its own root with no grade.
//
// The ladder used to be a hardcoded 23-letter set right here — one of three
// copies under supabase/functions, each carrying its own copy of this split. It
// now arrives as `ladder`, resolved from the brand's own row by the impure
// caller (this module is PURE and may not read a table), and the body is
// `_shared/brandGrades:splitRootGrade`.
function splitGrade(ref: string, ladder: ReadonlySet<string> = gradeSet(null)): { root: string; grade: string } {
  return splitRootGrade(ref, ladder);
}

// The cheapest priced SKU under a family root (8-digit prefix) = the model's
// base grade. Ascending price → the cheapest grade is the quoted base.
export function baseProductFor(root: string | null, products: Row[]): Row | null {
  if (!root) return null;
  let best: Row | null = null;
  for (const p of products) {
    const ref = String(p.reference || '');
    if (!ref.startsWith(root)) continue;
    if (!best || num(p.price_usd) < num(best.price_usd)) best = p;
  }
  return best;
}

// The graded family at a root → the CatalogFamily shape with RETAIL per-grade
// prices baked in (`retail` applies the margin), so the widget/inbox reprices
// identically to the internal configurator.
export function familyFor(
  root: string | null, products: Row[], retail: (n: number) => number,
  ladder: ReadonlySet<string> = gradeSet(null),
) {
  if (!root) return null;
  const byGrade: Record<string, { priceUsd: number; reference: string }> = {};
  let name = '';
  for (const p of products) {
    const ref = String(p.reference || '');
    const { root: r, grade } = splitGrade(ref, ladder);
    if (r !== root || !grade) continue;
    if (!byGrade[grade]) byGrade[grade] = { priceUsd: retail(num(p.price_usd)), reference: ref };
    if (!name && p.name) name = String(p.name);
  }
  const grades = Object.keys(byGrade).sort((a, b) => byGrade[a].priceUsd - byGrade[b].priceUsd);
  if (!grades.length) return null;
  return { root, name, graded: grades.length >= 2, grades, byGrade };
}

// A per-model retail-price lookup: base (the quoted base grade, retail) plus the
// per-grade retail prices. Prices are PRE-factor — priceInboxItems applies the
// dealer's markup × FX last, exactly as buildCatalog → applyDealerPricing does.
export interface PartPriceEntry {
  count: number;                       // billed units of this role on the model
  baseUsd: number | null;              // cheapest grade, retail (the default bill)
  byGrade: Record<string, number>;     // retail per grade (a picked part fabric)
}

export interface PriceEntry {
  baseUsd: number | null;
  byGrade: Record<string, number>;
  // Non-base roles with tagged parts AND a bound SKU root — priced like the base.
  parts?: Record<string, PartPriceEntry>;
  // EVERY billed componente role (partCount > 0), bound SKU or not — the domain
  // of the monocolor question below, and the mirror of the VM's `billed`
  // (`Object.keys(partFamilies).filter(partCount > 0)`, whose keys `partFamiliesFrom`
  // emits for an UNBOUND root too). `parts` cannot answer it: it drops a role with
  // no root, and a divergent pick on one of those still breaks the fold. Absent
  // when the model bills no componente at all — the ordinary piece, whose pricing
  // is byte-identical to before this existed.
  billedRoles?: string[];
}

// Distill the referenced togo_models + their catalogue SKUs into a
// modelId → PriceEntry index at the given retail margin. Pure: `models` are
// raw togo_models rows (id + product_root + parts), `products` the SKUs under
// their roots, `retail` the margin function the caller shares with buildCatalog.
export function buildPriceIndex(
  models: Row[],
  products: Row[],
  retail: (n: number) => number,
  ladder: ReadonlySet<string> = gradeSet(null),
): Record<string, PriceEntry> {
  const gradesOf = (root: string | null): Record<string, number> => {
    const byGrade: Record<string, number> = {};
    const family = familyFor(root, products, retail, ladder);
    if (family) {
      for (const [grade, info] of Object.entries(family.byGrade)) {
        byGrade[grade] = num((info as { priceUsd?: unknown }).priceUsd);
      }
    }
    return byGrade;
  };
  const index: Record<string, PriceEntry> = {};
  for (const m of models) {
    const id = String((m as Row).id ?? '');
    if (!id) continue;
    const root = ((m as Row).product_root as string | null) || null;
    const base = baseProductFor(root, products);
    const entry: PriceEntry = {
      baseUsd: base ? retail(num(base.price_usd)) : null,
      byGrade: gradesOf(root),
    };
    // The model's tagged parts (shared cushion/bolster SKUs) price alongside.
    const parts = ((m as Row).parts ?? null) as Row | null;
    // The BILLED componentes, asked BEFORE (and independently of) the roots: a
    // role tagged with a count but no bound SKU still counts as a componente for
    // the monocolor decision, exactly as it does in the VM (`partFamiliesFrom`
    // keys it with a null family). 'base' is never a componente of itself.
    const billedRoles = PART_ROLES.filter((role) => role !== 'base' && partCount(parts, role) > 0);
    if (billedRoles.length) entry.billedRoles = billedRoles;
    const roots = (parts?.roots ?? null) as Row | null;
    if (roots) {
      const partEntries: Record<string, PartPriceEntry> = {};
      for (const role of PART_ROLES) {
        if (role === 'base') continue;
        const count = partCount(parts, role);
        const partRoot = roots[role] ? String(roots[role]) : null;
        if (!count || !partRoot) continue;
        const partBase = baseProductFor(partRoot, products);
        partEntries[role] = {
          count,
          baseUsd: partBase ? retail(num(partBase.price_usd)) : null,
          byGrade: gradesOf(partRoot),
        };
      }
      if (Object.keys(partEntries).length) entry.parts = partEntries;
    }
    index[id] = entry;
  }
  return index;
}

/** THE ELEMENTO COMPLETO, asked of a stored lead item — the THIRD copy of the
 *  rule, and the reason all three finally answer the same number.
 *
 *  Ligne Roset prices a modular piece two ways out of ONE binding, and which
 *  applies is the CUSTOMER's doing: every componente riding the SAME material ⇒
 *  the piece IS one element and bills on the model's own SKU ALONE (the cheaper
 *  answer, and the DEFAULT build — the componentes are still listed, they are
 *  «incluido»); any componente in a DIFFERENT fabric ⇒ that base SKU PLUS each
 *  componente on its own (the dearer path). The fold shipped client-side
 *  (`resolveCompleteSku`, core/quote/views/configuratorView.js) and in the
 *  auto-quote worker (togo-quote-worker/quoteSeed.ts) and NEVER reached here, so
 *  the dealer's own inbox read a lead the visitor was shown at $12,880 as
 *  $23,190 — the whole SKU plus every rooted componente, each at its cheapest
 *  grade. Same lead, two prices, and the dearer one is the one the dealer quotes
 *  from. The wall forbids importing either mirror (sibling Edge Functions never
 *  import across folders), so the rule lives at THREE layers on purpose; the
 *  fixtures in tests/togoDealer.test.js are the ones tests/togoQuote.test.js
 *  pins the other two with.
 *
 *  MONOCOLOR IS JUDGED BY FABRIC CODE — the identity the customer actually
 *  picked, never the grade (two fabrics share a grade all the time) and never
 *  the fabric name. A componente with NO pick of its own rides the piece's cloth
 *  by construction and therefore agrees; an explicit pick of the very same code
 *  is not a divergence either (a row that reads "different" while the price says
 *  "same" is exactly the disagreement this rule removes). A piece with NO billed
 *  componentes returns false: it has only ever had one price, so there is
 *  nothing to fold in and nothing to mark «incluido».
 *
 *  Zones (exterior/interior) and structure are not componentes — `partCount`
 *  answers 0 for both, so they never enter `billedRoles` and a bicolor zone can
 *  no more break the fold here than it can in the VM. */
export function isCompleteElement(entry: PriceEntry | null | undefined, it: Row): boolean {
  const billed = entry?.billedRoles || [];
  if (!billed.length) return false;
  // MODO COMPONENTES does not sell the model's own SKU, so there is no elemento
  // completo in it; MODO PIEZA always is one, whatever the componentes wear.
  // The mixed-material check that used to live here is gone with its two twins
  // (the VM's resolveCompleteSku and the worker's): on the live catalogue
  // base+componentes bills the body twice — the EXCLUSIF canapé's «Base»
  // componente is itself an EXCLUSIF SOFA at $7,885 against a $9,560 base.
  return placementMode(it) === 'complete';
}

/** Mirror of the VM's `placementMode`. Absent ⇒ modo pieza, so every lead
    captured before the modes existed prices exactly as it always did. */
export function placementMode(it: Row | null | undefined): 'complete' | 'parts' {
  return it?.partsMode === true ? 'parts' : 'complete';
}

// A stored item's chosen grade letter (uppercased to match byGrade keys), or ''
// when the item carries no material/grade.
function itemGrade(it: Row): string {
  const mat = it.material;
  if (mat && typeof mat === 'object') {
    const g = (mat as Row).grade;
    if (g != null && String(g).trim()) return String(g).trim().toUpperCase();
  }
  return '';
}

// Price each stored inbox item and total the request. Per item:
//   • its material.grade priced at the family's byGrade[G] retail price, else
//   • the model's base retail price, else
//   • null (unknown model / no priced SKU),
// then its componentes — but ONLY when the build is not monocolor: a build whose
// componentes all ride the piece's own cloth bills that whole-piece price ALONE
// and lists them «incluido» (`isCompleteElement`, the fold below) — then × the
// dealer's PRICE FACTOR (markup × FX), rounded to 2dp: the same
// list→retail→factor stack the catalog GET uses, off the same dealer row, so the
// inbox states the number the visitor was shown. The dealer's pricing_mode does
// NOT apply here: it gates the visitor widget only; the dealer always sees
// prices in its own inbox.
// totalUsd sums the non-null prices (2dp); null when EVERY item priced null.
//
// A PART PICK OFF ITS LADDER PRICES NOTHING. A module's ladders are different
// SKUs — the settee's own, and its cushion family's (11370012 offers no Grade
// I) — so a cojín dressed in ARDA/FR has a pick this index cannot price. The
// part loop used to fall back to `part.baseUsd`, quietly billing the CHEAPEST
// grade for cloth the visitor never chose, and the zone loop simply ignored it:
// either way the dealer read a confident number for a build nobody had priced.
// The item now prices NULL, which is the same answer the widget's
// `placementTotalUsd` gives and the same shape the worker's `unresolved` gate
// turns into a notified skip.
//
// AND SO DOES THE WHOLE PIECE (2026-08). The base used to keep a documented
// fallback — "the whole piece always has a price of its own" — which reads as
// safety and is the same lie in its purest form: the Prado settee's family
// sells C,D,L,M,S,V, and a lead carrying Grade E TONA silently billed the
// CHEAPEST grade on the ladder, so the dealer's inbox stated a confident
// number for cloth nobody was ever quoted. A grade only means something inside
// the ladder that bills it; outside it there is no price to state, only one to
// invent. NOT a fallback: an item with NO pick at all still bills the base
// (the module ships in its cheapest cloth by convention, and that is what the
// palette has always shown), and a model with fewer than two grades has no
// ladder to be off — `productForGrade` prices any grade on it, so the widget
// half agrees and the two never diverge.
export function priceInboxItems(
  items: unknown[],
  priceIndex: Record<string, PriceEntry>,
  dealer: Row | null | undefined,
): { items: Array<Record<string, unknown>>; totalUsd: number | null } {
  const mult = dealerPriceFactor(dealer);
  let sum = 0;
  let anyPriced = false;
  const priced = (Array.isArray(items) ? items : []).map((raw) => {
    const it = (raw && typeof raw === 'object' ? raw : {}) as Row;
    const entry = priceIndex[String(it.modelId ?? '')] || null;
    let base: number | null = null;
    let complete = false;
    if (entry) {
      const picks = (it.partMaterials && typeof it.partMaterials === 'object' ? it.partMaterials : {}) as Row;
      // MONOCOLOR? — asked ONCE, off the stored picks, before anything is added.
      const uniform = isCompleteElement(entry, it);
      // A pick naming a grade its ladder doesn't carry: the item is unpriceable,
      // and stays so however well the rest of it adds up.
      let unpriceable = false;
      const grade = itemGrade(it);
      // A REAL ladder is two grades or more — the same `graded` rule
      // groupFamilies applies client-side, so a lone/ungraded SKU keeps pricing
      // any pick exactly as it does there (and as it does here today).
      const laddered = Object.keys(entry.byGrade).length >= 2;
      // MODO COMPONENTES starts at ZERO — the model's own SKU is not sold — and
      // the componentes below are the whole price. Modo pieza resolves that SKU
      // exactly as it always has.
      if (placementMode(it) === 'parts') base = 0;
      else if (grade && entry.byGrade[grade] != null) base = entry.byGrade[grade];
      else if (grade && laddered) unpriceable = true;
      else if (entry.baseUsd != null) base = entry.baseUsd;
      // THE FOLD. Monocolor ⇒ that whole-piece price is the WHOLE price: no
      // componente bills, no zone re-grades (a zone is a materialization of the
      // very SKU the piece is already billing, and the VM's complete path
      // ignores it for exactly that reason), and no componente ladder can make
      // the item unpriceable — the cushion SKU is not being sold here, so a
      // grade it never carried is not a gap. Whatever the whole-piece resolution
      // above decided STANDS, which is what keeps the off-ladder gate composed:
      // an unresolvable uniform build still prices null, it never folds to a
      // number. Mirror of `placementTotalUsd` (complete.unitUsd) and of
      // buildSeedComponents' `complete ? [] : …`.
      if (!uniform) {
        // Materialization zones (ottoman interior/exterior) re-grade the BASE
        // SKU: a bicolor piece prices at its DEAREST zone grade — the base SKU
        // is the complete materialization, so nothing else is added for a zone.
        for (const role of MATERIALIZATION_ROLES) {
          const pick = (picks[role] && typeof picks[role] === 'object' ? picks[role] : null) as Row | null;
          const g = pick?.grade ? String(pick.grade).trim().toUpperCase() : '';
          if (!g) continue;
          const v = entry.byGrade[g];
          if (v == null) { unpriceable = true; continue; }
          if (base == null || v > base) base = v;
        }
        // Tagged parts bill on top: each at its picked grade (item.partMaterials),
        // unpicked at its cheapest — the module ships with them either way. Same
        // convention as the widget/quote-line, so all three agree to the cent.
        if (base != null && entry.parts) {
          for (const [role, part] of Object.entries(entry.parts)) {
            const pick = (picks[role] && typeof picks[role] === 'object' ? picks[role] : null) as Row | null;
            const g = pick?.grade ? String(pick.grade).trim().toUpperCase() : '';
            // MODO COMPONENTES has NO price until every componente is chosen —
            // «no se puede quedar un componente vacío» — so an unpicked one is
            // a gap, never a fallback to the cheapest grade.
            if (!pick && placementMode(it) === 'parts') { unpriceable = true; continue; }
            if (g && part.byGrade[g] == null) { unpriceable = true; continue; }
            const unit = g ? part.byGrade[g] : part.baseUsd;
            if (unit != null) base += unit * part.count;
          }
        }
      }
      if (unpriceable) base = null;
      // The «incluido» marker, mirror of placementBreakdown's base line: the
      // fold RESOLVED, so this one price bought the componentes too. Emitted
      // only with a price on it — a uniform build the ladder can't price is a
      // gap to close, never something already paid for — and only when it
      // applies, so an ordinary item's shape is byte-identical to before.
      complete = uniform && base != null;
    }
    const priceUsd = base == null ? null : round2(base * mult);
    if (priceUsd != null) { anyPriced = true; sum += priceUsd; }
    return complete ? { ...it, priceUsd, complete: true } : { ...it, priceUsd };
  });
  return { items: priced, totalUsd: anyPriced ? round2(sum) : null };
}
