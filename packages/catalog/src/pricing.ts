/**
 * CATALOGUE PRICING — the brand-agnostic money rules, ported to the cent from
 * the reference app's `supabase/functions/togo-embed/dealer.ts`.
 *
 * Three questions live here, in dependency order:
 *   • what does a model COST — `baseProductFor` (the cheapest priced SKU under a
 *     root is the quoted base) and `familyFor` (the graded ladder, sorted by
 *     PRICE ascending, never by letter);
 *   • what does a stored build cost — `buildPriceIndex` distills models +
 *     products into a per-model lookup, `priceItems` applies it to a saved
 *     configuration (the port of `priceInboxItems`);
 *   • how much of that reaches a browser — `applyDealerPricing` (scale a SHARED
 *     catalogue per dealer, on a COPY) then `applyPricingMode` (full/from/hidden).
 *
 * Every grade decision goes through an injected `SkuGrammar`. There is no grade
 * table in this file — that is the whole point of the adapter.
 *
 * MONEY UNITS: prices flow as `number` in the price list's MAJOR units (USD
 * dollars), exactly like the reference, so parity is checkable to the cent.
 * `money.ts` converts at the DB boundary.
 */

import { DEFAULT_ROLE_SET, MATERIALIZATION_ROLES, partCount } from '@veta/materials';
import type { PartRoleSet, PartsMap } from '@veta/materials';
import { lr8DigitGrade, splitSkuOrRoot } from './skuGrammar.ts';
import type { SkuGrammar } from './skuGrammar.ts';

/* ------------------------------- shared shapes ------------------------------- */

type Row = Record<string, unknown>;

/** A catalogue row, as either the app (camelCase) or PostgREST (snake) hands it
 *  over — both spellings of the price are read, so one implementation serves
 *  the client and the server. */
export interface PriceProduct {
  reference?: unknown;
  name?: unknown;
  priceUsd?: unknown;
  price_usd?: unknown;
  [k: string]: unknown;
}

/** One rung of a graded ladder, priced at the caller's margin. */
export interface GradeProduct {
  priceUsd: number;
  reference: string;
  [k: string]: unknown;
}

/** A model's graded ladder — `grades` in ASCENDING PRICE order, so `grades[0]`
 *  is the quoted base grade. `graded` is false for a lone SKU (a standalone
 *  product that merely happens to end in a letter). */
export interface PriceFamily {
  root: string;
  name: string;
  graded: boolean;
  grades: string[];
  byGrade: Record<string, GradeProduct>;
}

/** A margin function: list price in, retail price out. Identity by default. */
export type RetailFn = (listUsd: number) => number;

const identityRetail: RetailFn = (n) => n;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The list price of a row, whichever spelling it arrived in. */
export function listPriceOf(p: PriceProduct | null | undefined): number {
  const raw = p?.priceUsd ?? p?.price_usd;
  return num(raw);
}

/* --------------------------------- families --------------------------------- */

/**
 * The cheapest priced SKU under a family root = the model's base grade.
 *
 * Prefix match on the reference, exactly as the reference app does: the root is
 * a literal SKU prefix, so this stays grammar-free and works for a catalogue
 * whose "root" is the whole SKU. Ascending price → the cheapest grade is the
 * quoted base (the "desde" price a picker shows).
 */
export function baseProductFor<T extends PriceProduct>(
  root: string | null | undefined,
  products: readonly T[] | null | undefined,
): T | null {
  if (!root) return null;
  let best: T | null = null;
  for (const p of products || []) {
    const ref = String(p?.reference ?? '');
    if (!ref.startsWith(root)) continue;
    if (!best || listPriceOf(p) < listPriceOf(best)) best = p;
  }
  return best;
}

/**
 * The graded family at a root, with RETAIL per-grade prices baked in — so a
 * widget, an inbox and the internal builder all reprice identically.
 *
 * A row joins the family only when its root matches AND its grade is one the
 * GRAMMAR knows. For `lr8DigitGrade` that drops ungraded rows (`''` is not on
 * the ladder), reproducing the reference byte for byte; for `simpleSku` the
 * single `''` tier IS the ladder, so an ungraded catalogue forms families of
 * one. Same rule, no special case.
 *
 * Grades sort by PRICE ascending (never alphabetically): `grades[0]` is the
 * base grade every "from" price is quoted at. Null when nothing priced matched.
 */
