/**
 * "Modelos" — ONE DASHBOARD. Gestión y estudio en la misma pantalla.
 *
 * There used to be three surfaces for one job: a Gestor table, a fidelity pane
 * with its own 3D canvas, and this workbench behind a drill-in you had to click
 * into and back out of. They are one grid now, and nothing is hidden behind
 * anything — SELECTING A ROW *IS* OPENING IT:
 *
 *   • LEFT   — the model TABLE (pages/admin/ModelManager, handed in whole as
 *              `table`): search, colección, orden, the estado tabs, the KPI
 *              strip, multi-select and the bulk bar. It replaced the plan-tile
 *              rail this file used to own; its «Colección» filter pill is the
 *              rail's chips, and the rail's ▲▼ became a drag on its own rows.
 *   • CENTER — the real 3D model, tinted per part group, clickable. Above it the
 *              model's own toolbar: detectar partes, eje, reemplazar/quitar 3D,
 *              optimizar mallas, el snippet de embed.
 *   • RIGHT  — the inspector, FIDELIDAD first (the retired pane's six checks,
 *              over this stage's own build — ModelFidelityPanel — plus «Foto de
 *              producto»), then the MODEL (name, colección, medidas, SKU base,
 *              planta, orden, telas, montaje, borrar) or, with a part group
 *              selected, that PART (nombre, selector de SKU, unir, acabados).
 *
 * SELECTION IS THE PARENT'S (`selectedId`/`onSelect`, owned by
 * pages/admin/TogoCatalog): the table, the stage and the inspector are three
 * views of ONE pick, and the previous split — a rail with its own `activeId`
 * plus a deep-link handshake to hand a row over — is precisely how the two
 * halves got out of step. There is no «Volver al gestor» because there is
 * nowhere to come back from.
 *
 * The studio is permanently DARK with terracotta accents (`.theme-studio`, the
 * same custom-property inheritance trick as `.theme-chrome`), in both app
 * themes — so every colour here is an ordinary token (`bg-canvas`, `text-ink-700`,
 * `bg-brand-500`) and nothing is hardcoded. The only literal colours in the file
 * are the 3D engine's, which cannot read CSS: those are READ BACK off the host's
 * computed custom properties, so the stage ground and the selection highlight
 * are the same tokens as the chrome around them.
 *
 * three.js is code-split behind `safeDynamicImport` (Traps), and the parsed model
 * comes from `loadTogoModels`' SHARED session cache — so the geometry it hands us
 * belongs to the whole app: we clone every buffer we put on our own scene and
 * dispose only those clones, never the cached sources. The renderer boots ONCE
 * and survives every model switch (only the model group is swapped): a WebGL
 * context per click would drop the oldest contexts on a long session.
 *
 * PARTS are edited as a DRAFT of the whole `parts` object and committed whole
 * («Guardar partes», or automatically when the dealer moves to another model),
 * exactly like the modal it supersedes. Everything else on the model commits as
 * you go, like every other control on this tab always has.
 *
 * ACABADOS are the exception to "a model owns its parts": a palette belongs to
 * the COLECCIÓN (the Prado legs are the same legs on every Prado), so the
 * editor prefills what the colección already offers for that part and the save
 * FANS THE CHANGE OUT to every sibling carrying the same group key — the plans
 * come from `lib/togo/collectionFinishes`, and the public read path stays
 * exactly as it was (every consumer still reads `model.parts.finishes`).
 * An ESTRUCTURA palette shares one step wider: it is a colección-level
 * parameter, so it fans out to every group MARKED Estructura whatever key that
 * group carries (the settee's legs export as `metal_01`, the armchair's as
 * `metal_02`), and it lands on every structure group of the model being edited
 * as the dealer types.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowLeft, Box, Check, Code2, Combine,
  Copy, ExternalLink, Link2, Loader2, Palette, Plus, RefreshCw, Sofa,
  Sparkles, Trash2, Ungroup, UploadCloud,
} from 'lucide-react';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import ModelFidelityPanel, { meshVersionFor } from './ModelFidelityPanel.jsx';
import ModelBrowser from '../quote-builder/ModelBrowser.jsx';
import useFileIntake from '../primitives/useFileIntake.js';
import { db, updateSettings } from '../../db/database.js';
import { uploadTogoMesh, removeTogoMesh } from '../../db/togoMeshUpload.js';
import { uploadTogoThumb, removeTogoThumb } from '../../db/togoThumbUpload.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { sanitizeSvg } from '../../lib/sanitizeSvg.js'; // SECURITY (L6): scrub untrusted SVG before innerHTML
import { swatchTileUrl } from '../../lib/swatchImage.js';
import { useApp } from '../../context/AppContext.jsx';
import { prefersReducedMotion } from '../../lib/motion.js';
import { togoEmbedSnippet, togoShareUrl } from '../../lib/togoEmbed.js';
import { loadMeshPlan } from '../../lib/togo/meshPlanCache.js';
import { autoUnitScale } from '../../lib/togo/togoModel.js';
import { saveCollectionFabrics, clearCollectionFabrics } from '../../lib/modelFabrics.js';
import { supabase } from '../../db/supabaseClient.js';
import { proposeCollectionBindings } from '../../lib/togo/autoLink.js';
import { buildFabricByCode } from '../../lib/togo/fabricIndex.js';
import { canonicalCollection } from '../../lib/togo/collections.js';
import { buildSuggestQuery, suggestSkuMatch, SUGGEST_LIMIT } from '../../lib/togo/suggestSku.js';
import { indexCandidates, resolveModelMatches, heroFabricOptions, planHeroPin, resolveCollectionMenu } from '../../core/quote/index.js';
import { probeMeshBinding } from './bindingProbe.js';
import { loadSceneFile, splitScene, exportPieceGlb, optimizeGlbUrl, isOptimizableMeshUrl } from './sceneImport.js';
import { loadTogoModels, ALCOVER_MESH_V } from './togoModelLoader.js';
import { renderTogoThumb, togoThumbStoreKey, bakedThumbUrl, TILE_THUMB } from './togoThumbnails.js';
import { setupTogoStage, disposeGroup, maskToOutline } from './togoSceneBuilder.js';
import {
  PART_ROLES, MATERIALIZATION_ROLES, BILLED_ROLES, COUNT_MAX, partKeysFor, classifyPartGroups,
  partCount, partMeshCount, accessoryRoleFor, mergedKeyOf, partLabelOf, partRoleFor,
  finishSpecOf, structureStarterFinish, planPartJoin, planPartSplit,
} from '../../lib/togo/meshParts.js';
import {
  applyStructureToDraft, inheritedFinishesFor, planFinishSync,
  planStructureFanout, resolveStructureFinish, structureFinishesOf, structureKeysOf,
} from '../../lib/togo/collectionFinishes.js';

// Exported so the page (and through it TogoWorkspace's workspace-wide drop
// target) accepts the same set the studio's own "Reemplazar 3D" does.
export const ACCEPT_3D = '.fbx,.glb,.gltf,.obj,.dae,.3ds';

/**
 * PORTADA — which piece, in which cloth, stands for a colección on the
 * configurator's first screen.
 *
 * Both were derived and stay derivable: the piece by a name ranking, the cloth
 * by a hash over the renderable palette (`resolveCollectionMenu`). Good
 * defaults — and a shop window shouldn't be stuck with defaults, because the
 * dealer is the one who knows which piece sells a colección and in which
 * colour. So each half pins INDEPENDENTLY and «Automática» hands it back; there
 * is no third state to explain.
 *
 * The cloth list is `heroFabricOptions` — the exact palette the index picks
 * from — so this can only ever offer a bolt the cover will actually render in,
 * and the chips are the Ligne Roset swatch photos (the same route the
 * configurator's own picker paints). «Al azar» is a real dice roll: it is a
 * human action that gets PERSISTED, unlike the automatic pick, which must stay
 * deterministic so the render cache can hit.
 */
