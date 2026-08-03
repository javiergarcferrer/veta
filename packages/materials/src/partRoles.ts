/**
 * The PART-ROLE model — the pure rules behind per-part fabric editing.
 *
 * A structured module (a platform sofa…) is not one price: the BASE
 * (platform/frame) has its own SKU per model, while the loose parts — seat/back
 * CUSHIONS, BOLSTERS, ARM CUSHIONS — are identical shared SKUs reused across
 * every base in the collection. The 3D export mirrors that: each part type is a
 * separate mesh node carrying a stable MATERIAL id (a pCon UUID shared across
 * models), while node NAMES don't exist at all. So parts are keyed by material
 * name, with a "#<nodeIndex>" fallback for unnamed materials.
 *
 * A model's stored tagging is the dealer-confirmed map:
 *   { mats:   { "<materialName>": role, ... },
 *     roots:  { cushion: "<productRoot>", bolster: "...", armCushion: "..." },
 *     counts: { cushion: 2, ... } }            // billed units; default = node count
 *
 * Everything here is a pure function of plain data (no three.js, no React), so
 * the classifier, the pricing roll-up and the payload sanitizer share ONE rule
 * set and are unit-testable.
 *
 * PHASE-1 SEAM: the taxonomy is DATA. Every function that consults it takes an
 * optional trailing `roles` set, defaulting to `DEFAULT_ROLE_SET` — the seven
 * roles the configurator ships with today. A collection that needs its own
 * vocabulary passes its own set; nothing here has to change, and no caller
 * breaks.
 */

/** The taggable roles, in display order. `base` prices via the model's own
 *  product_root; cushion/bolster/armCushion via parts.roots[role]; exterior/
 *  interior are MATERIALIZATION ZONES and `structure` is a FINISH-ONLY part
 *  (both below) — none of those three ever price at all. */
export const PART_ROLES: readonly string[] = ['base', 'structure', 'exterior', 'interior', 'cushion', 'bolster', 'armCushion'];

/**
 * Materialization ZONES — the two-fabric split of a one-SKU piece. That ONE
 * graded SKU covers the COMPLETE materialization (verified against the catalog:
 * single A–X ladders, no bicolor SKU), with two modes: MONOCOLOR (every zone
 * rides the base fabric — the default, no picks) or BICOLOR (the exterior body
 * and the interior plinth each pick a fabric). A zone therefore NEVER bills as
 * its own line; a bicolor pick can only re-grade the base SKU (dearest zone
 * wins).
 */
export const MATERIALIZATION_ROLES: readonly string[] = ['exterior', 'interior'];

/**
 * The roles that can NEVER bill — the ONE question `partCount` asks.
 *
 * Two different reasons, one answer, which is exactly why they must be asked
 * as one thing: a materialization ZONE is already INSIDE the base SKU (that
 * single ladder is the complete materialization), while a STRUCTURE (patas,
 * marcos, bases en acero o lacado negro) is a FINISH choice on metal — same
 * piece, same SKU, same price, whichever lacquer the client picks (owner,
 * 2026-07: «se eligen pero no cambian el precio»). Code that asks "does this
 * bill?" reads this list, so the next price-neutral role can't leak into the
 * billed slots.
 */
export const UNPRICED_ROLES: readonly string[] = [...MATERIALIZATION_ROLES, 'structure'];

/**
 * The BILLED roles — the slots a model can bind a part SKU to. Derived from the
 * role list MINUS `base` (it bills as the model itself) and the price-neutral
 * ones, so a new unpriced role can never leak in as an extra billable slot. A
 * studio reads it as its billable-slot list; the join/split planner reads it to
 * know which `roots`/`counts` a vacated role must give back.
 *
 * The DEFAULT taxonomy's answer. A collection with its own `PartRoleSet` asks
 * the same question of its own set (`all` minus `base` minus `unpriced`).
 */
export const BILLED_ROLES: readonly string[] = PART_ROLES.filter(
  (r) => r !== 'base' && !UNPRICED_ROLES.includes(r),
);

/** Spanish labels the pickers/chips render (the app copy is Spanish-first). */
export const PART_LABELS: Readonly<Record<string, string>> = {
  // «Cuerpo» — the trade word for the upholstered shell. The role KEY stays
  // `base`: that token is the money rule's own name (base SKU + componentes)
  // and the internal parity rule everything else is keyed on — only what a
  // human READS changes. «Base» named the same thing as the metal bases the
  // estructura rows offer, so the two vocabularies collided on screen. A
  // dealer's own studio label (`roleLabelOf`) still outranks this.
  base: 'Cuerpo',
  structure: 'Estructura',
  exterior: 'Exterior',
  interior: 'Interior',
  cushion: 'Cojín',
  bolster: 'Rulo',
  armCushion: 'Cojín de brazo',
};

