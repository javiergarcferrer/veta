/**
 * Strip baked-in LABEL meshes from a loaded model, in place — BY NAME, not by
 * shape. Some dealer exports carry a flat text/logo mesh (e.g. "Togo_pb") beside
 * the furniture; it pollutes the top-down silhouette AND inflates the measured
 * footprint (the "text + white space below the model" artifact). We can't edit the
 * uploaded file, so we drop the labelled meshes after load.
 *
 * NAME-based ON PURPOSE. A geometric "a flat/offset mesh is a label" rule kept
 * deleting REAL furniture: a table's TABLETOP is a flat slab, a Prado BOLSTER is a
 * thin panel, an ARM CUSHION is a small plate offset below the seat — all flat or
 * detached, none of them labels. There is no reliable shape signal that separates
 * those from a text plate, so we key off the NAME and never touch unlabelled
 * geometry. A true label mesh is named like one; real parts carry furniture names
 * (or none). `three` is accepted for call-site symmetry but unused. Idempotent.
 *
 * @returns the number of label meshes removed.
 */

// Node names that mark a mesh as a baked-in label/logo, not furniture. Matched on
// a word boundary (so "label"/"logo"/… as a token), plus the "_pb" export suffix.
const LABEL_NAME = /(^|[\s_.-])(label|logo|text|decal|watermark|sticker|nameplate|badge|caption)([\s_.-]|$)|_pb$/i;

export function stripLabelMeshes(THREE, object) {
  if (!object) return 0;
  const meshes = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const labels = meshes.filter((m) => LABEL_NAME.test(String(m.name || '')));
  if (!labels.length || labels.length >= meshes.length) return 0;   // never strip all

  for (const m of labels) {
    m.parent?.remove(m);
    m.geometry?.dispose?.();
  }
  return labels.length;
}

/**
 * Strip pCon GROUND-SHADOW planes, in place — degenerate-FLAT meshes lying at
 * the model's floor (the Prado exports carry a ~0 cm-thick decal strip at the
 * footprint edge). They inflated every derived footprint (plan, tile, 3D fit)
 * AND rendered as a fabric-coloured patch on the floor once upholstered. The
 * predicate (isGroundShadowBox) is deliberately near-degenerate-only, so real
 * flat parts (tabletops, bolster panels, seat pads) never match — the lesson
 * baked into stripLabelMeshes' name-only rule still holds; this is the one
 * shape that CAN'T be furniture. Idempotent; never strips everything.
 *
 * @returns the number of shadow meshes removed.
 */
import { isGroundShadowBox } from './meshParts.js';

export function stripShadowMeshes(THREE, object) {
  if (!object) return 0;
  object.updateMatrixWorld(true);
  const objBox = new THREE.Box3().setFromObject(object);
  if (!Number.isFinite(objBox.min.y)) return 0;
  const meshes = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const shadows = meshes.filter((m) => {
    const b = new THREE.Box3().setFromObject(m);
    return Number.isFinite(b.min.y) && isGroundShadowBox(b.min.y, b.max.y, objBox.min.y, objBox.max.y);
  });
  if (!shadows.length || shadows.length >= meshes.length) return 0;   // never strip all

  for (const m of shadows) {
    m.parent?.remove(m);
    m.geometry?.dispose?.();
  }
  return shadows.length;
}
