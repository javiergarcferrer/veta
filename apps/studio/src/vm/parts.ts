/**
 * THE PARTS WORKFLOW — "detect parts", as a pure function of measured boxes.
 *
 * Ported from the reference ModelStudio's `detect()` (RosetSoft
 * `components/togo/ModelStudio.jsx` ~1363) with the loading and the three.js
 * traversal lifted OUT: the worker measures every mesh node once
 * (`MeasuredNode`), and everything that DECIDES anything lives here, so the
 * classifier is unit-testable without a DOM, a GPU or a file.
 *
 * The order is load-bearing and is the reference's:
 *
 *   1. BOXES FIRST, THEN KEYS. Every node's world box is measured before any
 *      key is derived, because `partKeysFor` splits a material into SHAPE
 *      clusters and it needs all the boxes to see the split. Merging boxes per
 *      material name first averaged a cushion slab and a bolster roll into one
 *      box that is neither — the "back cushions and bolster not detected
 *      separately" report.
 *   2. FINGERPRINTS FROM THE COLLECTION'S ACCESSORY MODELS. pCon reuses ONE
 *      material id per part type across a whole collection, so a sofa sub-mesh
 *      sharing the loose cushion's material IS that cushion (identity); its
 *      measured size in cm is the second signal.
 *   3. EXISTING DEALER CHOICES ALWAYS WIN. The proposal only fills keys the
 *      stored tagging says nothing about — a detect re-run can never overwrite
 *      a confirmed role.
 */
import { autoUnitScale } from '@veta/geometry';
import { PART_ROLES, accessoryRoleFor, baseKeyOf, partKeysFor } from '@veta/materials';
import type { MeasuredNode, PartsDraft, UpAxis } from './types.ts';

/** One part GROUP: every node sharing a key, boxes merged. */
export interface PartGroupBox {
  key: string;
  min: [number, number, number];
  max: [number, number, number];
}

/** A reference fingerprint taken off a standalone accessory model. */
export interface AccessoryRef {
  role: string;
  /** The NAMED materials that model uses — positional keys ("#2") are
   *  meaningless across different exports and are never fingerprints. */
  matKeys: string[];
  /** The accessory's overall size, in cm. */
  size: [number, number, number];
}

const triple = (v: readonly number[]): [number, number, number] => [v[0], v[1], v[2]];

/**
 * Two boxes read as THE SAME PART when every extent agrees within 20% —
 * horizontal extents compared orientation-free (sorted), height apart.
 *
 * The same rule `@veta/materials`' `partKeysFor` splits clusters with, restated
 * here because the classifier compares boxes to boxes measured in different
 * files: materials keeps it private (it is an implementation detail of the
 * split), and duplicating the ±20% is cheaper than widening that package's API
 * for one consumer. Both sides are ratios, so neither cares about units.
 */
function sizeMatches(a: readonly number[], b: readonly number[]): boolean {
  const close = (x: number, y: number): boolean => {
    const m = Math.max(Math.abs(x), Math.abs(y));
    return m < 1e-6 || Math.abs(x - y) / m <= 0.2;
  };
  const [aw, ad] = [Math.max(a[0], a[2]), Math.min(a[0], a[2])];
  const [bw, bd] = [Math.max(b[0], b[2]), Math.min(b[0], b[2])];
  return close(aw, bw) && close(ad, bd) && close(a[1], b[1]);
}

/** A z-up export's box brought into the classifier's y-up frame. A coordinate
 *  PERMUTATION, so a min stays a min on every axis. */
const remapUp = (v: readonly number[], upAxis: UpAxis): [number, number, number] =>
  (upAxis === 'z' ? [v[0], v[2], v[1]] : [v[0], v[1], v[2]]);

/**
 * Measured nodes → part groups, in the SOURCE file's units.
 *
 * Boxes are remapped to y-up first, then keys are derived over ALL of them
 * (`partKeysFor` — the shape split), then the boxes of one key are merged. A
 * node with no usable box still joins its material's first cluster, exactly as
 * `partKeysFor` specifies.
 */