/** A complete role taxonomy: what exists, what can never bill, what it's called. */
export interface PartRoleSet {
  readonly all: readonly string[];
  readonly unpriced: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

/** The seven roles the configurator ships with — the default everywhere. */
export const DEFAULT_PART_ROLES = PART_ROLES;

/** The default taxonomy, bundled for the optional `roles` parameter below. */
export const DEFAULT_ROLE_SET: PartRoleSet = {
  all: PART_ROLES,
  unpriced: UNPRICED_ROLES,
  labels: PART_LABELS,
};

/** A model's dealer-confirmed part tagging. */
export interface PartsMap {
  mats?: Record<string, string> | null;
  roots?: Record<string, string> | null;
  counts?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** The stable part key for a mesh node: its source material name, else a
 *  positional fallback. `materialName` is read BEFORE the fabric material
 *  replaces it (loaders preserve the export's material names). */
export function partKeyFor(materialName: unknown, nodeIndex: unknown): string {
  const n = (materialName == null ? '' : String(materialName)).trim();
  return n || `#${Number(nodeIndex) || 0}`;
}

/** The material key a (possibly split) part key belongs to — "Fabric~2" →
 *  "Fabric". Only a trailing `~<digits>` counts, so a material genuinely named
 *  with a tilde is left alone. */
export function baseKeyOf(partKey: unknown): string {
  const s = String(partKey || '');
  const m = /^(.*)~\d+$/.exec(s);
  return m ? m[1] : s;
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
export function partRoleFor(
  parts: PartsMap | null | undefined,
  materialName: unknown,
  nodeIndex: unknown,
  partKey?: string | null,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): string {
  const mats: Record<string, string> = parts?.mats || {};
  const key = partKey || partKeyFor(materialName, nodeIndex);
  if (roles.all.includes(mats[key])) return mats[key];
  const base = baseKeyOf(key);
  if (base !== key && roles.all.includes(mats[base])) return mats[base];
  return 'base';
}

/** Whether a model has any non-base tagging (drives the part-editing UI). */
export function hasParts(parts: PartsMap | null | undefined, roles: PartRoleSet = DEFAULT_ROLE_SET): boolean {
  const mats: Record<string, string> = parts?.mats || {};
  return Object.values(mats).some((r) => roles.all.includes(r) && r !== 'base');
}

/**
 * The role a standalone ACCESSORY MODEL plays, from its name — the dealer
 * uploads the loose parts as their own models ("Back Cushion", "Bolster",
 * "Cojín de brazo"…), and those become the REFERENCE FINGERPRINTS the sofa
 * tagger matches against. Name keywords in both languages; null when the
 * model isn't a recognizable accessory (a sofa, an ottoman, a table).
 */
export function accessoryRoleFor(name: unknown): string | null {
  const s = (name == null ? '' : String(name)).toLowerCase();
  if (/(arm|brazo)/.test(s) && /(cushion|coj[ií]n)/.test(s)) return 'armCushion';
  if (/(bolster|rulo|cilindro)/.test(s)) return 'bolster';
  if (/(cushion|coj[ií]n)/.test(s)) return 'cushion';
  return null;
}

// Two boxes read as THE SAME PART when every extent agrees within 20% —
// horizontal extents compared orientation-free (sorted), height apart.
function sizeMatches(a: readonly number[], b: readonly number[]): boolean {
  const close = (x: number, y: number): boolean => {
    const m = Math.max(Math.abs(x), Math.abs(y));
    return m < 1e-6 || Math.abs(x - y) / m <= 0.2;
  };
  const [aw, ad] = [Math.max(a[0], a[2]), Math.min(a[0], a[2])];
  const [bw, bd] = [Math.max(b[0], b[2]), Math.min(b[0], b[2])];
  return close(aw, bw) && close(ad, bd) && close(a[1], b[1]);
}

/** One mesh node as the key derivation sees it: its material and its box. */
export interface PartNode {
  materialName?: unknown;
  size?: readonly number[] | null;
}

/**
 * The part key for every mesh node of a model, in traversal order.
 *
 * A key was the material name alone, which assumes pCon gives each PART TYPE its
 * own material. It usually does — and when it does this function is a no-op. But
 * some exports upholster the back cushions and the bolster in ONE material, and
 * then every rule downstream is reasoning about a single box merged from both:
 * a slab and a roll averaged into a shape that is neither, so the two can never
 * be told apart and can never be tagged, priced or re-covered separately. That
 * is exactly the "not detecting back cushions and bolster separately" report.
 *
 * So a material splits into CLUSTERS by SHAPE, not by position: parts of one
 * type are near-identical boxes (three back cushions), while a bolster is a
 * different box entirely. Shape rather than proximity because on a real sofa the
 * bolster LEANS on the cushions — they touch, so nothing spatial separates them.
 * `sizeMatches` is the same ±20% orientation-free comparison the classifier
 * already trusts, and it compares boxes to each OTHER, so it doesn't care what
 * units either side measured in.
 *
 * Cluster order is order of first appearance, and the FIRST cluster keeps the
 * bare material name — so every already-tagged model reads exactly as it did,
 * and `partRoleFor` lets later clusters inherit that tag until the dealer says
 * otherwise. `nodes` is `[{ materialName, size: [w,h,d] }]` in traversal order;
 * a node with no size joins the first cluster.
 */
export function partKeysFor(nodes: readonly PartNode[] | null | undefined): string[] {
  const reps = new Map<string, (readonly number[] | null)[]>();   // material key → representative size per cluster
  return (nodes || []).map((n, i) => {
    const base = partKeyFor(n?.materialName, i);
    let list = reps.get(base);
    if (!list) { list = []; reps.set(base, list); }
    const size = Array.isArray(n?.size) && n.size.length === 3 ? n.size : null;
    if (!size) { if (!list.length) list.push(null); return base; }
    let at = list.findIndex((r) => r && sizeMatches(size, r));
    if (at < 0) { list.push(size); at = list.length - 1; }
    return at === 0 ? base : `${base}~${at + 1}`;
  });
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
export function partCount(
  parts: PartsMap | null | undefined,
  role: string,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): number {
  // The price-neutral roles NEVER bill — a zone is already inside the base SKU,
  // a structure is a finish on metal (UNPRICED_ROLES). Guarded here, at the one
  // gate every price path crosses, so even a stray bound root or a typed count
  // can't charge for either.
  if (roles.unpriced.includes(role)) return 0;
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
  const mats: Record<string, string> = parts?.mats || {};
  return Object.values(mats).some((r) => r === role) ? 1 : 0;
}
