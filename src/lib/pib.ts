/**
 * PIB model — the pure logic that turns a parsed weekly Ligne Roset "Product
 * Information Briefing" into actionable signals: a delivery ETA for a quote
 * line, a whole-quote delivery summary, and the JARVIS "Suministro LR" bulletin
 * (with a week-over-week diff).
 *
 * Pure Model: no React / Supabase / pdf. The `pib-ingest` Edge Function fills
 * `PibBriefing.data` (a `PibData`); everything here reads it. Matching a quote
 * line back to a briefing entry layers, most-specific first:
 *   1. concrete SKU / family root (`line.reference` → splitSkuGrade)
 *   2. model code (`Product.familyCode`, e.g. "172" — the PIB prints "172 – MULTY")
 *   3. model / family NAME (`line.family` / `Product.family`, token-subset match)
 *   4. category (`Product.category` → the production-lead-time table)
 * The catalog `families` map (optional) unlocks code/category; without it we
 * still match on the line's own reference + family string.
 */

import { splitSkuGrade, productForGrade } from './catalog.js';
import type { CatalogFamily } from './catalog.js';
import { lineKind, QUOTE_KIND_INVENTORY } from './quoteKind.js';
import type {
  PibBriefing,
  PibData,
  PibItem,
  PibLeadTime,
  PibDiscontinuedProduct,
  PibPromoExclusion,
  PibNote,
  QuoteLine,
  Product,
} from '../types/domain.ts';

const MS_WEEK = 7 * 24 * 60 * 60 * 1000;
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** Tokens dropped before name-matching — connectors, units, generic words. */
const STOPWORDS = new Set(['LES', 'DE', 'DU', 'LA', 'THE', 'AND', 'OR', 'WITH', 'CM', 'X', 'MODEL', 'MODELO', 'REF']);

/* ------------------------------- ISO weeks -------------------------------- */

/** Sortable week key, e.g. (2026, 27) → "2026-W27". */
export function weekKey(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday (UTC midnight) of ISO week `week` in `year`. */
export function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** The ISO week+year a date falls in. */
export function isoWeekOf(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow + 3); // Thursday of this week decides the year
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const ftDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDow + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / MS_WEEK);
  return { year, week };
}

/** Parse ISO week numbers out of a lead-time label ("2026 Wk 42/43" → [42,43],
 *  "2026 – WK29" → [29], "wk51/02" → [51, 2]). */
export function parseIsoWeeks(label: string | null | undefined): number[] {
  const s = String(label || '');
  const m = s.match(/wk?\s*([0-9]{1,2}(?:\s*\/\s*[0-9]{1,2})*)/i);
  if (!m) return [];
  return m[1]
    .split('/')
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 53);
}

/** Parse a "4-6 WEEKS" / "11 WEEKS" style label → { min, max }. */
export function parseWeekRange(label: string | null | undefined): { min: number | null; max: number | null } {
  const s = String(label || '');
  const range = s.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:weeks?|semanas?|sem)/i);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = s.match(/(\d{1,2})\s*(?:weeks?|semanas?|sem)\b/i);
  if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
  return { min: null, max: null };
}

/* ------------------------------ name matching ----------------------------- */

