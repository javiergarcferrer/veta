/**
 * Mesh PART model — the pure rules behind per-part fabric editing.
 *
 * A structured module (Prado…) is not one price: the BASE (platform/frame) has
 * its own SKU per model, while the loose parts — seat/back CUSHIONS, BOLSTERS,
 * ARM CUSHIONS — are identical shared SKUs reused across every base in the
 * collection. The 3D export mirrors that: each part type is a separate mesh
 * node carrying a stable MATERIAL id (a pCon UUID shared across models), while
 * node NAMES don't exist at all. So parts are keyed by material name, with a
 * "#<nodeIndex>" fallback for unnamed materials.
 *
 * `togo_models.parts` (jsonb) stores the dealer-confirmed tagging:
 *   { mats:   { "<materialName>": role, ... },
 *     roots:  { cushion: "<productRoot>", bolster: "...", armCushion: "..." },
 *     counts: { cushion: 2, ... } }            // billed units; default = node count
 *
 * Everything here is a pure function of plain data (no three.js, no React), so
 * the classifier, the pricing roll-up, and the payload sanitizer share ONE rule
 * set and are unit-testable.
 */

// The slot KINDS and the three role lists they derive from live in their own
// module (`./partKinds.js`) — `meshParts.js` is a size-ledger file, and the Deno
// side already keeps them in one place too. Re-exported here so every existing
// consumer of these names is untouched.
export {
  PART_KINDS, PART_ROLES, MATERIALIZATION_ROLES, UNPRICED_ROLES, BILLED_ROLES,
  partKind, rolesOfKind, billsMoney, takesMaterial,
} from './partKinds.js';
import { BILLED_ROLES, PART_ROLES, UNPRICED_ROLES } from './partKinds.js';





/** Spanish labels the pickers/chips render (the app copy is Spanish-first). */
export const PART_LABELS = {
  // «Cuerpo» — the trade word for the upholstered shell. The role key stays
  // `base` (it is the money rule's own name: base SKU + componentes), only what
  // the dealer READS changes: «Base» named the same thing as the metal bases
  // the estructura rows offer, so the two vocabularies collided on screen. A
  // dealer's own studio label (roleLabelOf) still outranks this.
  base: 'Cuerpo',
  structure: 'Estructura',
  exterior: 'Exterior',
  interior: 'Interior',
  cushion: 'Cojín',
  bolster: 'Rulo',
  armCushion: 'Cojín de brazo',
};

/** The stable part key for a mesh node: its source material name, else a
 *  positional fallback. `materialName` is read BEFORE the fabric material
 *  replaces it (loaders preserve the export's material names). */
export function partKeyFor(materialName, nodeIndex) {
  const n = (materialName == null ? '' : String(materialName)).trim();
  return n || `#${Number(nodeIndex) || 0}`;
}

/** The role a mesh node plays, from the dealer-confirmed map. Untagged (or no
 *  map at all) reads as 'base' — the whole piece behaves exactly as before the
 *  parts feature existed.
 *
 *  `partKey` is the node's key from `partKeysFor` (which can be a SPLIT key like
 *  "Fabric~2"); without one it falls back to the plain material key. A split
 *  cluster with no tag of its own INHERITS its material's tag: every model
 *  tagged before parts could split keeps behaving exactly as it did, and the
 *  dealer only has to touch the cluster they want to say something different
 *  about. */
export function partRoleFor(parts, materialName, nodeIndex, partKey) {
  const mats = parts?.mats || {};
  const key = partKey || partKeyFor(materialName, nodeIndex);
  if (PART_ROLES.includes(mats[key])) return mats[key];
  const base = baseKeyOf(key);
  if (base !== key && PART_ROLES.includes(mats[base])) return mats[base];
  return 'base';
}

/** The material key a (possibly split) part key belongs to — "Fabric~2" →
 *  "Fabric". Only a trailing `~<digits>` counts, so a material genuinely named
 *  with a tilde is left alone. */
export function baseKeyOf(partKey) {
  const s = String(partKey || '');
  const m = /^(.*)~\d+$/.exec(s);
  return m ? m[1] : s;
}

/** Whether a model has any non-base tagging (drives the part-editing UI). */
export function hasParts(parts) {
  return Object.values(parts?.mats || {}).some((r) => PART_ROLES.includes(r) && r !== 'base');
}

/**
 * The role a standalone ACCESSORY MODEL plays, from its name — the dealer
 * uploads the loose parts as their own models ("Back Cushion", "Bolster",
 * "Cojín de brazo"…), and those become the REFERENCE FINGERPRINTS the sofa
 * tagger matches against. Name keywords in both languages; null when the
 * model isn't a recognizable accessory (a sofa, an ottoman, a table).
 */
export function accessoryRoleFor(name) {
  const s = (name == null ? '' : String(name)).toLowerCase();
  if (/(arm|brazo)/.test(s) && /(cushion|coj[ií]n)/.test(s)) return 'armCushion';
  if (/(bolster|rulo|cilindro)/.test(s)) return 'bolster';
  if (/(cushion|coj[ií]n)/.test(s)) return 'cushion';
  return null;
}

/**
 * Two boxes read as THE SAME PART when every extent agrees within `tol` —
 * horizontal extents compared orientation-free (sorted), height apart.
 *
 * TWO JOBS, TWO TOLERANCES, and they are not the same question:
 *
 *   ACROSS FILES (the default 20%, `classifyPartGroups` fingerprints) matches a
 *   sofa's group against a SEPARATELY MODELLED loose accessory — different
 *   export, different modeller, so it needs real slack.
 *
 *   INSIDE ONE FILE (`SAME_PART_TOL`, `partKeysFor`) asks whether two nodes of
 *   ONE material are the same part TYPE. Those are near-identical by
 *   construction — three back cushions are instanced copies, within a couple of
 *   percent — so 20% is far looser than the question needs, and the slack is
 *   what fused a base into its own seat cushion: measured on EXCLUSIF Lounge
 *   NoArm, whose M1 (base) and M5 (cushion) share material COL0 and sit within
 *   17% on height and 10% on depth, so ±20% called them one part and no dealer
 *   could ever separate them.
 *
 * WHY TIGHTEN RATHER THAN LOOSEN: over-splitting is RECOVERABLE and
 * under-splitting is not. A split cluster with no tag of its own inherits its
 * material's tag (`partRoleFor`), so an extra cluster changes nothing about how
 * an already-tagged model reads — it only hands the dealer a part they may now
 * name. Two bodies merged into one averaged box can never be told apart again.
 */