export function partGroupsFrom(
  nodes: readonly MeasuredNode[] | null | undefined,
  upAxis: UpAxis = 'y',
): PartGroupBox[] {
  const list = (nodes || []).map((n) => {
    const min = remapUp(n.min, upAxis);
    const max = remapUp(n.max, upAxis);
    return { materialName: n.materialName, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number] };
  });
  const keys = partKeysFor(list);
  const byKey = new Map<string, PartGroupBox>();
  list.forEach((n, i) => {
    const key = keys[i] as string;
    const g = byKey.get(key);
    if (g) {
      g.min = triple(g.min.map((v, a) => Math.min(v, n.min[a])));
      g.max = triple(g.max.map((v, a) => Math.max(v, n.max[a])));
    } else {
      byKey.set(key, { key, min: n.min, max: n.max });
    }
  });
  return [...byKey.values()];
}

/**
 * The same groups in CENTIMETRES — the power-of-ten unit guard applied off the
 * model's LARGEST extent, so a size fingerprint compares like for like against
 * an accessory measured in another file's units.
 */
export function partGroupsInCm(groups: readonly PartGroupBox[]): PartGroupBox[] {
  const raw = groups.reduce((m, g) => Math.max(m, ...g.max.map((v, a) => v - g.min[a])), 0);
  const unit = autoUnitScale(raw);
  return groups.map((g) => ({
    key: g.key,
    min: triple(g.min.map((v) => v * unit)),
    max: triple(g.max.map((v) => v * unit)),
  }));
}

/**
 * A fingerprint off ONE standalone accessory model (the dealer's loose "Back
 * Cushion" / "Bolster" / "Cojín de brazo" uploads). Null when the model's NAME
 * doesn't read as an accessory — a sofa is not a reference for anything.
 */
export function accessoryRefFrom(
  name: unknown,
  nodes: readonly MeasuredNode[] | null | undefined,
  upAxis: UpAxis = 'y',
): AccessoryRef | null {
  const role = accessoryRoleFor(name);
  if (!role) return null;
  const list = nodes || [];
  if (!list.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const matKeys: string[] = [];
  for (const n of list) {
    const lo = remapUp(n.min, upAxis);
    const hi = remapUp(n.max, upAxis);
    for (let a = 0; a < 3; a++) {
      if (lo[a] < min[a]) min[a] = lo[a];
      if (hi[a] > max[a]) max[a] = hi[a];
    }
    const nm = (n.materialName == null ? '' : String(n.materialName)).trim();
    if (nm && !matKeys.includes(nm)) matKeys.push(nm);
  }
  if (!Number.isFinite(min[0])) return null;
  const rawSize: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const unit = autoUnitScale(Math.max(...rawSize));
  return { role, matKeys, size: triple(rawSize.map((v) => v * unit)) };
}

/**
 * PROPOSE a role per part group — the pre-classification the dealer confirms.
 * `groups` are boxes in cm, one per group; `refs` are the collection's accessory
 * fingerprints. Returns `{ [key]: role }`.
 *
 * Fingerprints outrank every heuristic below (a shared material id is IDENTITY).
 * The heuristics, in the order a sofa gives them up:
 *   • base — bottom in the lowest quarter AND footprint ≥ 40% of the total; the
 *     largest-footprint group is always base, so a model is never all-cushions;
 *   • the MATERIALIZATION pair — nothing rides above the body and the only other
 *     group is a recessed plinth UNDER it: that is one SKU's two fabric zones
 *     (exterior body / interior plinth), not a cushion to bill;
 *   • armCushion — above the base top and hugging a lateral extreme;
 *   • bolster — an elongated roll that is also SMALL (a rulo never reaches a
 *     third of the piece's height; elongation alone misfiled a fused
 *     three-cushion slab as a rulo);
 *   • cushion — everything else above the base.
 */
export function classifyPartGroups(
  groups: readonly PartGroupBox[] | null | undefined,
  refs: readonly AccessoryRef[] = [],
): Record<string, string> {
  const list = (groups || []).filter((g) => g && g.min && g.max);
  if (!list.length) return {};
  const uMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const uMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const g of list) {
    for (let a = 0; a < 3; a++) {
      uMin[a] = Math.min(uMin[a], g.min[a]);
      uMax[a] = Math.max(uMax[a], g.max[a]);
    }
  }
  const totalW = uMax[0] - uMin[0];
  const totalH = uMax[1] - uMin[1];
  const totalD = uMax[2] - uMin[2];
  const footprint = (g: PartGroupBox): number => Math.max(0, g.max[0] - g.min[0]) * Math.max(0, g.max[2] - g.min[2]);
  const totalFp = Math.max(1e-6, totalW * totalD);

  const out: Record<string, string> = {};
  let largest: PartGroupBox | null = null;
  for (const g of list) {
    const isLow = g.min[1] <= uMin[1] + totalH * 0.25;
    if (isLow && footprint(g) >= totalFp * 0.4) out[g.key] = 'base';
    if (!largest || footprint(g) > footprint(largest)) largest = g;
  }
  if (largest && !Object.values(out).includes('base')) out[largest.key] = 'base';

  // The materialization pair (the reference's measured ottomans: body 8..41 cm
  // over a plinth 0..8 cm). A sofa never matches — its cushions sit ABOVE the
  // platform, so `rest` is not entirely under the base.
  {
    const rest = list.filter((g) => !out[g.key]);
    const baseBottom = Math.min(...list.filter((g) => out[g.key] === 'base').map((g) => g.min[1]));
    if (rest.length && rest.every((g) => g.max[1] <= baseBottom + totalH * 0.05)) {
      for (const g of list) out[g.key] = out[g.key] === 'base' ? 'exterior' : 'interior';
      return out;
    }
  }

  for (const g of list) {
    if (out[g.key]) continue;
    const w = g.max[0] - g.min[0];
    const h = g.max[1] - g.min[1];
    const d = g.max[2] - g.min[2];
    // A SPLIT cluster shares its material with another part type on this very
    // model — that is what made it split — so the material cannot say which
    // type it is, and taking it would undo the split. Shape is its only honest
    // signal.
    const split = baseKeyOf(g.key) !== g.key;
    if (!split) {
      const byMat = refs.find((ref) => (ref.matKeys || []).includes(g.key));
      if (byMat && PART_ROLES.includes(byMat.role)) { out[g.key] = byMat.role; continue; }
    }
    const bySize = refs.find((ref) => Array.isArray(ref.size) && sizeMatches([w, h, d], ref.size));
    if (bySize && PART_ROLES.includes(bySize.role)) { out[g.key] = bySize.role; continue; }
    const atSide = g.min[0] <= uMin[0] + totalW * 0.05 || g.max[0] >= uMax[0] - totalW * 0.05;
    if (atSide && w <= totalW * 0.3) { out[g.key] = 'armCushion'; continue; }
    const [long, short] = w >= d ? [w, d] : [d, w];
    const bolsterish = short > 0 && long / short >= 2.5 && h <= short * 1.2 && h <= totalH * 0.35;
    out[g.key] = bolsterish ? 'bolster' : 'cushion';
  }
  return out;
}