/** Uppercase, strip accents + punctuation, collapse whitespace. */
export function normName(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\(#?[^)]*\)/g, ' ') // drop "(MODEL 172)" / "(#12)"
    .replace(/[^A-Z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s: string | null | undefined): string[] {
  return normName(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Two model names match when one's significant tokens are a subset of the
 *  other's (so "MULTY FIRST" matches "MULTY", "SPACE" matches "SPACE low
 *  table"). Empty on either side ⇒ no match. */
export function nameMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/* --------------------------- line identity + match ------------------------ */

export interface PibIdentity {
  /** Uppercased full reference (SKU) as typed on the line. */
  reference: string;
  /** Family root (8-digit SKU prefix, or the whole ungraded SKU). */
  root: string;
  /** Grade letter parsed off the SKU (may be ''). */
  grade: string;
  /** Display family / model name (line.family, or the catalog product's). */
  familyName: string;
  /** Model code from the catalog product (e.g. "172"), when resolvable. */
  code: string;
  /** Category from the catalog product (e.g. "SEATS"), when resolvable. */
  category: string;
}

/** Resolve a quote line (+ optional catalog) to the identity keys the matcher
 *  needs. Works with just `{ reference, family }` when no catalog is given. */
export function pibIdentity(
  line: Pick<QuoteLine, 'reference' | 'family' | 'name'> | null | undefined,
  families?: ReadonlyMap<string, CatalogFamily> | null,
): PibIdentity {
  const reference = String(line?.reference || '').trim().toUpperCase();
  const { root, grade } = splitSkuGrade(reference);
  const fam = families ? families.get(root) : null;
  const product: Product | null = fam ? productForGrade(fam, grade) : null;
  return {
    reference,
    root,
    grade,
    familyName: line?.family || product?.family || fam?.name || line?.name || '',
    code: (product?.familyCode || '').trim(),
    category: (product?.category || '').trim(),
  };
}

/**
 * SKU-specific match — the line's reference equals the item's SKU (or shares its
 * family root). A concrete SKU encodes a specific finish/material, so this is how
 * "certain models in certain materials" stays precise: a briefing that lists
 * ODESSA `005HEW4N` (walnut/black base) matches ONLY that SKU, not every ODESSA.
 */
function refMatches(
  id: PibIdentity,
  item: { reference?: string } | null | undefined,
): boolean {
  const ref = String(item?.reference || '').trim().toUpperCase();
  if (!ref) return false;
  if (ref === id.reference || ref === id.root) return true;
  return !!id.root && splitSkuGrade(ref).root === id.root;
}

function codeMatches(id: PibIdentity, item: { code?: string } | null | undefined): boolean {
  const code = String(item?.code || '').trim();
  return !!code && !!id.code && code.toUpperCase() === id.code.toUpperCase();
}

/**
 * Model-level match — for entries that apply to a WHOLE model (special order,
 * discontinued, promo exclusion). When the PIB entry carries a SKU we stay
 * precise (that reference only); a code/name match is allowed ONLY when the entry
 * has no SKU (a genuinely model-wide note, e.g. "EATON — 11 weeks"). This stops a
 * single discontinued SKU from flagging its entire family.
 */
function modelMatches(
  id: PibIdentity,
  item: { reference?: string; code?: string; model?: string } | null | undefined,
): boolean {
  if (!item) return false;
  if (String(item.reference || '').trim()) return refMatches(id, item);
  if (codeMatches(id, item)) return true;
  return !!item.model && nameMatch(item.model, id.familyName);
}

export interface StockStatus {
  /** Display pill text: "En stock" (now) · "≈ oct 2026" (a dated week) · "Consultar". */
  label: string;
  tone: 'good' | 'normal' | 'warn';
  /** Representative ETA (ms) for a dated availability, else null. */
  etaMs?: number | null;
}

/**
 * The real availability of an in-stock/quick-ship row — the PIB's stock table
 * gives each SKU its OWN status, which is often NOT "available now":
 *   • literally "In Stock" / inStock=true  → En stock (now)
 *   • a dated week ("2026 - WK29")         → the ETA for that week
 *   • "Check with your account manager" / anything else → Consultar (ask, don't promise)
 */
export function stockStatus(
  item: PibItem | null | undefined,
  ctx: { briefing?: PibBriefing | null; now?: number } = {},
): StockStatus {
  const now = ctx.now ?? Date.now();
  const label = String(item?.leadTimeLabel || '').trim();
  const iso = item?.isoWeeks && item.isoWeeks.length ? item.isoWeeks : parseIsoWeeks(label);
  if (item?.inStock === true || /\b(in|en)\s*stock\b/i.test(label)) return { label: 'En stock', tone: 'good' };
  if (iso.length) {
    const est = fromIsoWeeks(iso, ctx.briefing, now);
    if (est) return { label: est.label, tone: 'normal', etaMs: est.etaMs ?? null };
  }
  return { label: 'Consultar', tone: 'warn' };
}

/* --------------------------- lead-time formatting ------------------------- */

/** The fields `lineDeliveryEstimate` / `quoteDeliverySummary` read off a line —
 *  identity for the PIB match, plus what `lineKind` needs to tell an inventory
 *  order (already in the warehouse) from a catalog one (still to ship). */
type DeliveryLine = Pick<QuoteLine, 'reference' | 'family' | 'name' | 'kind' | 'fromStock' | 'inventoryItemId'>;

export interface DeliveryEstimate {
  kind: 'inStock' | 'short' | 'production' | 'special' | 'discontinued';
  tone: 'good' | 'normal' | 'warn' | 'danger';
  /** Short pill text, e.g. "En stock", "4–6 sem.", "≈ oct 2026", "11 sem.". */
  label: string;
  /** Longer explanatory line for tooltip / detail row. */
  detail: string;
  weeks?: [number, number] | null;
  isoWeeks?: number[];
  /** Representative ETA (ms) — Monday of the target ISO week, when known. */
  etaMs?: number | null;
  /** Closure caveat, e.g. "+3 sem. por cierre de fábrica". */
  closureNote?: string | null;
  /** Which PIB bucket produced this (for debugging / "por qué"). */
  source: string;
  /** The briefing week label this came from, e.g. "WEEK 27-2026". */
  week: string;
}

function spanishMonth(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS_ES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Is the closure window still ahead of `now` (same year)? */
function closureRelevant(data: PibData, now: number): { active: boolean; extra: number; note: string } {
  const weeks = (data.closureWeeks || []).filter((w) => w >= 1 && w <= 53);
  const extra = data.closureExtraWeeks == null ? (weeks.length ? 3 : 0) : Number(data.closureExtraWeeks) || 0;
  if (!weeks.length) return { active: false, extra: 0, note: '' };
  const cur = isoWeekOf(new Date(now));
  const maxW = Math.max(...weeks);
  const active = cur.week <= maxW; // the closure hasn't fully passed this year
  const note = extra ? `+${extra} sem. por cierre de fábrica` : (data.closureNote || 'Cierre de fábrica');
  return { active, extra, note };
}

/**
 * The delivery signal for one quote line against a briefing. Priority:
 * discontinued → in stock → short lead-time → production (by category) →
 * special order. Returns null when nothing in the briefing matches the line.
 */
export function lineDeliveryEstimate(
  line: DeliveryLine | null | undefined,
  ctx: { briefing?: PibBriefing | null; families?: ReadonlyMap<string, CatalogFamily> | null; now?: number } = {},
): DeliveryEstimate | null {
  const briefing = ctx.briefing;
  const data: PibData | undefined = briefing?.data;
  if (!line || !data) return null;
  // The PIB only ever describes what the FACTORY can produce and ship. A line
  // sold FROM STOCK (an inventory order — lib/quoteKind.js) is already
  // physically in the dealer's warehouse, so no factory lead-time/stock/
  // discontinued signal applies to it.
  if (lineKind(line) === QUOTE_KIND_INVENTORY) return null;
  const now = ctx.now ?? Date.now();
  const id = pibIdentity(line, ctx.families);
  if (!id.reference && !normName(id.familyName)) return null;
  const week = briefing?.weekLabel || briefing?.week || '';
  const closure = closureRelevant(data, now);

  // 1) Discontinued — the strongest guardrail (model-level, but SKU-precise
  //    when the entry names a SKU, so one dead reference can't flag its family).
  const disc = (data.discontinuedProducts || []).find((d) => modelMatches(id, d));
  if (disc) {
    return {
      kind: 'discontinued',
      tone: 'danger',
      label: 'Descontinuado',
      detail: `Fuera de colección según ${week || 'el PIB'}${disc.description ? ` — ${disc.description}` : ''}`,
      source: 'discontinuedProducts',
      week,
    };
  }

  // 2) Quick-ship / stock — matched by SPECIFIC SKU (the PIB lists a reference in
  //    a specific finish; a different config of the same family is NOT covered).
  //    Status is per-SKU: "En stock" only when it truly is, else the dated week,
  //    else "Consultar" — never a blanket in-stock claim over a whole family.
  const stock = (data.inStock || []).find((i) => refMatches(id, i));
  if (stock) {
    const st = stockStatus(stock, { briefing, now });
    const tail = stock.description ? ` — ${stock.description}` : '';
    return {
      kind: 'inStock',
      tone: st.tone,
      label: st.label,
      detail: st.tone === 'good'
        ? `Disponible en fábrica ahora${tail}`
        : st.tone === 'warn'
          ? `Consultar disponibilidad con Ligne Roset${tail}`
          : `Disponibilidad prevista${tail}`,
      etaMs: st.etaMs ?? null,
      source: 'inStock',
      week,
    };
  }

  // 3) Short lead-time — a specific quick-ship CONFIG, so SKU-specific too (a
  //    general line of the same family gets the standard production lead-time).
  const short = (data.shortLeadTimes || []).find((i) => refMatches(id, i));
  if (short) {
    const min = short.minWeeks ?? parseWeekRange(short.leadTimeLabel).min;
    const max = short.maxWeeks ?? parseWeekRange(short.leadTimeLabel).max;
    if (min || max) {
      const lo = min ?? max!;
      const hi = max ?? min!;
      return {
        kind: 'short',
        tone: hi <= 6 ? 'good' : 'normal',
        label: lo === hi ? `${lo} sem.` : `${lo}–${hi} sem.`,
        detail: `Plazo corto de fábrica${closure.active ? ` (${closure.note})` : ''}`,
        weeks: [lo, hi],
        closureNote: closure.active ? closure.note : null,
        source: 'shortLeadTimes',
        week,
      };
    }
  }

  // 4) Special order (out-of-collection) — a whole model out of collection, so
  //    model-level (SKU-precise when the entry names one).
  const special = (data.specialOrder || []).find((i) => modelMatches(id, i));
  if (special) {
    const wk = special.maxWeeks ?? special.minWeeks ?? parseWeekRange(special.leadTimeLabel).max;
    return {
      kind: 'special',
      tone: 'warn',
      label: wk ? `${wk} sem.` : 'Pedido especial',
      detail: `Pedido especial (fuera de colección)${special.description ? ` — ${special.description}` : ''}`,
      weeks: wk ? [wk, wk] : null,
      source: 'specialOrder',
      week,
    };
  }

  // 5) Production lead-time by category (the coarse fallback).
  const cat = matchCategory(data.productionLeadTimes || [], id.category, id.familyName);
  if (cat) {
    const iso = cat.isoWeeks && cat.isoWeeks.length ? cat.isoWeeks : parseIsoWeeks(cat.label);
    const est = fromIsoWeeks(iso, briefing, now, cat.year);
    if (est) {
      return {
        ...est,
        kind: 'production',
        tone: 'normal',
        detail: `Producción ${id.category || cat.category} — ${est.detail}${closure.active ? ` · ${closure.note}` : ''}`,
        closureNote: closure.active ? closure.note : null,
        source: 'productionLeadTimes',
      };
    }
  }
  return null;
}

/** Build an ETA from ISO weeks (uses the LATER week — the conservative date). */
function fromIsoWeeks(
  iso: number[],
  briefing: PibBriefing | null | undefined,
  now: number,
  year?: number | null,
): DeliveryEstimate | null {
  const weeks = (iso || []).filter((w) => w >= 1 && w <= 53);
  if (!weeks.length) return null;
  const yr = year || briefing?.year || isoWeekOf(new Date(now)).year;
  const target = Math.max(...weeks);
  const monday = mondayOfIsoWeek(yr, target);
  return {
    kind: 'production',
    tone: 'normal',
    label: `≈ ${spanishMonth(monday.getTime())}`,
    detail: `sem. ${weeks.join('/')} · ${yr}`,
    isoWeeks: weeks,
    etaMs: monday.getTime(),
    source: 'iso',
    week: briefing?.weekLabel || briefing?.week || '',
  };
}

/** Match a category lead-time by category string, else by model name. */
function matchCategory(rows: PibLeadTime[], category: string, familyName: string): PibLeadTime | null {
  const cat = normName(category);
  if (cat) {
    const hit = rows.find((r) => nameMatch(r.category, category));
    if (hit) return hit;
  }
  if (familyName) {
    const hit = rows.find((r) => nameMatch(r.category, familyName));
    if (hit) return hit;
  }
  return null;
}

/* -------------------------- whole-quote summary --------------------------- */

export interface DeliverySummary {
  /** The slowest line's ETA drives the order (it ships when the last piece is ready). */
  label: string;
  detail: string;
  tone: 'good' | 'normal' | 'warn' | 'danger';
  /** True when any line matched a discontinued entry. */
  hasDiscontinued: boolean;
  /** How many lines the briefing could estimate. */
  estimated: number;
  week: string;
}

/**
 * Roll per-line estimates into one order-level delivery note: the SLOWEST line
 * wins (the customer waits for the last piece), and any discontinued line is
 * flagged loudly. Returns null when the briefing can't estimate any line.
 */
export function quoteDeliverySummary(
  lines: readonly DeliveryLine[] | null | undefined,
  ctx: { briefing?: PibBriefing | null; families?: ReadonlyMap<string, CatalogFamily> | null; now?: number } = {},
): DeliverySummary | null {
  if (!ctx.briefing?.data || !Array.isArray(lines) || !lines.length) return null;
  const ests = lines
    .map((l) => lineDeliveryEstimate(l, ctx))
    .filter((e): e is DeliveryEstimate => !!e);
  if (!ests.length) return null;
  const hasDiscontinued = ests.some((e) => e.kind === 'discontinued');
  const week = ests[0].week;

  // Rank: a datable ETA by date; a week range by its max; in-stock is soonest.
  const rank = (e: DeliveryEstimate): number => {
    if (e.kind === 'discontinued') return Number.POSITIVE_INFINITY - 1;
    if (e.etaMs) return e.etaMs;
    if (e.weeks) return (ctx.now ?? Date.now()) + e.weeks[1] * MS_WEEK;
    return 0; // in stock / unknown → soonest
  };
  const slowest = ests.reduce((a, b) => (rank(b) > rank(a) ? b : a));

  return {
    label: hasDiscontinued ? 'Revisar disponibilidad' : slowest.label,
    detail: hasDiscontinued
      ? 'Una o más piezas están descontinuadas — confirmar con Ligne Roset'
      : `Entrega estimada de fábrica: ${slowest.label} (${slowest.detail})`,
    tone: hasDiscontinued ? 'danger' : slowest.tone,
    hasDiscontinued,
    estimated: ests.length,
    week,
  };
}

/* --------------------------- promo exclusion ------------------------------ */

/** Is this line/product a model the PIB excludes from all promotions? */
export function pibPromoExcluded(
  briefing: PibBriefing | null | undefined,
  line: Pick<QuoteLine, 'reference' | 'family' | 'name'> | null | undefined,
  families?: ReadonlyMap<string, CatalogFamily> | null,
): boolean {
  const rows = briefing?.data?.promoExclusions;
  if (!rows || !rows.length || !line) return false;
  const id = pibIdentity(line, families);
  return rows.some((r) => {
    const code = String(r.code || '').trim();
    if (code && id.code && code.toUpperCase() === id.code.toUpperCase()) return true;
    return !!r.model && nameMatch(r.model, id.familyName);
  });
}

/* ------------------------------ JARVIS bulletin --------------------------- */

function itemKey(i: PibItem | PibDiscontinuedProduct): string {
  return (
    normName((i as PibItem).reference || (i as PibDiscontinuedProduct).reference) ||
    normName((i as PibItem).model || (i as PibDiscontinuedProduct).model) ||
    normName((i as any).description)
  );
}

/** Rows in `cur` whose key isn't present in `prev` (i.e. new this week). */
function newThisWeek<T extends PibItem | PibDiscontinuedProduct>(cur: T[] = [], prev: T[] = []): T[] {
  const seen = new Set(prev.map(itemKey).filter(Boolean));
  return cur.filter((i) => {
    const k = itemKey(i);
    return k && !seen.has(k);
  });
}

export interface LrBulletin {
  hasData: boolean;
  week?: string;
  weekLabel?: string;
  briefingAt?: number | null;
  leadTimes?: (PibLeadTime & { etaText?: string; etaMs?: number | null })[];
  /** Quick-ship / stock rows, each with its REAL per-SKU status (En stock / a
   *  dated week / Consultar). `availableNow` counts only the genuinely-in-stock. */
  inStock?: { items: (PibItem & { status: StockStatus })[]; count: number; availableNow: number };
  shortLeadTimes?: { items: PibItem[]; count: number };
  specialOrder?: { items: PibItem[]; count: number };
  discontinued?: { products: PibDiscontinuedProduct[]; fabrics: PibData['discontinuedFabrics']; count: number };
  promoExclusions?: PibData['promoExclusions'];
  newAvailability?: PibData['newAvailability'];
  closure?: { weeks: number[]; note: string; active: boolean; extraWeeks: number };
  diff?: {
    hasPrev: boolean;
    prevWeekLabel?: string;
    newlyDiscontinued: PibDiscontinuedProduct[];
    newlyInStock: PibItem[];
    leadTimeChanges: { category: string; from: string; to: string }[];
  };
  count?: number;
}

/**
 * Roll the stored briefings into the JARVIS "Suministro LR" panel: the latest
 * week's actionable lists PLUS a week-over-week diff (what's newly
 * discontinued, newly in stock, and which category lead-times moved). The diff
 * is the real insight — the part a human skimming the PDF misses.
 */
export function resolveLrBulletin({
  briefings = [],
  now = Date.now(),
}: { briefings?: PibBriefing[]; now?: number } = {}): LrBulletin {
  const sorted = [...briefings].sort((a, b) => String(b.week || '').localeCompare(String(a.week || '')));
  const latest = sorted[0];
  if (!latest) return { hasData: false };
  const prev = sorted[1] || null;
  const data: PibData = latest.data || {};
  const prevData: PibData = prev?.data || {};

  const leadTimes = (data.productionLeadTimes || []).map((r) => {
    const iso = r.isoWeeks && r.isoWeeks.length ? r.isoWeeks : parseIsoWeeks(r.label);
    const est = fromIsoWeeks(iso, latest, now, r.year);
    return { ...r, etaText: est?.label, etaMs: est?.etaMs ?? null };
  });

  const closure = closureRelevant(data, now);
  const discProducts = data.discontinuedProducts || [];
  const discFabrics = data.discontinuedFabrics || [];
  const inStockItems = (data.inStock || []).map((i) => ({ ...i, status: stockStatus(i, { briefing: latest, now }) }));

  return {
    hasData: true,
    week: latest.week,
    weekLabel: latest.weekLabel || latest.week,
    briefingAt: latest.briefingAt ?? null,
    leadTimes,
    inStock: {
      items: inStockItems,
      count: inStockItems.length,
      availableNow: inStockItems.filter((i) => i.status.tone === 'good').length,
    },
    shortLeadTimes: { items: data.shortLeadTimes || [], count: (data.shortLeadTimes || []).length },
    specialOrder: { items: data.specialOrder || [], count: (data.specialOrder || []).length },
    discontinued: { products: discProducts, fabrics: discFabrics, count: discProducts.length + discFabrics.length },
    promoExclusions: data.promoExclusions || [],
    newAvailability: data.newAvailability || [],
    closure: { weeks: data.closureWeeks || [], note: closure.note, active: closure.active, extraWeeks: closure.extra },
    diff: {
      hasPrev: !!prev,
      prevWeekLabel: prev?.weekLabel || prev?.week,
      newlyDiscontinued: prev ? newThisWeek(discProducts, prevData.discontinuedProducts) : [],
      newlyInStock: prev ? newThisWeek(data.inStock || [], prevData.inStock) : [],
      leadTimeChanges: prev ? leadTimeDiff(data.productionLeadTimes || [], prevData.productionLeadTimes || []) : [],
    },
    count: sorted.length,
  };
}

function leadTimeDiff(cur: PibLeadTime[], prev: PibLeadTime[]): { category: string; from: string; to: string }[] {
  const prevByCat = new Map(prev.map((r) => [normName(r.category), r.label]));
  const out: { category: string; from: string; to: string }[] = [];
  for (const r of cur) {
    const before = prevByCat.get(normName(r.category));
    if (before != null && before !== r.label) out.push({ category: r.category, from: before, to: r.label });
  }
  return out;
}

/* ------------------------ per-week change log ----------------------------- */

export interface PibChangeItem {
  /** Primary label — model name, reference, category, or note title. */
  label: string;
  /** Secondary line — reference/description, the lead-time, or the from→to move. */
  detail?: string;
}

export interface PibChangeGroup {
  key: 'discontinued' | 'inStock' | 'shortLeadTime' | 'specialOrder' | 'leadTime' | 'promoExclusion' | 'newAvailability';
  /** Section heading, e.g. "Nuevos descontinuados". */
  title: string;
  tone: 'good' | 'normal' | 'warn' | 'danger';
  items: PibChangeItem[];
}

export interface PibChanges {
  /** False for the oldest briefing — nothing earlier to diff against. */
  hasPrev: boolean;
  /** The briefing being described, e.g. "WEEK 28-2026". */
  weekLabel: string;
  /** The week it was diffed against, e.g. "WEEK 27-2026". */
  prevWeekLabel?: string;
  groups: PibChangeGroup[];
  /** Total change rows across all groups (0 ⇒ this week changed nothing). */
  total: number;
}

/** Display name for a stock/order/discontinued row: model, else SKU, else desc. */
function pibItemLabel(i: PibItem | PibDiscontinuedProduct): string {
  return (
    String((i as PibItem).model || '').trim() ||
    String(i.reference || '').trim() ||
    String((i as { description?: string }).description || '').trim()
  );
}

/** Secondary line: the SKU (when not already the label) + description. */
function pibItemDetail(i: PibItem | PibDiscontinuedProduct): string | undefined {
  const parts: string[] = [];
  const ref = String(i.reference || '').trim();
  const model = String((i as PibItem).model || '').trim();
  const desc = String((i as { description?: string }).description || '').trim();
  if (ref && model) parts.push(ref); // ref only useful when the label isn't already it
  if (desc) parts.push(desc);
  return parts.length ? parts.join(' · ') : undefined;
}

function promoKey(p: PibPromoExclusion): string {
  return normName(p.model) || normName(p.code);
}

/** Promo exclusions in `cur` not present in `prev`. */
function newPromoExclusions(cur: PibPromoExclusion[], prev: PibPromoExclusion[]): PibPromoExclusion[] {
  const seen = new Set(prev.map(promoKey).filter(Boolean));
  return cur.filter((p) => { const k = promoKey(p); return !!k && !seen.has(k); });
}

/** "New availability" notes in `cur` whose title wasn't in `prev`. */
function newNotes(cur: PibNote[], prev: PibNote[]): PibNote[] {
  const seen = new Set(prev.map((n) => normName(n.title)).filter(Boolean));
  return cur.filter((n) => { const k = normName(n.title); return !!k && !seen.has(k); });
}

/**
 * The week-over-week changelog for ONE briefing against the week before it: what
 * this PIB newly discontinued, put in stock, added as a short lead-time or
 * special order, moved on the production calendar, newly excluded from promos,
 * or announced as new availability. This is the per-row detail behind the
 * Configuración ▸ Briefings list, and generalizes the JARVIS bulletin diff
 * (which only ever diffs the single latest week). `hasPrev:false` for the oldest
 * briefing (no earlier week to compare) and `total:0` when nothing changed.
 */
export function pibBriefingChanges(
  current: PibBriefing | null | undefined,
  previous?: PibBriefing | null | undefined,
): PibChanges {
  const weekLabel = current?.weekLabel || current?.week || '';
  const prevWeekLabel = previous?.weekLabel || previous?.week || undefined;
  if (!current?.data || !previous?.data) {
    return { hasPrev: false, weekLabel, prevWeekLabel, groups: [], total: 0 };
  }
  const cur = current.data;
  const prev = previous.data;
  const groups: PibChangeGroup[] = [];
  const add = (key: PibChangeGroup['key'], title: string, tone: PibChangeGroup['tone'], items: PibChangeItem[]) => {
    if (items.length) groups.push({ key, title, tone, items });
  };
  const withLead = (i: PibItem): PibChangeItem => {
    const detail = [pibItemDetail(i), String(i.leadTimeLabel || '').trim()].filter(Boolean).join(' · ');
    return { label: pibItemLabel(i), detail: detail || undefined };
  };

  add('discontinued', 'Nuevos descontinuados', 'danger',
    newThisWeek(cur.discontinuedProducts || [], prev.discontinuedProducts || [])
      .map((i) => ({ label: pibItemLabel(i), detail: pibItemDetail(i) })));

  add('inStock', 'Nuevo en stock', 'good',
    newThisWeek(cur.inStock || [], prev.inStock || []).map(withLead));

  add('shortLeadTime', 'Nuevo plazo corto', 'normal',
    newThisWeek(cur.shortLeadTimes || [], prev.shortLeadTimes || []).map(withLead));

  add('specialOrder', 'Nuevo pedido especial', 'warn',
    newThisWeek(cur.specialOrder || [], prev.specialOrder || []).map(withLead));

  add('leadTime', 'Cambios de plazo de producción', 'normal',
    leadTimeDiff(cur.productionLeadTimes || [], prev.productionLeadTimes || [])
      .map((c) => ({ label: c.category, detail: `${c.from} → ${c.to}` })));

  add('promoExclusion', 'Nuevas exclusiones de promoción', 'warn',
    newPromoExclusions(cur.promoExclusions || [], prev.promoExclusions || [])
      .map((p) => ({ label: p.model || p.code || '', detail: p.model && p.code ? `cód. ${p.code}` : undefined })));

  add('newAvailability', 'Novedades de disponibilidad', 'good',
    newNotes(cur.newAvailability || [], prev.newAvailability || [])
      .map((n) => ({ label: n.title, detail: n.detail })));

  return {
    hasPrev: true,
    weekLabel,
    prevWeekLabel,
    groups,
    total: groups.reduce((n, g) => n + g.items.length, 0),
  };
}

/* ---------------------- expedited / special-conditions -------------------- */

export interface ExpeditedItem {
  /** Model / family name as printed. */
  model: string;
  /** The specific SKU when the PIB gives one (empty for a model-wide note). */
  reference: string;
  /** The finish / material / config the PIB names (why the condition applies). */
  description: string;
  /** Display status: "En stock" · "≈ jul 2026" · "4–6 sem." · "11 sem." · "Descontinuado". */
  statusLabel: string;
  tone: 'good' | 'normal' | 'warn' | 'danger';
}

export interface ExpeditedGroup {
  key: 'stock' | 'short' | 'special' | 'discontinued';
  title: string;
  items: ExpeditedItem[];
}

export interface ExpeditedCatalog {
  hasData: boolean;
  week: string;
  briefingAt: number | null;
  groups: ExpeditedGroup[];
  total: number;
}

function weekRangeLabel(item: PibItem): { label: string; hi: number | null } {
  const r = parseWeekRange(item.leadTimeLabel);
  const min = item.minWeeks ?? r.min;
  const max = item.maxWeeks ?? r.max;
  if (min == null && max == null) return { label: (item.leadTimeLabel || '').trim(), hi: null };
  const lo = (min ?? max) as number;
  const hi = (max ?? min) as number;
  return { label: lo === hi ? `${lo} sem.` : `${lo}–${hi} sem.`, hi };
}

/**
 * Project the latest PIB into the catalog's "Entrega rápida" tab — the models
 * carrying a SPECIAL CONDITION this week, grouped by condition: in-stock /
 * dated availability, short factory lead-time, special order (out of
 * collection), and discontinued. Each row keeps the SKU + finish the PIB named,
 * so the dealer sees exactly which configuration the condition applies to.
 */
export function resolveExpeditedCatalog(
  briefing: PibBriefing | null | undefined,
  ctx: { now?: number } = {},
): ExpeditedCatalog {
  const now = ctx.now ?? Date.now();
  const data = briefing?.data;
  if (!data) return { hasData: false, week: '', briefingAt: null, groups: [], total: 0 };

  const groups: ExpeditedGroup[] = [];

  const stock: ExpeditedItem[] = (data.inStock || []).map((i) => {
    const st = stockStatus(i, { briefing, now });
    return { model: i.model || i.reference || '', reference: i.reference || '', description: i.description || '', statusLabel: st.label, tone: st.tone };
  });
  if (stock.length) groups.push({ key: 'stock', title: 'En stock y disponibilidad', items: stock });

  const short: ExpeditedItem[] = (data.shortLeadTimes || []).map((i) => {
    const { label, hi } = weekRangeLabel(i);
    return { model: i.model || i.reference || '', reference: i.reference || '', description: i.description || '', statusLabel: label || 'Plazo corto', tone: hi != null && hi <= 6 ? 'good' : 'normal' };
  });
  if (short.length) groups.push({ key: 'short', title: 'Plazo corto de fábrica', items: short });

  const special: ExpeditedItem[] = (data.specialOrder || []).map((i) => {
    const { label } = weekRangeLabel(i);
    return { model: i.model || i.reference || '', reference: i.reference || '', description: i.description || '', statusLabel: label || 'Pedido especial', tone: 'warn' };
  });
  if (special.length) groups.push({ key: 'special', title: 'Pedido especial (fuera de colección)', items: special });

  const disc: ExpeditedItem[] = (data.discontinuedProducts || []).map((i) => ({
    model: i.model || i.reference || '', reference: i.reference || '', description: i.description || '', statusLabel: 'Descontinuado', tone: 'danger',
  }));
  if (disc.length) groups.push({ key: 'discontinued', title: 'Descontinuados', items: disc });

  return {
    hasData: true,
    week: briefing?.weekLabel || briefing?.week || '',
    briefingAt: briefing?.briefingAt ?? null,
    groups,
    total: groups.reduce((n, g) => n + g.items.length, 0),
  };
}