const SAME_PART_TOL = 0.10;

function sizeMatches(a, b, tol = 0.2) {
  const close = (x, y) => {
    const m = Math.max(Math.abs(x), Math.abs(y));
    return m < 1e-6 || Math.abs(x - y) / m <= tol;
  };
  const [aw, ad] = [Math.max(a[0], a[2]), Math.min(a[0], a[2])];
  const [bw, bd] = [Math.max(b[0], b[2]), Math.min(b[0], b[2])];
  return close(aw, bw) && close(ad, bd) && close(a[1], b[1]);
}

/**
 * CONGRUENCE — are two bodies THE SAME SHAPE, moved?
 *
 * `partKeysFor` has to answer one question: do these two nodes, which share a
 * material, show the same PART TYPE? The exact statement of "same part" is
 * CONGRUENT — related by a rigid motion (rotation + translation, and a mirror
 * for a left/right pair). So the test is a congruence invariant, not a
 * resemblance score:
 *
 *   nV, nT   vertex and triangle counts — combinatorial, and identical for
 *            instanced copies because they ARE one mesh drawn twice.
 *   A        surface area, Σ½|(b−a)×(c−a)| — invariant under any isometry.
 *   V        enclosed volume, Σ a·(b×c)/6 (divergence theorem) — same, and
 *            |V| so a mirrored copy still matches its twin.
 *
 * Rounded to 6 significant figures, which absorbs float noise while keeping two
 * genuinely different bodies apart: EXCLUSIF Lounge NoArm's base and its seat
 * cushion share material COL0 and are 14985v/58958t vs 3936v/16152t — the
 * counts alone separate them, and no tolerance has to be guessed.
 *
 * WHY THIS REPLACED A BOUNDING-BOX SCORE: a box is a projection, and two
 * different bodies can share one. Those two are within 17% on every extent, so
 * ANY threshold loose enough to group real instanced cushions also fused a base
 * into its own cushion. Congruence has no such overlap — it asks the question
 * that was actually meant.
 *
 * Pure over flat arrays, so the studio and the stage compute the same signature
 * from the same geometry. Returns '' when there is nothing to measure, which
 * reads as "unknown" and falls back to the box comparison below.
 */