export function familyFor(
  root: string | null | undefined,
  products: readonly PriceProduct[] | null | undefined,
  retail: RetailFn = identityRetail,
  grammar: SkuGrammar = lr8DigitGrade,
): PriceFamily | null {
  if (!root) return null;
  const byGrade: Record<string, GradeProduct> = {};
  let name = '';
  for (const p of products || []) {
    const ref = String(p?.reference ?? '');
    const { root: r, grade } = splitSkuOrRoot(grammar, ref);
    if (r !== root || !grammar.grades.includes(grade)) continue;
    // FIRST row wins a grade — a duplicated SKU never silently reprices.
    if (!byGrade[grade]) byGrade[grade] = { priceUsd: retail(listPriceOf(p)), reference: ref };
    if (!name && p?.name) name = String(p.name);
  }
  const grades = Object.keys(byGrade).sort((a, b) => byGrade[a].priceUsd - byGrade[b].priceUsd);
  if (!grades.length) return null;
  // A model is grade-priced only when several tiers share the root. A lone SKU
  // is a standalone product, not a fabric-graded model.
  return { root, name, graded: grades.length >= 2, grades, byGrade };
}

/**
 * Resolve a family + chosen grade to its SKU. An ungraded family returns its
 * sole member whatever grade is asked for — the reference's `productForGrade`.
 */
export function productForGrade(
  family: PriceFamily | null | undefined,
  grade: string | null | undefined,
): GradeProduct | null {
  if (!family) return null;
  const byGrade = family.byGrade || {};
  if (!family.graded) return Object.values(byGrade)[0] || null;
  return byGrade[String(grade || '').toUpperCase()] || null;
}

/* ------------------------------- price index ------------------------------- */

/** A non-base role's shared SKU, priced like the base. */
export interface PartPriceEntry {
  /** Billed units of this role on the model (`partCount`). */
  count: number;
  /** Cheapest grade, retail — what an unpicked part bills at. */
  baseUsd: number | null;
  /** Retail price per grade (a picked part fabric). */
  byGrade: Record<string, number>;
}

export interface PriceEntry {
  baseUsd: number | null;
  byGrade: Record<string, number>;
  /** Non-base roles with tagged parts AND a bound SKU root. */
  parts?: Record<string, PartPriceEntry>;
  /**
   * EVERY billed componente role (`partCount` > 0), bound SKU or not — the
   * domain of the monocolor question (`isCompleteElement`), and the mirror of
   * the placement side's `billed` (the keys `partFamiliesFrom` emits, which
   * includes an UNBOUND root's role with a null family). `parts` cannot answer
   * it: it drops a role with no root, and a divergent pick on one of those still
   * breaks the fold. Absent when the model bills no componente at all — the
   * ordinary piece, whose pricing is byte-identical to before this existed.
   */
  billedRoles?: string[];
}

export interface PriceIndexOptions {
  grammar?: SkuGrammar;
  roles?: PartRoleSet;
}

/**
 * Distill models + their catalogue SKUs into a `modelId → PriceEntry` lookup at
 * the given retail margin. Prices are PRE-multiplier — `priceItems` applies the
 * dealer's multiplier last, exactly as the catalogue payload does.
 *
 * Rows are read in either spelling (`product_root` / `productRoot`), so the
 * server's raw rows and the app's mapped ones both land here.
 */
