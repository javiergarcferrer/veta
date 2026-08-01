/**
 * The FINISH layer of the part model — merges, labels, and per-group finish
 * palettes (metal legs, lacquered bases). Ported from RosetSoft
 * `lib/togo/meshParts.js` (studio layer); pure functions of dealer-authored
 * jsonb, shared by the scene's material-precedence chain, the studio's
 * editors, and the API's payload sanitizer — ONE rule set for all three.
 *
 * A finish is a MATERIALIZATION choice that never bills: same piece, same SKU,
 * same price whichever lacquer the client picks (the `structure` role in
 * UNPRICED_ROLES). A materialization ZONE's role may also carry a palette; the
 * scene keys finishes by GROUP, not by role, so rendering is identical.
 */
import { baseKeyOf, partRoleFor, type PartsMap } from './partRoles.ts';

/** One normalized finish option — always a real `#rrggbb`, ids unique. */
export interface FinishOption {
  id: string;
  label: string;
  rgb: string;
  metal?: number;
  rough?: number;
}

/** A group's normalized palette; null shape never leaves finishSpecOf. */
export interface FinishSpec {
  label: string | null;
  options: FinishOption[];
  default: string | null;
}

/** The group a part key really belongs to, after following `merges`.
 *  The map is dealer-authored jsonb, so a chain can be hand-edited into a LOOP
 *  (a→b→a) and a naive walk would hang the render thread on a model the dealer
 *  can no longer open to fix it. We stop the moment we revisit a key and return
 *  the LAST SAFE one — always a real group, never a hang. No map, an empty
 *  target, or a key pointing at itself is the key itself. */
export function mergedKeyOf(parts: PartsMap | null | undefined, key: unknown): string {
  const merges = parts?.merges;
  let cur = key == null ? '' : String(key);
  if (!cur || !merges || typeof merges !== 'object') return cur;
  const map = merges as Record<string, unknown>;
  const seen = new Set([cur]);
  for (;;) {                                   // bounded: `seen` grows every hop
    const raw = map[cur];
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/** What a group is CALLED. The dealer's own label wins — read off the MERGED
 *  group, so a folded child never shows a name of its own — then the caller's
 *  fallback (the localized role label the pickers already render), then the
 *  group key, which is at least the material name the export carried. */
export function partLabelOf(parts: PartsMap | null | undefined, key: unknown, fallback?: unknown): string {
  const group = mergedKeyOf(parts, key);
  const labels = parts?.labels as Record<string, unknown> | undefined;
  const raw = labels?.[group];
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label) return label;
  const fb = fallback == null ? '' : String(fallback).trim();
  return fb || group;
}

/**
 * The name a ROLE wears on this model — the dealer's own word for it, else the
 * generic role label. `labels` is keyed by GROUP KEY (that is what the studio
 * edits), so this walks the tagging to find the groups wearing `role` and takes
 * the first LABELLED one, sorted so the answer can't flip between reads when a
 * role spans several groups. A merged child wears its target's identity.
 * `fallback` is the caller's localized role label — passed in rather than read
 * from PART_LABELS so a widget keeps answering in the visitor's language when
 * the dealer named nothing.
 */
export function roleLabelOf(parts: PartsMap | null | undefined, role: string, fallback?: unknown): string {
  const mats = parts?.mats || {};
  const labels = parts?.labels as Record<string, unknown> | undefined;
  const named = Object.keys(mats)
    .filter((key) => partRoleFor(parts, null, -1, key) === role)
    .map((key) => mergedKeyOf(parts, key))
    .sort();
  for (const group of named) {
    const raw = labels?.[group];
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (label) return label;
  }
  const fb = fallback == null ? '' : String(fallback).trim();
  return fb || role;
}

const FINISH_HEX = /^#[0-9a-f]{6}$/i;

// A PBR 0–1 knob, only when one was really given: `Number(null)` is 0, so a
// coerce-everything read would hand the scene a hard metal:0 for a field the
// dealer simply left blank.
function finishUnit(v: unknown): number | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/**
 * The finish palette for a group (its MERGED group — a folded child inherits
 * the target's), normalized so every consumer can trust the shape without
 * re-checking it: an option needs a non-empty `id`, a non-empty `label` and a
 * real `#rrggbb` — a half-typed row is DROPPED rather than rendered as a
 * nameless black swatch, and a duplicate id keeps its first row so the palette
 * stays addressable. `default` survives only if it names a surviving option.
 * Returns null when nothing valid is left, which is the same thing as "this
 * group has no finishes" — one falsy check covers both at every call site.
 */
export function finishSpecOf(parts: PartsMap | null | undefined, key: unknown): FinishSpec | null {
  const finishes = parts?.finishes as Record<string, unknown> | undefined;
  const spec = finishes?.[mergedKeyOf(parts, key)] as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== 'object') return null;
  const options: FinishOption[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(spec.options) ? spec.options : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const rgb = typeof r.rgb === 'string' ? r.rgb.trim() : '';
    if (!id || !label || !FINISH_HEX.test(rgb) || ids.has(id)) continue;
    ids.add(id);
    const opt: FinishOption = { id, label, rgb: rgb.toLowerCase() };
    const metal = finishUnit(r.metal), rough = finishUnit(r.rough);
    if (metal != null) opt.metal = metal;
    if (rough != null) opt.rough = rough;
    options.push(opt);
  }
  if (!options.length) return null;
  const label = typeof spec.label === 'string' ? spec.label.trim() : '';
  const def = typeof spec.default === 'string' ? spec.default.trim() : '';
  return { label: label || null, options, default: ids.has(def) ? def : null };
}