export function bodySignature(positions, indices) {
  const pos = positions;
  if (!pos || !pos.length) return '';
  const idx = indices && indices.length ? indices : null;
  const nT = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
  if (!nT) return '';
  const nV = Math.floor(pos.length / 3);
  let A = 0, V6 = 0;
  const ax = [0, 0, 0], bx = [0, 0, 0], cx = [0, 0, 0];
  for (let t = 0; t < nT; t += 1) {
    const i0 = (idx ? idx[t * 3] : t * 3) * 3;
    const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3;
    const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3;
    for (let k = 0; k < 3; k += 1) { ax[k] = pos[i0 + k]; bx[k] = pos[i1 + k]; cx[k] = pos[i2 + k]; }
    const ux = bx[0] - ax[0], uy = bx[1] - ax[1], uz = bx[2] - ax[2];
    const vx = cx[0] - ax[0], vy = cx[1] - ax[1], vz = cx[2] - ax[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    A += Math.hypot(nx, ny, nz);                       // ×2, constant factor — invariant either way
    V6 += ax[0] * (bx[1] * cx[2] - bx[2] * cx[1])
      + ax[1] * (bx[2] * cx[0] - bx[0] * cx[2])
      + ax[2] * (bx[0] * cx[1] - bx[1] * cx[0]);
  }
  const sig = (x) => (Number.isFinite(x) ? Number(x).toPrecision(6) : '0');
  return `${nV}:${nT}:${sig(A / 2)}:${sig(Math.abs(V6) / 6)}`;
}

/**
 * The part key for every mesh node of a model, in traversal order.
 *
 * A key was the material name alone, which assumes pCon gives each PART TYPE its
 * own material. It usually does — and when it does this function is a no-op. But
 * some exports upholster the back cushions and the bolster in ONE material, and
 * then every rule downstream is reasoning about a single box merged from both:
 * a slab and a roll averaged into a shape that is neither, so the two can never
 * be told apart and can never be tagged, priced or re-covered separately.
 *
 * So a material splits into CLUSTERS BY CONGRUENCE (`bodySignature`): same
 * shape moved = same part type, anything else = its own part. That is the exact
 * form of the question, so it needs no threshold — three instanced back
 * cushions share a signature to the last digit, while a base and the cushion
 * lying on it do not (different vertex counts, different area, different
 * volume) even when their bounding boxes agree within 17%, which is what used
 * to fuse them.
 *
 * The BOX comparison survives only as the fallback for a node whose geometry
 * this layer never saw (an old caller passing `size` alone) — same behaviour as
 * before for those, and no silent change for callers that do supply geometry.
 *
 * Cluster order is order of first appearance, and the FIRST cluster keeps the
 * bare material name — so every already-tagged model reads exactly as it did,
 * and `partRoleFor` lets later clusters inherit that tag until the dealer says
 * otherwise. `nodes` is `[{ materialName, signature?, size? }]` in traversal
 * order; a node with neither joins the first cluster.
 */
export function partKeysFor(nodes) {
  const reps = new Map();          // material key → [{ sig, size } per cluster]
  return (nodes || []).map((n, i) => {
    const base = partKeyFor(n?.materialName, i);
    let list = reps.get(base);
    if (!list) { list = []; reps.set(base, list); }
    const sig = typeof n?.signature === 'string' && n.signature ? n.signature : null;
    const size = Array.isArray(n?.size) && n.size.length === 3 ? n.size : null;
    if (!sig && !size) { if (!list.length) list.push({ sig: null, size: null }); return base; }
    // Congruence when both sides know their geometry — exact, no tolerance.
    // Otherwise the historical box comparison, so a caller that never had a
    // signature keeps its old clustering.
    let at = list.findIndex((r) => (
      sig && r.sig ? r.sig === sig
        : (size && r.size ? sizeMatches(size, r.size, SAME_PART_TOL) : false)
    ));
    if (at < 0) { list.push({ sig, size }); at = list.length - 1; }
    return at === 0 ? base : `${base}~${at + 1}`;
  });
}

/**
 * How close to the floor a PLINTH sits, as a share of the model's height, and
 * how tall it may be before it stops being one. Measured on the dealer's
 * hand-tagged Prado: every plinth starts within 0% of the floor and stands
 * 1–8 cm under a 40–86 cm piece (2–20% of the height). The band doubles as the
 * seam tolerance for "the body rests on it" — the two surfaces touch, so the
 * carried group's bottom is allowed to sit a hair below the plinth's top.
 *
 * 0.25 leaves headroom over the measured 0.20 worst case (the Rectangular
 * Ottoman's foot block) without reaching the upholstered bodies, which are
 * 37–44% of their model's height — there is no real part between the two, so
 * the threshold sits in open space rather than on a boundary.
 */
const PLINTH_FLOOR_BAND = 0.05;
const PLINTH_MAX_HEIGHT = 0.25;

/**
 * Pre-classification for the admin tagger — PROPOSES a role per part group;
 * the dealer confirms/overrides, and only the confirmed map is stored. Given
 * `groups`: [{ key, min:[x,y,z], max:[x,y,z] }] for the whole model (one
 * entry per part group, boxes merged per material), returns { [key]: role }.
 *
 * `refs` are FINGERPRINTS, from two sources that answer with different
 * authority — `[{ role, sig?, matKeys?: [names…], size?: [w,h,d] cm }]`:
 *
 *   • CONFIRMED SIBLINGS of the collection (partFingerprints.buildPartRefs)
 *     carry `sig`, the `bodySignature` congruence of a group the dealer already
 *     named. Exact identity, no threshold, and it outranks EVERY rule below —
 *     an answer the dealer gave is not up for debate with an aspect ratio.
 *     They deliberately carry NO `matKeys`: measured on the live catalog, a
 *     material name is not a part identity (`COL0` is tagged base, bolster AND
 *     structure across three EXCLUSIF models), so transferring by material
 *     would write the wrong role in silence.
 *   • STANDALONE ACCESSORY models (the loose Back Cushion / Bolster / Arm
 *     Cushion uploads) carry `matKeys` and `size`. Here the material IS
 *     identity — pCon reuses one id per part type — so a sofa group sharing the
 *     loose cushion's material IS that cushion; a group matching its SIZE
 *     (±20%, rotation-free) is next.
 *
 * The base rule still runs first: a platform can never be an accessory.
 *
 * Heuristic rules (when no fingerprint decides):
 *   • base — every group whose bottom sits in the lowest quarter of the model
 *     AND whose footprint covers ≥ 40% of the total footprint (the platform).
 *     At least the largest-footprint group is always base.
 *   • structure — the PLINTH: rests on the floor, is thin, and carries a wider
 *     body above it. See PLINTH_* below — this is the one role the classifier
 *     could not reach, and the one the dealer reaches for most.
 *   • armCushion — sits ABOVE the base top and hugs a lateral (x) extreme
 *     (its x-span ≤ 30% of total width, touching either side).
 *   • bolster — elongated roll: horizontal aspect ≥ 2.5 between its two floor
 *     axes, and thin (height ≤ 60% of its shorter floor axis × 2).
 *   • cushion — everything else above the base.
 */
export function classifyPartGroups(groups, refs = []) {
  const list = (groups || []).filter((g) => g && g.min && g.max);
  if (!list.length) return {};
  const uMin = [Infinity, Infinity, Infinity], uMax = [-Infinity, -Infinity, -Infinity];
  for (const g of list) for (let a = 0; a < 3; a++) {
    uMin[a] = Math.min(uMin[a], g.min[a]); uMax[a] = Math.max(uMax[a], g.max[a]);
  }
  const totalW = uMax[0] - uMin[0], totalH = uMax[1] - uMin[1], totalD = uMax[2] - uMin[2];
  const footprint = (g) => Math.max(0, g.max[0] - g.min[0]) * Math.max(0, g.max[2] - g.min[2]);
  const totalFp = Math.max(1e-6, totalW * totalD);

  const out = {};
  let baseTop = uMin[1];
  let largest = null;

  // ── LO YA RESPONDIDO, ANTES QUE NADA. A `sig` ref comes from a sibling the
  // dealer already confirmed (partFingerprints.buildPartRefs), and
  // `bodySignature` is exact congruence — the same mesh, moved — so a match is
  // identity, not resemblance. It runs FIRST and nothing below may overwrite
  // it: every rule after this is a guess, and a guess never outranks an answer.
  // (Contradictory fingerprints never reach here — buildPartRefs drops and
  // reports them, so a match is unambiguous by construction.)
  const taught = new Set();
  for (const g of list) {
    if (!g.sig) continue;
    const ref = refs.find((r) => r.sig && r.sig === g.sig);
    if (!ref || !PART_ROLES.includes(ref.role)) continue;
    out[g.key] = ref.role;
    taught.add(g.key);
    if (ref.role === 'base') baseTop = Math.max(baseTop, g.max[1]);
  }

  for (const g of list) {
    if (taught.has(g.key)) continue;
    const isLow = g.min[1] <= uMin[1] + totalH * 0.25;
    if (isLow && footprint(g) >= totalFp * 0.4) {
      out[g.key] = 'base';
      baseTop = Math.max(baseTop, g.max[1]);
    }
    if (!largest || footprint(g) > footprint(largest)) largest = g;
  }
  // A model is never all-cushions: the biggest footprint anchors as base.
  if (largest && !Object.values(out).includes('base')) {
    out[largest.key] = 'base';
    baseTop = largest.max[1];
  }

  // MATERIALIZATION pair (the Prado ottomans): nothing rides ABOVE the body —
  // the only untagged group(s) are a recessed PLINTH strictly UNDER it (the
  // measured ottoman GLBs: body 8..41 cm, plinth 0..8 cm). That's not a
  // cushion to bill; it's the second fabric ZONE of the same SKU
  // (mono/bicolor): the body proposes as EXTERIOR, the plinth as INTERIOR.
  // A sofa never matches — its cushions/bolsters sit above the platform.
  //
  // SKIPPED ENTIRELY once anything was TAUGHT. This branch is all-or-nothing —
  // it rewrites EVERY key on the model — so it cannot coexist with a partial
  // answer from the dealer without overwriting it. Measured: the High Table's
  // mid-air stretcher, taught as `structure` from a sibling, came back
  // `interior` because this fired first and re-labelled the whole piece.
  if (!taught.size) {
    const rest = list.filter((g) => !out[g.key]);
    const baseBottom = Math.min(...list.filter((g) => out[g.key] === 'base').map((g) => g.min[1]));
    if (rest.length && rest.every((g) => g.max[1] <= baseBottom + totalH * 0.05)) {
      for (const g of list) out[g.key] = out[g.key] === 'base' ? 'exterior' : 'interior';
      return out;
    }
  }

  for (const g of list) {
    if (out[g.key]) continue;
    const w = g.max[0] - g.min[0], h = g.max[1] - g.min[1], d = g.max[2] - g.min[2];
    // FINGERPRINTS first — a shared material id is IDENTITY (pCon reuses one
    // per part type across the collection), a matching size is next.
    //
    // Except on a SPLIT cluster (partKeysFor): its material is shared with
    // another part type on this very model — that is what made it split — so the
    // material cannot say which type THIS cluster is, and taking it would hand
    // the bolster the cushion's role and undo the split. Its shape is the only
    // honest signal it has, so it skips straight to the size fingerprint.
    const split = baseKeyOf(g.key) !== g.key;
    if (!split) {
      const byMat = refs.find((ref) => (ref.matKeys || []).includes(g.key));
      if (byMat && PART_ROLES.includes(byMat.role)) { out[g.key] = byMat.role; continue; }
    }
    // THE PLINTH IS ESTRUCTURA, NOT A ROLL — and it is the reason the machine
    // proposed to CHARGE for sofa frames. `structure` was unreachable from
    // here (the emitted vocabulary was base/cushion/bolster/armCushion, and a
    // ref can only carry what accessoryRoleFor names), so every plinth fell
    // through to `bolster`: measured across the dealer's own hand-tagged Prado,
    // that ONE gap was 8 of 12 disagreements. It is a money error in the worst
    // direction — `structure` is UNPRICED (patas, marcos, bases: a finish
    // choice that never changes the price) while bolster/cushion BILL, so the
    // proposal added a phantom part SKU to a piece that has none.
    //
    // The signature is positional, not shaped, which is why no aspect rule
    // could ever have caught it: measured on the five real plinths (Large Sofa
    // 187×8×54, Settee 87×8×110, Medium Sofa 120 148×8×53, Rectangular Ottoman
    // 72×1×62, Small Square Ottoman 52×1×62) each RESTS ON THE FLOOR, is THIN,
    // and CARRIES a wider body above it. Their footprints are 32–37% — just
    // under the 40% that makes a platform `base`, which is precisely how they
    // reached the bolster rule (187/54 = 3.5 is "elongated" on any reading).
    //
    // All three clauses are load-bearing. Without "rests on the floor" a seat
    // pad qualifies; without "thin" the upholstered body itself does; without
    // "carries something wider" a lone accessory model — one group that IS the
    // whole piece — reads as its own plinth. A real platform never reaches
    // here at all: the base rule claimed it above.
    const restsOnFloor = g.min[1] <= uMin[1] + totalH * PLINTH_FLOOR_BAND;
    const carries = list.some((o) => o !== g
      && o.min[1] >= g.max[1] - totalH * PLINTH_FLOOR_BAND
      && footprint(o) > footprint(g));
    if (restsOnFloor && h <= totalH * PLINTH_MAX_HEIGHT && carries) { out[g.key] = 'structure'; continue; }
    const bySize = refs.find((ref) => Array.isArray(ref.size) && sizeMatches([w, h, d], ref.size));
    if (bySize && PART_ROLES.includes(bySize.role)) { out[g.key] = bySize.role; continue; }
    const atSide = (g.min[0] <= uMin[0] + totalW * 0.05 || g.max[0] >= uMax[0] - totalW * 0.05);
    if (atSide && w <= totalW * 0.3) { out[g.key] = 'armCushion'; continue; }
    const [long, short] = w >= d ? [w, d] : [d, w];
    // A bolster is elongated AND SMALL: a roll's cross-section is a fraction of
    // the sofa. Elongation alone misfiled the dealer's real Prado Medium 120 —
    // its three back cushions export FUSED as one 174×66×50 slab, which is
    // "elongated" too (174/66 ≥ 2.5), so cushions and rulo both proposed as
    // rulo: the exact "not detecting them separately" report. Height does the
    // telling: the real rulo is 16 cm in an 87 cm sofa (18%), the cushion slab
    // 50 cm (57%). A rulo never reaches a third of the piece's height.
    const bolsterish = short > 0 && long / short >= 2.5 && h <= short * 1.2 && h <= totalH * 0.35;
    if (bolsterish) { out[g.key] = 'bolster'; continue; }
    out[g.key] = 'cushion';
  }
  return out;
}

/**
 * The CEILING on a typed billed count.
 *
 * `counts` is the one dealer-typed number that rides straight into a quote as a
 * QUANTITY, and nothing between the keyboard and the total questioned it: a
 * fat-fingered 100000 in the studio's «Se cobra ×» box multiplied the part SKU's
 * price by 100000 (a measured $30,004,800 on an ordinary bicolor build) and the
 * auto-quote path would have SENT that to the client.
 *
 * 20 because the catalog sells cushions and rulos as singles or as juegos de
 * 2/3 — a module's honest range is 0–3, and even a long sectional's loose parts
 * never approach twenty. The ceiling is deliberately far above anything real and
 * still far below anything ruinous: it can only ever catch a typo.
 */
export const COUNT_MAX = 20;

/**
 * BILLED units of a role's bound SKU. The catalog sells cushions/bolsters as
 * SINGLES or as SETS ("juego de 2/3"): the dealer binds the set SKU that
 * matches the module (a medium sofa's two back cushions → the set-of-2 SKU),
 * so a tagged role bills ONCE by default — the set already covers every
 * physical cushion. `counts[role]` overrides when needed (2 × a single SKU
 * when no set exists); an explicit 0 disables billing for the role.
 */
export function partCount(parts, role) {
  // The price-neutral roles NEVER bill — a zone is already inside the base SKU,
  // a structure is a finish on metal (UNPRICED_ROLES). Guarded here, at the one
  // gate every price path crosses, so even a stray bound root or a typed count
  // can't charge for either.
  if (UNPRICED_ROLES.includes(role)) return 0;
  const explicit = Number(parts?.counts?.[role]);
  // OUT OF RANGE FALLS BACK — it does not saturate. That is the idiom a NEGATIVE
  // count has always had here (`explicit >= 0` fails ⇒ the mesh-derived default),
  // and the ceiling joins it rather than inventing a second behaviour. Falling
  // back is also the safe direction for money: a garbage count then bills the ONE
  // set SKU the tagging implies, where saturating would bill twenty of them and
  // read on the quote as a deliberate quantity nobody typed.
  if (Number.isFinite(explicit) && explicit >= 0) {
    const n = Math.round(explicit);
    if (n <= COUNT_MAX) return n;
  }
  return Object.values(parts?.mats || {}).some((r) => r === role) ? 1 : 0;
}

/** PHYSICAL parts of a role on the model — how many tagged mesh groups carry
 *  it ("2 cojines en el modelo"). Display/admin only; billing is partCount. */
export function partMeshCount(parts, role) {
  return Object.values(parts?.mats || {}).filter((r) => r === role).length;
}

/**
 * Price roll-up for one placed piece:
 *   base unit price (already grade-resolved by the caller, like today)
 * + Σ over non-base roles present: partCount × the part SKU's price at the
 *   part's OWN picked grade (partPrices[role] — null when unpicked/unbound).
 * Pure: `partPrices` = { role: unitPrice|null }. Returns null only when the
 * base itself is unpriced (same contract the single-price flow has).
 *
 * An UNPRICED role (zone, structure) contributes nothing even if a caller hands
 * one a price: its partCount is 0, so the multiplication is the guard.
 */
export function piecePartsTotal(baseUnitPrice, parts, partPrices) {
  if (baseUnitPrice == null) return null;
  let total = Number(baseUnitPrice) || 0;
  for (const role of PART_ROLES) {
    if (role === 'base') continue;
    const unit = partPrices?.[role];
    if (unit == null) continue;
    total += (Number(unit) || 0) * partCount(parts, role);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Sanitize a lead payload's per-part fabric picks (server + client share the
 * shape): keep only known non-base roles, each trimmed to {grade, fabric,
 * code}. Returns null when nothing survives — the item then omits the field.
 *
 * A STRUCTURE is dropped like `base`: it wears a finish, not cloth, so a fabric
 * pick aimed at one is meaningless — its choice rides `partFinishes`
 * (sanitizePartFinishes). The ZONES are NOT dropped: a bicolor ottoman really
 * does pick a fabric per zone, it just re-grades the base SKU instead of
 * billing (materializedBase).
 */
export function sanitizePartMaterials(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const role of PART_ROLES) {
    if (role === 'base' || role === 'structure') continue;
    const m = raw[role];
    if (!m || typeof m !== 'object') continue;
    const grade = String(m.grade ?? '').slice(0, 8);
    const fabric = String(m.fabric ?? '').slice(0, 200);
    const code = String(m.code ?? '').slice(0, 32);
    if (grade || fabric) out[role] = { grade, fabric, code };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * ── ESTUDIO DE PARTES ──────────────────────────────────────────────────────
 * Three ADDITIVE keys on the same `togo_models.parts` jsonb — all optional, all
 * absent on every model tagged before the studio existed, so nothing below can
 * change what an untouched model renders:
 *
 *   labels:   { "<groupKey>": "Patas" }
 *   merges:   { "<childKey>": "<targetKey>" }
 *   finishes: { "<groupKey>": { label?, options: [{id,label,rgb,metal?,rough?}], default? } }
 *
 * MERGES exist because pCon decides what a "part" is and no heuristic can undo
 * a bad call: one export gives the two arm shells different material ids, and
 * `partKeysFor` can even SPLIT one material into clusters the dealer wants back
 * together. Instead of re-authoring the export, the dealer folds a child key
 * into a target and every surface reads the TARGET's identity — label, tag,
 * finish. LABELS are display only ("Patas" over a pCon UUID).
 *
 * FINISHES are the non-fabric materializations: the Prado platform's legs ship
 * in Acero or Acero lacado negro — same piece, same SKU, same price. So they
 * are a fixed PALETTE the dealer types once per model, and like the
 * exterior/interior zones they are PRICE-NEUTRAL BY CONSTRUCTION: a finish
 * binds no SKU root, never reaches partCount and never enters piecePartsTotal,
 * so no pick here can move a quote by a cent.
 *
 * The palette RENDERS on any group that carries one, but WHO CHOOSES is the
 * group's ROLE: a `structure` group offers its palette in the public
 * configurador (the client picks the acabado), while a `base` group's palette
 * is the dealer's alone — it still materializes the piece through its default
 * option, it is simply never offered. That gate lives at the surface that
 * offers it (ConfiguratorEmbed's openPartMaterial), never here: the scene keys finishes
 * by GROUP, not by role, so rendering is identical for both.
 */

/** The group a part key really belongs to, after following `merges`.
 *  The map is dealer-authored jsonb, so a chain can be hand-edited into a LOOP
 *  (a→b→a) and a naive walk would hang the render thread on a model the dealer
 *  can no longer open to fix it. We stop the moment we revisit a key and return
 *  the LAST SAFE one — always a real group, never a hang. No map, an empty
 *  target, or a key pointing at itself is the key itself. */
export function mergedKeyOf(parts, key) {
  const merges = parts?.merges;
  let cur = key == null ? '' : String(key);
  if (!cur || !merges || typeof merges !== 'object') return cur;
  const seen = new Set([cur]);
  for (;;) {                                   // bounded: `seen` grows every hop
    const raw = merges[cur];
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/** A dealer-authored jsonb sub-map, defensively: anything that isn't a plain
 *  object reads as empty, so a half-typed bag can never throw a spread. */
const bagOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const partsOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * `parts` with `key` RESOLVING to `role`, changing as little as it can.
 *
 * An UNTAGGED mesh is not the same thing as one tagged `base`: the scene builder
 * renders a factory-textured mesh as-is only while nothing claims it (an
 * explicit `base` OVERRIDES the walnut and puts fabric on it). So this touches
 * `mats[key]` in exactly two situations and leaves it alone otherwise:
 *
 *   • it ALREADY says `role` — untouched, not rewritten. Regrouping a key must
 *     not quietly strip a tag the dealer put there, or a join/separate round
 *     trip would repaint a factory-finished part;
 *   • it says something else — dropped, and re-written ONLY if the key would not
 *     land on `role` without it. A split island un-joined into its own material
 *     ("COL0~2" under "COL0") therefore comes out carrying NO tag at all, which
 *     is the exact state it had before anything split it and is what lets
 *     `partRoleFor`'s base-key inheritance go on answering for it. A key from a
 *     DIFFERENT material has nothing to inherit from, so it gets the tag —
 *     without it the role would fall back to `base`, a different fabric and, for
 *     a billed role, a different price.
 */
function settleRole(parts, key, role) {
  const src = partsOf(parts);
  if (bagOf(src.mats)[key] === role) return src;
  const mats = { ...bagOf(src.mats) };
  delete mats[key];
  const bare = { ...src, mats };
  if (partRoleFor(bare, null, -1, key) === role) return bare;
  return { ...bare, mats: { ...mats, [key]: role } };
}

/** Give back the `roots`/`counts` of every billed role in `vacated` that no key
 *  holds any more — the same rule the studio's slot writer applies, for the same
 *  money reason: a stale `counts.cushion` bills a part SKU on a model whose
 *  tagging no longer has a cushion at all. Roles still held are left alone. */
function releaseBilled(parts, vacated) {
  const held = new Set(Object.values(bagOf(parts?.mats)));
  const roots = { ...bagOf(parts?.roots) };
  const counts = { ...bagOf(parts?.counts) };
  for (const role of vacated) {
    if (!BILLED_ROLES.includes(role) || held.has(role)) continue;
    delete roots[role];
    delete counts[role];
  }
  return { ...partsOf(parts), roots, counts };
}

/**
 * ── JOIN — ONE GESTURE, TWO UNDERLYING CASES ───────────────────────────────
 *
 * "Une el cojín al armazón" is one thing to the dealer and two things to the
 * data, and that is exactly why he could not do it. pCon hands us MATERIAL
 * groups; `partKeysFor` then SPLITS a material whose meshes are different shapes
 * into islands ("COL0", "COL0~2", "COL0~3" — one material upholstering the frame
 * AND the seat cushions). So the two things a dealer points at can be:
 *
 *   • two different materials      → a MERGE  (`merges`, what this always did);
 *   • two islands of ONE material  → an UN-SPLIT (undoing `partKeysFor`) —
 *     which had no route at all: the join wrote `merges`, and `merges` moves a
 *     key's LABEL and its FINISH but never its ROLE, so the island stayed tagged
 *     `cushion`, kept rendering as a cushion and kept billing as one while the
 *     studio drew it folded in. The join looked like it did nothing.
 *
 * There is one operation now, and it produces ONE truth whichever case it was:
 *   1. every member points at the target in `merges` (chains flatten, and a
 *      target is never a child — that is what keeps `mergedKeyOf` loop-free);
 *   2. every member RESOLVES to the target's role (settleRole) — so the mesh
 *      renders, prices and counts as the target, not as what it used to be;
 *   3. the target's identity wins for `labels`/`finishes`, and a member's own is
 *      ADOPTED when the target has none. Either way the member's keys are
 *      REMOVED: a palette left on a key nothing renders is not merely dead, it
 *      keeps fanning itself out across the colección forever (`partKeysOf` reads
 *      `finishes` as evidence the model "has" that group).
 *   4. a billed role the join emptied gives back its `roots`/`counts`.
 *
 * Pure and whole-object; anything it doesn't touch rides through untouched. An
 * unusable target, an empty member list, or a bag of the wrong shape returns the
 * input unchanged rather than throwing — `parts` is dealer-authored jsonb.
 */
export function planPartJoin(parts, targetKey, memberKeys) {
  const src = partsOf(parts);
  const target = mergedKeyOf(src, targetKey);
  if (!target) return src;
  const members = [...new Set((memberKeys || [])
    .map((k) => (k == null ? '' : String(k)))
    .filter((k) => k && k !== target))];
  if (!members.length) return src;

  const role = partRoleFor(src, null, -1, target);
  const vacated = new Set(members.map((m) => bagOf(src.mats)[m]).filter(Boolean));

  const fold = new Set(members);
  const merges = { ...bagOf(src.merges) };
  for (const m of members) merges[m] = target;
  // Anything that pointed AT a member now points at the target: a two-hop chain
  // still resolves, but flattening it keeps the map readable and keeps a later
  // split from stranding a grandchild on a key that is no longer a group.
  for (const [k, v] of Object.entries(merges)) {
    if (k !== target && typeof v === 'string' && fold.has(v.trim())) merges[k] = target;
  }
  delete merges[target];

  const labels = { ...bagOf(src.labels) };
  const finishes = { ...bagOf(src.finishes) };
  for (const m of members) {
    if (m in labels) {
      if (!(target in labels)) labels[target] = labels[m];
      delete labels[m];
    }
    if (m in finishes) {
      if (!(target in finishes)) finishes[target] = finishes[m];
      delete finishes[m];
    }
  }

  let next = { ...src, merges, labels, finishes };
  for (const m of members) next = settleRole(next, m, role);
  return releaseBilled(next, vacated);
}

/**
 * ── SEPARATE — the same gesture, the other direction ───────────────────────
 *
 * The inverse of `planPartJoin`, and deliberately blind to how the member came
 * to be inside the group: a key the dealer folded in and a split island that was
 * only ever INHERITING its material's tag both come out as parts of their own.
 * That is the whole of "poder desagrupar lo que viene agrupado de fábrica" — the
 * dealer never has to know which of the two he is looking at.
 *
 *   • the merge entry is dropped, so the key is its own group again;
 *   • it KEEPS the role it was wearing (settleRole writes the tag only when the
 *     key wouldn't inherit it anyway) — separating a part must never silently
 *     re-file it as `base`, which is a different fabric and, for a billed role,
 *     a different price.
 *
 * What it CANNOT give back is a palette the join folded into the target: a
 * separated key comes out with no `finishes` of its own and takes the
 * colección's estructura (or the one-click starter) again. Nothing is lost that
 * the join didn't already say belonged to the target.
 *
 * A member key that IS the group (you cannot separate a group from itself) and
 * an unknown key are both no-ops.
 */
export function planPartSplit(parts, groupKey, memberKeys) {
  const src = partsOf(parts);
  const group = mergedKeyOf(src, groupKey);
  const members = [...new Set((memberKeys || [])
    .map((k) => (k == null ? '' : String(k)))
    .filter((k) => k && k !== group))];
  if (!members.length) return src;

  const role = partRoleFor(src, null, -1, group);
  const merges = { ...bagOf(src.merges) };
  for (const m of members) delete merges[m];
  let next = { ...src, merges };
  for (const m of members) next = settleRole(next, m, role);
  return next;
}

/** What a group is CALLED. The dealer's own label wins — read off the MERGED
 *  group, so a folded child never shows a name of its own — then the caller's
 *  fallback (the role label the pickers already render, PART_LABELS[role]),
 *  then the group key, which is at least the material name the export carried. */
export function partLabelOf(parts, key, fallback) {
  const group = mergedKeyOf(parts, key);
  const raw = parts?.labels?.[group];
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label) return label;
  const fb = fallback == null ? '' : String(fallback).trim();
  return fb || group;
}

/**
 * The name a ROLE wears on this model — the dealer's own word for it, else the
 * generic role label.
 *
 * The widget's part chips, its hover card and its Resumen all speak in roles
 * ("Cojín", "Cojín de brazo"), which are the app's taxonomy, not the dealer's
 * catalogue: a Prado's arm cushion is not called the same thing as a Kashima's,
 * and the customer reads the dealer's words. `labels` is already keyed by GROUP
 * KEY (that is what the Estudio edits), so this walks the tagging to find the
 * groups wearing `role` and takes the first LABELLED one, sorted so the answer
 * can't flip between reads when a role spans several groups. A merged child
 * wears its target's identity, exactly as everywhere else.
 *
 * `fallback` is the caller's localized role label — passed in rather than read
 * from PART_LABELS so the widget keeps answering in the visitor's language when
 * the dealer named nothing.
 */
export function roleLabelOf(parts, role, fallback) {
  const mats = parts?.mats || {};
  const named = Object.keys(mats)
    .filter((key) => partRoleFor(parts, null, -1, key) === role)
    .map((key) => mergedKeyOf(parts, key))
    .sort();
  for (const group of named) {
    const raw = parts?.labels?.[group];
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (label) return label;
  }
  const fb = fallback == null ? '' : String(fallback).trim();
  return fb || role;
}

const FINISH_HEX = /^#[0-9a-f]{6}$/i;

// A PBR 0–1 knob, only when one was really given: `Number(null)` is 0, so a
// coerce-everything read would hand the scene a hard metal:0 for a field the
// dealer simply left blank (the same trap that printed "$0.00/día" on ABO ads).
function finishUnit(v) {
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
export function finishSpecOf(parts, key) {
  const spec = parts?.finishes?.[mergedKeyOf(parts, key)];
  if (!spec || typeof spec !== 'object') return null;
  const options = [];
  const ids = new Set();
  for (const raw of Array.isArray(spec.options) ? spec.options : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const rgb = typeof raw.rgb === 'string' ? raw.rgb.trim() : '';
    if (!id || !label || !FINISH_HEX.test(rgb) || ids.has(id)) continue;
    ids.add(id);
    const opt = { id, label, rgb: rgb.toLowerCase() };
    const metal = finishUnit(raw.metal), rough = finishUnit(raw.rough);
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
 * THE CANONICAL ESTRUCTURA PALETTE — Ligne Roset's own pair for metal structure
 * (patas, marcos, bases): acero, and acero lacado negro. Both are metal, acero
 * is the default, and neither moves a price (a structure never bills).
 *
 * It exists because marking a group Estructura and DEFINING its palette were two
 * independent steps, and only the first had a control the dealer could find:
 * a group could save as `structure` with no `finishes` at all, which reads as a
 * finished choice in the Estudio and renders as NOTHING in the configurador
 * (`finishSpecOf` returns null ⇒ the group is dropped from the client's list).
 * So the role now arrives with this palette already on it, and the studio offers
 * it as one click wherever a structure lost its own.
 *
 * A FRESH object per call, deliberately: it is written straight into a parts
 * DRAFT and from there into a jsonb row, and a shared constant would alias into
 * every model that adopted it.
 */
export function structureStarterFinish() {
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
export function finishOptionOf(spec, optionId) {
  const options = Array.isArray(spec?.options) ? spec.options : [];
  if (!options.length) return null;
  const want = optionId == null ? '' : String(optionId).trim();
  return options.find((o) => o?.id === want)
    || options.find((o) => o?.id === spec.default)
    || options[0];
}

/**
 * THE STRUCTURE GROUPS A PIECE OFFERS — patas, marcos, bases: metal and lacquer.
 * A DIFFERENT AXIS from cloth and deliberately kept apart from it: same piece,
 * same SKU, same price whichever the client picks (UNPRICED_ROLES), so a finish
 * can never make a quote read "por partes".
 *
 * One entry per merged GROUP (four legs exported as four materials are ONE leg
 * group). `group` is both the key a picker opens with and the key the pick is
 * stored under — the scene reads `partFinishes[mergedGroupKey]` — so a group
 * whose merged key no longer reads as a structure is skipped rather than opening
 * the wrong picker, exactly like a group with no valid palette: neither is a
 * choice we can honestly offer.
 *
 * A GROUP WITH NO PALETTE IS NOT A CHOICE, which is exactly why the Estudio has
 * to say so: this returns nothing for it, the client sees nothing, and only the
 * dealer's screen can explain why (resolveStructureFinish).
 *
 * Sorted by key, so a piece with two structure groups lists them the same way on
 * every read — jsonb key order is not meaning.
 */
export function structureGroupsOf(parts) {
  const out = [];
  const seen = new Set();
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
 * WHICH structure group a tap means — the picker's half of the tap, and the
 * reason a tap on the legs can't dead-end in the fabric library.
 *
 * The stage stamps every mesh with its merged group key, but not every caller
 * has one: the 2D drag-end reports the ROLE alone, and so does the hover card's
 * edit button. And a key can be real yet palette-less — a SPLIT cluster
 * ("metal~2") exists in the mesh and inherits its material's Estructura tag long
 * before it exists in `parts`, so `finishSpecOf` answers null for it.
 *
 * Precedence, most specific first:
 *   1. the key itself, when it carries a palette;
 *   2. its BASE key — the same inheritance `partRoleFor` already grants a split
 *      cluster for its ROLE, now granted for its palette;
 *   3. the piece's ONE structure group, when it has exactly one — with a single
 *      answer there is nothing to guess;
 *   4. null. Several groups and no key names none of them, and picking the first
 *      would silently repaint a part the visitor never touched.
 */
export function structureGroupFor(parts, partKey) {
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
  return groups.length === 1 ? groups[0] : null;
}

/**
 * Sanitize a lead payload's per-part FINISH picks — the sibling of
 * sanitizePartMaterials, and like it the ONLY thing deciding what gets stored:
 * `{ [groupKey]: optionId }`, key trimmed to 64 chars (a pCon material name or
 * UUID fits with room to spare), id to 32, at most 12 groups — a model has a
 * handful of finish groups, and the cap is what stops a hand-crafted POST from
 * writing a novel into the lead. Excess is dropped by insertion order, so the
 * same payload always sanitizes to the same object. Null when nothing survives.
 */
export function sanitizePartFinishes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    // Counted by the object itself: two keys that collide once trimmed are one
    // group, and must not eat two of the twelve slots.
    if (Object.keys(out).length >= 12) break;
    const key = String(k).trim().slice(0, 64);
    const id = typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 32) : '';
    if (!key || !id) continue;
    out[key] = id;
  }
  return Object.keys(out).length ? out : null;
}

/** Mount facts for a model row: where a piece sits. Floor is the default;
 *  'seat' rows (standalone cushions/bolsters) ride at mountHeightCm and stay
 *  out of the plan's collision/magnet. */
export function mountOf(model) {
  const seat = model?.mount === 'seat';
  const h = Number(model?.mountHeightCm);
  return { seat, heightCm: seat ? (Number.isFinite(h) && h > 0 ? h : 40) : 0 };
}

/**
 * A pCon GROUND-SHADOW plane: a DEGENERATE-FLAT mesh lying at the model's floor.
 * The Prado exports carry one (a ~10 cm decal strip at the footprint edge,
 * height 0.0) and it silently INFLATED every derived footprint — the settee's
 * tile measured 160×179 when its platform is 160×160, so two modules could
 * never join front-to-back ("won't let me join"). Deliberately far stricter
 * than any real part (meshClean's lesson: geometric label-stripping once
 * deleted tabletops): the mesh must be under 1% of the model's height thick
 * AND start in the bottom 2% — a bolster (≈18%) or a seat pad (≈10% tall)
 * doesn't come close. Pure: takes {min,max} y-extents in any unit.
 */
export function isGroundShadowBox(meshMinY, meshMaxY, objMinY, objMaxY) {
  const H = objMaxY - objMinY;
  if (!(H > 0)) return false;
  const h = Math.max(0, meshMaxY - meshMinY);
  return h / H < 0.01 && (meshMinY - objMinY) / H < 0.02;
}