export function buildPriceIndex(
  models: readonly Row[] | null | undefined,
  products: readonly PriceProduct[] | null | undefined,
  retail: RetailFn = identityRetail,
  opts: PriceIndexOptions = {},
): Record<string, PriceEntry> {
  const grammar = opts.grammar || lr8DigitGrade;
  const roles = opts.roles || DEFAULT_ROLE_SET;
  const gradesOf = (root: string | null): Record<string, number> => {
    const byGrade: Record<string, number> = {};
    const family = familyFor(root, products, retail, grammar);
    if (family) {
      for (const [grade, info] of Object.entries(family.byGrade)) byGrade[grade] = num(info.priceUsd);
    }
    return byGrade;
  };
  const index: Record<string, PriceEntry> = {};
  for (const m of models || []) {
    const id = String(m?.id ?? '');
    if (!id) continue;
    const root = (m?.product_root ?? m?.productRoot ?? null) as string | null;
    const base = baseProductFor(root, products);
    const entry: PriceEntry = {
      baseUsd: base ? retail(listPriceOf(base)) : null,
      byGrade: gradesOf(root),
    };
    // The model's tagged parts (shared cushion/bolster SKUs) price alongside.
    const parts = (m?.parts ?? null) as PartsMap | null;
    // The BILLED componentes, asked BEFORE (and independently of) the roots: a
    // role tagged with a count but no bound SKU is still a componente for the
    // monocolor decision, exactly as it is on the placement side (where
    // `partFamiliesFrom` keys it with a null family). 'base' is never a
    // componente of itself.
    const billedRoles = roles.all.filter((role) => role !== 'base' && partCount(parts, role, roles) > 0);
    if (billedRoles.length) entry.billedRoles = billedRoles;
    const partRoots = (parts?.roots ?? null) as Row | null;
    if (partRoots) {
      const partEntries: Record<string, PartPriceEntry> = {};
      for (const role of roles.all) {
        if (role === 'base') continue;
        const count = partCount(parts, role, roles);
        const partRoot = partRoots[role] ? String(partRoots[role]) : null;
        if (!count || !partRoot) continue;
        const partBase = baseProductFor(partRoot, products);
        partEntries[role] = {
          count,
          baseUsd: partBase ? retail(listPriceOf(partBase)) : null,
          byGrade: gradesOf(partRoot),
        };
      }
      if (Object.keys(partEntries).length) entry.parts = partEntries;
    }
    index[id] = entry;
  }
  return index;
}

/**
 * THE ELEMENTO COMPLETO, asked of a STORED item — the same law
 * `resolveCompleteSku` applies to a live placement, over the saved shape.
 *
 * A modular piece prices two ways out of ONE binding, and which applies is the
 * CUSTOMER's doing: every componente riding the SAME material ⇒ the piece IS one
 * element and bills on the model's own SKU ALONE (the cheaper answer, and the
 * DEFAULT build — the componentes are still listed, they are "incluido"); any
 * componente in a DIFFERENT fabric ⇒ that base SKU PLUS each componente on its
 * own (the dearer path). The fold shipped on the live-placement path and never
 * reached the stored one, so an inbox read a build the visitor was shown at
 * 12,880 as 23,190 — the whole SKU plus every rooted componente, each at its
 * cheapest grade. Same lead, two prices, and the dearer one is the one the
 * dealer quotes from.
 *
 * MONOCOLOR IS JUDGED BY FABRIC CODE — the identity the customer actually
 * picked, never the grade (two fabrics share a grade all the time) and never the
 * fabric name. A componente with NO pick of its own rides the piece's cloth by
 * construction and therefore agrees; an explicit pick of the very same code is
 * not a divergence either. A piece with NO billed componentes returns false: it
 * has only ever had one price, so there is nothing to fold in and nothing to
 * mark "incluido".
 *
 * Zones and structure are not componentes — `partCount` answers 0 for both, so
 * they never enter `billedRoles` and a bicolor zone can no more break the fold
 * here than it can on the placement side.
 */
export function isCompleteElement(entry: PriceEntry | null | undefined, it: Row): boolean {
  const billed = entry?.billedRoles || [];
  if (!billed.length) return false;
  const picks = (it.partMaterials && typeof it.partMaterials === 'object' ? it.partMaterials : {}) as Row;
  const material = (it.material && typeof it.material === 'object' ? it.material : null) as Row | null;
  const baseCode = String(material?.code || '').trim();
  for (const role of billed) {
    const pick = (picks[role] && typeof picks[role] === 'object' ? picks[role] : null) as Row | null;
    const code = String(pick?.code || '').trim();
    if (!code) continue;                 // no pick of its own ⇒ rides the piece's cloth
    if (code !== baseCode) return false; // mixed materialization ⇒ price by parts
  }
  return true;
}

/** A saved item's chosen grade, uppercased to match the `byGrade` keys. */
function itemGrade(it: Row): string {
  const mat = it.material;
  if (mat && typeof mat === 'object') {
    const g = (mat as Row).grade;
    if (g != null && String(g).trim()) return String(g).trim().toUpperCase();
  }
  return '';
}