/**
 * A STARTER structure palette — a metal pair (steel, black-lacquered steel).
 * Exists because marking a group `structure` and DEFINING its palette are two
 * independent authoring steps: a group saved as structure with no palette reads
 * as a finished choice in the studio and renders as NOTHING in the widget
 * (finishSpecOf → null drops it from the client's list). The role arrives with
 * this palette already on it, and the studio offers it as one click wherever a
 * structure lost its own. A FRESH object per call, deliberately: it is written
 * straight into a parts draft and from there into a jsonb row, and a shared
 * constant would alias into every model that adopted it.
 */
export function structureStarterFinish(): { options: FinishOption[]; default: string } {
  return {
    options: [
      { id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 },
      { id: 'acero-lacado-negro', label: 'Acero lacado negro', rgb: '#17181c', metal: 1 },
    ],
    default: 'acero',
  };
}

/** The option a pick resolves to: the picked id, else the palette's default,
 *  else the first option. A palette always answers with SOMETHING — a leg that
 *  silently loses its material reads as a broken model, not as "no pick". */
export function finishOptionOf(spec: FinishSpec | null | undefined, optionId: unknown): FinishOption | null {
  const options = Array.isArray(spec?.options) ? spec.options : [];
  if (!options.length) return null;
  const want = optionId == null ? '' : String(optionId).trim();
  return options.find((o) => o?.id === want)
    || options.find((o) => o?.id === spec?.default)
    || options[0]!;
}

/**
 * THE STRUCTURE GROUPS A PIECE OFFERS — a different axis from cloth: same
 * piece, same SKU, same price whichever the client picks (UNPRICED_ROLES), so
 * a finish can never make a quote read "by parts". One entry per merged GROUP
 * (four legs exported as four materials are ONE leg group). A group whose
 * merged key no longer reads as a structure is skipped, exactly like a group
 * with no valid palette: neither is a choice we can honestly offer. Sorted by
 * key — jsonb key order is not meaning.
 */
export function structureGroupsOf(parts: PartsMap | null | undefined): Array<{ group: string; spec: FinishSpec }> {
  const out: Array<{ group: string; spec: FinishSpec }> = [];
  const seen = new Set<string>();
  for (const key of Object.keys(parts?.mats || {}).sort()) {
    if (partRoleFor(parts, null, -1, key) !== 'structure') continue;
    const group = mergedKeyOf(parts, key);
    if (seen.has(group)) continue;
    seen.add(group);
    const spec = finishSpecOf(parts, group);
    if (!spec || partRoleFor(parts, null, -1, group) !== 'structure') continue;
    out.push({ group, spec });
  }
  return out;
}

/**
 * WHICH structure group a pick means. Not every caller carries a group key
 * (a 2D drag-end reports the role alone), and a key can be real yet
 * palette-less (a split cluster inherits its material's tag before it exists
 * in `parts`). Precedence, most specific first: the key itself when it carries
 * a palette; its BASE key (the same inheritance partRoleFor grants a split
 * cluster's role, now granted for its palette); the piece's ONE structure
 * group when it has exactly one; null — several groups and no key names none
 * of them, and picking the first would silently repaint a part the visitor
 * never touched.
 */
export function structureGroupFor(parts: PartsMap | null | undefined, partKey: unknown): { group: string; spec: FinishSpec } | null {
  const groups = structureGroupsOf(parts);
  if (!groups.length) return null;
  const key = partKey == null ? '' : String(partKey).trim();
  if (key) {
    const exact = groups.find((g) => g.group === key);
    if (exact) return exact;
    const base = baseKeyOf(key);
    const byBase = base !== key ? groups.find((g) => g.group === base) : null;
    if (byBase) return byBase;
  }
  return groups.length === 1 ? groups[0]! : null;
}

/**
 * Sanitize a lead payload's per-part FINISH picks — the ONLY thing deciding
 * what gets stored: `{ [groupKey]: optionId }`, key trimmed to 64 chars, id to
 * 32, at most 12 groups — the cap is what stops a hand-crafted POST from
 * writing a novel into the lead. Counted by the output object itself: two keys
 * that collide once trimmed are one group, and must not eat two of the twelve
 * slots. Excess drops by insertion order so the same payload always sanitizes
 * to the same object. Null when nothing survives.
 */
export function sanitizePartFinishes(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    const key = String(k).trim().slice(0, 64);
    const id = typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 32) : '';
    if (!key || !id) continue;
    out[key] = id;
  }
  return Object.keys(out).length ? out : null;
}
