/**
 * FINISHES — a palette belongs to the COLLECTION, not to a model, and the
 * studio must say how far a save will reach BEFORE it commits.
 *
 * The dealer types «Legs: steel / black lacquered steel» once on one Prado and
 * means it for every Prado. Storage disagrees (each model row carries its own
 * `parts.finishes` bag), so this module is the translation: it reads a
 * collection's palettes as a union and PLANS the sibling writes that keep them
 * agreeing. The plan is also the preview — «this will also change N models» is
 * counted straight off the rows that will be written, so the number the dealer
 * reads is the plan that then runs (`blastRadius`).
 *
 * Two sharing rules, and they must never both claim a key:
 *   • a normal palette shares BY KEY — pCon reuses one material id per part type
 *     across a collection, so "the legs" really do arrive under the same key on
 *     every model of the family;
 *   • a STRUCTURE palette shares BY ROLE — the settee's legs can export as
 *     `metal_01` and the armchair's as `metal_02`, and a key-based fan-out never
 *     reaches the armchair. A structure palette is a collection-level parameter:
 *     it lands on every group marked structure, whatever key it carries.
 *
 * Ported from the reference `lib/togo/collectionFinishes.js`. Pure: plain data
 * in, plans out — the caller performs the writes.
 */
import { finishSpecOf, mergedKeyOf, partRoleFor, structureStarterFinish } from '@veta/materials';
import type { FinishOption, FinishSpec } from '@veta/materials';
import type { PartsDraft } from './types.ts';

/** The minimum a model must look like to take part in a fan-out. */
export interface FinishModel {
  id: string;
  collection?: string | null;
  parts?: PartsDraft | null;
  /** Freshness for the union's conflict rule; missing reads as 0. */
  updatedAt?: number | null;
}

/** One planned sibling write. */
export interface FanoutRow {
  id: string;
  parts: PartsDraft;
}

/** A palette as the dealer typed it — normalized only at read time. */
export type FinishSpecDraft = { label?: string | null; options?: unknown[]; default?: string | null } & Record<string, unknown>;

const bagOf = (v: unknown): Record<string, any> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** A collection name, normalized. An unnamed model belongs to `''` — its own
 *  bucket, never everyone's. */
const collectionOf = (m: { collection?: string | null } | null | undefined): string =>
  (typeof m?.collection === 'string' ? m.collection.trim() : '');

/**
 * A spec that COUNTS as defined. The editor deletes a key rather than storing an
 * empty palette, so an options-less object, an array or a stray null is not a
 * definition: it never enters the union, is never inherited, is never fanned out.
 */
function definedSpec(spec: unknown): FinishSpecDraft | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const s = spec as FinishSpecDraft;
  return Array.isArray(s.options) && s.options.length ? s : null;
}

/**
 * Structural equality. jsonb key order is not meaning and a round trip can
 * reorder it, so a re-serialized identical palette MUST compare equal —
 * otherwise every save rewrites every sibling forever and the blast radius
 * never reads 0.
 */
function sameSpec(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameSpec(v, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameSpec((a as any)[k], (b as any)[k]));
}

/** Every part key a stored `parts` knows about — tagged materials, both ends of
 *  every merge, and anything already labelled or painted. A model that folded
 *  its legs into another group still HAS those legs. */