/**
 * Price every stored item of a saved configuration and total it (the port of
 * `priceInboxItems`). Per item:
 *   • its `material.grade` at the family's retail price for that grade, else
 *   • the model's base retail price, else null (unknown model / unpriced);
 *   • then its componentes — but ONLY when the build is not monocolor: a build
 *     whose componentes all ride the piece's own cloth bills that whole-piece
 *     price ALONE and lists them "incluido" (`isCompleteElement`, the fold);
 *   • otherwise materialization ZONES re-grade that base SKU (a bicolor piece
 *     prices at its DEAREST zone grade and never adds a line) and tagged parts
 *     bill on top at their own picked grade, unpicked at their cheapest (the
 *     module physically ships with them);
 *   • then × the dealer multiplier, rounded to 2dp.
 *
 * `totalUsd` sums the non-null prices; null when EVERY item priced null.
 *
 * A PICK OFF ITS LADDER PRICES NOTHING, on either axis. A module's ladders are
 * different SKUs — the settee's own and its cushion family's — so a cushion
 * dressed in a grade that family never sold has a pick this index cannot price.
 * The part loop used to fall back to `part.baseUsd`, quietly billing the
 * CHEAPEST grade for cloth the visitor never chose, and the zone loop simply
 * ignored it; the whole piece kept a documented fallback that reads as safety
 * and is the same lie in its purest form (a lead carrying an off-ladder grade
 * silently billed the cheapest rung). The item now prices NULL — the same answer
 * `placementTotal` gives, so the two halves never diverge. NOT a fallback
 * removal: an item with NO pick at all still bills the base (the module ships in
 * its cheapest cloth by convention, and that is what a palette has always
 * shown), and a model with fewer than two grades has no ladder to be off —
 * `productForGrade` prices any grade on it.
 */
export function priceItems(
  items: readonly unknown[] | null | undefined,
  priceIndex: Record<string, PriceEntry>,
  multiplier: unknown,
): { items: Array<Record<string, unknown>>; totalUsd: number | null } {
  const mult = safeMultiplier(multiplier);
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
      // A REAL ladder is two grades or more — the same `graded` rule `familyFor`
      // applies, so a lone/ungraded SKU keeps pricing any pick exactly as it does
      // there (and as it always has here).
      const laddered = Object.keys(entry.byGrade).length >= 2;
      if (grade && entry.byGrade[grade] != null) base = entry.byGrade[grade];
      else if (grade && laddered) unpriceable = true;
      else if (entry.baseUsd != null) base = entry.baseUsd;
      // THE FOLD. Monocolor ⇒ that whole-piece price is the WHOLE price: no
      // componente bills, no zone re-grades (a zone is a materialization of the
      // very SKU the piece is already billing, and the complete path ignores it
      // for exactly that reason), and no componente ladder can make the item
      // unpriceable — the cushion SKU is not being sold here, so a grade it never
      // carried is not a gap. Whatever the whole-piece resolution above decided
      // STANDS, which is what keeps the off-ladder gate composed: an unresolvable
      // uniform build still prices null, it never folds to a number.
      if (!uniform) {
        // A zone is already INSIDE the base SKU: the dearest picked zone grade
        // re-grades it, nothing is ever added.
        for (const role of MATERIALIZATION_ROLES) {
          const pick = (picks[role] && typeof picks[role] === 'object' ? picks[role] : null) as Row | null;
          const g = pick?.grade ? String(pick.grade).trim().toUpperCase() : '';
          if (!g) continue;
          const v = entry.byGrade[g];
          if (v == null) { unpriceable = true; continue; }
          if (base == null || v > base) base = v;
        }
        if (base != null && entry.parts) {
          for (const [role, part] of Object.entries(entry.parts)) {
            const pick = (picks[role] && typeof picks[role] === 'object' ? picks[role] : null) as Row | null;
            const g = pick?.grade ? String(pick.grade).trim().toUpperCase() : '';
            if (g && part.byGrade[g] == null) { unpriceable = true; continue; }
            const unit = g ? part.byGrade[g] : part.baseUsd;
            if (unit != null) base += unit * part.count;
          }
        }
      }
      if (unpriceable) base = null;
      // The "incluido" marker, mirror of the breakdown's base line: the fold
      // RESOLVED, so this one price bought the componentes too. Emitted only with
      // a price on it — a uniform build the ladder can't price is a gap to close,
      // never something already paid for — and only when it applies, so an
      // ordinary item's shape is byte-identical to before.
      complete = uniform && base != null;
    }
    const priceUsd = base == null ? null : round2(base * mult);
    if (priceUsd != null) { anyPriced = true; sum += priceUsd; }
    return complete ? { ...it, priceUsd, complete: true } : { ...it, priceUsd };
  });
  return { items: priced, totalUsd: anyPriced ? round2(sum) : null };
}

