/**
 * SHARED FINISHES — a part's palette belongs to the COLECCIÓN, not to a model.
 *
 * The dealer types «Patas: Acero / Acero lacado negro» once on ONE Prado and
 * means it for every Prado: the legs of the settee, of the armchair and of the
 * ottoman are the same legs, from the same list, at the same price. Storage
 * disagrees — `togo_models.parts.finishes` is per MODEL — so this module is the
 * translation between the two: it reads a colección's palettes as a UNION, and
 * it plans the writes that keep every sibling carrying the same one.
 *
 * Sharing keys on the GROUP KEY, and that is only sound because of how pCon
 * exports: it reuses ONE material id per part type across a whole collection
 * (the same fact `classifyPartGroups` fingerprints accessories against), so
 * "the legs" really do arrive under the same key on every model of the family.
 * A key that doesn't recur simply never fans out — a model is only ever written
 * for a part it actually has.
 *
 * ESTRUCTURA IS THE EXCEPTION, and it shares BY ROLE instead (owner, 2026-07:
 * «estructura is the same across a collection and parameters should be saved to
 * be applied to all items in collection marked estructura»). The key rule is not
 * enough for it: the settee's legs can export as `metal_01` and the armchair's
 * as `metal_02`, and then a key-based fan-out never reaches the armchair — the
 * dealer retypes the same acero / acero lacado negro on every model. So a
 * `structure` palette is a COLECCIÓN-LEVEL PARAMETER: it lands on every group
 * MARKED Estructura in the colección, whatever key each one happens to carry
 * (`planStructureFanout`), and inside the edited model too
 * (`applyStructureToDraft`) — the rule is about the ROLE, not about who is being
 * edited. Storage is unchanged: it still lands in each model's
 * `parts.finishes[groupKey]`, so nothing downstream learns a new shape.
 *
 * A PER-KEY palette shares ON SAVE; ESTRUCTURA ALSO SHARES ON READ. The key
 * rule rewrites siblings, so what every consumer reads is still the model's own
 * stored row — no migration, no new table, no server change. The estructura
 * palette rides that AND a READ-TIME INJECTION: `resolveTogoModels`
 * (core/quote/views/configuratorView.js) resolves `structureFinishesOf` once per
 * colección and drops it onto every group marked Estructura that carries no
 * valid palette of its own, on a COPY — nothing is written, the stored row is
 * untouched, and the studio still edits exactly what is stored.
 *
 * That injection is what makes the role AUTOMATIC (owner, 2026-07: «QUITA LO DE
 * USAR EN ESTE MODELO. HAZLO AUTOMATICO»). Marking a group Estructura used to be
 * only half a write — the palette shown next to it lived on a SIBLING's row, and
 * a button had to be pressed to make it real. Now a pieza marcada Estructura
 * simply HAS the colección's acabados, and every row saved before this existed
 * stops being a dead end without anyone reopening it.
 *
 * Pure: plain data in, plans out. No React, no db, no supabase — the studio
 * calls it and performs the writes it hands back.
 */
import { canonicalCollection } from './collections.js';
import { finishSpecOf, mergedKeyOf, partRoleFor } from './meshParts.js';

/** Legacy rows carry a null collection and read as 'Togo' — the SAME default
 *  `resolveTogoModelCards` projects, so a card and its raw row can never land
 *  in two different colecciones.
 *
 *  CANONICAL, for that same reason: the cards VM folds «Exclusif»/«EXCLUSIF»
 *  into one collection, and a fan-out comparing raw strings would have reached
 *  only the 12 rows spelled like the card and silently skipped the other 38 —
 *  a palette applied to a quarter of its own colección. */
function collectionOf(model) {
  return canonicalCollection(model?.collection);
}

/** A plain jsonb bag, or an empty one — `parts`, `finishes` and friends are
 *  dealer-authored jsonb, so an array or a string is possible and is nothing. */
const bagOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * A finish spec that COUNTS as defined. The studio only ever stores a palette
 * with at least one option (emptying it deletes the key — `setFinish`), so an
 * options-less object, an array or a stray null is not a definition: it never
 * enters the union, is never inherited, and is never fanned out. `finishSpecOf`
 * still decides what RENDERS; this only decides what the dealer said.
 */
function definedSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  return Array.isArray(spec.options) && spec.options.length ? spec : null;
}

/**
 * Structural equality for a stored spec. Key order in jsonb is not meaning and
 * a round-trip can reorder it, so a re-serialized identical palette MUST
 * compare equal — otherwise every save would rewrite every sibling forever
 * (and the "se aplicarán también a N modelos" line would never read 0).
 */
function sameSpec(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameSpec(v, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameSpec(a[k], b[k]));
}

/**
 * Every part key a stored `parts` object knows about — the tagged materials,
 * BOTH ends of every merge, and the keys the dealer already labelled or gave a
 * palette. Containment is asked of the whole row rather than of `mats` alone: a
 * model that folded its legs into another group still HAS those legs, and one
 * that only carries the palette (because a previous fan-out put it there) must
 * stay in sync instead of keeping an orphan copy forever.
 */
function partKeysOf(parts) {
  const out = new Set();
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

/** Whether a model carries this group key at all: it knows the key itself, or
 *  one of its keys FOLDS INTO it (`mergedKeyOf` — a merged child renders under
 *  the target's identity, so the target's palette is the one it wears). */
function hasGroupKey(parts, groupKey) {
  for (const key of partKeysOf(parts)) {
    if (key === groupKey || mergedKeyOf(parts, key) === groupKey) return true;
  }
  return false;
}

/**
 * Whether a group key plays the `structure` role in this model — resolved the
 * way the rest of the app resolves a role: on the MERGED group (`mergedKeyOf` —
 * a folded child wears its target's identity, so it never drags the group into
 * a role of its own) and through `partRoleFor`, so an untagged SPLIT cluster
 * ("patas~2") still inherits its material's tag. Untagged reads as `base`,
 * exactly as everywhere else, which is why a model tagged before Estructura
 * existed has no structure groups and is therefore never written.
 *
 * Asked of ONE key, because a caller with a live stage knows keys the stored
 * row has never heard of: a split cluster exists in the MESH, and it only
 * enters `parts` once the dealer labels, folds or paints it.
 */
function isStructureKey(parts, key) {
  const group = mergedKeyOf(parts, key) || key;
  return partRoleFor(parts, group, 0, group) === 'structure';
}

/**
 * ONE model's ESTRUCTURA groups — the group keys it renders whose role is
 * `structure`. This is what makes the estructura palette shareable across a
 * colección that never agreed on a key: the question asked of every model is
 * "which of your parts are marked Estructura", not "do you have `metal_01`".
 *
 * SORTED, not in order of appearance: jsonb key order is not meaning and a
 * round-trip can reorder it, so a model with two structure groups must not
 * answer "which palette is mine" differently on the next read
 * (`structureFinishesOf` takes the first defined one).
 */
export function structureKeysOf(parts) {
  const out = new Set();
  for (const key of partKeysOf(parts)) {
    const group = mergedKeyOf(parts, key) || key;
    if (isStructureKey(parts, group)) out.add(group);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The colección's rows, FRESHEST FIRST — the conflict rule of every read here.
 *
 * Two models can disagree about the same key: the dealer edited the legs on the
 * settee, then again on the armchair before the first save had fanned out, or a
 * row was written by an older build. The LAST WORD WINS, and `updatedAt` is
 * exactly that — every write to a togo_models row touches it, so the most
 * recently saved model carries the dealer's latest intent.
 *
 * A tie (same millisecond, or a row with no stamp at all) falls back to the
 * model id, so the union is DETERMINISTIC: the studio must not paint one
 * palette on this render and another on the next just because the rows arrived
 * in a different order, and a fan-out must never oscillate between two answers.
 */
function rankedRows(models, collection) {
  const want = collectionOf({ collection });
  const stamp = (m) => (Number.isFinite(Number(m?.updatedAt)) ? Number(m.updatedAt) : 0);
  return (models || [])
    .filter((m) => m?.id && collectionOf(m) === want)
    .sort((a, b) => stamp(b) - stamp(a) || String(a.id).localeCompare(String(b.id)));
}

/**
 * THE COLECCIÓN'S PALETTES — the union of every model's `parts.finishes`,
 * `{ [groupKey]: spec }`. What the collection as a whole offers for each part
 * type; the freshest definition of a key wins (see `rankedRows`).
 */
export function collectionFinishesOf(models, collection) {
  const out = {};
  for (const model of rankedRows(models, collection)) {
    for (const [key, raw] of Object.entries(bagOf(model?.parts?.finishes))) {
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;   // a fresher row already spoke
      const spec = definedSpec(raw);
      if (spec) out[key] = spec;
    }
  }
  return out;
}

/**
 * THE COLECCIÓN'S ONE ESTRUCTURA PALETTE, or null.
 *
 * Not a map like `collectionFinishesOf`: the whole point of the role is that
 * the colección has a SINGLE acabado de estructura, so this answers with the
 * spec itself. The union runs over every model's structure groups (whatever
 * their keys), freshest row first — the same `rankedRows` conflict rule every
 * read here shares, so the last save is the dealer's latest intent and a tie
 * still resolves the same way on every render.
 */
export function structureFinishesOf(models, collection) {
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

/** The sibling's parts with ONLY its palette for `key` touched — mats, roots,
 *  counts, labels and merges ride through untouched (by reference), and an
 *  emptied `finishes` is pruned, the same shape the studio's own save writes. */
function withFinish(parts, key, spec) {
  const finishes = { ...bagOf(parts?.finishes) };
  if (spec) finishes[key] = spec; else delete finishes[key];
  const next = { ...bagOf(parts) };
  if (Object.keys(finishes).length) next.finishes = finishes; else delete next.finishes;
  return next;
}

/**
 * THE FAN-OUT for ONE palette: the sibling rows that must be rewritten so the
 * colección agrees about `groupKey`, as `[{ id, parts }]` ready for
 * `db.togoModels.update`.
 *
 * Every OTHER model of the colección that CONTAINS the key (see `hasGroupKey`)
 * takes `spec` — or loses the key when `spec` is null (removing a palette is
 * shared exactly like defining one). A model without the part is never touched,
 * and neither is one that already carries the identical spec: the plan is what
 * CHANGES, so re-saving an unchanged palette plans nothing and the studio's
 * preview line can be counted straight off it.
 */
export function planFinishFanout(models, { collection, sourceModelId, groupKey, spec } = {}) {
  const key = typeof groupKey === 'string' ? groupKey.trim() : '';
  if (!key) return [];
  const next = definedSpec(spec);                       // null ⇒ the palette was removed
  const want = collectionOf({ collection });
  const out = [];
  for (const model of models || []) {
    if (!model?.id || model.id === sourceModelId) continue;
    if (collectionOf(model) !== want) continue;
    const parts = bagOf(model.parts);
    if (!hasGroupKey(parts, key)) continue;             // not this model's part — leave it alone
    const finishes = bagOf(parts.finishes);
    const had = Object.prototype.hasOwnProperty.call(finishes, key);
    if (next ? sameSpec(finishes[key], next) : !had) continue;   // already agrees
    out.push({ id: model.id, parts: withFinish(parts, key, next) });
  }
  return out;
}

/** The palettes a save actually MOVED: the keys of either map whose defined
 *  spec differs. Diffing lives here so the view never has to; it is also what
 *  keeps the fan-out narrow — a save that only renamed a part must not rewrite
 *  the whole colección. */
function changedFinishKeys(before, after) {
  const a = bagOf(before);
  const b = bagOf(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !sameSpec(definedSpec(a[k]), definedSpec(b[k])));
}

/**
 * THE FAN-OUT for a whole save — `planFinishFanout` folded over every palette
 * that changed between the parts draft as it was LOADED (`before`) and as it is
 * being saved (`after`), as one write per sibling.
 *
 * Folded rather than looped at the call site because two changed keys can land
 * on the SAME sibling: each plan must see the previous one's rewrite, or the
 * second write would be computed from the stale row and would drop the first
 * palette on the floor.
 */
export function planFinishSync(models, { collection, sourceModelId, before, after } = {}) {
  const changed = changedFinishKeys(before, after);
  if (!changed.length) return [];
  let rows = models || [];
  const byId = new Map();
  for (const key of changed) {
    const plan = planFinishFanout(rows, {
      collection, sourceModelId, groupKey: key, spec: bagOf(after)[key],
    });
    if (!plan.length) continue;
    const patch = new Map(plan.map((p) => [p.id, p.parts]));
    for (const [id, parts] of patch) byId.set(id, parts);
    rows = rows.map((m) => (m?.id && patch.has(m.id) ? { ...m, parts: patch.get(m.id) } : m));
  }
  return [...byId].map(([id, parts]) => ({ id, parts }));
}

/**
 * THE ESTRUCTURA FAN-OUT — the sibling rows that must be rewritten so the whole
 * colección wears the same acabado de estructura, as `[{ id, parts }]`.
 *
 * `planFinishFanout`'s sibling by ROLE instead of by key: every OTHER model of
 * the colección takes `spec` on EVERY ONE of its structure groups (a model with
 * several gets all of them), or loses those keys when `spec` is null — removing
 * the palette is shared exactly like defining it.
 *
 * What it REFUSES to touch is the whole safety of the thing: a model with no
 * structure groups is never written (nothing there is estructura), a
 * non-structure group is never written even when it happens to carry the very
 * same key (the key is not what the rule is about), another colección is never
 * written, and neither is a model that already agrees — so a re-save plans
 * nothing and the studio's preview line can be counted straight off the plan.
 * `mats`/`roots`/`counts`/`labels`/`merges` ride through untouched, and an
 * emptied `finishes` is pruned.
 */
export function planStructureFanout(models, { collection, sourceModelId, spec } = {}) {
  const next = definedSpec(spec);                       // null ⇒ the palette was removed
  const want = collectionOf({ collection });
  // A RETRACTION must be OWNED. spec:null coming from a model that itself has
  // at least one group marked Estructura is the dealer emptying the colección's
  // palette from a participating model — that fans out like a definition (the
  // pin above). The same null coming from a model with NO estructura at all is
  // just an unrelated save passing through, and letting it fan would blank
  // every sibling's palette as a side effect of touching an empty model. The
  // studio's change-gate already refuses that call; this makes the pure layer
  // refuse it too, so no future caller can repeat the mistake.
  if (!next) {
    const source = (models || []).find((m) => m?.id === sourceModelId);
    if (!source || !structureKeysOf(bagOf(source.parts)).length) return [];
  }
  const out = [];
  for (const model of models || []) {
    if (!model?.id || model.id === sourceModelId) continue;
    if (collectionOf(model) !== want) continue;
    const parts = bagOf(model.parts);
    const keys = structureKeysOf(parts);
    if (!keys.length) continue;                         // nothing marked Estructura here
    // Folded, not mapped: a model with two structure groups is ONE write, and
    // the second key must see the first one's rewrite.
    let patched = null;
    for (const key of keys) {
      const finishes = bagOf((patched || parts).finishes);
      const had = Object.prototype.hasOwnProperty.call(finishes, key);
      if (next ? sameSpec(finishes[key], next) : !had) continue;   // already agrees
      patched = withFinish(patched || parts, key, next);
    }
    if (patched) out.push({ id: model.id, parts: patched });
  }
  return out;
}

/** A loose spec (the colección's, a starter) run through the SAME normalizer
 *  every consumer trusts. `finishSpecOf` only reads out of a `parts` bag, so the
 *  spec is staged in one — under a constant key, since the bag carries no
 *  `merges` and the key can therefore mean nothing to the answer. Null when the
 *  Model would render nothing from it, which is the whole question being asked
 *  (`definedSpec` only counts rows; only this counts SAVEABLE ones). */
const STAGE_KEY = '\0spec';
function normalizedSpec(spec) {
  return spec ? finishSpecOf({ finishes: { [STAGE_KEY]: spec } }, STAGE_KEY) : null;
}

/**
 * WILL THIS ESTRUCTURA REACH THE CLIENT? — the studio's one honest answer.
 *
 * Marking a group Estructura and giving it a PALETTE used to be two independent
 * writes, and only the first had a control the dealer could find. Everything
 * downstream needs both: the configurador lists a structure group only when
 * `finishSpecOf` returns a palette (structureGroupsOf), so a group saved as
 * `structure` with no `finishes` rendered as nothing, told nobody, and read in
 * the Estudio as a finished choice.
 *
 * The role is AUTOMATIC now, at BOTH ends: the studio applies the colección's
 * palette the moment the group is marked, and `resolveTogoModels` INJECTS it at
 * read time for every row that carries none (module header). So "marked but not
 * yet adopted" is not a state any more, and the question collapses to «does a
 * palette the Model accepts exist, own or colección».
 *
 * `collectionSpec` is the colección's estructura palette (`structureFinishesOf`)
 * — the EXACT thing the VM injects, so this verdict and what the client is
 * offered cannot drift. Statuses, exhaustive:
 *   • off     — not an estructura; nothing to say.
 *   • ready   — a palette the Model accepts, own or colección. The client sees it.
 *   • partial — its own palette, but some rows are DROPPED by finishSpecOf
 *               (no name, no #rrggbb). Those options never reach anyone.
 *   • invalid — rows typed, NONE saveable: everything the dealer typed here is
 *               being thrown away, whatever the colección still covers the piece
 *               with. A warning about HIS words, not about the client's choice.
 *   • empty   — no palette anywhere, own OR colección. One click plants the
 *               canonical pair.
 */
export function resolveStructureFinish(parts, key, collectionSpec = null) {
  const group = mergedKeyOf(parts, key) || key;
  const structure = isStructureKey(parts, group);
  const own = finishSpecOf(parts, group);
  const raw = definedSpec(bagOf(parts?.finishes)[group]);
  const rawCount = raw ? raw.options.length : 0;
  const dropped = Math.max(0, rawCount - (own?.options?.length || 0));
  // Only ever consulted when the group has nothing of its own — the colección
  // never outranks the model's own word about its own part, which is also the
  // injection's rule.
  const shared = own ? null : normalizedSpec(collectionSpec);

  let status;
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

/**
 * The EDITED model's own half of the same rule: its parts with every one of ITS
 * structure groups carrying `spec` (or losing it when `spec` is null).
 *
 * The colección-level rule applies inside the model being edited too — its legs
 * and its frame are the same estructura — so the studio applies this as the
 * dealer types instead of waiting for the save: the model on the stage is
 * instantly consistent with what its siblings are about to be written with.
 * A model with no structure groups rides through untouched (identity), which is
 * also what makes this safe to call without asking first.
 */
export function applyStructureToDraft(parts, spec) {
  const next = definedSpec(spec);
  let out = parts;
  for (const key of structureKeysOf(parts)) out = withFinish(out, key, next);
  return out;
}

/**
 * What THIS model shows as INHERITED: the colección's palette for each part it
 * has (`partKeys` — the group keys currently on the studio's stage) and has NOT
 * defined itself. The studio prefills the finish editor with it and says where
 * it came from; the first edit makes it the model's own, and the save fans it
 * back out.
 *
 * The union deliberately excludes this model, so a key it stopped defining
 * falls back to what the rest of the colección still says rather than to
 * nothing.
 *
 * PRECEDENCE, most specific first: OWN palette > the colección's SAME-KEY
 * palette > the colección's ESTRUCTURA palette (that last one only for a group
 * marked Estructura, since it is the only palette that is shared by role). The
 * same-key answer outranks the estructura one because it is a statement about
 * this exact part, and because it is what the colección already showed before
 * the role existed — nothing an existing colección displays can change.
 *
 * `parts` is this model's parts when the caller has a live one (the studio's
 * unsaved DRAFT — a group marked Estructura a second ago must already inherit
 * the colección's estructura); it falls back to the stored row.
 */
export function inheritedFinishesFor(models, { collection, modelId, partKeys, parts } = {}) {
  const keys = new Set((partKeys || [])
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean));
  if (!keys.size) return {};
  const rows = models || [];
  const own = parts == null ? rows.find((m) => m?.id === modelId)?.parts : parts;
  const mine = bagOf(own?.finishes);
  const others = rows.filter((m) => m?.id !== modelId);
  const shared = collectionFinishesOf(others, collection);
  const structureSpec = structureFinishesOf(others, collection);
  const out = {};
  for (const key of keys) {
    if (definedSpec(mine[key])) continue;                     // its own palette wins
    // The role is asked of the KEY, not of `structureKeysOf`: the caller's keys
    // come off the live stage, and a split cluster is estructura long before it
    // exists in `parts`.
    const spec = definedSpec(shared[key]) || (isStructureKey(own, key) ? structureSpec : null);
    if (spec) out[key] = spec;
  }
  return out;
}
