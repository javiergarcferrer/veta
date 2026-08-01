/**
 * Clean a loaded model's node tree, in place — drop the two kinds of non-furniture
 * geometry dealer exports carry: baked-in LABEL meshes and pCon GROUND-SHADOW
 * planes. Both polluted the top-down silhouette AND inflated the measured
 * footprint; we can't edit the uploaded file, so we drop the offending nodes
 * after load.
 *
 * three.js is DEPENDENCY-INJECTED (`THREE`) — this module is structurally typed
 * against the handful of members it uses, so it stays code-split and unit-testable
 * against a plain test double.
 */

// ── Injected three.js surface (structural — no `three` import) ─────────────

export interface Box3Like {
  min: { y: number };
  max: { y: number };
  setFromObject(object: unknown): Box3Like;
}

export interface ThreeLike {
  Box3: new () => Box3Like;
}

/** The subset of an Object3D this module reads/mutates. */
export interface MeshNodeLike {
  name?: string;
  isMesh?: boolean;
  parent?: { remove(child: unknown): unknown } | null;
  geometry?: { dispose?: () => void } | null;
  traverse(callback: (node: MeshNodeLike) => void): void;
  updateMatrixWorld?(force?: boolean): void;
}

// ── Label meshes (NAME-based, on purpose) ─────────────────────────────────

/**
 * Node names that mark a mesh as a baked-in label/logo, not furniture. Matched on
 * a word boundary (so "label"/"logo"/… as a token), plus the "_pb" export suffix
 * (a legacy dealer-export convention — kept in the default because real files in
 * the wild still carry it).
 */
export const LABEL_MESH_NAME = /(^|[\s_.-])(label|logo|text|decal|watermark|sticker|nameplate|badge|caption)([\s_.-]|$)|_pb$/i;

/**
 * Is this node name a baked-in label/logo?
 *
 * NAME-based ON PURPOSE. A geometric "a flat/offset mesh is a label" rule kept
 * deleting REAL furniture: a table's TABLETOP is a flat slab, a bolster is a thin
 * panel, an ARM CUSHION is a small plate offset below the seat — all flat or
 * detached, none of them labels. There is no reliable shape signal that separates
 * those from a text plate, so we key off the NAME and never touch unlabelled
 * geometry. A true label mesh is named like one; real parts carry furniture names
 * (or none).
 *
 * The regex is a parameter so a collection with its own export convention can pass
 * its own; the default is the proven table above.
 */
export function isLabelMeshName(name: unknown, labelName: RegExp = LABEL_MESH_NAME): boolean {
  return labelName.test(String(name || ''));
}

/**
 * A GROUND-SHADOW plane: a DEGENERATE-FLAT mesh lying at the model's floor.
 * The pCon exports carry one (a ~10 cm decal strip at the footprint edge,
 * height 0.0) and it silently INFLATED every derived footprint — a settee's
 * tile measured 160×179 when its platform is 160×160, so two modules could
 * never join front-to-back ("won't let me join"). Deliberately far stricter
 * than any real part (the label lesson above: geometric stripping once deleted
 * tabletops): the mesh must be under 1% of the model's height thick AND start
 * in the bottom 2% — a bolster (≈18%) or a seat pad (≈10% tall) doesn't come
 * close. This is the ONE shape that CAN'T be furniture.
 *
 * Pure: takes {min,max} vertical extents in any unit.
 */
export function isGroundShadowBox(meshMinY: number, meshMaxY: number, objMinY: number, objMaxY: number): boolean {
  const H = objMaxY - objMinY;
  if (!(H > 0)) return false;
  const h = Math.max(0, meshMaxY - meshMinY);
  return h / H < 0.01 && (meshMinY - objMinY) / H < 0.02;
}

// ── Strippers ─────────────────────────────────────────────────────────────

export interface StripLabelOptions {
  /** Name classifier regex; default `LABEL_MESH_NAME`. */
  labelName?: RegExp;
}

/**
 * Strip label meshes from `object`, in place, BY NAME. `THREE` is accepted for
 * call-site symmetry but unused. Idempotent; never strips everything (a file whose
 * every mesh reads as a label is a naming convention we don't understand, not a
 * file of labels).
 *
 * @returns the number of label meshes removed.
 */
export function stripLabelMeshes(
  THREE: ThreeLike | null | undefined,
  object: MeshNodeLike | null | undefined,
  opts: StripLabelOptions = {},
): number {
  if (!object) return 0;
  const labelName = opts.labelName ?? LABEL_MESH_NAME;
  const meshes: MeshNodeLike[] = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const labels = meshes.filter((m) => isLabelMeshName(m.name, labelName));
  if (!labels.length || labels.length >= meshes.length) return 0;   // never strip all

  for (const m of labels) {
    m.parent?.remove(m);
    m.geometry?.dispose?.();
  }
  return labels.length;
}

export interface StripShadowOptions {
  /**
   * Shape classifier; default `isGroundShadowBox`. Deliberately NOT a name regex —
   * shadow decals are named like anything, and the near-degenerate box is the one
   * signal that can't be real furniture.
   */
  isShadow?: (meshMinY: number, meshMaxY: number, objMinY: number, objMaxY: number) => boolean;
}

/**
 * Strip ground-shadow planes from `object`, in place — the flat decals that
 * inflated every derived footprint (plan, tile, 3D fit) AND rendered as a
 * fabric-coloured patch on the floor once upholstered. Idempotent; never strips
 * everything.
 *
 * @returns the number of shadow meshes removed.
 */
export function stripShadowMeshes(
  THREE: ThreeLike,
  object: MeshNodeLike | null | undefined,
  opts: StripShadowOptions = {},
): number {
  if (!object) return 0;
  const isShadow = opts.isShadow ?? isGroundShadowBox;
  object.updateMatrixWorld?.(true);
  const objBox = new THREE.Box3().setFromObject(object);
  if (!Number.isFinite(objBox.min.y)) return 0;
  const meshes: MeshNodeLike[] = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const shadows = meshes.filter((m) => {
    const b = new THREE.Box3().setFromObject(m);
    return Number.isFinite(b.min.y) && isShadow(b.min.y, b.max.y, objBox.min.y, objBox.max.y);
  });
  if (!shadows.length || shadows.length >= meshes.length) return 0;   // never strip all

  for (const m of shadows) {
    m.parent?.remove(m);
    m.geometry?.dispose?.();
  }
  return shadows.length;
}

export interface CleanMeshNodesResult {
  labels: number;
  shadows: number;
  removed: number;
}

export type CleanMeshNodesOptions = StripLabelOptions & StripShadowOptions;

/**
 * Both strippers, in the order every loader applies them: labels first (a clean
 * footprint + render), then ground shadows. Idempotent — running it twice on the
 * same tree removes nothing the second time.
 */
export function cleanMeshNodes(
  THREE: ThreeLike,
  object: MeshNodeLike | null | undefined,
  opts: CleanMeshNodesOptions = {},
): CleanMeshNodesResult {
  const labels = stripLabelMeshes(THREE, object, opts);
  const shadows = stripShadowMeshes(THREE, object, opts);
  return { labels, shadows, removed: labels + shadows };
}