function partKeysOf(parts: PartsDraft | null | undefined): Set<string> {
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

/** Whether a model carries this group key at all — itself, or via a merge. */
function hasGroupKey(parts: PartsDraft | null | undefined, groupKey: string): boolean {
  for (const key of partKeysOf(parts)) {
    if (key === groupKey || mergedKeyOf(parts, key) === groupKey) return true;
  }
  return false;
}

/** Whether a key plays the structure role — asked of the MERGED group and
 *  through `partRoleFor`, so an untagged split cluster inherits its material's
 *  tag exactly as it does everywhere else. */
export function isStructureKey(parts: PartsDraft | null | undefined, key: string): boolean {
  const group = mergedKeyOf(parts, key) || key;
  return partRoleFor(parts, group, 0, group) === 'structure';
}

/** ONE model's structure groups, SORTED — jsonb key order is not meaning, and a
 *  model with two structure groups must answer the same on every read. */
export function structureKeysOf(parts: PartsDraft | null | undefined): string[] {
  const out = new Set<string>();
  for (const key of partKeysOf(parts)) {
    const group = mergedKeyOf(parts, key) || key;
    if (isStructureKey(parts, group)) out.add(group);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The collection's rows, FRESHEST FIRST — the conflict rule of every read here.
 *  Two models can disagree about a key; the last save is the dealer's latest
 *  intent. A tie falls back to the id so the union is deterministic. */
function rankedRows<T extends FinishModel>(models: readonly T[] | null | undefined, collection: string | null | undefined): T[] {
  const want = collectionOf({ collection });
  const stamp = (m: T): number => (Number.isFinite(Number(m?.updatedAt)) ? Number(m.updatedAt) : 0);
  return (models || [])
    .filter((m) => m?.id && collectionOf(m) === want)
    .slice()
    .sort((a, b) => stamp(b) - stamp(a) || String(a.id).localeCompare(String(b.id)));
}

/** THE COLLECTION'S PALETTES — the union of every model's `parts.finishes`. */
export function collectionFinishesOf(
  models: readonly FinishModel[] | null | undefined,
  collection: string | null | undefined,
): Record<string, FinishSpecDraft> {
  const out: Record<string, FinishSpecDraft> = {};
  for (const model of rankedRows(models, collection)) {
    for (const [key, raw] of Object.entries(bagOf(model?.parts?.finishes))) {
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;   // a fresher row already spoke
      const spec = definedSpec(raw);
      if (spec) out[key] = spec;
    }
  }
  return out;
}

/** THE COLLECTION'S ONE STRUCTURE PALETTE, or null — the whole point of the role
 *  is that a collection has a SINGLE structure finish, so this answers with the
 *  spec itself rather than a map. */
export function structureFinishesOf(
  models: readonly FinishModel[] | null | undefined,
  collection: string | null | undefined,
): FinishSpecDraft | null {
  for (const model of rankedRows(models, collection)) {
    const parts = model?.parts || null;
    const finishes = bagOf(parts?.finishes);
    for (const key of structureKeysOf(parts)) {
      const spec = definedSpec(finishes[key]);
      if (spec) return spec;
    }
  }
  return null;
}

/** The parts with ONE palette written (or removed) — everything else rides
 *  through, and an emptied `finishes` is pruned. */
export function writeFinish(parts: PartsDraft | null | undefined, key: string, spec: unknown): PartsDraft {
  const finishes = { ...bagOf(parts?.finishes) };
  const next = definedSpec(spec);
  if (next) finishes[key] = next; else delete finishes[key];
  const out: PartsDraft = { ...(parts || {}) };
  if (Object.keys(finishes).length) out.finishes = finishes; else delete out.finishes;
  return out;
}

/** The draft with every empty sub-bag dropped — the shape a commit writes. */
export function prunedParts(parts: PartsDraft | null | undefined): PartsDraft {
  const next: PartsDraft = { ...(parts || {}) };
  for (const k of ['merges', 'labels', 'finishes', 'roots', 'counts']) {
    const bag = (next as Record<string, unknown>)[k];
    if (bag && typeof bag === 'object' && !Object.keys(bag as object).length) delete (next as Record<string, unknown>)[k];
  }
  return next;
}

/** The canonical starter pair (steel / black-lacquered steel) planted on ONE
 *  group. Exists because marking a group structure and DEFINING its palette are
 *  two independent writes, and a structure with no palette renders as nothing in
 *  the widget while reading as finished in the studio. */
export function applyStarterStructure(parts: PartsDraft | null | undefined, key: string): PartsDraft {
  return writeFinish(parts, key, structureStarterFinish());
}

/** The EDITED model's own half of the role rule: every one of ITS structure
 *  groups carries `spec` (or loses it when null). A model with no structure
 *  groups rides through untouched, which is what makes this safe to call
 *  without asking first. */
export function applyStructureToDraft(parts: PartsDraft | null | undefined, spec: unknown): PartsDraft {
  const next = definedSpec(spec);
  let out: PartsDraft = parts || {};
  for (const key of structureKeysOf(parts)) out = writeFinish(out, key, next);
  return out;
}

export interface KeyFanoutParams {
  collection?: string | null;
  sourceModelId?: string | null;
  groupKey: string;
  spec?: unknown;
}

/**
 * THE FAN-OUT for ONE palette — every OTHER model of the collection that
 * CONTAINS the key takes `spec`, or loses it when `spec` is null (removing a
 * palette shares exactly like defining one). A model without the part is never
 * touched, and neither is one that already agrees: the plan is what CHANGES, so
 * a re-save plans nothing and the preview line counts straight off it.
 */
export function planFinishFanout(
  models: readonly FinishModel[] | null | undefined,
  { collection, sourceModelId, groupKey, spec }: KeyFanoutParams,
): FanoutRow[] {
  const key = typeof groupKey === 'string' ? groupKey.trim() : '';
  if (!key) return [];
  const next = definedSpec(spec);
  const want = collectionOf({ collection });
  const out: FanoutRow[] = [];
  for (const model of models || []) {
    if (!model?.id || model.id === sourceModelId) continue;
    if (collectionOf(model) !== want) continue;
    const parts = model.parts || null;
    if (!hasGroupKey(parts, key)) continue;
    const finishes = bagOf(parts?.finishes);
    const had = Object.prototype.hasOwnProperty.call(finishes, key);
    if (next ? sameSpec(finishes[key], next) : !had) continue;
    out.push({ id: model.id, parts: writeFinish(parts, key, next) });
  }
  return out;
}

/** The palettes a save actually MOVED. Diffed here so no view has to, and it is
 *  what keeps the fan-out narrow — a save that only renamed a part must not
 *  rewrite the collection. */
function changedFinishKeys(before: unknown, after: unknown): string[] {
  const a = bagOf(before);
  const b = bagOf(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !sameSpec(definedSpec(a[k]), definedSpec(b[k])));
}

export interface FinishSyncParams {
  collection?: string | null;
  sourceModelId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * THE FAN-OUT for a whole save — `planFinishFanout` FOLDED over every palette
 * that changed. Folded rather than looped at the call site because two changed
 * keys can land on the same sibling: the second plan must see the first one's
 * rewrite, or it would be computed from the stale row and drop it.
 */
export function planFinishSync(
  models: readonly FinishModel[] | null | undefined,
  { collection, sourceModelId, before, after }: FinishSyncParams,
): FanoutRow[] {
  const changed = changedFinishKeys(before, after);
  if (!changed.length) return [];
  let rows: FinishModel[] = [...(models || [])];
  const byId = new Map<string, PartsDraft>();
  for (const key of changed) {
    const plan = planFinishFanout(rows, { collection, sourceModelId, groupKey: key, spec: bagOf(after)[key] });
    if (!plan.length) continue;
    const patch = new Map(plan.map((p) => [p.id, p.parts]));
    for (const [id, parts] of patch) byId.set(id, parts);
    rows = rows.map((m) => (m?.id && patch.has(m.id) ? { ...m, parts: patch.get(m.id)! } : m));
  }
  return [...byId].map(([id, parts]) => ({ id, parts }));
}

export interface StructureFanoutParams {
  collection?: string | null;
  sourceModelId?: string | null;
  spec?: unknown;
}

/**
 * THE STRUCTURE FAN-OUT — by ROLE. Every OTHER model of the collection takes
 * `spec` on EVERY one of its structure groups.
 *
 * What it REFUSES to touch is the safety of the whole thing: a model with no
 * structure groups is never written, a non-structure group is never written even
 * when it carries the very same key, another collection is never written, and a
 * model that already agrees is never written. A RETRACTION must be OWNED — a
 * null spec coming from a model that has no structure at all is an unrelated
 * save passing through, and letting it fan would blank every sibling's palette
 * as a side effect of touching an empty model.
 */
export function planStructureFanout(
  models: readonly FinishModel[] | null | undefined,
  { collection, sourceModelId, spec }: StructureFanoutParams,
): FanoutRow[] {
  const next = definedSpec(spec);
  const want = collectionOf({ collection });
  if (!next) {
    const source = (models || []).find((m) => m?.id === sourceModelId);
    if (!source || !structureKeysOf(source.parts).length) return [];
  }
  const out: FanoutRow[] = [];
  for (const model of models || []) {
    if (!model?.id || model.id === sourceModelId) continue;
    if (collectionOf(model) !== want) continue;
    const parts = model.parts || null;
    const keys = structureKeysOf(parts);
    if (!keys.length) continue;
    // Folded, not mapped: a model with two structure groups is ONE write, and
    // the second key must see the first one's rewrite.
    let patched: PartsDraft | null = null;
    for (const key of keys) {
      const finishes = bagOf((patched || parts)?.finishes);
      const had = Object.prototype.hasOwnProperty.call(finishes, key);
      if (next ? sameSpec(finishes[key], next) : !had) continue;
      patched = writeFinish(patched || parts, key, next);
    }
    if (patched) out.push({ id: model.id, parts: patched });
  }
  return out;
}

export interface FinishCommitParams {
  collection?: string | null;
  sourceModelId?: string | null;
  /** The parts draft's `finishes` as it was LOADED. */
  before?: unknown;
  /** …and as it is being saved. */
  after?: unknown;
  /** The whole draft — the structure rule reads roles off it. */
  parts?: PartsDraft | null;
}

/** Everything one save implies, plus the number to show before committing. */
export interface FinishCommitPlan {
  rows: FanoutRow[];
  /** How many OTHER models this save rewrites — the blast radius. */
  blastRadius: number;
  /** True when the structure palette itself moved (shared by role). */
  structureMoved: boolean;
}

/**
 * THE ONE FAN-OUT PLAN — used both to WRITE on save and to PREVIEW before it, so
 * the number the dealer reads is the plan that runs.
 *
 * The two rules share one `finishes` bag and must not both claim a key, so the
 * structure keys are STRIPPED out of the key-based diff rather than fanned out
 * twice. Structure is planned against the rows AS THE KEY PASS LEFT THEM — one
 * sibling can be touched by both passes, and the second must see the first's
 * rewrite. And it only fires when this save actually MOVED that palette, which
 * is what keeps a save that merely renamed a part from rewriting the collection.
 */
export function planFinishCommit(
  models: readonly FinishModel[] | null | undefined,
  { collection, sourceModelId, before, after, parts }: FinishCommitParams,
): FinishCommitPlan {
  const structureKeys = structureKeysOf(parts);
  const skip = new Set(structureKeys);
  const byKey = (bag: unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(bagOf(bag)).filter(([k]) => !skip.has(k)));

  let rows: FinishModel[] = [...(models || [])];
  const planned = new Map<string, PartsDraft>();
  for (const p of planFinishSync(rows, {
    collection, sourceModelId, before: byKey(before), after: byKey(after),
  })) planned.set(p.id, p.parts);

  let structureMoved = false;
  if (structureKeys.length) {
    const spec = structureFinishesOf(
      [{ id: sourceModelId || 'self', collection, parts: { ...(parts || {}), finishes: bagOf(after) } }],
      collection,
    );
    // Did THIS save move it? Asked of the module itself: the draft's palette
    // planned onto this model as it was LOADED. A row comes back only when the
    // two genuinely disagree.
    structureMoved = planStructureFanout(
      [{ id: 'before', collection, parts: { ...(parts || {}), finishes: bagOf(before) } }],
      { collection, sourceModelId: null, spec },
    ).length > 0;
    if (structureMoved) {
      rows = rows.map((m) => (m?.id && planned.has(m.id) ? { ...m, parts: planned.get(m.id)! } : m));
      for (const p of planStructureFanout(rows, { collection, sourceModelId, spec })) planned.set(p.id, p.parts);
    }
  }
  const out = [...planned].map(([id, next]) => ({ id, parts: next }));
  return { rows: out, blastRadius: out.length, structureMoved };
}

export type StructureFinishStatus = 'off' | 'ready' | 'partial' | 'invalid' | 'empty';

export interface StructureFinishState {
  group: string;
  structure: boolean;
  status: StructureFinishStatus;
  /** True when the client will actually be offered something. */
  ready: boolean;
  own: FinishSpec | null;
  collection: FinishSpec | null;
  effective: FinishSpec | null;
  /** Rows the dealer typed that the normalizer THREW AWAY (no name, no hex). */
  dropped: number;
  rawCount: number;
}

const STAGE_KEY = '\0spec';
/** A loose spec run through the SAME normalizer every consumer trusts — staged
 *  in a bag because `finishSpecOf` only reads out of one. */
function normalizedSpec(spec: unknown): FinishSpec | null {
  return spec ? finishSpecOf({ finishes: { [STAGE_KEY]: spec } } as PartsDraft, STAGE_KEY) : null;
}

/**
 * WILL THIS STRUCTURE REACH THE CLIENT? — the studio's one honest answer, since
 * a group can be marked structure and render as nothing (the widget lists a
 * structure group only when it has a palette the Model accepts).
 */
export function resolveStructureFinish(
  parts: PartsDraft | null | undefined,
  key: string,
  collectionSpec: unknown = null,
): StructureFinishState {
  const group = mergedKeyOf(parts, key) || key;
  const structure = isStructureKey(parts, group);
  const own = finishSpecOf(parts, group);
  const raw = definedSpec(bagOf(parts?.finishes)[group]);
  const rawCount = raw ? (raw.options as unknown[]).length : 0;
  const dropped = Math.max(0, rawCount - (own?.options?.length || 0));
  // Only consulted when the group has nothing of its own — the collection never
  // outranks the model's own word about its own part.
  const shared = own ? null : normalizedSpec(collectionSpec);

  let status: StructureFinishStatus;
  if (!structure) status = 'off';
  else if (own) status = dropped ? 'partial' : 'ready';
  else if (rawCount) status = 'invalid';
  else if (shared) status = 'ready';
  else status = 'empty';

  return {
    group,
    structure,
    status,
    ready: status === 'ready' || status === 'partial',
    own,
    collection: shared,
    effective: own || shared,
    dropped,
    rawCount,
  };
}

/** A palette draft the editor mutates — options in, options out, always a real
 *  array so a View never has to guard the shape. */
export function paletteDraftOf(spec: unknown): { label: string; options: FinishOption[]; default: string } {
  const s = definedSpec(spec);
  const normalized = normalizedSpec(s);
  return {
    label: (typeof s?.label === 'string' ? s.label : '') || '',
    options: normalized?.options ? [...normalized.options] : [],
    default: normalized?.default || '',
  };
}