function CoverPicker({ collection, modelId, modelName, pieces, materials, heroes, onSave }) {
  const [open, setOpen] = useState(false);
  const pin = (heroes && collection && heroes[collection]) || null;
  const isCover = !!pin?.modelId && pin.modelId === modelId;
  const options = useMemo(() => heroFabricOptions(materials), [materials]);
  const cloth = pin?.code ? options.find((o) => o.code === pin.code) || null : null;
  // The piece currently carrying the cover, when it is not this one — named, so
  // «Usar esta pieza» says what it replaces instead of silently taking over.
  const heldBy = pin?.modelId && !isCover
    ? (pieces || []).find((p) => p.id === pin.modelId)?.name || null
    : null;
  if (!collection) return null;
  return (
    <section className="border-b border-ink-200 px-3 py-2.5">
      <div className="flex items-baseline gap-1.5">
        <span className="label mb-0">Portada · {collection}</span>
        {(pin?.modelId || pin?.code) && (
          <span className="ml-auto rounded-full bg-brand-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-brand-700">
            elegida
          </span>
        )}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-ink-400">
        La pieza y la tela con que esta colección se presenta en el configurador.
      </p>

      <button
        type="button"
        onClick={() => onSave(collection, { modelId: isCover ? null : modelId })}
        className={`mt-2 w-full rounded-md border px-2 py-1.5 text-[11px] font-medium transition ${
          isCover
            ? 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100'
            : 'border-ink-200 text-ink-700 hover:bg-ink-50'
        }`}
      >
        {isCover ? '✓ Esta pieza es la portada — quitar' : 'Usar esta pieza como portada'}
      </button>
      {heldBy && (
        <p className="mt-1 text-[10px] leading-snug text-ink-400">Ahora la lleva «{heldBy}».</p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md border border-ink-200 bg-ink-50">
          {cloth && <img src={swatchTileUrl(cloth, 28)} alt="" className="h-full w-full object-cover" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-700">
          {cloth ? `${cloth.materialName} · ${cloth.colorName}` : 'Tela automática'}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-md border border-ink-200 px-1.5 py-1 text-[10px] text-ink-600 hover:bg-ink-50"
        >
          {open ? 'Cerrar' : 'Cambiar'}
        </button>
        <button
          type="button"
          title="Una tela al azar del catálogo"
          disabled={!options.length}
          onClick={() => onSave(collection, { code: options[Math.floor(Math.random() * options.length)]?.code || null })}
          className="shrink-0 rounded-md border border-ink-200 px-1.5 py-1 text-[10px] text-ink-600 hover:bg-ink-50 disabled:opacity-40"
        >
          Al azar
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto overscroll-contain scroll-thin pr-0.5">
            {options.map((o) => (
              <button
                key={o.code}
                type="button"
                title={`${o.materialName} · ${o.colorName}`}
                onClick={() => { onSave(collection, { code: o.code }); setOpen(false); }}
                className={`aspect-square overflow-hidden rounded border transition ${
                  o.code === pin?.code ? 'border-brand-400 ring-2 ring-brand-400' : 'border-ink-200 hover:border-brand-300'
                }`}
              >
                <img src={swatchTileUrl(o, 40)} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
          {pin?.code && (
            <button
              type="button"
              onClick={() => { onSave(collection, { code: null }); setOpen(false); }}
              className="mt-1 text-[10px] text-ink-500 underline underline-offset-2 hover:text-ink-700"
            >
              Volver a la tela automática
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A `togo_models` row as the CONFIGURATOR sees it — the shape the renderer and
 *  the store key both read, so a picture baked here is stamped exactly as the
 *  widget will re-derive it from the public payload. Baked fields are
 *  deliberately absent: this shape is what we are baking FROM. */
function thumbModelOf(row) {
  return {
    id: row.id,
    name: row.name || '',
    collection: row.collection || 'Togo',
    widthCm: row.widthCm,
    depthCm: row.depthCm,
    mesh: row.meshUrl
      ? { url: row.meshUrl, scale: row.meshScale ?? null, upAxis: row.meshUpAxis || 'y', rotateY: row.meshRotateY || 0 }
      : null,
  };
}

/** The row as the widget sees it, WITH what has already been baked for it — the
 *  shape `bakedThumbUrl` asks "is this picture still this piece?" of. Added back
 *  here rather than in `thumbModelOf`, which is the shape we bake FROM. */
function bakedStateOf(row) {
  return {
    ...thumbModelOf(row),
    thumbUrl: row.thumbUrl, thumbStamp: row.thumbStamp,
    heroThumbUrl: row.heroThumbUrl, heroThumbStamp: row.heroThumbStamp,
  };
}

/**
 * The BILLED part slots. `parts.roots`/`parts.counts` are ROLE-keyed (that is
 * the Model's billing shape, meshParts.js), so a model can carry at most this
 * many part SKUs — three. The list is the MODEL's (`BILLED_ROLES`), not a second
 * derivation of it: the join planner gives a vacated slot's root and count back
 * by that same list, and two copies of "what bills" is how one of them goes
 * stale.
 */
const BILLED_SLOTS = BILLED_ROLES;

/** What the model's parts list calls a non-billed group: «Componente» (viste
 *  tela, y se cotiza con el SKU del modelo) or «Estructura» (metal/lacado — the
 *  client picks the acabado, the price never moves). A legacy materialization
 *  ZONE (exterior/interior, from the retired zone control) never billed either
 *  and has no control of its own, so it reads as plain «Componente». */
const SLOT_LABELS = { base: 'Componente', structure: 'Estructura', exterior: 'Componente', interior: 'Componente' };

// Stage geometry is normalized to this radius (cm-ish) before framing, so the
// lighting/shadow rig — which setupTogoStage sizes off the radius, with a
// hardcoded shadow near plane of 1 — is built ONCE and every model, whatever
// unit it was authored in, lands in the regime that rig was tuned for.
const CANON_RADIUS = 100;

// How long the parts draft sits before it writes itself. Long enough that typing
// a part's name is one save and not one per keystroke (each carries the
// colección fan-out behind it), short enough that "everything saves itself" is
// true rather than aspirational.
const AUTOSAVE_MS = 900;

// Golden-angle spin: consecutive groups land as far apart as they can, so a
// 12-part export still reads as twelve distinguishable tints.
const GOLDEN_ANGLE = 137.508;
const spinOf = (i) => ((i * GOLDEN_ANGLE) % 360) / 360;

/**
 * A group's tint. The studio renders FLAT tinted materials (no fabrics, no
 * weave), so the palette's only job is telling parts apart — biased into the
 * warm CLAY band the old orange configurator lived in rather than spraying the
 * whole colour wheel across a dark stage. The golden-angle spin drives hue
 * INSIDE that band, and two cheap co-primes drive saturation and lightness, so
 * neighbours differ in more than one dimension and the band never runs out.
 */
function clayOf(i) {
  const t = spinOf(i);
  return {
    h: (7 + t * 51) / 360,
    s: 0.30 + (((i * 0.37) % 1) * 0.26),
    l: 0.40 + (((i * 0.61) % 1) * 0.20),
  };
}
const cssClay = (i) => {
  const c = clayOf(i);
  return `hsl(${(c.h * 360).toFixed(1)} ${(c.s * 100).toFixed(0)}% ${(c.l * 100).toFixed(0)}%)`;
};

const FINISH_HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_FINISH_RGB = '#c9c3b8';

/** A group's fallback display name — the dealer's label wins over this. */
const fallbackLabelFor = (key) => (String(key || '').startsWith('#') ? `Malla ${key}` : String(key || ''));

/** Slug for a finish id: accent-folded, lowercase, hyphenated, and bounded to
 *  the 32 chars `sanitizePartFinishes` lets a picked option carry. */
function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** `base`, or `base-2`/`base-3`… when another option already owns it. */
function uniqueId(base, taken) {
  const root = base || 'acabado';
  if (!taken.has(root)) return root;
  for (let n = 2; n < 99; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
  return `${root}-${Date.now().toString(36)}`;
}

/** Mirror of the Model's private `finishUnit`, for rendering the metal toggle
 *  alone: 0–1 NUMBERS only, and a missing knob stays missing (never coerced to
 *  a hard 0). Written back the same way — a boolean would be dropped and the
 *  option would render as paint instead of steel. */
function unitOrNull(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/**
 * Mesh nodes → the part GROUPS this studio edits, in order of first appearance
 * (so a group's colour is stable while the dealer works). Purely a fold of the
 * Model's own `mergedKeyOf` over the node keys: a merged child contributes its
 * meshes to its target's group and never appears as a group of its own.
 */
function buildGroups(partKeys, parts) {
  const byKey = new Map();
  const order = [];
  for (const key of (partKeys || [])) {
    const gk = mergedKeyOf(parts, key) || key;
    let row = byKey.get(gk);
    if (!row) { row = { key: gk, members: [], nodeCount: 0 }; byKey.set(gk, row); order.push(row); }
    row.nodeCount += 1;
    if (!row.members.includes(key)) row.members.push(key);
  }
  return order.map((row, i) => ({ ...row, index: i }));
}

/** A plain-data copy of the stored parts — the draft must never alias the row. */
const cloneParts = (parts) => {
  try { return parts ? JSON.parse(JSON.stringify(parts)) : {}; } catch { return {}; }
};

/** Drop the empty maps so the stored row stays honest about what was set. */
function prunedParts(draft) {
  const next = { ...(draft || {}) };
  for (const k of ['merges', 'labels', 'finishes', 'roots', 'counts']) {
    if (next[k] && !Object.keys(next[k]).length) delete next[k];
  }
  return next;
}

/** The draft with ONE group's palette written, or removed when the editor hands
 *  back nothing renderable — the same shape `prunedParts` then commits. */
function writeFinish(draft, key, spec) {
  const finishes = { ...(draft?.finishes || {}) };
  if (spec && spec.options?.length) finishes[key] = spec; else delete finishes[key];
  return { ...(draft || {}), finishes };
}

/**
 * EVERY sibling row one save of this model implies — the studio's ONE fan-out
 * plan, composed from the Model's two rules and re-implementing neither. Used
 * both to WRITE (on save) and to PREVIEW («se aplicarán también a N modelos»),
 * so the number the dealer reads is the plan that then runs.
 *
 * Two rules share the same `finishes` bag and must not both claim a key:
 *   • an ESTRUCTURA palette is the COLECCIÓN's parameter — it lands on every
 *     group marked Estructura in every sibling, whatever key each one carries
 *     (planStructureFanout), so its keys are STRIPPED out of the key-based diff
 *     rather than fanned out twice;
 *   • every other palette fans out BY KEY, exactly as it always has.
 *
 * The estructura fan-out only fires when this save actually MOVED that palette,
 * and the question is asked of the module itself — the draft's palette planned
 * onto this model AS IT WAS LOADED (its own groups, carrying the palettes it
 * opened with): a row comes back only when the two genuinely disagree. That
 * gate is what keeps a save that merely renamed a part from rewriting the
 * colección — and, the case that matters, keeps a model whose estructura is
 * simply empty from blanking every sibling's palette just by being saved.
 *
 * Structure is planned against the rows AS THE KEY PASS LEFT THEM (the same
 * fold planFinishSync does internally, for the same reason): one sibling can be
 * touched by both passes, and the second must see the first one's rewrite.
 */
function planSiblingFinishes(models, { collection, sourceModelId, before, after, parts }) {
  const structureKeys = structureKeysOf(parts);
  const skip = new Set(structureKeys);
  const byKey = (bag) => Object.fromEntries(Object.entries(bag || {}).filter(([k]) => !skip.has(k)));

  let rows = models || [];
  const planned = new Map();
  for (const p of planFinishSync(rows, {
    collection, sourceModelId, before: byKey(before), after: byKey(after),
  })) planned.set(p.id, p.parts);

  if (structureKeys.length) {
    const spec = structureFinishesOf([{ id: sourceModelId || 'self', collection, parts }], collection);
    const moved = planStructureFanout(
      [{ id: 'antes', collection, parts: { ...parts, finishes: before || {} } }],
      { collection, sourceModelId: null, spec },
    ).length > 0;
    if (moved) {
      rows = rows.map((m) => (m?.id && planned.has(m.id) ? { ...m, parts: planned.get(m.id) } : m));
      for (const p of planStructureFanout(rows, { collection, sourceModelId, spec })) planned.set(p.id, p.parts);
    }
  }
  return [...planned].map(([id, next]) => ({ id, parts: next }));
}

/**
 * Which role SLOT a group takes when the dealer binds it to `root`.
 * Three billed slots exist per model, so binding is an allocation:
 *   1. another group already bills this very SKU → SHARE its slot (two groups,
 *      one SKU, one billed line — today's N-keys-per-role model);
 *   2. this group already owns a billed slot ALONE → keep it, rewrite the root
 *      (if a SIBLING shares the slot, detaching is the only safe move — keeping
 *      it would silently re-SKU that sibling too);
 *   3. otherwise the first genuinely free slot;
 *   4. none free → refuse, and write nothing.
 * Returns `{ role }` or `{ error }`.
 */
function planSkuSlot(parts, members, currentRole, root) {
  const mats = parts?.mats || {};
  const roots = parts?.roots || {};
  const mine = new Set(members);
  const heldByOthers = (role) => Object.entries(mats).some(([k, r]) => r === role && !mine.has(k));
  const held = (role) => Object.values(mats).some((r) => r === role);

  const shared = BILLED_SLOTS.find((role) => root && roots[role] === root && heldByOthers(role));
  if (shared) return { role: shared };
  if (BILLED_SLOTS.includes(currentRole) && !heldByOthers(currentRole)) return { role: currentRole };
  const free = BILLED_SLOTS.find((role) => !held(role));
  if (free) return { role: free };
  return { error: `Máximo ${BILLED_SLOTS.length} SKUs de parte por modelo. Quita el SKU de otra parte primero.` };
}

/**
 * Move a group into `role` (base / a zone / a billed slot) and keep the billing
 * maps honest: a billed slot the group just VACATED and nobody else holds loses
 * its root and count, so a stale SKU can never bill on a model that no longer
 * has that part. Whole-object, immutable; keys nobody touched ride through.
 */
function writeSlot(parts, members, role, root) {
  const mats = { ...(parts?.mats || {}) };
  const vacated = new Set(members.map((m) => mats[m]).filter(Boolean));
  for (const m of members) mats[m] = role;

  const roots = { ...(parts?.roots || {}) };
  const counts = { ...(parts?.counts || {}) };
  if (BILLED_SLOTS.includes(role)) {
    if (root) roots[role] = root;
  }
  for (const r of vacated) {
    if (r === role || !BILLED_SLOTS.includes(r)) continue;
    if (Object.values(mats).some((x) => x === r)) continue;   // a sibling still holds it
    delete roots[r];
    delete counts[r];
  }
  const next = { ...(parts || {}), mats, roots, counts };
  if (!Object.keys(roots).length) delete next.roots;
  if (!Object.keys(counts).length) delete next.counts;
  return next;
}

/** An `--ink-500`-style token read back as a three.js hex — the engine cannot
 *  read CSS, and hardcoding the two colours it needs would let the stage drift
 *  from the chrome around it. Falls back to the shipped value. */
function tokenColor(el, name, fallback) {
  try {
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    const p = raw.split(/[\s,/]+/).slice(0, 3).map(Number);
    if (p.length === 3 && p.every((n) => Number.isFinite(n))) {
      return ((p[0] & 255) << 16) | ((p[1] & 255) << 8) | (p[2] & 255);
    }
  } catch { /* fall through to the shipped value */ }
  return fallback;
}

/**
 * The product binding rides the quote pane's REAL catalog picker — the same
 * ModelBrowser modal the dealer uses to add a catalog line to a quote, not a
 * bare text typeahead. Picking a model binds its family root; the footer clears
 * the binding. ModelBrowser loads its own bounded data, so the picker never
 * waits on the page's full-catalog fetch.
 *
 * REASSIGNMENT is the common case, not a first binding: the picker therefore
 * opens ON what is already bound (`currentRoot` seeds the search selected, so
 * the family is on screen and the first keystroke replaces it) and carries
 * `presets` — the colección, one tap away, because the LR family names hold it
 * ("PRADO 2 S/2 BOLSTERS"). The «SKU actual» line keeps the assignment readable
 * after the dealer has typed something else over the seed.
 */
export function ProductBindModal({
  open, onClose, profileId, onPick, onClear,
  // The OPEN BRAND's name, for the copy. Null ⇒ the neutral wording: a picker
  // that names a manufacturer the dealer isn't working in is worse than one
  // that names none.
  brandName = null,
  title = null,
  clearLabel = 'Sin vincular (precio manual)',
  currentRoot = '', currentName = '', presets = [],
}) {
  const heading = title || (brandName ? `Vincular a producto ${brandName}` : 'Vincular a producto del catálogo');
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={heading}
      flushBody
      footer={(
        <button type="button" onClick={() => { onClear(); onClose(); }} className="btn-ghost text-sm">
          {clearLabel}
        </button>
      )}
    >
      {open && (
        <>
          {currentRoot && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-ink-100 bg-ink-50/50 px-4 py-2 sm:px-6">
              <span className="text-[10px] uppercase tracking-wide text-ink-400">SKU actual</span>
              <span className="font-mono text-xs font-medium text-ink-900">{currentRoot}</span>
              {currentName && <span className="min-w-0 truncate text-xs text-ink-600">{currentName}</span>}
              <span className="ml-auto text-[10px] text-ink-400">se reemplaza al elegir otro</span>
            </div>
          )}
          <ModelBrowser
            profileId={profileId}
            onPick={(m) => { onPick(m); onClose(); }}
            initialQuery={currentRoot}
            presets={presets}
          />
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ModelStudio({
  cards = [], navIds = null, models = [], collections = [], materials = [], families = [], products = null,
  fabricLinks = [], profileId, onNeedCatalog, onAddModel, onImportSeeds,
  // The OPEN BRAND's own name — what the copy says instead of a manufacturer
  // this deploy happens to have shipped first. Null ⇒ neutral wording.
  brandName = null,
  table = null, selectedId = null, onSelect, fidelityRow = null, fidelityResolved = null,
  // The ACTIVE BRAND's import module set (src/brands/modules), resolved by the
  // page. Only the geometry adapter reaches this file: it decides which files
  // «Reemplazar 3D» accepts, because what counts as a model is a property of
  // the manufacturer's library, not of the studio. Null = the default set, so
  // an unbranded mount behaves exactly as before.
  modules = null,
}) {
  // The dealer's chosen covers, on the team settings row (see CoverPicker).
  // `planHeroPin` owns the merge so "pinned nothing" can't be encoded two ways.
  const { settings } = useApp();
  const heroes = settings?.togoHeroes || null;
  const saveHero = useCallback(
    (collection, patch) => updateSettings(profileId, { togoHeroes: planHeroPin(heroes, collection, patch) }),
    [profileId, heroes],
  );
  const hostRef = useRef(null);
  // The selected group's gold silhouette — the SAME outline cue the public
  // configurator strokes around a selected piece (TogoStage), written
  // imperatively in the render frame so it never trails the camera.
  const outlineSvgRef = useRef(null);
  const outlineCasingRef = useRef(null);
  const outlineGoldRef = useRef(null);
  const engineRef = useRef(null);

  // ── Which model is on the stage. The PARENT owns the pick (the table to the
  // left sets it); this is a lookup, never a second copy of the truth.
  const activeId = selectedId || null;
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const card = useMemo(() => cards.find((c) => c.id === activeId) || null, [cards, activeId]);
  const row = useMemo(() => (models || []).find((m) => m.id === activeId) || null, [models, activeId]);
  const cardRef = useRef(card);
  cardRef.current = card;
  // The raw rows, by ref: the finish fan-out is planned against the whole
  // colección from inside async save paths, which must never close over the
  // list as it was when the handler was created.
  const modelsRef = useRef(models);
  modelsRef.current = models;
  // By ref for the same reason, and so every save callback below keeps a STABLE
  // identity: `flushParts` is an unmount-cleanup dependency, so a callback that
  // re-created on a prop change would fire a flush just by re-subscribing.
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  const collection = card?.collection || 'Togo';

  // ── The parts DRAFT (the whole `parts` object) + its dirty flag.
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // The palettes the draft was LOADED with — the baseline the save diffs
  // against to know which finishes to fan out across the colección. State (not
  // just a ref) because the save bar previews the fan-out before committing.
  const [baseFinishes, setBaseFinishes] = useState(null);
  const baseFinishesRef = useRef(null);
  baseFinishesRef.current = baseFinishes;
  // WHO THE DRAFT BELONGS TO — the model id AND its colección, captured when the
  // draft loaded. Both writers (`saveParts`, `flushParts`) plan the colección's
  // fan-out against THIS, never against whatever is on the stage now: selection
  // moved to the parent, so the swap is observed in an effect, by which time
  // `cardRef` already holds the NEXT model and reading the collection off it
  // would fan a Prado palette out across Togo.
  const draftOwnerRef = useRef({ id: null, collection: 'Togo' });

  const [partKeys, setPartKeys] = useState([]);
  // Part keys whose GLB material brought its own texture (a Ligne Roset product
  // folder that shipped its bitmaps). Display only — the render rule lives in
  // the scene builder; this is just what the inspector badges.
  const [factoryKeys, setFactoryKeys] = useState([]);
  const [status, setStatus] = useState('idle');       // idle | loading | ready | failed
  const [meshErr, setMeshErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  // Join-by-click: while on, a click in the 3D stage FOLDS that mesh into the
  // selected part instead of selecting it (and a click on an already-folded
  // mesh separates it again). The dealer arms it once and keeps clicking.
  const [joinMode, setJoinMode] = useState(false);
  const [slotErr, setSlotErr] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [fanoutErr, setFanoutErr] = useState(0);      // siblings the fan-out couldn't write
  const [saving, setSaving] = useState(false);

  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState(null);
  const [meshBusy, setMeshBusy] = useState(false);
  const [meshOpErr, setMeshOpErr] = useState(null);
  const [embedOpen, setEmbedOpen] = useState(false);
  // The PART group's catalog picker. The model's own binding (SKU base) carries
  // its own picker inside ModelInspector, next to the row it binds.
  const [picker, setPicker] = useState(null);         // null | 'part'

  // ── Commit the draft. Whole-object, empties pruned — the same shape the modal
  // this replaces wrote, so nothing downstream can tell the difference.
  const commitParts = useCallback(async (next, id = activeIdRef.current) => {
    if (!id) return;
    await db.togoModels.update(id, { parts: prunedParts(next), updatedAt: Date.now() });
  }, []);

  // ── The finish FAN-OUT. A palette belongs to the colección, not to the model
  // being edited (collectionFinishes), so every sibling carrying the same part
  // key — and, for an estructura, every sibling marked Estructura at all —
  // takes the change the moment the model's own save lands. Sequential writes
  // (a colección is a handful of models), and a sibling that refuses NEVER
  // fails the dealer's own save: it is counted and reported, not thrown.
  const fanoutFinishes = useCallback(async (id, next, before, col) => {
    // Planned against a FRESH read, not `modelsRef.current`. The ref is a RENDER
    // snapshot, and this runs immediately after our own commit — before the live
    // query that refreshes it has come back. Every row in the plan is written
    // WHOLE (`parts: p.parts`, derived from the sibling's own parts), so planning
    // off a snapshot means writing each sibling back as it was at the last paint:
    // anything landed in between — another studio session, a Deno-side writer, or
    // this same fan-out's previous pass — is clobbered whole-object. A read
    // failure falls back to the snapshot, which is exactly what this always did:
    // a stale plan is the old behaviour, no plan at all would silently break the
    // «se aplicarán también a N modelos» the dealer was just shown.
    let rows = modelsRef.current;
    try {
      const pid = profileIdRef.current;
      if (pid) rows = await db.togoModels.where('profileId').equals(pid).toArray();
    } catch { /* the render snapshot stands in — see above */ }
    const plan = planSiblingFinishes(rows, {
      collection: col, sourceModelId: id, before, after: next?.finishes, parts: next,
    });
    if (!plan.length) { setFanoutErr(0); return; }
    // IN FLIGHT TOGETHER, not one after another. Each sibling is an independent
    // row carrying its OWN payload (so this can't be one bulk patch), and waiting
    // for each round trip before starting the next made a save cost as many trips
    // as the colección has models — the wait the dealer actually felt. Bounded,
    // because a wide colección firing every write at once is how the tab stalls.
    let failed = 0;
    let next_ = 0;
    const worker = async () => {
      for (;;) {
        const p = plan[next_++];
        if (!p) return;
        try { await db.togoModels.update(p.id, { parts: p.parts, updatedAt: Date.now() }); }
        catch { failed += 1; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, plan.length) }, worker));
    setFanoutErr(failed);
  }, []);

  // ── ONE write chain per model, at a time. `saveParts` and `flushParts` write
  // the same row through the same two steps, and nothing kept them apart: the
  // save cleared its dirty flag only AFTER its first await, so a rail pick inside
  // that window found `dirtyRef.current` still true and ran the flush's whole
  // chain on top of the save's — a duplicate commit plus a duplicate
  // colección-wide fan-out, the two interleaving over the same siblings.
  //
  // Two levers, because they answer different halves: the dirty flag is now
  // cleared SYNCHRONOUSLY (below, the idiom `flushParts` already used) so a
  // redundant second caller never starts, and this latch serializes the callers
  // that are NOT redundant — the dealer who edits again while the first save is
  // still in flight really does have a second draft to write, and it must land
  // after the first, never woven through it.
  const saveChainsRef = useRef(new Map());          // modelId → the chain in flight
  //
  // TWO HANDLES, because the dealer and the data need different answers. THIS
  // model's row is written first; the colección-wide fan-out that follows touches
  // rows he is not looking at. Making him watch that finish is what turned
  // editing ten models into ten waits — so `committed` is what the UI waits on,
  // and `done` (the whole thing) is what the next save on this model queues
  // behind. The serialization is unchanged: a second edit still lands after the
  // first, fan-out included, never woven through it.
  const runSave = useCallback((id, next, before, col) => {
    const prev = saveChainsRef.current.get(id);
    const committed = (prev ? prev.catch(() => {}) : Promise.resolve())
      .then(() => commitParts(next, id));
    const done = committed.then(() => fanoutFinishes(id, next, before, col));
    saveChainsRef.current.set(id, done);
    // Only the LAST chain clears the slot — an earlier one settling must not
    // unlatch a successor that is still running.
    done.catch(() => {}).then(() => {
      if (saveChainsRef.current.get(id) === done) saveChainsRef.current.delete(id);
    });
    return { committed, done };
  }, [commitParts, fanoutFinishes]);

  const saveParts = useCallback(async () => {
    // Asked of the REF, not the `saving` state this closure captured: a second
    // tap in the same tick reads the same stale `false` and starts a second save.
    // Clearing dirty first (below) makes that second tap a no-op.
    if (!draftOwnerRef.current.id || !dirtyRef.current) return;
    const { id, collection: col } = draftOwnerRef.current;
    const next = draftRef.current;
    const before = baseFinishesRef.current;
    dirtyRef.current = false;
    setDirty(false);
    setSaving(true);
    setSaveErr(null);
    try {
      // The fan-out keeps running behind this — the dealer is free the moment
      // HIS model's row is written.
      await runSave(id, next, before, col).committed;
      // The stage can swap models while this is in flight. `next.finishes` is
      // THIS model's new baseline, and writing it onto whatever is on the stage
      // now would hand the next save a `before` belonging to a different model —
      // a diff against palettes nobody touched, fanned out across the colección.
      if (activeIdRef.current === id) {
        baseFinishesRef.current = next?.finishes || null;
        setBaseFinishes(next?.finishes || null);
      }
    } catch (e) {
      // Still on this model ⇒ the draft is unsaved again, exactly as before this
      // save started. Moved on ⇒ the flag now belongs to the model on the stage
      // and must not be marked dirty by another model's failure.
      if (activeIdRef.current === id) {
        dirtyRef.current = true;
        setDirty(true);
        setSaveErr(e?.message || 'No se pudieron guardar las partes.');
      } else {
        setSaveErr('No se pudieron guardar las partes del modelo anterior.');
      }
    } finally {
      setSaving(false);
    }
  }, [runSave]);

  // Leaving a model (a row click in the table, unmount) must never drop work in
  // flight: the pending draft is committed against the model it BELONGS to —
  // `draftOwnerRef`, not the stage, which by the time this runs is already
  // showing the next piece.
  const flushParts = useCallback(() => {
    if (!dirtyRef.current || !draftOwnerRef.current.id) return;
    const { id, collection: col } = draftOwnerRef.current;
    const next = draftRef.current;
    const before = baseFinishesRef.current;
    dirtyRef.current = false;
    setDirty(false);
    runSave(id, next, before, col).done
      .catch(() => setSaveErr('No se pudieron guardar las partes del modelo anterior.'));
  }, [runSave]);

  useEffect(() => () => flushParts(), [flushParts]);

  // ── SAVING IS AUTOMATIC, and now actually is.
  //
  // «Guardar partes» is gone, so this is what replaces the click — not an extra
  // convenience on top of it. Everything else on the model has always committed
  // as you type; `parts` is written as one object, and its only writers were the
  // unmount cleanup and the model swap. That made the button load-bearing:
  // tagging a part and then reloading the tab lost the edit outright, because a
  // page unload does not run React cleanups.
  //
  // `saveParts` and not `flushParts`: the save advances `baseFinishes`, and the
  // colección fan-out is a DIFF against it — a repeating writer that never moved
  // the baseline would re-fan the same palettes across every sibling on every
  // tick. It is already a no-op when nothing is dirty, clears the flag
  // synchronously, and rides the one-write-chain latch, so a debounce landing on
  // top of an in-flight save queues behind it instead of interleaving.
  //
  // A FAILURE STOPS THE CLOCK (`saveErr`), and that is the whole reason the
  // error is a gate and not just a message: a failed save marks the draft dirty
  // again, so re-arming on it would spin — one commit, one full `togoModels`
  // read and one fan-out across the colección every 900 ms, for as long as the
  // network stays down. The next edit clears the error (`editParts`) and is the
  // retry; leaving the model or hiding the tab still flushes regardless.
  useEffect(() => {
    if (!dirty || saveErr) return undefined;
    const t = setTimeout(() => { saveParts(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, saveErr, saveParts]);

  // The debounce window is the one place work can still be in the air, and a tab
  // switch (or an app switch on the dealer's laptop) is the moment it is most
  // likely to be: `hidden` fires with the page still alive, so the write really
  // does go out. Same flush the model swap uses — against `draftOwnerRef`, never
  // the stage.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onHide = () => { if (document.visibilityState === 'hidden') flushParts(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flushParts);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushParts);
    };
  }, [flushParts]);

  const editParts = useCallback((fn) => {
    setDraft((d) => fn(d || {}));
    dirtyRef.current = true;
    setDirty(true);
    setSlotErr(null);
    setFanoutErr(0);
    // A new edit IS the retry: it re-arms the autosave clock a failed save
    // stopped (above), so the dealer never has to find a button to try again.
    setSaveErr(null);
  }, []);

  // Nothing picked yet → land on the first piece, so the dashboard never opens
  // on an empty stage. ONLY when the pick is null: an id we can't find might be
  // a row that hasn't arrived yet (a model created seconds ago selects itself
  // before the live query returns it), and auto-correcting would steal it back.
  // A row that really went away clears the pick explicitly — the studio's own
  // delete and the table's bulk delete both call `onSelect(null)`.
  useEffect(() => {
    if (selectedId || !cards.length) return;
    onSelect?.(cards[0].id);
  }, [selectedId, cards, onSelect]);

  // ── The stage swapped. A fresh draft per model — keyed on the ID alone, so
  // the row refetch that follows every commit can never clobber what the dealer
  // is typing — and, FIRST, the previous model's pending draft is flushed
  // against the model it belongs to. The REF is written here too, not just the
  // state: the mesh-swap effect below runs in the SAME commit and reads it to
  // paint the initial grouping — a render behind, it would paint the previous
  // model's merges.
  useEffect(() => {
    if (draftOwnerRef.current.id === activeId) return;
    flushParts();                              // writes against draftOwnerRef (the OLD model)
    draftOwnerRef.current = { id: activeId, collection: cardRef.current?.collection || 'Togo' };
    const fresh = cloneParts(cardRef.current?.parts);
    draftRef.current = fresh;
    setDraft(fresh);
    baseFinishesRef.current = fresh.finishes || null;
    setBaseFinishes(fresh.finishes || null);
    dirtyRef.current = false;
    setDirty(false);
    setPartKeys([]);
    setSelected(null);
    setHovered(null);
    setSlotErr(null);
    setSaveErr(null);
    setFanoutErr(0);
    setDetectErr(null);
    setMeshOpErr(null);
    // `flushParts` is stable (it only closes over `runSave`); listing it would
    // re-run this whole reset on a save-chain identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // A RETAG while the model stays on the stage (the inspector's «Colección»
  // field) moves who the fan-out belongs to. Without this the next save would
  // still plan against the colección the piece was opened under.
  useEffect(() => {
    if (draftOwnerRef.current.id === activeId && card) {
      draftOwnerRef.current.collection = card.collection || 'Togo';
    }
  }, [activeId, card]);

  const mesh = card?.mesh || null;
  const meshKey = mesh?.url ? `${mesh.url}|${mesh.upAxis || 'y'}|${mesh.rotateY || 0}|${mesh.scale || 0}` : '';
  const hasModels = cards.length > 0;

  // ── The 3D stage. Boots ONCE (renderer, camera, controls, lighting rig, the
  // render loop) and lives for as long as the studio does; models are swapped
  // into it by the effect below. A WebGL context per model would have the
  // browser dropping the oldest contexts after a dozen clicks.
  const [engineReady, setEngineReady] = useState(0);
  useEffect(() => {
    if (!hasModels) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    let alive = true;

    const teardown = () => {
      const eng = engineRef.current;
      if (!eng) return;
      engineRef.current = null;
      if (eng.raf) cancelAnimationFrame(eng.raf);
      eng.ro?.disconnect();
      eng.controls?.dispose?.();
      // Only OUR clones: every geometry was cloned off the shared cache and
      // every material is one this studio made (see the build pass below).
      disposeGroup(eng.group);
      eng.placeholder?.dispose?.();
      eng.stage?.dispose?.();
      eng.maskRT?.dispose?.();
      eng.maskMat?.dispose?.();
      eng.renderer?.domElement?.remove();
      eng.renderer?.dispose?.();
    };

    (async () => {
      try {
        const [THREE, { OrbitControls }, { RoomEnvironment }] = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/controls/OrbitControls.js')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
        ]);
        if (!alive) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.domElement.style.cssText = 'display:block;outline:none;touch-action:none;width:100%;height:100%';
        host.appendChild(renderer.domElement);

        // Registered NOW, half-built: anything that throws below still has its
        // renderer and canvas reclaimed by teardown.
        const eng = {
          THREE, renderer, group: null, holder: null, nodes: [], mats: new Map(), groupOf: new Map(),
          sig: '', raf: 0, ro: null, hover: null, sized: '', touched: false, height: CANON_RADIUS,
          accent: tokenColor(host, '--brand-500', 0xd68a66),
        };
        engineRef.current = eng;

        const scene = new THREE.Scene();
        const group = new THREE.Group();
        scene.add(group);
        eng.scene = scene;
        eng.group = group;

        // The rig is built for the CANONICAL radius every model is normalized
        // to, so it never has to be rebuilt (and never mis-sizes its shadow
        // frustum on a model authored in metres).
        eng.stage = setupTogoStage(
          { THREE, RoomEnvironment }, renderer, scene, CANON_RADIUS,
          { ground: tokenColor(host, '--canvas', 0x171512) },
        );

        const camera = new THREE.PerspectiveCamera(35, 1, CANON_RADIUS / 100, CANON_RADIUS * 400);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = !prefersReducedMotion();
        controls.dampingFactor = 0.09;
        controls.enablePan = true;
        controls.zoomToCursor = true;
        controls.maxPolarAngle = Math.PI * 0.495;
        controls.minDistance = CANON_RADIUS * 0.6;
        controls.maxDistance = CANON_RADIUS * 14;
        eng.camera = camera;
        eng.controls = controls;

        const frame = () => {
          const vFov = (camera.fov * Math.PI) / 180;
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.4, camera.aspect));
          const height = eng.height;
          const dist = Math.max(
            CANON_RADIUS / Math.tan(hFov / 2),
            (height * 0.5 + CANON_RADIUS * 0.4) / Math.tan(vFov / 2),
          ) * 1.3;
          camera.position.set(dist * 0.6, height * 0.55 + dist * 0.42, dist * 0.78);
          controls.target.set(0, height * 0.42, 0);
          controls.update();
        };
        eng.frame = frame;

        const resize = () => {
          const w = Math.max(1, Math.round(host.clientWidth));
          const h = Math.max(1, Math.round(host.clientHeight));
          const key = `${w}x${h}`;
          if (eng.sized === key) return;
          eng.sized = key;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          // Re-frame on every size change until the dealer takes the camera:
          // the first layout pass can measure a host with no height yet, and a
          // framing solved for that aspect crops the piece.
          if (!eng.touched) frame();
        };
        resize();

        // ── Picking. A drag is an orbit, a tap is a selection: the pointer has
        // to stay put between down and up for the click to count, or every
        // camera move would re-select whatever it started on.
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        // Both keys come back: `raw` is the mesh's OWN part key and `group` the
        // key it currently renders under. Join-by-click needs the difference —
        // clicking a mesh already folded into the selected part must be able to
        // separate exactly that mesh, and the group key alone can't name it.
        const groupAt = (ev) => {
          const rect = renderer.domElement.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
          ray.setFromCamera(ndc, camera);
          const hit = ray.intersectObject(group, true)[0];
          const key = hit?.object?.userData?.partKey;
          return key ? { raw: key, group: eng.groupOf.get(key) || key } : null;
        };
        let down = null;
        const onDown = (ev) => {
          eng.touched = true;
          down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
        };
        const onUp = (ev) => {
          const start = down;
          down = null;
          if (!start || start.id !== ev.pointerId) return;
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) return;   // that was an orbit
          const hit = groupAt(ev);
          // React owns what a click MEANS (select, or fold into the part being
          // joined) — the engine only reports what was under the pointer.
          if (eng.pick) eng.pick(hit);
          else setSelected(hit?.group ?? null);
        };
        const onMove = (ev) => {
          if (down) return;                                    // don't raycast mid-orbit
          const hit = groupAt(ev);
          const key = hit?.group ?? null;
          // 'copy' while joining: the pointer says "this click ADDS", which is
          // the only cue distinguishing the two things a click can now do.
          renderer.domElement.style.cursor = key ? (eng.joinMode ? 'copy' : 'pointer') : '';
          if (key === eng.hover) return;
          eng.hover = key;
          setHovered(key);
        };
        const onLeave = () => {
          renderer.domElement.style.cursor = '';
          if (eng.hover == null) return;
          eng.hover = null;
          setHovered(null);
        };
        renderer.domElement.addEventListener('pointerdown', onDown);
        renderer.domElement.addEventListener('pointerup', onUp);
        renderer.domElement.addEventListener('pointermove', onMove);
        renderer.domElement.addEventListener('pointerleave', onLeave);
        renderer.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          if (eng.raf) { cancelAnimationFrame(eng.raf); eng.raf = 0; }
          setStatus('failed');
          setMeshErr('El navegador perdió el contexto 3D.');
        });

        /** Paint one material per GROUP and remember which group each key is in. */
        eng.setGroups = (groups) => {
          const sig = groups.map((g) => `${g.key}:${g.members.join(',')}`).join('|');
          if (sig === eng.sig) return;
          eng.sig = sig;
          eng.groupOf = new Map();
          const next = new Map();
          groups.forEach((g) => {
            for (const m of g.members) eng.groupOf.set(m, g.key);
            const mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
            const c = clayOf(g.index);
            mat.color.setHSL(c.h, c.s, c.l);
            next.set(g.key, mat);
          });
          for (const n of eng.nodes) {
            const mat = next.get(eng.groupOf.get(n.key) || n.key);
            if (mat) n.mesh.material = mat;
          }
          for (const old of eng.mats.values()) old.dispose();
          eng.mats = next;
        };

        /** Selection reads as the gold silhouette OUTLINE (the configurator's
         *  own cue) plus the brand accent lifting off the part; hover as a
         *  soft lift of the part's own tint. */
        eng.setHighlight = (selKey, hovKey) => {
          eng.selKey = selKey || null;
          eng.selMeshes = selKey
            ? eng.nodes.filter((n) => (eng.groupOf.get(n.key) || n.key) === selKey).map((n) => n.mesh)
            : null;
          eng.outlineSig = '';                       // force a redraw next frame
          for (const [key, mat] of eng.mats) {
            if (key === selKey) {
              mat.emissive.setHex(eng.accent);
              mat.emissiveIntensity = 0.55;
            } else if (key === hovKey) {
              mat.emissive.copy(mat.color);
              mat.emissiveIntensity = 0.22;
            } else {
              mat.emissiveIntensity = 0;
            }
          }
        };

        // ── The selected group's silhouette — TogoStage's mask-pass outline,
        // adapted from one piece-group to an arbitrary MESH SET (a merged part
        // group is meshes scattered through the model, not one subtree). Each
        // computed frame renders the selection alone (white, unlit, double-
        // sided) through the live camera's sub-frustum into a small offscreen
        // target; `maskToOutline` traces the readback — the true silhouette,
        // every concavity included, robust to any dealer mesh.
        const MASK_LAYER = 30;
        const MASK_MAX = 512;
        const MASK_CELL = 2;
        const _mv = new THREE.Vector3();
        const _mbox = new THREE.Box3();
        const _b = new THREE.Box3();
        const maskOutlineFor = (meshes, cw, ch) => {
          if (!eng.maskRT) {
            eng.maskRT = new THREE.WebGLRenderTarget(MASK_MAX, MASK_MAX, { depthBuffer: false, stencilBuffer: false });
            eng.maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false, fog: false });
            eng.maskBuf = new Uint8Array(MASK_MAX * MASK_MAX * 4);
            eng.maskClear = new THREE.Color();
          }
          _mbox.makeEmpty();
          for (const m of meshes) { _b.setFromObject(m); if (!_b.isEmpty()) _mbox.union(_b); }
          if (_mbox.isEmpty()) return null;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let i = 0; i < 8; i++) {
            _mv.set(i & 1 ? _mbox.max.x : _mbox.min.x, i & 2 ? _mbox.max.y : _mbox.min.y, i & 4 ? _mbox.max.z : _mbox.min.z).project(camera);
            const x = (_mv.x * 0.5 + 0.5) * cw, y = (-_mv.y * 0.5 + 0.5) * ch;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
          if (!(maxX > minX) || !(maxY > minY)) return null;
          const cell = Math.max(MASK_CELL, (maxX - minX + 12) / (MASK_MAX - 2), (maxY - minY + 12) / (MASK_MAX - 2));
          const rx = Math.floor((minX - 3 * cell) / cell) * cell;
          const ry = Math.floor((minY - 3 * cell) / cell) * cell;
          const gw = Math.min(MASK_MAX, Math.ceil((maxX + 3 * cell - rx) / cell));
          const gh = Math.min(MASK_MAX, Math.ceil((maxY + 3 * cell - ry) / cell));
          if (gw < 2 || gh < 2) return null;
          const bg = scene.background;
          const override = scene.overrideMaterial;
          const camLayers = camera.layers.mask;
          renderer.getClearColor(eng.maskClear);
          const clearA = renderer.getClearAlpha();
          try {
            for (const m of meshes) m.layers.enable(MASK_LAYER);
            scene.background = null;
            scene.overrideMaterial = eng.maskMat;
            camera.layers.set(MASK_LAYER);
            camera.setViewOffset(cw, ch, rx, ry, gw * cell, gh * cell);
            renderer.setClearColor(0x000000, 1);
            eng.maskRT.viewport.set(0, 0, gw, gh);
            renderer.setRenderTarget(eng.maskRT);
            renderer.render(scene, camera);
            renderer.readRenderTargetPixels(eng.maskRT, 0, 0, gw, gh, eng.maskBuf);
          } catch { return null; } finally {
            renderer.setRenderTarget(null);
            renderer.setClearColor(eng.maskClear, clearA);
            camera.clearViewOffset();
            camera.layers.mask = camLayers;
            scene.overrideMaterial = override;
            scene.background = bg;
            for (const m of meshes) m.layers.disable(MASK_LAYER);
          }
          // ALL islands: a joined part is usually several disjoint solids (the
          // four legs, a pair of cushions), and they are ONE selection — so
          // every one of them gets a line, not just the biggest.
          return maskToOutline(eng.maskBuf, gw, gh, { x: rx, y: ry, cell, allLoops: true });
        };
        // Every island rides ONE path element as its own subpath, so the two
        // strokes (ink casing + gold) stay two nodes however many pieces the
        // selection turns out to be.
        const drawOutline = (loops) => {
          const svg = outlineSvgRef.current; if (!svg) return;
          let d = '';
          for (const pts of (loops || [])) {
            if (!pts || pts.length < 3) continue;
            for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + pts[i].x.toFixed(1) + ' ' + pts[i].y.toFixed(1);
            d += 'Z';
          }
          if (d) {
            outlineCasingRef.current?.setAttribute('d', d);
            outlineGoldRef.current?.setAttribute('d', d);
            svg.style.display = '';
          } else {
            svg.style.display = 'none';
          }
        };
        // Recompute only when the view or the selection actually changed — the
        // studio's loop runs every frame, and a static camera would otherwise
        // pay a mask render + GPU readback per frame for a line that can't move.
        eng.strokeOutline = () => {
          const meshes = eng.selMeshes;
          if (!meshes || !meshes.length) {
            if (eng.outlineSig !== 'off') { eng.outlineSig = 'off'; drawOutline(null); }
            return;
          }
          const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
          const p = camera.position, q = camera.quaternion;
          const sig = `${eng.selKey}|${eng.sized}|${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}|${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`;
          if (sig === eng.outlineSig) return;
          eng.outlineSig = sig;
          drawOutline(cw > 0 && ch > 0 ? maskOutlineFor(meshes, cw, ch) : null);
        };

        eng.ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => resize()) : null;
        eng.ro?.observe(host);

        const tick = () => {
          if (engineRef.current !== eng) return;
          eng.raf = requestAnimationFrame(tick);
          controls.update();
          if (!document.hidden) {
            renderer.render(scene, camera);
            eng.strokeOutline();
          }
        };
        eng.raf = requestAnimationFrame(tick);

        setEngineReady((n) => n + 1);
      } catch (e) {
        if (!alive) return;
        teardown();
        setStatus('failed');
        setMeshErr(e?.message || 'No se pudo iniciar el visor 3D.');
      }
    })();

    return () => { alive = false; teardown(); };
  }, [hasModels]);

  // ── Swap the model on the (already-running) stage.
  useEffect(() => {
    if (!engineReady) return undefined;
    const eng = engineRef.current;
    if (!eng) return undefined;

    const clear = () => {
      if (!eng.holder) return;
      eng.group.remove(eng.holder);
      disposeGroup(eng.holder);          // our clones only
      eng.placeholder?.dispose?.();
      eng.placeholder = null;
      eng.holder = null;
      eng.nodes = [];
      // The outline must never stroke meshes of a model that just left the
      // stage — hide it until the selection effect re-derives the new set.
      eng.selMeshes = null;
      eng.mats = new Map();              // disposeGroup already freed them
      eng.groupOf = new Map();
      eng.sig = '';
    };

    if (!meshKey) {
      clear();
      setStatus('failed');
      setMeshErr(null);
      // The parts list still works without a mesh: fall back to the keys the
      // stored tagging already knows about, so the dealer is never locked out.
      setPartKeys(Object.keys(draftRef.current?.mats || {}));
      return undefined;
    }

    let alive = true;
    setStatus('loading');
    setMeshErr(null);

    (async () => {
      try {
        const THREE = eng.THREE;
        const desc = cardRef.current?.mesh;
        // No cache argument: this rides the SHARED session cache, so opening a
        // model whose thumbnail already rendered costs nothing.
        const { modelFor } = await loadTogoModels({ pieces: [{ mesh: desc }] });
        if (!alive || engineRef.current !== eng) return;
        const source = modelFor({ mesh: desc })?.object;
        if (!source) throw new Error('No se pudo cargar el modelo 3D.');

        // The studio's own copy. `clone(true)` shares geometry AND materials
        // with the cached source, so the build pass below replaces both before
        // anything of ours is ever disposed.
        const model = source.clone(true);
        model.updateMatrixWorld(true);

        // Boxes FIRST, in the SAME z-up remap the tagger uses and before any
        // normalization — so the keys this studio paints are exactly the keys
        // the stored tagging was written against.
        const zUp = (desc?.upAxis || 'y') === 'z';
        const boxV = new THREE.Box3();
        const sizeV = new THREE.Vector3();
        const nodes = [];
        model.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
          const nm = mats[0]?.name;
          boxV.setFromObject(o).getSize(sizeV);
          nodes.push({
            mesh: o,
            materialName: nm,
            // Whether the mesh brought its OWN finish — the exact test the
            // scene builder renders by (a map with real image data). Read HERE,
            // because the studio replaces every material with a flat tint one
            // line later and the fact would be gone.
            factory: mats.some((m) => m?.map?.isTexture && (m.map.image || m.map.source?.data)),
            size: zUp ? [sizeV.x, sizeV.z, sizeV.y] : [sizeV.x, sizeV.y, sizeV.z],
          });
        });
        if (!nodes.length) throw new Error('El modelo no tiene mallas.');
        const keys = partKeysFor(nodes);
        // The part keys whose meshes carry a factory finish — the inspector
        // badges them, so "why doesn't this one take the tela?" is answered on
        // the row instead of read as a bug.
        const ownMatKeys = keys.filter((k, i) => k && nodes[i].factory);

        const placeholder = new THREE.MeshStandardMaterial({ color: 0xbfb8ac, roughness: 0.9, metalness: 0 });
        nodes.forEach((n, i) => {
          n.key = keys[i];
          if (n.mesh.geometry) n.mesh.geometry = n.mesh.geometry.clone();   // own the buffers
          n.mesh.material = placeholder;                                    // drop the shared material
          n.mesh.castShadow = true;
          n.mesh.receiveShadow = true;
          n.mesh.userData.partKey = keys[i];
        });

        // Orientation fixups, same as the stage: stand up a Z-up export, then
        // apply the dealer's manual spin.
        if (zUp) model.rotation.x = -Math.PI / 2;
        if (desc?.rotateY) model.rotation.y += (desc.rotateY * Math.PI) / 180;

        const holder = new THREE.Group();
        holder.add(model);
        holder.updateMatrixWorld(true);

        // Centre on the turn axis, sit it on the floor the stage catches
        // shadows on, then NORMALIZE to the canonical radius the rig was built
        // for — whatever unit the export was authored in.
        const box = new THREE.Box3().setFromObject(holder);
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        model.position.set(-centre.x, -box.min.y, -centre.z);
        const radius = Math.max(1e-3, Math.hypot(size.x, size.z) / 2);
        const k = CANON_RADIUS / radius;
        holder.scale.setScalar(k);
        holder.updateMatrixWorld(true);

        if (!alive || engineRef.current !== eng) { disposeGroup(holder); placeholder.dispose(); return; }

        clear();
        eng.holder = holder;
        eng.placeholder = placeholder;
        eng.nodes = nodes;
        eng.height = Math.max(1e-3, size.y) * k;
        eng.group.add(holder);
        eng.group.updateMatrixWorld(true);
        eng.touched = false;
        eng.frame?.();

        // Paint whatever grouping the draft already implies, then hand the keys
        // to React (which drives every later repaint through setGroups).
        eng.setGroups(buildGroups(keys, draftRef.current));
        setPartKeys(keys);
        setFactoryKeys(ownMatKeys);
        setStatus('ready');
      } catch (e) {
        if (!alive || engineRef.current !== eng) return;
        clear();
        setPartKeys(Object.keys(draftRef.current?.mats || {}));
        setFactoryKeys([]);
        setStatus('failed');
        setMeshErr(e?.message || 'No se pudo cargar el modelo 3D.');
      }
    })();

    return () => { alive = false; };
  }, [engineReady, meshKey]);

  // Grouping depends on the MERGES alone, and every draft write is immutable —
  // so `merges` identity is the honest trigger. Keying this on `draft` would
  // rebuild every material on each keystroke typed into a label.
  const merges = draft?.merges;
  const groups = useMemo(() => buildGroups(partKeys, { merges }), [partKeys, merges]);
  const group = useMemo(() => groups.find((g) => g.key === selected) || null, [groups, selected]);

  // Which groups render their FACTORY finish — the model brought its own
  // texture AND nothing the dealer authored outranks it. Mirrors the scene
  // builder's precedence (finish > explicit tag > factory texture > fabric), so
  // the badge says what the configurador actually shows: leave it alone and the
  // walnut stays walnut; tag it and it takes tela like anything else.
  const factoryGroups = useMemo(() => {
    const own = new Set(factoryKeys);
    const out = new Set();
    for (const g of groups) {
      if (!g.members.some((m) => own.has(m))) continue;
      if (PART_ROLES.includes(draft?.mats?.[g.key]) || finishSpecOf(draft, g.key)) continue;
      out.add(g.key);
    }
    return out;
  }, [groups, factoryKeys, draft]);

  // What the COLECCIÓN already offers for the parts on this stage but this
  // model doesn't define itself — the finish editor shows it prefilled, and the
  // first edit makes it the model's own (collectionFinishes).
  const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);
  // The DRAFT is what decides here, not the stored row: a group marked
  // Estructura a second ago must already inherit the colección's estructura.
  const inheritedFinishes = useMemo(
    () => inheritedFinishesFor(models, { collection, modelId: activeId, partKeys: groupKeys, parts: draft }),
    [models, collection, activeId, groupKeys, draft],
  );
  // The colección's ONE estructura palette — the EXACT thing `resolveTogoModels`
  // injects into every structure group that carries none, so the verdict below
  // and what the client is actually offered cannot drift apart. Deliberately not
  // `inheritedFinishes` (which lets a SAME-KEY palette off a Base sibling win):
  // that one is the editor's prefill, this one is the rule.
  const collectionStructure = useMemo(
    () => structureFinishesOf(models, collection),
    [models, collection],
  );

  // How many siblings this save would rewrite — shown BEFORE committing,
  // because a save that silently rewrote five other models reads as a bug the
  // first time the dealer notices it. The estructura fan-out is counted in it
  // (same plan as the save), so the number IS the blast radius.
  const fanoutCount = useMemo(() => (dirty && activeId
    ? planSiblingFinishes(models, {
      collection, sourceModelId: activeId, before: baseFinishes, after: draft?.finishes, parts: draft,
    }).length
    : 0), [dirty, activeId, models, collection, baseFinishes, draft]);

  useEffect(() => { engineRef.current?.setGroups?.(groups); }, [groups]);
  useEffect(() => { engineRef.current?.setHighlight?.(selected, hovered); }, [selected, hovered, groups]);

  // ── Draft edits.
  const setLabel = useCallback((key, text) => editParts((d) => {
    const labels = { ...(d.labels || {}) };
    if (String(text).trim()) labels[key] = String(text); else delete labels[key];
    return { ...d, labels };
  }), [editParts]);

  // An ESTRUCTURA palette is the colección's, not the group's: editing it here
  // writes it onto EVERY structure group of this model at once, so the piece on
  // the stage is instantly as consistent as the siblings the save will rewrite.
  // Any other role keeps owning its own key.
  //
  // The SELECTED group is written first either way — a split cluster
  // ("patas~2") wears its material's Estructura tag without ever appearing in
  // `parts`, so writing it is also what puts it on the map for the fold.
  const setGroupFinish = useCallback((key, spec, role) => editParts((d) => {
    const next = writeFinish(d, key, spec);
    return role === 'structure' ? applyStructureToDraft(next, spec) : next;
  }), [editParts]);

  // ── UNIR / SEPARAR — ONE gesture, and the Model owns what it means.
  //
  // The dealer points at two things and says "these are one part" (or at one
  // member and says "this one is its own"). What that IS in the data depends on
  // where the keys came from — two pCon materials are a MERGE, two islands of the
  // same material are an UN-SPLIT — and he must never have to know which:
  // `planPartJoin`/`planPartSplit` (meshParts.js) settle the merge map, the role,
  // the label and the palette together so both cases land on ONE truth. This
  // layer only decides WHICH keys the gesture is about.
  const separate = useCallback((memberKeys) => {
    const keys = (memberKeys || []).filter(Boolean);
    if (!keys.length) return;
    editParts((d) => planPartSplit(d, mergedKeyOf(d, keys[0]), keys));
  }, [editParts]);

  const mergeInto = useCallback((targetKey, keys) => {
    if (!keys?.length) return;
    // A group's MEMBERS, not the group key: folding a group in has to carry
    // everything already folded into it, or its children stay pointed at a key
    // that is no longer a group of its own.
    const members = [];
    for (const gk of keys) {
      const g = groups.find((x) => x.key === gk);
      if (g) members.push(...g.members); else members.push(gk);
    }
    editParts((d) => planPartJoin(d, targetKey, members));
    setSelected(targetKey);
  }, [editParts, groups]);

  // What a stage click MEANS, given the mode. Handed to the engine by ref
  // (below) so the pointer handler never closes over stale state.
  //
  // ONE armed mode does BOTH directions, because to the dealer it is one
  // question asked of whatever he clicks: inside this part ⇒ take it out, outside
  // ⇒ bring it in. `hit.raw` is the mesh's OWN key, which is what makes taking it
  // out possible for a natively-grouped island too — it need not carry a merge
  // entry, it only needs to not be the group key itself.
  const handlePick = useCallback((hit) => {
    if (!joinMode || !selected) { setSelected(hit?.group ?? null); return; }
    if (!hit) return;                       // empty space: stay armed, join more
    if (hit.group === selected) {
      if (hit.raw !== selected) separate([hit.raw]);
      return;
    }
    mergeInto(selected, [hit.group]);
  }, [joinMode, selected, separate, mergeInto]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.pick = handlePick;
    eng.joinMode = joinMode && !!selected;
  }, [handlePick, joinMode, selected, engineReady]);

  // Disarm whenever the target goes away (deselect, another model): a live
  // join mode with nothing to join into would swallow the next select click.
  useEffect(() => { if (!selected) setJoinMode(false); }, [selected]);
  useEffect(() => { setJoinMode(false); }, [meshKey]);
  // ── KEYBOARD. The mode's ONE button lives in the inspector, which can be
  // scrolled past the part editor, and tagging a catalogue means the same few
  // moves over and over — so the hands stay on the keyboard.
  //
  //   U        modo unir on/off (needs a selected part — that IS what you join into)
  //   Esc      sale del modo; con el modo ya fuera, deselecciona
  //   ← / →    modelo anterior / siguiente
  //
  // Never while typing: a bare letter is a shortcut only outside a field, or
  // renaming a part would toggle modes mid-word. Modifier combos are left to the
  // browser — Cmd+← is "back", not "previous model".
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      const tag = el?.tagName;
      if (el?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        if (joinMode) setJoinMode(false);
        else setSelected(null);
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        // Arming it with nothing selected would swallow the next click, which is
        // the same reason the mode clears itself when the selection goes.
        if (selected) { e.preventDefault(); setJoinMode((v) => !v); }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // The list the dealer is LOOKING at — the table's own filtered, searched
        // and sorted order. Walking `cards` instead would jump out of the filter
        // he just applied, into a model the screen isn't even showing. Falls back
        // to the full list only before the table has published anything.
        const order = navIds?.length ? navIds : cards.map((c) => c.id);
        const at = order.indexOf(activeIdRef.current);
        if (at < 0) return;
        const to = order[at + (e.key === 'ArrowRight' ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        onSelect?.(to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [joinMode, selected, cards, navIds, onSelect]);

  // Marking a group ESTRUCTURA is JOINING it to the colección's acabado, and
  // that join is AUTOMATIC (owner, 2026-07: «QUITA LO DE USAR EN ESTE MODELO.
  // HAZLO AUTOMATICO»): the palette arrives WITH the role, in the same edit.
  //
  // It used not to, and that was the whole feature's dead end: `structure` and
  // `finishes` are two independent writes, the configurador needs BOTH
  // (structureGroupsOf drops a group whose `finishSpecOf` is null), and only the
  // role had a control the dealer could find. The editor below PREFILLED the
  // colección's palette and badged it — but that palette lived on a sibling's
  // row, so until a button was pressed the model itself still had nothing.
  //
  // Precedence, asked against the POST-click draft (a group can only take the
  // colección's estructura once it IS one):
  //   1. THIS model's own estructura — its legs and its frame are the same
  //      estructura, so a second structure group joins the palette already on the
  //      piece instead of overwriting it;
  //   2. the COLECCIÓN's.
  // Neither ⇒ nothing is planted: `resolveStructureFinish` reads `empty` and the
  // editor's one-click Acero / Acero lacado negro starter is the offer. A group
  // that already carries a valid palette is left completely alone.
  const setSlot = useCallback((members, role, key = null) => editParts((d) => {
    const next = writeSlot(d, members, role, null);
    if (role !== 'structure' || !key || finishSpecOf(next, key)) return next;
    const col = cardRef.current?.collection || 'Togo';
    const spec = structureFinishesOf([{ id: 'self', collection: col, parts: next }], col)
      || structureFinishesOf(modelsRef.current, col);
    return spec ? applyStructureToDraft(next, spec) : next;
  }), [editParts]);

  const bindSku = useCallback((members, currentRole, root) => {
    const plan = planSkuSlot(draftRef.current, members, currentRole, root);
    if (plan.error) { setSlotErr(plan.error); return; }
    editParts((d) => writeSlot(d, members, plan.role, root));
  }, [editParts]);

  // The typed count is CLAMPED to the Model's range here too, so a typo can't
  // even be staged into the draft. It SATURATES (the low end always has: a typed
  // -5 stores 0, it doesn't revert) rather than falling back like `partCount`,
  // and the difference is deliberate — the input re-mounts on the stored value,
  // so the dealer watching their 100000 land as COUNT_MAX reads as a limit,
  // where watching it land as 1 reads as the studio losing their input. The
  // Model's fall-back is the guard for what this control can no longer produce:
  // a hand-edited row, or one written by a bundle that predates this clamp.
  const setCount = useCallback((role, n) => editParts((d) => ({
    ...d,
    counts: { ...(d.counts || {}), [role]: Math.min(COUNT_MAX, Math.max(0, Math.round(Number(n) || 0))) },
  })), [editParts]);

  // ── "Detectar partes" — unchanged from the card it moved off: load the mesh,
  // cluster its meshes per material + shape, fingerprint the collection's loose
  // accessory models, and PROPOSE a role per group. Existing choices win; the
  // proposal only fills NEW keys. Commits (the dealer just asked for it), then
  // restamps the plan from the shadow-stripped mesh.
  const accessories = useMemo(() => (card
    ? cards.filter((a) => a.id !== card.id && a.collection === card.collection && a.mesh && accessoryRoleFor(a.name))
    : []), [cards, card]);

  const detect = async () => {
    if (!card?.mesh || detecting) return;
    setDetecting(true); setDetectErr(null);
    try {
      const { modelFor } = await loadTogoModels({ pieces: [{ mesh: card.mesh }] });
      const real = modelFor({ mesh: card.mesh });
      if (!real?.object) throw new Error('No se pudo cargar el modelo 3D.');
      const THREE = await safeDynamicImport(() => import('three'));
      const obj = real.object;
      obj.updateMatrixWorld(true);
      // One group per material name (fallback: node index), boxes merged. A
      // z-up export swaps its height axis so the classifier reads y-up boxes.
      const zUp = (card.meshUpAxis || 'y') === 'z';
      const remap = (v) => (zUp ? [v[0], v[2], v[1]] : v);
      // Every mesh's box first, THEN the keys. A material that upholsters two
      // different part types splits into shape clusters — merging its boxes
      // before that split averaged a slab and a roll into one box that is
      // neither. `partKeysFor` needs all the boxes to see it.
      const meshes = [];
      obj.traverse((o) => {
        if (!o.isMesh) return;
        const name = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
        const box = new THREE.Box3().setFromObject(o);
        const min = remap(box.min.toArray()), max = remap(box.max.toArray());
        meshes.push({ materialName: name, min, max, size: max.map((v, a) => v - min[a]) });
      });
      const keys = partKeysFor(meshes);
      const byKey = new Map();
      meshes.forEach((m, i) => {
        const key = keys[i];
        const g = byKey.get(key);
        if (g) {
          g.min = g.min.map((v, a) => Math.min(v, m.min[a]));
          g.max = g.max.map((v, a) => Math.max(v, m.max[a]));
        } else byKey.set(key, { key, min: m.min, max: m.max });
      });
      const found = [...byKey.values()];
      if (!found.length) throw new Error('El modelo no tiene mallas.');
      // FINGERPRINTS from the collection's standalone accessory models: pCon
      // reuses ONE material id per part type across the collection, so a sofa
      // sub-mesh sharing the loose cushion's material IS that cushion; its
      // measured size (cm) is the second signal. Each accessory loads once (the
      // loader caches by URL) and a broken one just contributes nothing.
      const refs = (await Promise.all(accessories.map(async (a) => {
        try {
          const { modelFor: accModelFor } = await loadTogoModels({ pieces: [{ mesh: a.mesh }] });
          const acc = accModelFor({ mesh: a.mesh });
          if (!acc?.object) return null;
          acc.object.updateMatrixWorld(true);
          const accZUp = (a.meshUpAxis || 'y') === 'z';
          const accRemap = (v) => (accZUp ? [v[0], v[2], v[1]] : v);
          const matKeys = [];
          const boxAll = new THREE.Box3().setFromObject(acc.object);
          acc.object.traverse((o) => {
            if (!o.isMesh) return;
            const nm = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
            // Only NAMED materials fingerprint — positional keys ("#2") are
            // meaningless across different exports.
            if (nm && String(nm).trim()) matKeys.push(String(nm).trim());
          });
          const rawMin = accRemap(boxAll.min.toArray()), rawMax = accRemap(boxAll.max.toArray());
          const rawSize = rawMax.map((v, i2) => v - rawMin[i2]);
          const unit = autoUnitScale(Math.max(...rawSize));
          return { role: accessoryRoleFor(a.name), matKeys, size: rawSize.map((v) => v * unit) };
        } catch { return null; }
      }))).filter((ref) => ref && ref.role);
      // The sofa's own groups measure in ITS units — bring them to cm with the
      // same unit guard so size fingerprints compare like for like.
      const sofaRaw = found.reduce((m, g) => Math.max(m, ...g.max.map((v, i2) => v - g.min[i2])), 0);
      const sofaUnit = autoUnitScale(sofaRaw);
      const cmGroups = found.map((g) => ({ key: g.key, min: g.min.map((v) => v * sofaUnit), max: g.max.map((v) => v * sofaUnit) }));
      const proposal = classifyPartGroups(cmGroups, refs);
      // Keep the dealer's existing choices; the proposal only fills NEW keys.
      const base = draftRef.current || {};
      const next = { ...base, mats: { ...proposal, ...(base.mats || {}) } };
      setDraft(next);
      dirtyRef.current = false;
      setDirty(false);
      // Detect writes parts DIRECTLY (no fan-out — it never edits palettes),
      // but it must not interleave with an in-flight save chain on this model:
      // both end in commitParts on the same row and the loser's write wins.
      // Wait the chain out; its failure is its own problem (already surfaced).
      await saveChainsRef.current.get(activeIdRef.current)?.catch(() => {});
      await commitParts(next);
      // Restamp the plan + footprint from the (shadow-stripped) mesh: the tile
      // becomes PLATFORM-true, so joined modules meet platform-to-platform and
      // the leaning cushions overhang instead of padding the footprint.
      try {
        const plan = await loadMeshPlan(card.mesh.url, { upAxis: card.meshUpAxis || 'y' });
        if (plan?.svg) await db.togoModels.update(card.id, { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm, updatedAt: Date.now() });
      } catch { /* keep the stored plan */ }
    } catch (e) {
      setDetectErr(e?.message || 'No se pudieron detectar las partes.');
    } finally {
      setDetecting(false);
    }
  };

  // ── The model's own 3D file. Same pipeline as the upload card: serve a compact
  // GLB, keep the original as the model's source.
  const replaceMesh = async (file) => {
    if (!file || !card || meshBusy) return;
    setMeshBusy(true); setMeshOpErr(null);
    try {
      const prev = card.meshUrl;
      const { THREE, object } = await loadSceneFile(file);
      const split = splitScene(THREE, object);
      const isGlb = /\.(glb|gltf)$/i.test(file.name);
      const upAxis = split.upAxis || card.meshUpAxis || 'y';
      const servable = (split.pieces.length === 1 && !isGlb)
        ? new File([await exportPieceGlb(THREE, split.pieces[0].meshes)], file.name.replace(/\.[^.]+$/, '') + '.glb', { type: 'model/gltf-binary' })
        : file;
      const url = await uploadTogoMesh(servable);
      const plan = await loadMeshPlan(url, { upAxis });
      const sourceUrl = (servable === file) ? null : await uploadTogoMesh(file).catch(() => null);
      await db.togoModels.update(card.id, {
        meshUrl: url, meshScale: null, meshUpAxis: upAxis, meshRotateY: card.meshRotateY || 0,
        // A file that just came out of `exportPieceGlb` IS the current pipeline —
        // it is already one mesh per solid. Saying so here is what stops the
        // automatic pass from downloading and re-exporting it for nothing, and
        // what lets it be tagged straight away instead of waiting for a re-export
        // it doesn't need. `servable === file` means a GLB we passed through
        // untouched, which the pass still owes a look at.
        ...(servable === file ? {} : { meshV: ALCOVER_MESH_V }),
        meshSourceUrl: sourceUrl, meshSourceName: file.name, ingestedAt: Date.now(),
        ...(plan?.svg ? { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm } : {}),
        updatedAt: Date.now(),
      });
      // The replaced GLB is this model's alone → reclaimed. The ORIGINAL
      // (meshSourceUrl) is NOT: a batch import uploads one pCon export and
      // shares it across every piece it produced, so deleting it here would
      // 404 the provenance of the model's siblings.
      if (prev) removeTogoMesh(prev);
    } catch (e) { setMeshOpErr(e?.message || 'No se pudo subir el modelo 3D.'); }
    finally { setMeshBusy(false); }
  };
  // What THIS BRAND calls a 3D model. The list also writes the error message,
  // so a dealer on a module set that doesn't read .3ds is never told to try one.
  const meshExtensions = modules?.geometry?.extensions || null;
  const meshIntake = useFileIntake({
    accept: modules?.geometry?.accept || ACCEPT_3D,
    disabled: meshBusy || !card,
    onFiles: ([f]) => replaceMesh(f),
    onReject: () => setMeshOpErr(
      meshExtensions?.length
        ? `Sube un modelo 3D (${meshExtensions.join(', ')}).`
        : 'Sube un modelo 3D (.fbx, .glb, .obj…).',
    ),
  });

  const removeMesh = async () => {
    if (!card) return;
    const prev = card.meshUrl;
    await db.togoModels.update(card.id, {
      meshUrl: null, meshSourceUrl: null, meshSourceName: null, ingestedAt: null,
      updatedAt: Date.now(),
    });
    if (prev) removeTogoMesh(prev);   // the shared original stays (see replaceMesh)
  };

  // Flipping the vertical axis changes which plane is the floor → re-derive the plan.
  const toggleAxis = async () => {
    if (!card?.meshUrl || meshBusy) return;
    const next = card.meshUpAxis === 'z' ? 'y' : 'z';
    setMeshBusy(true); setMeshOpErr(null);
    try {
      const plan = await loadMeshPlan(card.meshUrl, { upAxis: next });
      await db.togoModels.update(card.id, { meshUpAxis: next, ...(plan?.svg ? { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm } : {}), updatedAt: Date.now() });
    } catch (e) { setMeshOpErr(e?.message || 'No se pudo regenerar.'); } finally { setMeshBusy(false); }
  };

  // Refresh the stored 2D plan + footprint from the current mesh.
  const regenPlan = async () => {
    if (!card?.meshUrl || meshBusy) return;
    setMeshBusy(true); setMeshOpErr(null);
    try {
      const plan = await loadMeshPlan(card.meshUrl, { upAxis: card.meshUpAxis || 'y' });
      if (plan?.svg) await db.togoModels.update(card.id, { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm, updatedAt: Date.now() });
      else setMeshOpErr('El modelo no produjo una planta.');
    } catch (e) { setMeshOpErr(e?.message || 'No se pudo regenerar la planta.'); } finally { setMeshBusy(false); }
  };

  // ── «Optimizar mallas» — the catalogue-wide re-export.
  //
  // Every GLB ingested before the mesh pipeline existed is non-indexed float32
  // soup that each visitor downloads whole and then re-creases on load (the
  // heaviest step of the model load, paid on every launch, on every device).
  // This walks the catalogue and runs each file through the SAME export a fresh
  // import goes through, then swaps the row's mesh_url for the optimized upload
  // — the exact wiring «Reemplazar 3D» already has, no new server anything.
  //
  // Idempotent by the FILE's own stamp: an already-optimized GLB comes back
  // `skipped` for the price of its download and nothing is written, so a run
  // interrupted halfway just resumes where it stopped.
  const optimizeRunning = useRef(false);
  const [meshOpt, setMeshOpt] = useState(null);
  const optimizeMeshes = useCallback(async () => {
    if (optimizeRunning.current) return;
    // GLB only. A row still serving a raw .fbx/.obj (a multi-piece drop uploads
    // the file verbatim) has no stamp to read and no round trip we can promise
    // is lossless — it stays as it is until someone re-imports it.
    // …and only what the CURRENT pipeline hasn't already produced. The row's
    // recorded version is what makes the automatic pass free: without it, every
    // session would download the whole catalogue just to read each file's stamp
    // and learn there was nothing to do.
    const rows = (models || []).filter(
      (m) => isOptimizableMeshUrl(m.meshUrl) && (m.meshV || 0) < ALCOVER_MESH_V,
    );
    if (!rows.length) return;
    // A URL two rows share (a duplicated model) must not be reclaimed out from
    // under its sibling, so count the references before touching storage.
    const refs = new Map();
    for (const m of models || []) if (m.meshUrl) refs.set(m.meshUrl, (refs.get(m.meshUrl) || 0) + 1);
    optimizeRunning.current = true;
    const state = {
      running: true, done: 0, total: rows.length, current: rows[0]?.name || '',
      optimized: 0, skipped: 0, before: 0, after: 0, failed: [],
    };
    const publish = () => setMeshOpt({ ...state, failed: [...state.failed] });
    publish();
    let next = 0;
    // Three at a time: each unit is a download, a parse, a weld and an upload,
    // and firing the whole catalogue at once is how the tab dies mid-run.
    const worker = async () => {
      for (;;) {
        const row = rows[next++];
        if (!row) return;
        state.current = row.name || '';
        publish();
        try {
          const out = await optimizeGlbUrl(row.meshUrl, { name: row.name || 'modelo', sourceUrl: row.meshSourceUrl || null });
          state.before += out.before;
          state.after += out.after;
          if (out.skipped) {
            // Already current INSIDE the file — record it so this row never
            // costs another download.
            state.skipped++;
            await db.togoModels.update(row.id, { meshV: ALCOVER_MESH_V, updatedAt: Date.now() });
          } else {
            const prev = row.meshUrl;
            const url = await uploadTogoMesh(out.file);
            await db.togoModels.update(row.id, { meshUrl: url, meshV: ALCOVER_MESH_V, ingestedAt: Date.now(), updatedAt: Date.now() });
            state.optimized++;
            if ((refs.get(prev) || 0) <= 1) removeTogoMesh(prev);
          }
        } catch (e) {
          console.error('[togo] mesh optimize failed', row.name, e);
          state.failed.push(row.name || row.id);
        }
        state.done++;
        publish();
      }
    };
    try {
      // Lanes scale with the machine but never past 3: each unit is a download
      // + parse + export on the UI thread (the split itself runs in the worker),
      // and a 2-core tablet gets one lane so the studio stays interactive.
      const lanes = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2), rows.length);
      await Promise.all(Array.from({ length: lanes }, worker));
    } finally {
      state.running = false;
      state.current = '';
      publish();
      optimizeRunning.current = false;
    }
  }, [models]);

  // ── «Miniaturas» — the catalogue-wide THUMBNAIL BAKE.
  //
  // The configurator's piece list is a wall of three.js renders of the real
  // meshes. To draw pieces NOBODY HAS SELECTED YET, a first-time visitor pulls
  // the three bundle, then each piece's GLB, parses it, draws it and encodes a
  // PNG — all before placing anything. Every device pays it once and the first
  // visit is the one that decides whether the widget feels instant.
  //
  // So it is rendered HERE, once, by the same engine the widget would have used,
  // and stored as a plain public image (`thumb_url`). The widget then paints its
  // catalogue from <img> and only touches a mesh when a piece is actually
  // placed. Same picture either way — this only moves who pays for it.
  //
  // Idempotent by the row's own content stamp: `bakedThumbUrl` returns null for
  // a row that has none or whose picture no longer matches it, so a run
  // interrupted halfway resumes, and a re-run with nothing stale does nothing.
  // EVERY piece gets the bare CREAM BODY, and the handful that are COVERS get a
  // second, dressed picture. That split mirrors the widget exactly: a
  // collection's own page is what a visitor builds from, so its tiles stay
  // neutral (you are reading shapes there, not colours), while the index tile —
  // the shop window — wears real cloth.
  //
  // The cover and its cloth are derived HERE with the very functions the widget
  // runs (`resolveCollectionMenu` honouring the dealer's pins,
  // `buildFabricByCode` for the appearance), because what we bake has to be what
  // it will ask for: a descriptor that differs by one field stamps differently,
  // and then the cover photo reads as stale and the index renders it anyway.
  const covers = useMemo(() => {
    const fabricByCode = buildFabricByCode(materials);
    const map = new Map();   // collection → { heroId, code, fab }
    for (const e of resolveCollectionMenu(models, materials, heroes)) {
      if (e.hero?.id && e.fabric?.code) {
        map.set(e.collection, { heroId: e.hero.id, code: e.fabric.code, fab: fabricByCode[e.fabric.code] || null });
      }
    }
    return map;
  }, [models, materials, heroes]);

  /** What this row still owes: `[{ slot, opts }]`, empty when its pictures are
   *  current. ACTIVE rows only — an inactive model is not in the public palette,
   *  so baking it spends a render on something nobody will be shown. */
  const bakePlan = useCallback((row) => {
    if (!row?.id || row.active === false) return [];
    const state = bakedStateOf(row);
    const out = [];
    if (!bakedThumbUrl(state, TILE_THUMB)) out.push({ slot: 'thumb', opts: TILE_THUMB });
    // The dressed slot is the COVER's alone. A piece that stops being the cover
    // keeps its old dressed file, harmlessly: nothing ever asks for it again,
    // and if it becomes a cover later the stamp decides whether it still fits.
    const cover = covers.get(canonicalCollection(row.collection));
    if (cover && cover.heroId === row.id) {
      const dressed = { ...TILE_THUMB, code: cover.code, fab: cover.fab };
      if (!bakedThumbUrl(state, dressed)) out.push({ slot: 'hero', opts: dressed });
    }
    return out;
  }, [covers]);

  const bakeRunning = useRef(false);
  const [thumbBake, setThumbBake] = useState(null);
  const bakeThumbs = useCallback(async () => {
    if (bakeRunning.current) return;
    // UNITS, not rows: a piece can owe one picture or both (its cloth changed
    // but its mesh didn't), and counting rows would report a run that is half
    // the work it looks like.
    const units = [];
    for (const row of (models || [])) for (const u of bakePlan(row)) units.push({ row, ...u });
    if (!units.length) return;
    bakeRunning.current = true;
    const state = { running: true, done: 0, total: units.length, current: units[0]?.row?.name || '', baked: 0, failed: [] };
    const publish = () => setThumbBake({ ...state, failed: [...state.failed] });
    publish();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const unit = units[next++];
        if (!unit) return;
        const { row, slot, opts } = unit;
        state.current = row.name || '';
        publish();
        try {
          // The model as the CONFIGURATOR sees it, carrying no baked fields —
          // so the stamp matches the one the widget will rebuild from the
          // payload, and the renderer can never hand back the very picture we
          // are here to replace.
          const shape = thumbModelOf(row);
          const stamp = togoThumbStoreKey(shape, opts);
          const url = await renderTogoThumb(shape, opts);
          if (!url) throw new Error('sin render');
          // The engine hands back a URL (blob: or data:) and keeps the bytes to
          // itself; reading them back locally is cheaper than teaching it a
          // second output mode for one caller.
          const blob = await (await fetch(url)).blob();
          const prev = slot === 'hero' ? row.heroThumbUrl : row.thumbUrl;
          const nextUrl = await uploadTogoThumb(`${row.id}-${slot}`, stamp, blob);
          await db.togoModels.update(row.id, slot === 'hero'
            ? { heroThumbUrl: nextUrl, heroThumbStamp: stamp, updatedAt: Date.now() }
            : { thumbUrl: nextUrl, thumbStamp: stamp, updatedAt: Date.now() });
          state.baked++;
          // Named per (model, slot, stamp), so no two rows and no two slots can
          // share one file — the superseded object is this one's alone to drop.
          if (prev && prev !== nextUrl) removeTogoThumb(prev);
        } catch (e) {
          console.error('[togo] thumbnail bake failed', row.name, slot, e);
          const label = row.name || row.id;
          if (!state.failed.includes(label)) state.failed.push(label);
        }
        state.done++;
        publish();
      }
    };
    try {
      // Two lanes: the renders themselves are serialized by the engine's own
      // queue (one offscreen GPU context), so lanes only overlap the parts that
      // wait on the network — the mesh download of one piece against the upload
      // of the last. More would just queue deeper for nothing.
      const lanes = Math.min(2, units.length);
      await Promise.all(Array.from({ length: lanes }, worker));
    } finally {
      state.running = false;
      state.current = '';
      publish();
      bakeRunning.current = false;
    }
  }, [models, bakePlan]);

  const deleteModel = () => {
    if (!card) return;
    if (!window.confirm(`¿Eliminar el modelo "${card.name}"? Desaparecerá del configurador público.`)) return;
    dirtyRef.current = false;
    setDirty(false);
    // Hand the pick to a SURVIVOR, chosen here from the list we can still see.
    // Clearing it to null instead would leave the "nothing picked" effect to
    // choose — and it would choose off a `cards` that still contains the row we
    // just deleted, because the refetch lands a beat later.
    const next = cards.find((c) => c.id !== card.id)?.id || null;
    db.togoModels.delete(card.id);
    onSelect?.(next);
  };

  // How many models the re-export would even look at — the same predicate the
  // run itself filters on, so the automatic pass can't be triggered by work that
  // isn't there.
  const optimizableCount = useMemo(
    () => cards.filter((c) => isOptimizableMeshUrl(c.meshUrl) && (c.meshV || 0) < ALCOVER_MESH_V).length,
    [cards],
  );

  // ── Both of these were buttons until the dealer pointed out they shouldn't be.
  // They are MAINTENANCE, not decisions: nobody should have to know that a 3D
  // file predates the current pipeline, or that a model was never tagged. So
  // they run themselves, once per session, and only when there is work.
  // How many pictures the catalogue currently owes — the SAME predicate the run
  // filters on, so the automatic pass can never be triggered by work that isn't
  // there. It recomputes off `models`, so editing a piece (which restamps it)
  // puts it straight back into this count.
  const bakeableCount = useMemo(
    () => (models || []).reduce((n, m) => n + bakePlan(m).length, 0),
    [models, bakePlan],
  );

  const autoOptimized = useRef(false);
  useEffect(() => {
    if (autoOptimized.current || !optimizableCount) return;
    // On the idle after first paint, never inside the mount: the batch's first
    // downloads+parses would otherwise compete with the studio's own first
    // render — the dealer opens the page INTO the jank. Latched inside `start`
    // so a cancelled idle (deps changed, unmount) doesn't burn the one shot.
    const idle = window.requestIdleCallback;
    const start = () => { autoOptimized.current = true; optimizeMeshes(); };
    const handle = idle ? idle(start, { timeout: 5000 }) : window.setTimeout(start, 1200);
    return () => (idle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, [optimizableCount, optimizeMeshes]);

  // ── THE MECHANISM THAT KEEPS THE CATALOGUE'S PICTURES CURRENT.
  //
  // Not a one-shot: this effect is armed by `bakeableCount`, which is derived
  // from `models` through the same stamp the widget checks. So the loop closes
  // by itself — rename a piece, re-dimension it, replace its mesh, and the row
  // stops matching its own picture, reappears in the count, and is re-baked in
  // the idle after the write lands. Nothing to remember, no button to press,
  // and the public never shows a stale photo in the meantime: it falls back to
  // rendering that piece live until the new file exists.
  //
  // WAITS FOR THE RE-EXPORT. «Optimizar mallas» swaps `mesh_url`, which is part
  // of the stamp — baking first would render every optimized piece twice, and
  // the second render is the only one that would survive.
  // One attempt per (model, exact picture) per session. A model that CANNOT
  // render — a corrupt mesh — would otherwise sit in the count forever and
  // re-arm this effect on every publish of the pass's own progress. Keyed on
  // the store key rather than the id, so the give-up is scoped to the version
  // that failed: edit the piece and it earns a fresh attempt, which is what
  // keeps this a self-healing loop instead of a one-way blocklist.
  const bakeTried = useRef(new Set());
  const bakeKeyOf = (m) => `${m.id}:${bakePlan(m).map((u) => togoThumbStoreKey(thumbModelOf(m), u.opts)).join('|')}`;
  useEffect(() => {
    if (!bakeableCount || meshOpt?.running || optimizableCount || thumbBake?.running) return;
    const pending = (models || []).filter((m) => bakePlan(m).length && !bakeTried.current.has(bakeKeyOf(m)));
    if (!pending.length) return;
    const idle = window.requestIdleCallback;
    const start = () => {
      for (const m of pending) bakeTried.current.add(bakeKeyOf(m));
      bakeThumbs();
    };
    const handle = idle ? idle(start, { timeout: 5000 }) : window.setTimeout(start, 1200);
    return () => (idle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, [bakeableCount, optimizableCount, meshOpt?.running, thumbBake?.running, models, bakePlan, bakeThumbs]);

  // Tagging WAITS for the re-export: a pre-split mesh is one node per material,
  // so detecting against it would key the parts off the old grouping — and those
  // keys are what the dealer's own corrections hang on. Once per model per
  // session, because a model that legitimately yields no groups must not sit
  // there re-detecting forever.
  const autoDetected = useRef(new Set());
  useEffect(() => {
    if (!card?.id || !card.mesh || detecting || meshOpt?.running) return;
    if ((card.meshV || 0) < ALCOVER_MESH_V && isOptimizableMeshUrl(card.meshUrl)) return;
    if (autoDetected.current.has(card.id)) return;
    if (Object.keys(draftRef.current?.mats || {}).length) return;
    // WAIT FOR THE IDLE. Tagging loads this model's mesh AND every loose
    // accessory in its colección to fingerprint against — so firing it inside the
    // click that selected the model made opening a piece feel slow, which is the
    // opposite of what automating it was for. The model paints first; the tagging
    // runs in the gap after. Cancelled if the dealer moves on, so clicking
    // through the list costs nothing.
    const id = card.id;
    const start = () => { autoDetected.current.add(id); detect(); };
    const idle = window.requestIdleCallback;
    const handle = idle ? idle(start, { timeout: 4000 }) : window.setTimeout(start, 600);
    return () => (idle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
    // `detect` is re-created every render and deliberately not a dep: the guards
    // above are what decide, and listing it would re-fire the effect constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, card?.mesh, card?.meshV, card?.meshUrl, detecting, meshOpt?.running]);

  const groupRole = group ? partRoleFor(draft, group.key, 0, group.key) : 'base';

  // What the part picker OPENS on. Only a billed role holds a root (the same
  // read the Componente card does), and it seeds the search so the family is
  // already on screen; the chips beside it are the collections a replacement
  // comes from — this piece's colección, plus the model's own base family when
  // its name starts on a different word (the LR family names carry it:
  // "PRADO S/2 BACK CUSHIONS").
  const partRoot = BILLED_SLOTS.includes(groupRole) ? (draft?.roots?.[groupRole] || '') : '';
  const partFamily = partRoot ? families.find((f) => f.root === partRoot) || null : null;
  const baseWord = (card?.familyName || '').trim().split(/\s+/)[0] || '';
  const skuPresets = [{ label: collection, q: collection }];
  if (baseWord && baseWord.toLowerCase() !== collection.toLowerCase()) {
    skuPresets.push({ label: baseWord, q: baseWord });
  }

  // ── «Sugerir con Claude». The catalog is indexed ONCE per page (27k rows into
  // one row per root) and shared by both suggestion controls — the model's SKU
  // base and every part's slot. `products` is a LAZY dependency, so this stays
  // null until something asks for the catalog.
  const candidateIndex = useMemo(
    () => (products ? indexCandidates(products) : null),
    [products],
  );
  // What the piece IS, for the narrower and for the prompt. Memoised because it
  // is a prop on both inspectors: a fresh object per render would re-run the
  // suggestion effect on every keystroke elsewhere in the studio.
  const modelCtx = useMemo(() => (card ? {
    name: card.name || '',
    widthCm: card.widthCm ?? null,
    depthCm: card.depthCm ?? null,
    collection: card.collection || '',
    category: row?.category || '',
  } : null), [card, row]);

  // Will the selected ESTRUCTURA actually reach the client? The one derivation
  // that used to be missing — a group can be `structure` with no usable palette,
  // and every surface (this inspector, the parts list, the configurador) then
  // disagreed silently about whether the dealer was done.
  const groupFinish = useMemo(
    () => (group ? resolveStructureFinish(draft, group.key, collectionStructure) : null),
    [group, draft, collectionStructure],
  );
  // The same question for EVERY group, so the parts list can flag the ones that
  // will show the client nothing. The colección COUNTS here: its palette is
  // injected at read time, so a group carrying only that one is finished — the
  // list must not keep calling it unterminated work.
  const finishStateByKey = useMemo(() => {
    const out = {};
    for (const g of groups) out[g.key] = resolveStructureFinish(draft, g.key, collectionStructure);
    return out;
  }, [groups, draft, collectionStructure]);

  // ── FIDELIDAD. The retired pane answered its six checks off a build of its
  // OWN; there is one stage now, so the report is what THIS stage observed —
  // nothing restated off the row:
  //   • meshLoaded/meshCount — the swap effect above either parsed the GLB and
  //     handed React one key per mesh node, or it failed (`status`, `meshErr`).
  //   • factoryMeshes — `factoryKeys`, read off the ORIGINAL materials before
  //     the studio replaced them with its flat part tints.
  //   • finishMaterials — the groups an estructura palette will actually dress
  //     (`resolveStructureFinish`, the exact rule `resolveTogoModels` injects),
  //     asked of the LIVE DRAFT, so the row reacts as the dealer works.
  //   • the two fabric halves are FALSE by construction: this stage renders part
  //     tints, never cloth, so it has observed nothing about a tela — and the
  //     panel passes no fabric code, which makes that check read its honest
  //     "sin tela — cuerpo base" state instead of inventing a verdict.
  const buildReport = useMemo(() => {
    if (status !== 'ready' && status !== 'failed') return null;
    const loaded = status === 'ready';
    return {
      meshLoaded: loaded,
      meshCount: loaded ? partKeys.length : 0,
      factoryMeshes: loaded ? factoryKeys.length : 0,
      finishMaterials: loaded ? groups.filter((g) => finishStateByKey[g.key]?.ready).length : 0,
      fabricWithScan: false,
      fabricPixels: false,
    };
  }, [status, partKeys, factoryKeys, groups, finishStateByKey]);

  // The GLB's pipeline stamp (off the bytes, HTTP-cached, memoized per URL) —
  // `undefined` while it's being read, so the check says "leyendo" rather than
  // "sin sello".
  const [meshV, setMeshV] = useState(undefined);
  useEffect(() => {
    let alive = true;
    setMeshV(undefined);
    if (!mesh?.url) { setMeshV(null); return undefined; }
    meshVersionFor(String(mesh.url)).then((v) => { if (alive) setMeshV(v); });
    return () => { alive = false; };
  }, [mesh?.url]);

  return (
    <div className="theme-studio text-ink-800 lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      {/* The dashboard fills the screen, and it MEASURES NOTHING to do it. This
          used to be `calc(100dvh - 11.5rem)`, a hand-summed budget of the page
          paddings + the workspace app-bar; every chrome change silently
          invalidated it, and the arithmetic could only be wrong in two
          directions — short (a dead strip under the grid, which is what the
          owner saw) or long (the inspector's save bar pushed past the bottom of
          an installed PWA, where nothing can reach it).
          Now the height is HANDED DOWN: Layout gives the Togo route a real
          flex column (see MainContent), the workspace makes its app-bar
          `shrink-0`, and the workbench simply takes what's left. Grow the
          masthead and this still fits. */}
      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-canvas lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_20rem]">

        {/* ── LEFT: the model table. Handed in whole by the section — it IS the
            rail (one click on a row is what puts the piece on the stage), and
            it scrolls inside its own column. */}
        {table}

        {/* ── CENTER: the stage. */}
        <section className="relative flex min-h-0 flex-col border-y border-ink-200 lg:border-y-0">
          <StageToolbar
            card={card}
            busy={meshBusy}
            detecting={detecting}
            meshIntake={meshIntake}
            onToggleAxis={toggleAxis}
            onRemoveMesh={removeMesh}
            onEmbed={() => setEmbedOpen(true)}
            meshOpt={meshOpt}
          />
          {/* The catalogue-wide re-export's progress, under the toolbar that
              starts it (it was the rail's footer; the rail is the table now,
              and a catalogue-wide tool is not a table row). */}
          {meshOpt && (
            <div role="status" className="shrink-0 space-y-1 border-b border-ink-200 bg-surface px-3 py-1.5 text-[10px] leading-tight text-ink-400">
              {meshOpt.running ? (
                <>
                  <p className="tabular-nums">Optimizando {Math.min(meshOpt.done + 1, meshOpt.total)}/{meshOpt.total}{meshOpt.current ? ` · ${meshOpt.current}` : ''}</p>
                  <div className="h-1 overflow-hidden rounded-full bg-ink-100">
                    <div className="h-full bg-brand-500 transition-all" style={{ width: `${(meshOpt.done / Math.max(1, meshOpt.total)) * 100}%` }} />
                  </div>
                </>
              ) : (
                <p className="tabular-nums">
                  {meshOpt.optimized} optimizada{meshOpt.optimized === 1 ? '' : 's'}
                  {meshOpt.skipped > 0 && ` · ${meshOpt.skipped} ya lo estaba${meshOpt.skipped === 1 ? '' : 'n'}`}
                  {meshOpt.before > 0 && ` · ${asMb(meshOpt.before)} → ${asMb(meshOpt.after)}`}
                </p>
              )}
              {meshOpt.failed.length > 0 && (
                <p className="text-red-400">No se pudieron optimizar: {meshOpt.failed.join(', ')}.</p>
              )}
            </div>
          )}
          {/* The thumbnail bake's own line — same idiom, its own row: they are
              different work (one rewrites the 3D files, the other photographs
              them) and they can run in the same session. */}
          {thumbBake && (
            <div role="status" className="shrink-0 space-y-1 border-b border-ink-200 bg-surface px-3 py-1.5 text-[10px] leading-tight text-ink-400">
              {thumbBake.running ? (
                <>
                  <p className="tabular-nums">Fotografiando {Math.min(thumbBake.done + 1, thumbBake.total)}/{thumbBake.total}{thumbBake.current ? ` · ${thumbBake.current}` : ''}</p>
                  <div className="h-1 overflow-hidden rounded-full bg-ink-100">
                    <div className="h-full bg-brand-500 transition-all" style={{ width: `${(thumbBake.done / Math.max(1, thumbBake.total)) * 100}%` }} />
                  </div>
                </>
              ) : (
                <p className="tabular-nums">
                  {thumbBake.baked} miniatura{thumbBake.baked === 1 ? '' : 's'} lista{thumbBake.baked === 1 ? '' : 's'} — el configurador ya no arma el 3D para enseñar el catálogo
                </p>
              )}
              {thumbBake.failed.length > 0 && (
                <p className="text-red-400">Sin miniatura: {thumbBake.failed.join(', ')}.</p>
              )}
            </div>
          )}
          {(detectErr || meshOpErr) && (
            <div role="alert" className="flex items-start gap-1.5 border-b border-ink-200 bg-ink-100 px-3 py-1.5 text-[10px] text-red-400">
              <AlertCircle size={11} className="mt-0.5 shrink-0" /> {detectErr || meshOpErr}
            </div>
          )}

          <div className="relative h-[55dvh] min-h-0 flex-1 lg:h-auto">
            {hasModels && <div ref={hostRef} className="absolute inset-0" />}
            {/* The selected group's silhouette — warm gold over a dark ink
                casing, the configurator's own selection cue (TogoStage). Path
                data written IMPERATIVELY by strokeOutline in the render frame;
                no viewBox, so SVG user units ARE CSS px, 1:1. */}
            {hasModels && (
              <svg
                ref={outlineSvgRef}
                className="pointer-events-none absolute inset-0 z-[6] h-full w-full"
                style={{ overflow: 'visible', display: 'none' }}
                fill="none"
                aria-hidden
              >
                <path ref={outlineCasingRef} stroke="rgb(35 32 26 / 0.8)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
                <path ref={outlineGoldRef} stroke="#f5c000" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            )}
            {/* Armed join mode: the stage's clicks have changed meaning, so it
                says so ON the stage — a click that silently regrouped instead of
                selecting reads as a bug.
                STATUS ONLY. It used to carry its own «Listo» next to the
                inspector's «terminar», two buttons for one mode with two
                different words on them; the mode has exactly one button now (the
                inspector's) and this says where the other exit is. */}
            {joinMode && group && (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-[7] flex justify-center px-3">
                <div role="status" className="flex items-center gap-2 rounded-full border border-brand-400/60 bg-canvas/95 px-3 py-1.5 shadow-lg">
                  <Combine size={13} className="shrink-0 text-brand-600" aria-hidden />
                  <span className="text-[11px] text-ink-700">
                    Clic en una malla para unirla a <b className="text-ink-900">{partLabelOf(draft, group.key, fallbackLabelFor(group.key))}</b>, o en una suya para separarla
                  </span>
                  <span className="shrink-0 rounded border border-ink-300 px-1 text-[9px] text-ink-400">Esc</span>
                </div>
              </div>
            )}
            {/* An EMPTY BRAND says so honestly. The example pieces are Ligne
                Roset's own Togo modules, so they are offered only where the
                page hands the callback over (its own brand) — seeding another
                manufacturer's catalog with someone else's sofa is inventing
                data, not helping. */}
            {!hasModels && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <EmptyState
                  icon={Sofa}
                  title="Aún no hay modelos"
                  description={onImportSeeds
                    ? 'Sube el modelo 3D de cada pieza, o importa las piezas de ejemplo para empezar.'
                    : 'Suelta aquí la biblioteca 3D de esta marca para empezar.'}
                  action={onImportSeeds
                    ? <button type="button" onClick={onImportSeeds} className="btn-primary text-sm"><Sparkles size={15} /> Importar piezas de ejemplo</button>
                    : (onAddModel ? <button type="button" onClick={onAddModel} className="btn-primary text-sm"><Plus size={15} /> Agregar modelo</button> : null)}
                />
              </div>
            )}
            {hasModels && !meshKey && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-xs space-y-2">
                  <Box size={22} className="mx-auto text-ink-300" aria-hidden />
                  <p className="text-xs text-ink-500">Sube un 3D para editar sus partes.</p>
                  {/* Opens the ONE intake the toolbar owns — a second
                      `rootProps`/`inputProps` pair off the same hook would
                      double-fire every drop. */}
                  <button type="button" onClick={meshIntake.open} className="btn-secondary mx-auto text-[11px]">
                    {meshBusy ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />} Subir 3D
                  </button>
                </div>
              </div>
            )}
            {hasModels && meshKey && status !== 'ready' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
                {status === 'failed' ? (
                  <div className="max-w-xs space-y-1">
                    <AlertCircle size={18} className="mx-auto text-ink-300" aria-hidden />
                    <p className="text-xs text-ink-500">{meshErr || 'No se pudo mostrar el modelo.'}</p>
                    <p className="text-[11px] text-ink-400">Puedes seguir editando las partes desde la lista.</p>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-2 text-xs text-ink-400">
                    <Loader2 size={14} className="animate-spin" /> Cargando el modelo…
                  </span>
                )}
              </div>
            )}
            {hasModels && meshKey && status === 'ready' && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
                <span className="rounded-full bg-ink-100/80 px-2.5 py-1 text-[10px] font-medium text-ink-700">
                  Toca una parte para seleccionarla · arrastra para girar
                </span>
              </div>
            )}
          </div>
        </section>

        {/* ── RIGHT: the inspector. */}
        <aside className="flex min-h-0 flex-col lg:border-l lg:border-ink-200">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {/* FIDELIDAD first, and OUTSIDE the model/part switch: the checks
                answer "is this piece safe to publish", which is as true with a
                part group selected as without. This is the whole of the retired
                fidelity pane — its six answers over the stage's own build, with
                no second canvas. */}
            <ModelFidelityPanel
              row={fidelityRow}
              resolved={fidelityResolved}
              report={buildReport}
              building={status === 'loading'}
              meshV={meshV}
            />
            {/* PORTADA — which piece, in which cloth, stands for this colección
                on the configurator's first screen. Here because the piece IS
                the selection: "esta pieza es la portada" is one click on the
                model you are already looking at, instead of a separate screen
                that would ask you to find it again. */}
            {card && (
              <CoverPicker
                collection={card.collection}
                modelId={card.id}
                modelName={card.name}
                pieces={models}
                materials={materials}
                heroes={heroes}
                onSave={saveHero}
              />
            )}
            {!card ? null : group ? (
              <PartInspector
                key={group.key}
                group={group}
                groups={groups}
                role={groupRole}
                draft={draft}
                families={families}
                slotErr={slotErr}
                collection={collection}
                inheritedFinish={inheritedFinishes[group.key] || null}
                finishState={groupFinish}
                factory={factoryGroups.has(group.key)}
                candidateIndex={candidateIndex}
                modelCtx={modelCtx}
                onBack={() => setSelected(null)}
                onLabel={(text) => setLabel(group.key, text)}
                onSlot={(role) => setSlot(group.members, role, group.key)}
                onPickSku={() => { onNeedCatalog?.(); setPicker('part'); }}
                onBindSku={(root) => bindSku(group.members, groupRole, root)}
                onNeedCatalog={onNeedCatalog}
                onCount={setCount}
                onMerge={(keys) => mergeInto(group.key, keys)}
                onSeparate={separate}
                onFinish={(spec) => setGroupFinish(group.key, spec, groupRole)}
                onHoverGroup={setHovered}
                joinMode={joinMode}
                onToggleJoinMode={() => setJoinMode((v) => !v)}
              />
            ) : (
              <ModelInspector
                key={card.id}
                card={card}
                row={row}
                collections={collections}
                cards={cards}
                families={families}
                products={products}
                candidateIndex={candidateIndex}
                modelCtx={modelCtx}
                fabricLinks={fabricLinks}
                fabricLinkModule={modules?.catalog?.fabricLink || null}
                brandName={brandName}
                profileId={profileId}
                groups={groups}
                draft={draft}
                finishStateByKey={finishStateByKey}
                factoryGroups={factoryGroups}
                status={status}
                busy={meshBusy}
                hasMesh={!!meshKey}
                onNeedCatalog={onNeedCatalog}
                onRegenPlan={regenPlan}
                onDelete={deleteModel}
                onSelectGroup={setSelected}
                onHoverGroup={setHovered}
              />
            )}
          </div>

          {/* The parts draft's STATUS strip. It used to hold «Guardar partes»
              (plus a «Descartar» beside it) — a button the dealer had to find for
              the one part of this screen that did not save itself, while every
              other control here commits as you type. It saves itself now
              (AUTOSAVE_MS above), so all that is left to say is whether the write
              is out, what the colección is about to take with it, and what broke.
              Nothing to press: a button that only ever means "yes, do the thing
              you were going to do anyway" is the thing that made this confusing. */}
          {(dirty || saving || saveErr || fanoutErr > 0) && (
            <div role="status" className="border-t border-ink-200 bg-surface px-3 py-2 space-y-1.5">
              {saveErr && (
                <p className="flex items-start gap-1 text-[10px] text-red-400">
                  <AlertCircle size={11} className="mt-0.5 shrink-0" /> {saveErr}
                </p>
              )}
              {/* The model's own save landed; only the colección lagged behind. */}
              {fanoutErr > 0 && (
                <p className="text-[10px] leading-tight text-ink-400">
                  No se pudieron actualizar {fanoutErr} modelo{fanoutErr === 1 ? '' : 's'} de la colección.
                </p>
              )}
              {dirty && fanoutCount > 0 && (
                <p className="text-[10px] leading-tight text-ink-400">
                  Los acabados se aplicarán también a {fanoutCount} modelo{fanoutCount === 1 ? '' : 's'} de {collection}.
                </p>
              )}
              {(dirty || saving) && (
                <p className="flex items-center gap-1.5 text-[10px] text-ink-400">
                  <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden /> Guardando…
                </p>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* The catalog picker for the selected PART group — picking allocates one
          of the model's three billed slots (planSkuSlot). The MODEL's own base
          SKU has its own picker, inside the model inspector. */}
      <ProductBindModal
        open={picker === 'part'}
        onClose={() => setPicker(null)}
        profileId={profileId}
        title="SKU de esta parte"
        clearLabel="Sin SKU propio (se cotiza con la base)"
        currentRoot={partRoot}
        currentName={partFamily?.name || ''}
        presets={skuPresets}
        onPick={(m) => group && bindSku(group.members, groupRole, m.root)}
        onClear={() => group && setSlot(group.members, 'base')}
      />

      <EmbedModal open={embedOpen} onClose={() => setEmbedOpen(false)} brandName={brandName} />
    </div>
  );
}

/** Bytes as MB, for the mesh optimizer's before/after line. */
const asMb = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;

// ─────────────────────────────────────────────────────────────────────────────
// STAGE TOOLBAR

function StageToolbar({
  card, busy, detecting, meshIntake, onToggleAxis, onRemoveMesh, onEmbed, meshOpt = null,
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-200 bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink-900">{card?.name || 'Sin modelo'}</div>
        {card && <div className="truncate text-[10px] text-ink-400">{card.collection}</div>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {/* Detecting and re-exporting are MAINTENANCE, not decisions — the dealer
            should never have to know that a mesh needs re-exporting or that a
            model was never tagged, so both run themselves (see the effects in
            ModelStudio). What is left here is the passive read-out: work in
            flight, never a button. */}
        {(detecting || meshOpt?.running) && (
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-400" aria-live="polite">
            <Loader2 size={11} className="animate-spin" aria-hidden />
            {detecting ? 'Detectando partes…' : `Preparando mallas ${meshOpt.done}/${meshOpt.total}`}
          </span>
        )}
        {card?.meshUrl && (
          <button type="button" onClick={onToggleAxis} disabled={busy} className="btn-ghost text-[11px] disabled:opacity-50" title="Si el modelo aparece acostado, cambia el eje vertical (regenera la planta)">
            Eje {card.meshUpAxis === 'z' ? 'Z' : 'Y'}
          </button>
        )}
        {card && (
          <label {...meshIntake.rootProps} className={`btn-ghost text-[11px] cursor-pointer ${meshIntake.dragging ? 'ring-2 ring-brand-500' : ''}`} title="Reemplazar el archivo 3D de este modelo">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />} {card.meshUrl ? 'Reemplazar 3D' : 'Subir 3D'}
            <input {...meshIntake.inputProps} />
          </label>
        )}
        {card?.meshUrl && (
          <button type="button" onClick={onRemoveMesh} className="p-1 text-ink-400 hover:text-red-500" title="Quitar el modelo 3D (vuelve a la geometría generada)">
            <Trash2 size={13} />
          </button>
        )}
        <button type="button" onClick={onEmbed} className="btn-ghost text-[11px]" title="El código para embeber el configurador en tu web">
          <Code2 size={12} /> Insertar
        </button>
      </div>
    </div>
  );
}

/** The website embed snippet + a link to the public widget. */
function EmbedModal({ open, onClose, brandName = null }) {
  const [copied, setCopied] = useState(false);
  const snippet = togoEmbedSnippet(undefined, { brandName });
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <Modal open={open} onClose={onClose} size="md" title="Embeber en tu web">
      <div className="space-y-2.5">
        <p className="text-[11px] text-ink-500">
          Pega este código en tu sitio: muestra un card que abre el configurador en una nueva pestaña.
          Los clientes arman su Togo y te llega como cotización borrador para dar seguimiento.
        </p>
        <div className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-ink-900 p-3 font-mono text-[11px] text-ink-100">{snippet}</div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={copy} className="btn-ghost text-xs">
            {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar código'}
          </button>
          <a href={togoShareUrl()} target="_blank" rel="noreferrer" className="btn-ghost text-xs"><ExternalLink size={14} /> Abrir vista pública</a>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECTOR — the MODEL

function ModelInspector({
  card, row, collections, cards, families, products, fabricLinks, fabricLinkModule = null,
  brandName = null, profileId,
  candidateIndex = null, modelCtx = null,
  groups, draft, finishStateByKey = {}, factoryGroups = null, status, busy, hasMesh = true,
  onNeedCatalog, onRegenPlan, onDelete, onSelectGroup, onHoverGroup,
}) {
  const [pickOpen, setPickOpen] = useState(false);
  // Optimistic binding: a global invalidate refetches the (huge) catalog, so the
  // persisted row can lag ~seconds. Show the dealer's choice INSTANTLY and clear
  // the optimistic value only once the row catches up.
  const [pending, setPending] = useState(null);
  const boundRoot = pending != null ? pending : (card.productRoot || '');
  useEffect(() => {
    if (pending != null && (card.productRoot || '') === pending) setPending(null);
  }, [card.productRoot, pending]);
  const bind = async (val) => {
    setPending(val);
    setPickOpen(false);
    try { await db.togoModels.update(card.id, { productRoot: val || null, updatedAt: Date.now() }); }
    catch { setPending(null); }
  };
  const boundFamily = families.find((f) => f.root === boundRoot) || null;

  // Whether the model has componentes at all — the only case where the base SKU
  // is one of TWO prices (monocolor rides it alone, mixed materials add each
  // componente on top). A piece that is all base has one price and the note
  // below would be noise. Read off the same roles the list below renders.
  const hasComponents = useMemo(
    () => groups.some((g) => BILLED_SLOTS.includes(partRoleFor(draft, g.key, 0, g.key))),
    [groups, draft],
  );

  // Inline retag — commit on blur/Enter. Normalises 'Togo'/empty back to null so
  // legacy default semantics stay uniform (the resolver defaults null → 'Togo').
  const commitCollection = (v) => {
    const norm = v.trim() && v.trim() !== 'Togo' ? v.trim() : null;
    if (norm === (card.collection === 'Togo' ? null : card.collection)) return;
    db.togoModels.update(card.id, { collection: norm, updatedAt: Date.now() });
  };
  // Categoría — the grouping ABOVE colección, detected from the LR library
  // folder tree on a folder import. It lives on the ROW (the cards VM doesn't
  // project it), so it reads and writes there.
  const commitCategory = (v) => {
    const norm = v.trim() || null;
    if (norm === (row?.category || null)) return;
    db.togoModels.update(card.id, { category: norm, updatedAt: Date.now() });
  };
  // Grupo — the level ABOVE categoría (Upholstery / Occasional / …), the LR
  // library's own top division. Same raw-ROW story as categoría.
  const commitGroup = (v) => {
    const norm = v.trim() || null;
    if (norm === (row?.productGroup || null)) return;
    db.togoModels.update(card.id, { productGroup: norm, updatedAt: Date.now() });
  };
  const commitDim = (field, v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0 || n === card[field]) return;
    db.togoModels.update(card.id, { [field]: n, updatedAt: Date.now() });
  };

  return (
    <div className="divide-y divide-ink-200">
      {/* ── The model itself. */}
      <section className="space-y-2.5 px-3 py-3">
        <div>
          <label className="label" htmlFor={`togo-name-${card.id}`}>Nombre</label>
          <input
            id={`togo-name-${card.id}`}
            className="input h-8 py-0 text-[13px] font-medium"
            defaultValue={card.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== card.name && db.togoModels.update(card.id, { name: e.target.value.trim(), updatedAt: Date.now() })}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>

        <div>
          <label className="label" htmlFor={`togo-col-input-${card.id}`}>Colección</label>
          <input
            id={`togo-col-input-${card.id}`}
            className="input h-8 py-0 text-[12px]"
            list={`togo-col-${card.id}`}
            defaultValue={card.collection === 'Togo' ? '' : card.collection}
            placeholder="Togo"
            onBlur={(e) => commitCollection(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          <datalist id={`togo-col-${card.id}`}>
            {collections.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>

        <div>
          <label className="label" htmlFor={`togo-group-input-${card.id}`}>Grupo</label>
          <input
            id={`togo-group-input-${card.id}`}
            className="input h-8 py-0 text-[12px]"
            defaultValue={row?.productGroup || ''}
            placeholder="Sin grupo"
            onBlur={(e) => commitGroup(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>

        <div>
          <label className="label" htmlFor={`togo-cat-input-${card.id}`}>Categoría</label>
          <input
            id={`togo-cat-input-${card.id}`}
            className="input h-8 py-0 text-[12px]"
            defaultValue={row?.category || ''}
            placeholder="Sin categoría"
            onBlur={(e) => commitCategory(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">Ancho (cm)</span>
            <input
              type="number" min="1" className="input h-8 py-0 text-[12px] tabular-nums"
              defaultValue={card.widthCm}
              onBlur={(e) => commitDim('widthCm', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </label>
          <label className="block">
            <span className="label">Fondo (cm)</span>
            <input
              type="number" min="1" className="input h-8 py-0 text-[12px] tabular-nums"
              defaultValue={card.depthCm}
              onBlur={(e) => commitDim('depthCm', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </label>
        </div>

        {/* Estado has ONE control on this screen and it is the pill on the
            model's own table row, two columns to the left (always scrolled into
            view). A second checkbox here was the same flag written a second way
            — and it stamped `updatedAt`, which the pill deliberately doesn't:
            publishing a piece is not an edit to its colección's palette. */}

        {/* El orden en la paleta del configurador se arrastra en la TABLA, no se
            teclea aquí. The ▲▼ that used to sit here moved a piece it could not
            show you next to its neighbours — the list being ordered was two
            panes away. On the table the dealer drags a row among the pieces it
            is being ordered against (Alt+↑↓ with the keyboard), against the same
            `planTogoReorder`. */}
      </section>

      {/* ── The model's SKU. ONE binding, TWO prices: the catalog entry for the
          whole piece IS the elemento completo, so a monocolor build quotes on
          it alone and a mixed one adds the componentes on top. */}
      <section className="space-y-1 px-3 py-3">
        <span className="label mb-0">SKU base</span>
        <button
          type="button"
          onClick={() => { onNeedCatalog?.(); setPickOpen(true); }}
          className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
            boundRoot ? 'border-brand-300 bg-brand-500/10 text-brand-700 hover:bg-brand-500/20' : 'border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
          }`}
          title={`Vincular el producto${brandName ? ` ${brandName}` : ''} que da el precio por grado`}
        >
          <Link2 size={12} className="shrink-0" />
          <span className="min-w-0 truncate">
            {boundRoot
              ? `SKU ${boundRoot}${boundFamily ? ` · ${boundFamily.name}` : ''}`
              : 'Sin vincular — toca para elegir del catálogo'}
          </span>
        </button>
        {boundFamily?.graded && (
          <p className="text-[10px] leading-tight text-ink-400">{boundFamily.grades.length} grados de tela.</p>
        )}
        {/* The rule this ONE SKU carries, in the owner's own words — shown only
            where there are componentes, since a piece that is all base has a
            single price and nothing to explain. */}
        {hasComponents && (
          <p className="text-[10px] leading-tight text-ink-400">
            Se cotiza así cuando todos los componentes llevan el mismo material; si se mezclan, se suma cada componente por su SKU (más caro).
          </p>
        )}
        {pending != null && <p className="text-[10px] text-ink-400">Guardando…</p>}
        {/* Unbound is exactly where the suggestion belongs: an already-bound
            model has an answer, and re-proposing one over it is how a good
            binding gets replaced by a plausible one. */}
        {!boundRoot && (
          <SkuSuggestPanel
            model={modelCtx}
            candidateIndex={candidateIndex}
            onNeedCatalog={onNeedCatalog}
            onBind={bind}
          />
        )}
        {/* The quote pane's catalog browser, binding a family root on pick —
            opened on the SKU it is replacing, with the colección one tap away. */}
        <ProductBindModal
          open={pickOpen}
          onClose={() => setPickOpen(false)}
          brandName={brandName}
          profileId={profileId}
          currentRoot={boundRoot}
          currentName={boundFamily?.name || ''}
          presets={[{ label: card.collection || 'Togo', q: card.collection || 'Togo' }]}
          onPick={(m) => bind(m.root)}
          onClear={() => bind('')}
        />
      </section>

      {/* ── The derived plan. */}
      <section className="space-y-1.5 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="label mb-0">Planta</span>
          {card.meshUrl && (
            <button type="button" onClick={onRegenPlan} disabled={busy} className="btn-ghost text-[10px] disabled:opacity-50" title="Regenerar el plano 2D y la huella desde el modelo 3D">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Regenerar
            </button>
          )}
        </div>
        <div className="grid aspect-[4/3] w-24 place-items-center overflow-hidden rounded-lg bg-canvas p-2 text-ink-600 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: sanitizeSvg(card.svg || '') }} />
        {row?.meshSourceName && (
          <p className="truncate text-[10px] text-ink-400" title={row.meshSourceName}>
            Fuente: {row.meshSourceName}
            {row.ingestedAt ? ` · ${new Date(row.ingestedAt).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          </p>
        )}
      </section>

      {/* ── The model's part groups — the index into the part editor. Every row
          that will show the client NOTHING says so here, on the row: an
          Estructura is a real choice once a palette the Model accepts exists,
          its own or the colección's (resolveStructureFinish), and the dealer is
          looking at this list, not at the part he hasn't opened yet. */}
      <section className="space-y-1.5 px-3 py-3">
        <span className="label mb-0">Partes</span>
        {groups.length === 0 ? (
          /* Three different "nothing here", and only one of them is «Detectar
             partes»: with no 3D there is nothing to detect FROM, and while the
             mesh is loading there is nothing to say yet. */
          <p className="text-[10px] leading-tight text-ink-400">
            {!hasMesh
              ? 'Este modelo no tiene 3D todavía. Sube uno con «Reemplazar 3D» y luego usa «Detectar partes».'
              : status === 'loading'
                ? 'Leyendo las mallas…'
                : 'Sin partes que etiquetar — usa «Detectar partes» sobre el modelo 3D.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {groups.map((g) => {
              const role = partRoleFor(draft, g.key, 0, g.key);
              const root = draft?.roots?.[role] || '';
              const fin = finishStateByKey[g.key] || null;
              const unfinished = !!fin?.structure && !fin.ready;
              const factory = !!factoryGroups?.has(g.key);
              return (
                <li key={g.key}>
                  <button
                    type="button"
                    onClick={() => onSelectGroup(g.key)}
                    onMouseEnter={() => onHoverGroup(g.key)}
                    onMouseLeave={() => onHoverGroup((h) => (h === g.key ? null : h))}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ink-100"
                    title={g.key}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-white/10" style={{ backgroundColor: cssClay(g.index) }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-800">{partLabelOf(draft, g.key, fallbackLabelFor(g.key))}</span>
                    {/* The piece came with its own finish and keeps it — said
                        HERE because the alternative is the dealer picking a
                        tela, seeing this part ignore it, and filing a bug. */}
                    {factory && (
                      <span className="shrink-0 rounded-full bg-ink-100 px-1.5 py-0.5 text-[9px] font-medium text-ink-500">
                        Material propio
                      </span>
                    )}
                    {unfinished && (
                      <AlertCircle
                        size={11}
                        className="shrink-0 text-amber-400"
                        aria-hidden
                      />
                    )}
                    <span className={`shrink-0 text-[10px] ${unfinished ? 'text-amber-400' : 'text-ink-400'}`}>
                      {BILLED_SLOTS.includes(role)
                        ? (root ? `Componente · SKU ${root}` : 'Componente')
                        : unfinished
                          // «sin acabados» is only true when NOTHING covers it.
                          // `invalid` means the rows typed here are all being
                          // thrown away — a different thing to go fix.
                          ? (fin.status === 'invalid' ? 'Estructura · acabados incompletos' : 'Estructura · sin acabados')
                          : SLOT_LABELS[role] || SLOT_LABELS.base}
                    </span>
                  </button>
                  {/* Some rows kept, some dropped — the kept ones hide the loss,
                      so it is spelled out rather than left to a badge. */}
                  {fin?.status === 'partial' && (
                    <p className="pl-6 text-[10px] leading-tight text-amber-400">
                      {fin.dropped} acabado{fin.dropped === 1 ? '' : 's'} sin nombre o sin color — no se guardan.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Montaje: where the piece sits on the plan. */}
      <MountSection card={card} />

      {/* ── Collection-wide tools (they act on every model of this colección). */}
      <section className="space-y-2 px-3 py-3">
        <span className="label mb-0">Colección · {card.collection}</span>
        <AutoLinkRow
          collection={card.collection}
          cards={cards.filter((c) => c.collection === card.collection)}
          products={products}
          onNeedCatalog={onNeedCatalog}
        />
        {/* The offered-fabric roster is READ FROM THE MANUFACTURER, so the
            row exists only for a brand whose catalog module declares where to
            read it. A brand that publishes no roster gets no control at all —
            never a box pointing it at another manufacturer's website. */}
        {fabricLinkModule?.supported && (
          <CollectionFabricsLink
            collection={card.collection}
            cards={cards.filter((c) => c.collection === card.collection)}
            links={fabricLinks}
            fabricLink={fabricLinkModule}
            profileId={profileId}
          />
        )}
      </section>

      <section className="px-3 py-3">
        <button type="button" onClick={onDelete} className="btn-ghost w-full text-[11px] text-ink-400 hover:text-red-500" title="Eliminar el modelo del catálogo">
          <Trash2 size={12} /> Eliminar modelo
        </button>
      </section>
    </div>
  );
}

/**
 * "Montaje" — where the piece sits. 'Piso' (default) is a normal module;
 * 'Asiento' marks a standalone accessory (cojín/rulo suelto) that renders at
 * seat height, floats over the plan (no collision/magnet) and drops centred on
 * the last module when added.
 */
function MountSection({ card }) {
  const seat = card.mount === 'seat';
  const setMount = (v) => db.togoModels.update(card.id, { mount: v === 'seat' ? 'seat' : null, updatedAt: Date.now() });
  const setHeight = (v) => {
    const n = Number(v);
    db.togoModels.update(card.id, { mountHeightCm: Number.isFinite(n) && n > 0 ? n : null, updatedAt: Date.now() });
  };
  return (
    <section className="space-y-1.5 px-3 py-3">
      <span className="label mb-0">Montaje</span>
      <div className="flex items-center gap-1.5">
        <select className="input h-7 w-28 py-0 text-[11px]" value={seat ? 'seat' : 'floor'} onChange={(e) => setMount(e.target.value)}>
          <option value="floor">Piso</option>
          <option value="seat">Asiento</option>
        </select>
        {seat && (
          <label className="flex items-center gap-1 text-[10px] text-ink-400">
            altura
            <input
              type="number" min="1" className="input h-7 w-16 py-0 text-[11px]"
              defaultValue={card.mountHeightCm ?? 40}
              onBlur={(e) => setHeight(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            cm
          </label>
        )}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECTOR — a PART group

/**
 * The selected group's editor: what it's called, WHAT IT SELLS AS (the SKU
 * selector — see SkuSelector), which mesh groups make it up, and the finishes it
 * can be ordered in.
 */
function PartInspector({
  group, groups, role, draft, families, slotErr, collection, inheritedFinish = null,
  finishState = null, factory = false, candidateIndex = null, modelCtx = null,
  onBack, onLabel, onSlot, onPickSku, onBindSku, onNeedCatalog, onCount,
  onMerge, onSeparate, onFinish, onHoverGroup,
  joinMode = false, onToggleJoinMode,
}) {
  const [joining, setJoining] = useState(false);
  const [checked, setChecked] = useState(() => new Set());
  // WHAT THIS PART IS MADE OF — every key that resolves into this group, minus
  // the group's own. Read as inventory, not as history: a member can be another
  // pCon material the dealer folded in OR a split island of THIS one's material
  // ("COL0~2", which the shape clusterer took apart without ever being asked),
  // and the list must not care which — that is the whole of separating something
  // you did not group yourself.
  const members = group.members.filter((m) => m !== group.key);
  const others = groups.filter((g) => g.key !== group.key);

  const toggle = (key) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="divide-y divide-ink-200">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={onBack} className="btn-ghost text-[11px]" title="Volver al modelo">
          <ArrowLeft size={12} /> Modelo
        </button>
        <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-white/10" style={{ backgroundColor: cssClay(group.index) }} aria-hidden />
      </div>

      <section className="space-y-2 px-3 py-3">
        <label className="block">
          <span className="label">Nombre de la parte</span>
          <input
            type="text"
            className="input h-8 py-0 text-[12px]"
            value={draft?.labels?.[group.key] ?? ''}
            placeholder={fallbackLabelFor(group.key)}
            onChange={(e) => onLabel(e.target.value)}
          />
        </label>
        <p className="text-[10px] leading-tight text-ink-400">
          {group.nodeCount} {group.nodeCount === 1 ? 'malla' : 'mallas'} en el modelo
          {members.length ? ` · ${members.length + 1} piezas unidas` : ''}
        </p>
        {/* Why this part ignores the tela — and the one thing that changes it.
            The dealer's own tag always wins; nothing here is a dead end. */}
        {factory && (
          <p className="flex items-start gap-1 text-[10px] leading-tight text-ink-400">
            <span className="mt-px shrink-0 rounded-full bg-ink-100 px-1.5 py-0.5 text-[9px] font-medium text-ink-500">
              Material propio
            </span>
            <span>
              Viene con su material de fábrica (madera, laca…) y se renderiza tal cual: no toma tela.
              Si le pones una parte o un acabado aquí, manda tu elección.
            </span>
          </p>
        )}
      </section>

      <SkuSelector
        role={role}
        draft={draft}
        families={families}
        error={slotErr}
        candidateIndex={candidateIndex}
        modelCtx={modelCtx}
        partLabel={partLabelOf(draft, group.key, fallbackLabelFor(group.key))}
        onSlot={onSlot}
        onPickSku={onPickSku}
        onBindSku={onBindSku}
        onNeedCatalog={onNeedCatalog}
        onCount={onCount}
      />

      {/* ── ACABADOS — directly under «Se cotiza como», because for an Estructura
          it IS the rest of that choice. It used to sit at the very bottom of the
          inspector, below the whole «Unir mallas» block: the dealer clicked
          Estructura, saw nothing else happen, and saved a part the client can
          never see. On a structure the section is framed as the continuation of
          the click (a brand rule down its left edge); on any other role it stays
          the quiet dealer-only control it always was. */}
      <section className={`px-3 py-3${role === 'structure' ? ' border-l-2 border-brand-500 bg-brand-500/5' : ''}`}>
        {role === 'structure' && <StructureFinishNote state={finishState} />}
        <FinishEditor
          groupKey={group.key}
          draft={draft}
          inherited={inheritedFinish}
          collection={collection}
          structure={role === 'structure'}
          onFinish={onFinish}
        />
        {/* WHO picks — the ONE thing that separates Base from Estructura, said
            where the palette is authored. Both are price-neutral, both render
            their acabado; only a structure's is offered to the client. And WHO
            it belongs to: the estructura is the colección's, so marking a pieza
            Estructura is all it takes — said before the save, not discovered
            afterwards. */}
        {role === 'structure' && (
          <>
            <p className="mt-1.5 text-[10px] leading-tight text-ink-400">El cliente elige entre estos acabados.</p>
            <p className="mt-1 text-[10px] leading-tight text-ink-400">
              Es el acabado de estructura de toda la colección {collection}: se aplica solo con marcar la pieza como Estructura, aquí y en las demás.
            </p>
          </>
        )}
        {!BILLED_SLOTS.includes(role) && role !== 'structure' && (
          <p className="mt-1.5 text-[10px] leading-tight text-ink-400">
            El cliente no elige este acabado: se materializa siempre con el que quede por defecto.
          </p>
        )}
      </section>

      {/* ── UNIR Y SEPARAR — one control for both directions.
          It has to be one control because the dealer cannot see the difference
          it used to depend on. pCon hands over MATERIAL groups and the studio
          then splits a material whose meshes are different shapes into islands;
          so "el cojín" and "el armazón" can be two materials (a merge) or two
          islands of one material (an un-split), and on screen they look
          identical. Joining wrote `merges`, which does nothing for an island's
          ROLE, so the one case he actually had — a seat cushion tagged out of the
          frame's own material — had no route at all. Both are one gesture now,
          and it runs the same in reverse: what came grouped from the file
          separates exactly like what he grouped himself. */}
      <section className="space-y-1.5 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="label mb-0">Unir y separar</span>
        </div>

        {/* THE mode, and the only button that arms or ends it. The checkbox list
            stays as the fallback below, because a mesh fully enclosed by another
            (a frame inside a cushion) can't be clicked. */}
        {(others.length > 0 || members.length > 0) && (
          <>
            <button
              type="button"
              onClick={onToggleJoinMode}
              aria-pressed={joinMode}
              className={`w-full text-[11px] ${joinMode ? 'btn-brand' : 'btn-secondary'}`}
            >
              <Combine size={12} aria-hidden /> {joinMode ? 'Terminar' : 'Unir y separar con clic'}
              <kbd className="ml-1 rounded border border-current/30 px-1 text-[9px] opacity-60">U</kbd>
            </button>
            <p className="text-[10px] leading-tight text-ink-400">
              {joinMode
                ? 'Clic en cualquier malla del modelo para unirla a esta pieza; clic en una que ya sea suya para separarla.'
                : 'Actívalo y ve tocando en el modelo: lo que toques se une a esta pieza, y lo que ya sea suyo se separa.'}
            </p>
            {others.length > 0 && (
              <button
                type="button"
                onClick={() => { setJoining((v) => !v); setChecked(new Set()); }}
                className="btn-ghost w-full text-[10px] text-ink-500"
              >
                {joining ? 'Cerrar la lista' : 'o elígelas de la lista'}
              </button>
            )}
          </>
        )}

        {joining && (
          <>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {others.map((g) => (
                <li key={g.key}>
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-ink-100"
                    onMouseEnter={() => onHoverGroup(g.key)}
                    onMouseLeave={() => onHoverGroup((h) => (h === g.key ? null : h))}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-brand-500"
                      checked={checked.has(g.key)}
                      onChange={() => toggle(g.key)}
                    />
                    <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-white/10" style={{ backgroundColor: cssClay(g.index) }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-700" title={g.key}>
                      {partLabelOf(draft, g.key, fallbackLabelFor(g.key))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => { onMerge([...checked]); setChecked(new Set()); setJoining(false); }}
              disabled={checked.size === 0}
              className="btn-secondary w-full text-[11px] disabled:opacity-50"
            >
              <Combine size={12} aria-hidden /> Unir seleccionadas ({checked.size})
            </button>
            <p className="text-[10px] leading-tight text-ink-400">
              Se unen en «{partLabelOf(draft, group.key, fallbackLabelFor(group.key))}» — una sola parte, un solo acabado, un solo SKU.
            </p>
          </>
        )}

        {/* WHAT THIS PART IS MADE OF — every key inside it, however it got there.
            The key is shown raw (it is the pCon material name, often a UUID) with
            the dealer's own label above it when there is one. */}
        {members.length > 0 && (
          <>
            <ul className="space-y-1">
              {members.map((m) => (
                <li key={m} className="flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-500" title={m}>{m}</span>
                  <button type="button" onClick={() => onSeparate([m])} className="btn-ghost shrink-0 text-[10px]" title="Separar esta malla de la parte">
                    <Ungroup size={11} aria-hidden /> Separar
                  </button>
                </li>
              ))}
            </ul>
            {members.length > 1 && (
              <button type="button" onClick={() => onSeparate(members)} className="btn-ghost w-full text-[10px] text-ink-500">
                <Ungroup size={11} aria-hidden /> Separarlas todas
              </button>
            )}
            <p className="text-[10px] leading-tight text-ink-400">
              Cada una vuelve a ser su propia pieza, con el mismo rol que tiene ahora. El acabado se queda en «{partLabelOf(draft, group.key, fallbackLabelFor(group.key))}».
            </p>
          </>
        )}
        {!joining && members.length === 0 && others.length === 0 && (
          <p className="text-[10px] leading-tight text-ink-400">
            Una sola malla: no hay nada con que unirla ni nada que separarle.
          </p>
        )}
        {!joining && members.length === 0 && others.length > 0 && group.nodeCount > 1 && (
          <p className="text-[10px] leading-tight text-ink-400">
            Sus {group.nodeCount} mallas comparten un solo material del export y la misma forma: van juntas siempre.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * THE ESTRUCTURA VERDICT — "¿lo va a ver el cliente?", answered above the editor
 * instead of being left to the dealer to infer from an empty list.
 *
 * A structure group reaches the configurador when a palette the Model accepts
 * exists — its own, or the colección's, which is injected at read time. So only
 * two states are silent failures now (resolveStructureFinish): nothing anywhere,
 * and rows that were typed but can't be saved. Each says what is wrong in one
 * line — the editor right below is where it gets fixed. The «no lo verá» wording
 * belongs to `empty` alone: with a colección palette behind it, a broken row
 * costs the dealer his own words, not the client's choice.
 */
function StructureFinishNote({ state }) {
  if (!state || state.status === 'ready' || state.status === 'off') return null;
  const text = {
    partial: `${state.dropped} acabado${state.dropped === 1 ? '' : 's'} sin nombre o sin color: no se guarda${state.dropped === 1 ? '' : 'n'} y el cliente no lo${state.dropped === 1 ? '' : 's'} verá.`,
    invalid: 'Ningún acabado está completo (falta el nombre o el color): no se guardará ninguno.',
    empty: 'Esta estructura no tiene acabados: el cliente no la verá en el configurador.',
  }[state.status];
  if (!text) return null;
  return (
    <p role="status" className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-tight text-amber-400">
      <AlertCircle size={11} className="mt-px shrink-0" aria-hidden /> {text}
    </p>
  );
}

/**
 * THE PIECE SELECTOR — how a part group is sold. TWO answers, because a piece
 * can only be one of two things IN FRONT OF THE CLIENT (owner, 2026-08: «Base»
 * is dead as a concept — todo lo que se ve es Componente o Estructura):
 *
 *   • Componente — VISTE TELA: the piece the client dresses with a fabric.
 *   • Estructura — VISTE ACABADO: metal o lacado (patas, marcos, bases). Price-
 *                  neutral — no SKU, no slot, nothing to bill — but its palette
 *                  IS offered: the client picks the acabado in the configurador.
 *                  That's the whole difference between the two: WHAT it wears.
 *
 * How a Componente BILLS is a sub-choice NESTED inside it, not a third card,
 * because «SKU propio vs se cotiza con el modelo» is a fact only the DEALER
 * ever sees — the client-facing kinds are the two dressing verbs, so the radio
 * group IS the model:
 *   – Con el SKU del modelo — un elemento incambiable sin SKU propio, incluido
 *                             en el precio del modelo (the ex-«Base»; it may
 *                             carry acabados, but they are the DEALER's — the
 *                             piece always materializes with the default).
 *   – Con SKU propio        — a real catalog SKU: the piece is charged apart,
 *                             taking one of the model's three billed slots,
 *                             plus the units it bills (the catalog sells
 *                             cushions singly OR as a "juego de 2/3").
 *
 * A model tagged before this (a materialization ZONE, exterior/interior) never
 * billed either, so it READS as Componente «con el SKU del modelo» and stays
 * exactly as stored — nothing is rewritten behind the dealer's back; an
 * explicit click on that sub-choice normalizes it.
 */
function SkuSelector({
  role, draft, families, error, candidateIndex = null, modelCtx = null, partLabel = '',
  onSlot, onPickSku, onBindSku, onNeedCatalog, onCount,
}) {
  const billed = BILLED_SLOTS.includes(role);
  const structure = role === 'structure';
  const root = billed ? (draft?.roots?.[role] || '') : '';
  const fam = root ? families.find((f) => f.root === root) || null : null;
  const meshN = billed ? partMeshCount(draft, role) : 0;
  // What to SEARCH the catalog for. A billed slot already names itself in the
  // catalog's own vocabulary (cushion / bolster / armCushion); a part that
  // hasn't taken a slot yet is read off the dealer's label the same way the
  // accessory tagger does — and if that says nothing, the label itself goes.
  const suggestRole = billed ? role : accessoryRoleFor(partLabel);
  const suggestPart = useMemo(
    () => ({ role: suggestRole || '', label: partLabel }),
    [suggestRole, partLabel],
  );
  // A leftover zone role renders as Componente (it never billed), so the click
  // that lands it on the plain role is the dealer's, never a silent mount-time
  // write.
  const legacyZone = MATERIALIZATION_ROLES.includes(role);

  return (
    <section className="space-y-1.5 px-3 py-3">
      <span className="label mb-0">Se cotiza como</span>

      {/* Clicking the already-active card is a no-op (it's a radio); coming
          from Estructura it lands on the default sub-choice, el SKU del modelo. */}
      <SkuOption
        active={!structure}
        onClick={() => { if (structure) onSlot('base'); }}
        title="Componente — viste tela"
        hint="Viste tela. Por defecto se cotiza con el SKU del modelo; con SKU propio se cobra aparte (elige el producto del catálogo)."
      >
        <SkuSubOption
          active={!billed && !structure}
          onClick={() => { if (billed || structure || legacyZone) onSlot('base'); }}
          title="Con el SKU del modelo"
          note="incluido"
        />

        <SkuSubOption
          active={billed}
          onClick={onPickSku}
          icon={Link2}
          title="Con SKU propio"
          note="se cobra aparte"
          action={billed && root ? 'cambiar producto' : 'elegir producto'}
        />

        {/* The same «Sugerir con Claude» the model's SKU base offers, narrowed
            to THIS componente: a cojín / rulo binds its OWN root («EXCLUSIF
            OTTOMAN», «EXCLUSIF BACK CUSHION»), never the sofa's. Offered only
            while the part has no SKU of its own — replacing a good binding with
            a plausible one is not an improvement. */}
        {!structure && !root && onBindSku && modelCtx && (
          <SkuSuggestPanel
            model={modelCtx}
            part={suggestPart}
            candidateIndex={candidateIndex}
            onNeedCatalog={onNeedCatalog}
            onBind={onBindSku}
          />
        )}

        {billed && (
          <div className="space-y-1 rounded-lg border border-ink-200 bg-surface p-2">
            {root && (
              <p className="text-[10px] font-medium leading-tight text-ink-600">
                SKU {root}{fam?.name ? ` · ${fam.name}` : ''}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-ink-500">
                <span className="text-ink-400">Se cobra</span>
                <input
                  key={String(partCount(draft, role))}
                  type="number" min="0" max={COUNT_MAX} className="input h-6 w-14 py-0 text-[11px]"
                  defaultValue={partCount(draft, role)}
                  onBlur={(e) => onCount(role, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                />
                <span className="text-ink-400">× SKU</span>
              </label>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-400">{meshN} en el modelo</span>
            </div>
            <p className="text-[10px] leading-tight text-ink-400">
              El catálogo vende individual o en juego de 2/3 — déjalo en 1 si el SKU es un juego que ya cubre todos.
            </p>
            {root && (
              <button type="button" onClick={() => onSlot('base')} className="btn-ghost text-[10px] text-ink-400 hover:text-red-500">
                <Trash2 size={11} /> Quitar SKU
              </button>
            )}
          </div>
        )}
      </SkuOption>

      <SkuOption
        active={structure}
        onClick={() => { if (!structure) onSlot('structure'); }}
        title="Estructura — viste acabado"
        hint="Metal o lacado: el cliente elige el acabado abajo y no cambia el precio."
      />

      {error && (
        <p role="alert" className="flex items-start gap-1 text-[10px] text-red-400">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </section>
  );
}

/* ── «Sugerir con Claude» ─────────────────────────────────────────────────── */

/** How a confidence READS. 'baja' must never look like 'alta' — the whole point
 *  of showing one is that the dealer can distrust it, and these bind a price. */
const CONFIDENCE_STYLE = {
  alta: { chip: 'bg-emerald-500/15 text-emerald-500', label: 'Confianza alta' },
  media: { chip: 'bg-amber-500/15 text-amber-500', label: 'Confianza media' },
  baja: { chip: 'bg-ink-200 text-ink-500', label: 'Poco seguro' },
};

const usdFrom = (n) => (n == null ? 'sin precio' : `desde US$${Math.round(n).toLocaleString('en-US')}`);

/**
 * The suggestion control, rendered inline in BOTH SKU surfaces — the model's
 * «SKU base» and each part's slot. One screen, no modal: the dealer reads the
 * pick, its confidence, the one-line why and the alternatives WITH their prices
 * before binding, because the price difference between two near-identical roots
 * is the whole risk (a $4,170 twin of a $7,120 piece).
 *
 * The split of labour: `resolveModelMatches` narrows the catalog HERE (the
 * browser already holds it), `togo-match` has Claude pick one of those rows and
 * explain why. Nothing auto-binds — «proponer siempre» (owner, 2026-08); the
 * bind rides the studio's existing write path, one click.
 */
function SkuSuggestPanel({ model, part = null, candidateIndex, onNeedCatalog, onBind }) {
  const [stage, setStage] = useState('idle');   // idle | waiting | thinking | done | error
  const [res, setRes] = useState(null);         // { suggestion, shortlist, degraded }
  const [err, setErr] = useState(null);
  // ONE run per click, and the click is the ONLY trigger. `stage` is deliberately
  // NOT a dependency: an effect that both reads and writes its own trigger tears
  // down (and cancels) the very request it just started. The claimed-run ref
  // then stops the catalog arriving — or refetching under the live query — from
  // silently spending a second Claude call on the same question.
  const [runId, setRunId] = useState(0);
  const claimed = useRef(0);

  const ask = () => {
    setErr(null); setRes(null); setStage('waiting');
    onNeedCatalog?.();
    setRunId((n) => n + 1);
  };

  useEffect(() => {
    if (!runId || claimed.current === runId || !candidateIndex || !model) return undefined;
    claimed.current = runId;
    let cancelled = false;
    setStage('thinking');
    (async () => {
      const shortlist = resolveModelMatches(
        buildSuggestQuery(model, part),
        candidateIndex,
        // A componente lifts the cushion refusal: six Exclusif cushion roots
        // state their own «1 BACK CUSHION» subtype, and refusing those for a
        // PART empties the very suggestion this panel exists to make.
        { limit: SUGGEST_LIMIT, forPart: !!part },
      );
      if (cancelled) return;
      if (!shortlist.length) {
        setErr(part
          ? 'El catálogo no ofrece ningún SKU compatible con este componente.'
          : 'El catálogo no ofrece ningún SKU compatible con esta pieza.');
        setStage('error');
        return;
      }
      const out = await suggestSkuMatch({ model, part, candidates: shortlist });
      if (cancelled) return;
      if (!out?.ok || !out.suggestion) {
        setErr(out?.error || 'No se pudo obtener una sugerencia.');
        setStage('error');
        return;
      }
      setRes({ ...out, shortlist });
      setStage('done');
    })().catch((e) => {
      if (!cancelled) { setErr(e?.message || 'No se pudo obtener una sugerencia.'); setStage('error'); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per click; the catalog may land after it
  }, [runId, candidateIndex]);

  const busy = stage === 'waiting' || stage === 'thinking';

  if (stage === 'idle') {
    return (
      <button
        type="button"
        onClick={ask}
        className="btn-ghost w-full justify-center text-[10px]"
        title="Que Claude proponga el SKU del catálogo que le pone precio a esta pieza"
      >
        <Sparkles size={11} /> Sugerir con Claude
      </button>
    );
  }

  if (busy) {
    return (
      <p className="flex items-center justify-center gap-1.5 py-1 text-[10px] text-ink-400">
        <Loader2 size={11} className="animate-spin" />
        {stage === 'waiting' ? 'Cargando el catálogo…' : 'Claude está comparando el catálogo…'}
      </p>
    );
  }

  if (stage === 'error') {
    return (
      <div className="space-y-1">
        <p role="alert" className="flex items-start gap-1 text-[10px] leading-tight text-amber-400">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {err}
        </p>
        <button type="button" onClick={ask} className="btn-ghost w-full justify-center text-[10px]">
          <RefreshCw size={11} /> Reintentar
        </button>
      </div>
    );
  }

  if (!res) return null;
  const pick = res.suggestion;
  const style = CONFIDENCE_STYLE[pick.confidence] || CONFIDENCE_STYLE.baja;
  const rowOf = (root) => res.shortlist.find((c) => c.root === root) || null;
  const picked = rowOf(pick.root);
  // The alternatives ARE the shortlist minus the pick — kept in the ranker's
  // order, with their prices, so the dealer sees what binding the other one
  // would cost before he does it.
  const others = res.shortlist.filter((c) => c.root !== pick.root);

  return (
    <div className="space-y-1.5 rounded-lg border border-ink-200 bg-surface p-2">
      <div className="flex items-center gap-1.5">
        <Sparkles size={11} className="shrink-0 text-ink-400" aria-hidden />
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${style.chip}`}>{style.label}</span>
        {pick.source === 'fallback' && (
          <span className="rounded-full bg-ink-200 px-1.5 py-0.5 text-[9px] text-ink-500">sin Claude</span>
        )}
      </div>

      <p className="text-[11px] font-medium leading-tight text-ink-900">
        SKU {pick.root}
        {picked?.name ? <span className="font-normal text-ink-600"> · {picked.name}</span> : null}
      </p>
      <p className="text-[10px] tabular-nums text-ink-500">{usdFrom(picked?.fromUsd)}</p>
      {pick.why && <p className="text-[10px] leading-tight text-ink-500">{pick.why}</p>}
      {/* A degrade says so in the dealer's own words — «poco seguro» alone would
          read as Claude hedging, when in fact Claude never answered. */}
      {pick.note && <p className="text-[10px] leading-tight text-amber-400">{pick.note}</p>}

      {/* Nothing auto-binds — «proponer siempre». This is the one click, and it
          rides the studio's existing write path (the model's own bind, or
          planSkuSlot for a componente). */}
      <button
        type="button"
        onClick={() => onBind(pick.root)}
        className="btn-primary w-full justify-center py-1 text-[10px]"
        title={`Vincular esta pieza al SKU ${pick.root}`}
      >
        <Link2 size={11} /> Vincular {pick.root}
      </button>

      {others.length > 0 && (
        <div className="space-y-0.5 border-t border-ink-100 pt-1.5">
          <p className="text-[9px] uppercase tracking-wide text-ink-400">Alternativas</p>
          {others.map((c) => (
            <button
              key={c.root}
              type="button"
              onClick={() => onBind(c.root)}
              className="flex w-full items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-ink-100"
              title={`Vincular al SKU ${c.root} en su lugar`}
            >
              <span className="font-mono text-[10px] text-ink-700">{c.root}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-ink-500">{c.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-400">{usdFrom(c.fromUsd)}</span>
            </button>
          ))}
          {pick.runnerUp && (
            <p className="pt-0.5 text-[10px] leading-tight text-ink-400">
              {pick.runnerUp.root}: {pick.runnerUp.why}
            </p>
          )}
        </div>
      )}

      <button type="button" onClick={ask} className="btn-ghost w-full justify-center text-[10px] text-ink-400">
        <RefreshCw size={11} /> Sugerir otra vez
      </button>
    </div>
  );
}

/**
 * One card of «Se cotiza como». Childless it IS the button (Estructura); with
 * children the card becomes a div whose HEADER is the button, so the nested
 * sub-choices are real controls and not buttons inside a button.
 */
function SkuOption({ active, onClick, title, hint, icon: Icon, children }) {
  const shell = `rounded-lg border transition-colors ${
    active ? 'border-brand-500 bg-brand-500/15' : 'border-ink-200 bg-surface'
  }`;
  const head = (
    <>
      <span className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${active ? 'border-brand-500' : 'border-ink-300'}`} aria-hidden>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1 truncate text-[11px] font-medium ${active ? 'text-brand-700' : 'text-ink-700'}`}>
          {Icon && <Icon size={11} className="shrink-0" aria-hidden />}
          {title}
        </span>
        {hint && <span className="mt-0.5 block text-[10px] leading-tight text-ink-400">{hint}</span>}
      </span>
    </>
  );

  if (!children) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${shell}${active ? '' : ' hover:border-ink-300 hover:bg-ink-100'}`}
      >
        {head}
      </button>
    );
  }

  return (
    <div className={shell}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`flex w-full items-start gap-2 rounded-t-lg px-2 py-1.5 text-left${active ? '' : ' hover:bg-ink-100'}`}
      >
        {head}
      </button>
      <div className="space-y-1 px-2 pb-2">{children}</div>
    </div>
  );
}

/**
 * A billing sub-choice inside the Componente card — dealer-only, so it reads
 * one notch quieter than the card it lives in, and indented under it.
 *
 * Its label WRAPS (inline spans, no truncate): the rail is 20rem wide and
 * «Con SKU propio · se cobra aparte · elegir producto» does not fit on one
 * line — truncating it printed «Con SKU propio · se», which reads as a bug.
 */
function SkuSubOption({ active, onClick, title, note, action, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex w-full items-start gap-1.5 rounded-md py-1 pl-3 pr-1 text-left transition-colors hover:bg-ink-100/60"
    >
      <span className={`mt-0.5 grid h-3 w-3 shrink-0 place-items-center rounded-full border ${active ? 'border-brand-500' : 'border-ink-300'}`} aria-hidden>
        {active && <span className="h-1 w-1 rounded-full bg-brand-500" />}
      </span>
      <span className={`min-w-0 flex-1 text-[10px] leading-tight ${active ? 'font-medium text-brand-700' : 'text-ink-600'}`}>
        {Icon && <Icon size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />}
        {/* The choice and what it costs are ONE unit; the affordance is the one
            break opportunity (the three don't fit on one line at 20rem, and the
            separating space MUST live outside both nowraps or the row has
            nowhere to break and spills past the card). */}
        <span className="whitespace-nowrap">
          {title}{note && <span className="text-ink-400"> · {note}</span>}
        </span>
        {action && (
          <>
            {' '}
            <span className="whitespace-nowrap text-ink-400 underline decoration-dotted">· {action}</span>
          </>
        )}
      </span>
    </button>
  );
}

/**
 * The group's FINISHES — the palette a client picks from for this part (the
 * Prado legs' Acero / Acero lacado negro). Exactly one option is the default:
 * it's what renders before anyone chooses.
 *
 * The rows are read from the RAW draft, not from `finishSpecOf`: the Model
 * DROPS a nameless or malformed option (rightly — it would render as an
 * unaddressable swatch), and an editor that deleted the row you are in the
 * middle of naming would be unusable. `finishSpecOf` still decides what COUNTS,
 * and a row it won't accept says so on its face.
 *
 * A palette is the COLECCIÓN's (collectionFinishes): a part this model hasn't
 * given finishes to, but its siblings have, opens PREFILLED with theirs and
 * says so. Editing simply works — the first keystroke writes the palette into
 * this model's draft, and saving fans the change back out to the colección.
 * An ESTRUCTURA inherits one step wider — from whatever the colección marks as
 * Estructura, under any key — so the badge names that as where it came from.
 *
 * THE BADGE IS INFORMATION, NOT A GATE. It used to carry «Usarlos en este
 * modelo», because a shown palette lived on a SIBLING's row while the
 * configurador read this one's — so until that button was pressed the client saw
 * nothing. `resolveTogoModels` now injects the colección's estructura at read
 * time, so there is nothing left to adopt: the badge only says where the
 * acabados come from and that editing them here edits them everywhere. The one
 * button that survives is the starter, for an estructura with nothing ANYWHERE —
 * a real dead end, not a display state. `dropped` is read off what is ON SCREEN
 * rather than off `resolveStructureFinish` (which judges the saved draft): the
 * dealer is often mid-keystroke here, and the verdict banner above owns that view.
 */
function FinishEditor({ groupKey, draft, inherited = null, collection, structure = false, onFinish }) {
  const own = draft?.finishes?.[groupKey] || null;
  const shared = !own && inherited?.options?.length ? inherited : null;
  const stored = own || shared;
  const rows = (Array.isArray(stored?.options) ? stored.options : [])
    .filter((o) => o && typeof o === 'object')
    .map((raw, i) => ({
      raw,
      id: (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : (slugify(raw.label) || `acabado-${i + 1}`),
      label: typeof raw.label === 'string' ? raw.label : '',
      rgb: FINISH_HEX.test(String(raw.rgb)) ? String(raw.rgb).toLowerCase() : DEFAULT_FINISH_RGB,
      metal: unitOrNull(raw.metal),
    }));
  // Normalized against the spec ON SCREEN, not against the draft: an inherited
  // palette isn't in the draft yet, and reading it from there would flag every
  // one of its options as unsaveable.
  const live = finishSpecOf({ finishes: stored ? { [groupKey]: stored } : {} }, groupKey);
  const counted = new Set((live?.options || []).map((o) => o.id));
  const dropped = rows.filter((r) => !counted.has(r.id)).length;
  const def = (typeof stored?.default === 'string' && stored.default) || live?.default || rows[0]?.id || '';

  // An option carries `metal`/`rough` as 0–1 NUMBERS or not at all — a boolean
  // is dropped by the Model and the option would render as paint, not steel.
  const toOption = (r) => {
    const out = { ...(r.raw || {}), id: r.id, label: r.label, rgb: r.rgb };
    if (r.metal != null) out.metal = r.metal; else delete out.metal;
    return out;
  };
  const write = (nextRows, nextDef) => {
    const options = nextRows.map(toOption);
    if (!options.length) { onFinish(null); return; }
    const fallback = options[0].id;
    onFinish({
      ...(stored || {}),
      options,
      default: options.some((o) => o.id === nextDef) ? nextDef : fallback,
    });
  };

  const add = () => {
    const label = `Acabado ${rows.length + 1}`;
    const next = [...rows, {
      raw: {},
      id: uniqueId(slugify(label), new Set(rows.map((r) => r.id))),
      label,
      rgb: DEFAULT_FINISH_RGB,
      metal: null,
    }];
    write(next, def || next[next.length - 1].id);
  };

  const patch = (i, fields) => write(rows.map((r, k) => (k === i ? { ...r, ...fields } : r)), def);

  // Re-slug on blur, never mid-word: re-deriving the id on every keystroke
  // churns the default pointer for no reason.
  const reslug = (i) => {
    const row = rows[i];
    if (!row) return;
    const taken = new Set(rows.filter((_, k) => k !== i).map((r) => r.id));
    const id = uniqueId(slugify(row.label) || `acabado-${i + 1}`, taken);
    if (id === row.id) return;
    write(rows.map((r, k) => (k === i ? { ...r, id } : r)), def === row.id ? id : def);
  };

  const remove = (i) => {
    const gone = rows[i];
    write(rows.filter((_, k) => k !== i), def === gone?.id ? '' : def);
  };

  // The canonical LR pair, written for real — deep-cloned because it goes
  // straight into a draft and from there into a jsonb row. It rides the ordinary
  // onFinish, so an estructura started this way still fans out to the whole
  // colección exactly as a typed one does.
  const plantStarter = () => onFinish(JSON.parse(JSON.stringify(structureStarterFinish())));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label mb-0">{structure ? 'Acabados de estructura' : 'Acabados'}</span>
        <button type="button" onClick={add} className="btn-ghost text-[10px]">
          <Plus size={11} aria-hidden /> Añadir acabado
        </button>
      </div>

      {/* WHERE these acabados come from — information only. The estructura is
          already on this pieza (it is injected at read time), so there is
          nothing to press: the badge just says whose palette it is and that
          editing it here edits it everywhere. */}
      {shared && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-400"
            title={structure
              ? 'Estos acabados son la estructura de la colección: ya se aplican a esta pieza. Al editarlos aquí se aplican a todas las marcadas como Estructura.'
              : 'Estos acabados vienen de otros modelos de la colección. Al editarlos aquí se aplican a todos.'}
          >
            <Link2 size={10} className="shrink-0" aria-hidden />
            <span className="truncate">
              {structure ? `Estructura de la colección ${collection}` : `Compartido con la colección ${collection}`}
            </span>
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="space-y-1.5">
          <p className="text-[10px] leading-tight text-ink-400">
            {structure
              ? 'Sin acabados: el cliente no verá esta estructura. Empieza con el par de siempre y ajústalo.'
              : 'Sin acabados propios — esta parte se materializa con la tela del modelo.'}
          </p>
          {/* The way out of the dead end, in one click: Ligne Roset's own pair
              for metal structure, straight from the Model so the studio can't
              drift from what the scene renders. */}
          {structure && (
            <button type="button" onClick={plantStarter} className="btn-secondary w-full text-[10px]">
              <Palette size={11} aria-hidden /> Usar Acero / Acero lacado negro
            </button>
          )}
        </div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => (
            // Index-keyed on purpose: the id is re-derived from the label, and a
            // changing key would remount the input mid-word.
            <li key={i} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-1.5 py-1">
              <input
                type="radio"
                name={`finish-default-${groupKey}`}
                className="h-3 w-3 shrink-0 accent-brand-500"
                checked={def === r.id}
                onChange={() => write(rows, r.id)}
                title="Acabado por defecto"
                aria-label={`Acabado por defecto: ${r.label || r.id}`}
              />
              <input
                type="color"
                className="h-6 w-7 shrink-0 cursor-pointer rounded border border-ink-200 bg-surface p-0.5"
                value={r.rgb}
                onChange={(e) => patch(i, { rgb: e.target.value })}
                aria-label={`Color de ${r.label || r.id}`}
              />
              <input
                type="text"
                className="input h-6 min-w-0 flex-1 py-0 text-[11px]"
                value={r.label}
                placeholder="Nombre"
                onChange={(e) => patch(i, { label: e.target.value })}
                onBlur={() => reslug(i)}
              />
              <label className="inline-flex shrink-0 items-center gap-1 text-[10px] text-ink-500" title="Se renderiza como metal">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-brand-500"
                  checked={r.metal != null && r.metal > 0}
                  onChange={(e) => patch(i, { metal: e.target.checked ? 1 : null })}
                />
                metal
              </label>
              {!counted.has(r.id) && (
                <span className="shrink-0 text-amber-400" title="Ponle un nombre: sin él este acabado no se guarda">
                  <AlertCircle size={11} aria-hidden />
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                className="shrink-0 p-1 text-ink-300 hover:text-red-500"
                title="Quitar acabado"
                aria-label={`Quitar ${r.label || r.id}`}
              >
                <Trash2 size={11} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* The row marker is an 11px glyph behind a tooltip — easy to miss, and
          missing it costs the whole part. So the count is spelled out under the
          list, in words, whenever the Model would drop a row. */}
      {dropped > 0 && (
        <p role="status" className="flex items-start gap-1 text-[10px] leading-tight text-amber-400">
          <AlertCircle size={11} className="mt-px shrink-0" aria-hidden />
          {dropped === 1
            ? 'Un acabado no se guardará: le falta el nombre.'
            : `${dropped} acabados no se guardarán: les falta el nombre.`}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION-WIDE TOOLS (ported verbatim from the card wall — same logic, dark skin)

/**
 * "Auto-vincular" — the agentic path from a pile of "Pieza N" uploads to a
 * priced palette: probe each unbound model's REAL 3D file (height + arm side,
 * `bindingProbe`), match footprints against the LR price list
 * (`lib/togo/autoLink`), and propose SKU + clean name per model. The dealer
 * REVIEWS and applies — bindings decide quoted money, so a human confirms;
 * anything geometry couldn't settle arrives flagged. Existing bindings are never
 * touched. Renders nothing when the collection is fully bound.
 */
function AutoLinkRow({ collection, cards, products, onNeedCatalog }) {
  const unbound = useMemo(() => cards.filter((c) => !c.productRoot), [cards]);
  const [stage, setStage] = useState('idle');   // idle | waiting | probing | review | applying
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);   // { proposals, unmatched }
  const [picked, setPicked] = useState({});
  const [err, setErr] = useState(null);

  const run = () => { setErr(null); setStage('waiting'); onNeedCatalog?.(); };

  // The probe+match pass fires once the (lazily requested) catalog is in.
  useEffect(() => {
    if (stage !== 'waiting' || !products) return undefined;
    let cancelled = false;
    (async () => {
      const targets = unbound;
      setStage('probing');
      setProgress({ done: 0, total: targets.length });
      const geometry = {};
      for (const c of targets) {
        if (cancelled) return;
        if (c.mesh) {
          try { geometry[c.id] = await probeMeshBinding(c); }
          catch { /* geometry is optional — the matcher just flags review */ }
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      const res = proposeCollectionBindings({ collection, models: targets, products, geometry });
      if (cancelled) return;
      if (!res.proposals.length) {
        setErr('Ninguna pieza sin vincular coincide con un SKU del catálogo de esta colección.');
        setStage('idle');
        return;
      }
      setResult(res);
      setPicked(Object.fromEntries(res.proposals.map((p) => [p.modelId, true])));
      setStage('review');
    })().catch((e) => {
      if (!cancelled) { setErr(e?.message || 'No se pudo analizar la colección.'); setStage('idle'); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the waiting→catalog handshake only
  }, [stage, products]);

  const apply = async () => {
    if (!result || stage === 'applying') return;
    setStage('applying');
    try {
      for (const p of result.proposals) {
        if (!picked[p.modelId]) continue;
        await db.togoModels.update(p.modelId, { productRoot: p.root, name: p.name, updatedAt: Date.now() });
      }
      setResult(null); setStage('idle'); setErr(null);
    } catch (e) {
      setErr(e?.message || 'No se pudieron guardar los vínculos.');
      setStage('review');
    }
  };

  if (!unbound.length && stage === 'idle') return null;
  const nameOf = (id) => cards.find((c) => c.id === id)?.name || id;
  const pickedCount = result ? result.proposals.filter((p) => picked[p.modelId]).length : 0;

  return (
    <div className="space-y-1.5 rounded-lg border border-ink-200 bg-surface px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1 text-[10px] text-ink-400">
          <Sparkles size={11} className="shrink-0" />
          <span className="truncate">{unbound.length} sin SKU</span>
        </span>
        {stage === 'idle' && (
          <button type="button" onClick={run} className="btn-ghost shrink-0 text-[10px]" title="Analizar los modelos 3D y proponer SKU + nombre desde el catálogo de la marca">
            <Sparkles size={11} /> Proponer SKUs
          </button>
        )}
        {(stage === 'waiting' || stage === 'probing') && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] text-ink-500">
            <Loader2 size={11} className="animate-spin" />
            {stage === 'waiting' ? 'Cargando catálogo…' : `${Math.min(progress.done + 1, progress.total)}/${progress.total}`}
          </span>
        )}
      </div>

      {err && (
        <div className="inline-flex items-start gap-1 text-[10px] text-red-400">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {(stage === 'review' || stage === 'applying') && result && (
        <div className="space-y-1.5">
          {result.proposals.map((p) => (
            <label key={p.modelId} className="flex cursor-pointer items-start gap-2 text-[10px]">
              <input
                type="checkbox"
                checked={!!picked[p.modelId]}
                onChange={(e) => setPicked((s) => ({ ...s, [p.modelId]: e.target.checked }))}
                className="mt-0.5 shrink-0 accent-brand-500"
              />
              <span className="min-w-0 flex-1 leading-snug">
                <span className="text-ink-500">{nameOf(p.modelId)}</span>
                <span className="text-ink-400"> → </span>
                <span className="font-medium text-ink-800">{p.name}</span>
                <span className="tabular-nums text-ink-400"> · SKU {p.root}</span>
                {p.needsReview && (
                  <span className="text-amber-400"> · revisar{p.reasons.length ? `: ${p.reasons.join(' · ')}` : ''}</span>
                )}
              </span>
            </label>
          ))}
          {result.unmatched.length > 0 && (
            <p className="text-[10px] leading-tight text-ink-400">
              Sin propuesta: {result.unmatched.map(nameOf).join(', ')} — vincúlalos manualmente.
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button type="button" onClick={() => { setResult(null); setStage('idle'); }} className="btn-ghost text-[10px]">
              Cancelar
            </button>
            <button type="button" onClick={apply} disabled={!pickedCount || stage === 'applying'} className="btn-primary text-[10px] disabled:opacity-50">
              {stage === 'applying' ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Aplicar {pickedCount}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Telas" — ONE materials link per modular collection. The dealer pastes the
 * family's product page on THE BRAND'S OWN SITE and the offered fabrics are
 * fetched once and persisted under EVERY family root the collection's models
 * bind — the base SKU and the tagged part SKUs — so a single link updates all
 * the models in that family at once.
 *
 * `fabricLink` is the ACTIVE BRAND's catalog-module capability: it owns the
 * reader, the placeholder and the wording, so this component never names a
 * manufacturer. The caller only mounts it when the brand declares one. The
 * effect (the Supabase function invoker) is handed to `fetch` rather than
 * imported by the brand layer — same seam as `materials.parse`'s uploader.
 */
function CollectionFabricsLink({ collection, cards, links, fabricLink, profileId }) {
  // Every family root the collection touches: base bindings + per-part SKUs.
  const roots = useMemo(
    () => [...new Set(cards.flatMap((c) => [c.productRoot, ...Object.values(c.parts?.roots || {})]).filter(Boolean))],
    [cards],
  );
  const linked = useMemo(
    () => (links || []).filter((l) => roots.includes(l.id) && (l.patternNames?.length || l.sourceUrl)),
    [links, roots],
  );
  // The collection's current link = the freshest row among its roots.
  const current = useMemo(
    () => linked.slice().sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0] || null,
    [linked],
  );
  const unbound = cards.filter((c) => !c.productRoot).length;

  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);   // { fabrics, roots } after a save

  // The brand's own name where the copy needs one — '' rather than a guess, so
  // a brand that never told us reads as plain "un producto".
  const brandLabel = fabricLink?.label ? ` (${fabricLink.label})` : '';
  // The effect the brand layer is HANDED instead of importing: one function, so
  // `src/brands/**` keeps no Supabase client of its own.
  const invokeFn = useCallback((name, opts) => supabase.functions.invoke(name, opts), []);

  // Fetch the page once, then fan the SAME result out to every root.
  const apply = async (source) => {
    const target = (source || '').trim();
    if (busy || !target || !roots.length) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const result = await fabricLink.fetch(target, { invoke: invokeFn });
      await saveCollectionFabrics(roots, profileId, result);
      setDone({ fabrics: result.patternNames.length, roots: roots.length });
      setUrl(''); setEditing(false);
    } catch (e) {
      setErr(e?.message || 'No se pudo leer la página del fabricante.');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    if (!window.confirm(`¿Quitar el enlace de telas de ${collection}? Sus modelos volverán a ofrecer todas las telas del grado.`)) return;
    setBusy(true); setErr(null); setDone(null);
    try { await clearCollectionFabrics(roots); setUrl(''); setEditing(false); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-1.5 rounded-lg border border-ink-200 bg-surface px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className={`inline-flex min-w-0 items-center gap-1 text-[10px] ${current ? 'text-emerald-400' : 'text-ink-400'}`}>
          <Palette size={11} className="shrink-0" />
          <span className="truncate" title={current?.title || undefined}>
            {current
              ? `Telas · ${current.patternNames?.length || 0} · ${linked.length}/${roots.length} SKUs`
              : 'Telas · sin vincular'}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {current?.sourceUrl && (
            <a href={current.sourceUrl} target="_blank" rel="noreferrer" className="btn-ghost text-[10px]" title={current.title || current.sourceUrl}>
              <ExternalLink size={11} /> Ver
            </a>
          )}
          {current?.sourceUrl && (
            <button
              type="button" onClick={() => apply(current.sourceUrl)} disabled={busy}
              className="btn-ghost text-[10px] disabled:opacity-50"
              title="Volver a leer la página y actualizar las telas de todos los modelos de la colección"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Actualizar
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              // Never a dead disabled button: without bound SKUs the click
              // explains what to do (a disabled control also swallows its title).
              if (!roots.length) {
                setErr(`Vincula primero los modelos de esta colección a un producto${brandLabel} — sin SKU no hay telas por grado.`);
                return;
              }
              setEditing((v) => !v); setErr(null); setDone(null);
            }}
            className="btn-ghost text-[10px]"
            title="Pegar el enlace de telas disponibles de esta colección"
          >
            <Link2 size={11} /> {current ? 'Cambiar' : 'Vincular'}
          </button>
          {current && (
            <button
              type="button" onClick={clear} disabled={busy}
              className="p-1 text-ink-400 hover:text-red-500 disabled:opacity-50"
              title="Quitar el enlace de telas de toda la colección"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="flex items-center gap-1.5">
          <input
            className="input h-7 min-w-0 flex-1 py-0 text-[11px]"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={fabricLink.placeholder || 'https://…'}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(url); }}
            autoFocus
          />
          <button
            type="button" onClick={() => apply(url)} disabled={busy || !url.trim()}
            className="btn-primary h-7 shrink-0 text-[10px] disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Aplicar
          </button>
        </div>
      )}

      {err && (
        <div className="inline-flex items-start gap-1 text-[10px] text-red-400">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}
      {done && (
        <div className="inline-flex items-start gap-1 text-[10px] text-emerald-400">
          <Check size={11} className="mt-0.5 shrink-0" />
          {done.fabrics} telas aplicadas a {done.roots} SKU{done.roots === 1 ? '' : 's'} de {collection}.
        </div>
      )}
      {(editing || !current) && (
        <p className="text-[10px] leading-tight text-ink-400">
          Un solo enlace aplica a todos los modelos de la colección: el selector de telas se limita a las
          que el fabricante ofrece para esta familia.{fabricLink.hint ? ` ${fabricLink.hint}.` : ''}
          {unbound > 0 && ` ${unbound} modelo${unbound === 1 ? '' : 's'} sin producto vinculado no restringe${unbound === 1 ? '' : 'n'}.`}
        </p>
      )}
    </div>
  );
}