/* ---------------------------- per-dealer presentation ---------------------------- */

/**
 * A valid, finite, POSITIVE multiplier — anything else (0, negative, NaN, junk)
 * falls back to 1. Identity is the only safe failure: a dealer's prices then
 * read as the base retail, never as zero.
 */
export function safeMultiplier(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Clamp a percentage to [0, max]. The ceiling defaults to 500 because the
 * percentages this package handles are MARGINS, which legitimately exceed 100%;
 * a DISCOUNT field must pass `max = 100` explicitly (a >100% discount inverts
 * the sale). A negative always clamps to 0 — it would invert the operation.
 */
export function clampPct(v: unknown, max = 500): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > max ? max : n;
}

/** How much of a priced model reaches the browser. */
export type PricingMode = 'full' | 'from' | 'hidden';

const PRICING_MODES: ReadonlySet<string> = new Set(['full', 'from', 'hidden']);

/** Validate a stored mode, falling back to 'full'. */
export function validPricingMode(v: unknown): PricingMode {
  return PRICING_MODES.has(v as string) ? (v as PricingMode) : 'full';
}

/** A family as it rides a catalogue payload — only the price-bearing half
 *  matters here; everything else passes through untouched. */
export interface PayloadFamily {
  byGrade?: Record<string, { priceUsd?: unknown; [k: string]: unknown }> | null;
  [k: string]: unknown;
}

/** One catalogue model as a payload carries it. */
export interface CatalogModel {
  priceUsd?: number | null;
  family?: PayloadFamily | null;
  partFamilies?: Record<string, PayloadFamily | null> | null;
  [k: string]: unknown;
}

function scaleFamily(fam: PayloadFamily | null | undefined, m: number): PayloadFamily | null {
  if (!fam || !fam.byGrade || typeof fam.byGrade !== 'object') return fam ?? null;
  const byGrade: Record<string, { priceUsd: number; [k: string]: unknown }> = {};
  for (const [grade, info] of Object.entries(fam.byGrade)) {
    const g = (info || {}) as { priceUsd?: unknown; [k: string]: unknown };
    byGrade[grade] = { ...g, priceUsd: round2(num(g.priceUsd) * m) };
  }
  return { ...fam, byGrade };
}

/**
 * Scale a catalogue model's prices for one dealer — `priceUsd` and every
 * `family.byGrade[*].priceUsd` (and the part families, which are the same kind
 * of ladder) × the multiplier, rounded to 2dp.
 *
 * Returns a COPY. The catalogue is SHARED across dealers and re-priced per
 * request, so mutating it would leak one dealer's markup into the next
 * response — pinned by the reference's own non-mutation test.
 */
export function applyDealerPricing(model: CatalogModel, multiplier: unknown): CatalogModel {
  const m = safeMultiplier(multiplier);
  const price = model.priceUsd;
  const next: CatalogModel = {
    ...model,
    priceUsd: price == null ? null : round2(num(price) * m),
    family: scaleFamily(model.family, m),
  };
  if (model.partFamilies && typeof model.partFamilies === 'object') {
    next.partFamilies = Object.fromEntries(
      Object.entries(model.partFamilies).map(([role, fam]) => [role, scaleFamily(fam, m)]),
    );
  }
  return next;
}

/**
 * How much of the priced shape reaches the browser:
 *   • 'full'   — unchanged (the client reprices per grade);
 *   • 'from'   — keep `priceUsd` (a base "desde …" anchor) but drop the family,
 *                so the client cannot reprice per grade;
 *   • 'hidden' — no price at all reaches the browser (a "request a quote" dealer).
 * The part families go with the base family: they are the same "reprice
 * client-side" capability. Returns a COPY.
 */
export function applyPricingMode(model: CatalogModel, mode: unknown): CatalogModel {
  const m = validPricingMode(mode);
  if (m === 'full') return { ...model };
  if (m === 'from') return { ...model, family: null, partFamilies: null };
  return { ...model, priceUsd: null, family: null, partFamilies: null };
}