/** What one detect run produced, and what it left alone. */
export interface DetectResult {
  /** The classifier's raw answer, key → role (what it WOULD say). */
  proposal: Record<string, string>;
  /** The draft to commit: proposal under the stored tagging, so every confirmed
   *  choice survives and only NEW keys are filled. */
  parts: PartsDraft;
  /** The keys the proposal actually contributed — what the UI should highlight. */
  added: string[];
  /** Keys the dealer had already decided; the proposal was discarded for these. */
  kept: string[];
  groups: PartGroupBox[];
}

export interface DetectInput {
  nodes: readonly MeasuredNode[] | null | undefined;
  upAxis?: UpAxis;
  /** The collection's accessory models, already measured. */
  accessories?: readonly { name: unknown; nodes: readonly MeasuredNode[]; upAxis?: UpAxis }[];
  /** The model's stored tagging — never overwritten. */
  parts?: PartsDraft | null;
}

/**
 * The whole detect flow: measure → key → classify → merge under the dealer's
 * choices. Throws nothing; a model with no meshes yields an empty proposal and
 * the stored tagging untouched (the caller reports "no geometry").
 */
export function detectParts({ nodes, upAxis = 'y', accessories = [], parts = null }: DetectInput): DetectResult {
  const groups = partGroupsInCm(partGroupsFrom(nodes, upAxis));
  const refs = accessories
    .map((a) => accessoryRefFrom(a.name, a.nodes, a.upAxis ?? 'y'))
    .filter((r): r is AccessoryRef => !!r);
  const proposal = classifyPartGroups(groups, refs);
  const stored: Record<string, string> = { ...(parts?.mats || {}) };
  const added: string[] = [];
  const kept: string[] = [];
  for (const key of Object.keys(proposal)) (stored[key] ? kept : added).push(key);
  return {
    proposal,
    parts: { ...(parts || {}), mats: { ...proposal, ...stored } },
    added,
    kept,
    groups,
  };
}
