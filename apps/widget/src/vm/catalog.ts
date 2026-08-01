/**
 * THE CATALOG PROJECTION — one API payload in, exactly what the engines eat out.
 *
 * Every engine this widget drives wants the same facts in a slightly different
 * shape: `@veta/layout` wants footprints and a collection tag, `@veta/catalog`
 * wants price ladders and part bindings, `@veta/rules` wants tags and mounts,
 * `@veta/scene` wants meshes. Deriving those four shapes inside components is
 * how a configurator ends up with four subtly different ideas of one model, so
 * they are derived ONCE, here.
 *
 * Two boundary decisions:
 *
 *   • MONEY ARRIVES IN MINOR UNITS (`{amountMinor, currency}`) and the ported
 *     money rules are written in MAJOR units, so `fromMinor` converts exactly
 *     here — at the wire — and nowhere else downstream.
 *   • THE DEALER PRESENTATION IS ALREADY APPLIED. The API multiplied and
 *     applied `full|from|hidden` before serving, so this file must NOT re-apply
 *     either: re-running the multiplier would mark the catalogue up twice. What
 *     travels forward is the MODE, because the deck still has to decide whether
 *     to show money at all.
 */

import {
  DEFAULT_LAYOUT_PARAMS,
  type LayoutParams,
  type PieceModel,
} from '@veta/layout';
import { fromMinor, validPricingMode, type PriceFamily, type PricingMode, type ResolvedPiece } from '@veta/catalog';
import { parseRuleset, type RuleCatalog, type Ruleset } from '@veta/rules';
import type { CatalogPayload, CollectionView as CollectionRow, FamilyView, MaterialView, ModelView } from './client.ts';

/** One entry in the piece palette — everything a tile and a placement need. */
export interface PaletteItem {
  id: string;
  slug: string;
  name: string;
  widthCm: number;
  depthCm: number;
  heightCm: number;
  tags: string[];
  collection: string;
  /** 'seat' accessories float above the floor plan. */
  mount: 'seat' | null;
  mountHeightCm: number | null;
  meshUrl: string | null;
  meshParams: Record<string, unknown> | null;
  planSvg: string | null;
  sku: string;
  defaultRot: number;
  /** MAJOR units in the catalogue's currency; null = no price on screen. */
  priceUsd: number | null;
}

/** The merged model shape both the layout and the pricing engines consume. */
export type ResolvedModel = PieceModel & ResolvedPiece & PaletteItem;

export interface CollectionSummary {
  id: string;
  slug: string;
  name: string;
  layoutParams: LayoutParams;
  /** `RenderParams` for `@veta/scene`, straight from the collection row. */
  renderParams: Record<string, unknown>;
  taxonomy: Record<string, unknown>;
  pricingMode: PricingMode;
  currency: string;
}

/** A material family (level 1 of the picker) and its colours (level 2). */
export interface MaterialColorOption {
  code: string;
  name: string;
  grade: string;
  rgb: string | null;
  textureUrl: string | null;
  normalUrl: string | null;
  familyId: string;
  familyName: string;
  category: string;
}

export interface MaterialFamily {
  id: string;
  name: string;
  category: string;
  colors: MaterialColorOption[];
}

export interface WidgetCatalog {
  collection: CollectionSummary;
  /** Every collection the tenant published — the collection switcher. */
  collections: Array<{ id: string; slug: string; name: string }>;
  palette: PaletteItem[];
  /** id → the merged model, for layout + pricing + scene. */
  modelById: Record<string, ResolvedModel>;
  /** The projection `@veta/rules` reads (never the raw rows). */
  ruleCatalog: RuleCatalog;
  ruleset: Ruleset | null;
  /** Rule ids the parser dropped — surfaced to the console, never to a visitor. */
  droppedRules: string[];
  families: MaterialFamily[];
  /** code → colour, the flat index the picker and the appearance pipeline share. */
  colorByCode: Record<string, MaterialColorOption>;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

const obj = (v: unknown): Record<string, unknown> => (
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
);

/** The collection's layout tuning, over the engine defaults. */
export function layoutParamsOf(renderParams: Record<string, unknown>): LayoutParams {
  const layout = obj(renderParams.layout ?? renderParams);
  const overlap = obj(layout.linkOverlapCm);
  const linkOverlapCm: Record<string, number> = {};
  for (const [k, v] of Object.entries(overlap)) {
    const cm = Number(v);
    if (Number.isFinite(cm)) linkOverlapCm[String(k).toLowerCase()] = cm;
  }
  return {
    gridCm: num(layout.gridCm, DEFAULT_LAYOUT_PARAMS.gridCm),
    edgeSnapCm: num(layout.edgeSnapCm, DEFAULT_LAYOUT_PARAMS.edgeSnapCm),
    dockCm: num(layout.dockCm, DEFAULT_LAYOUT_PARAMS.dockCm),
    linkOverlapCm: Object.keys(linkOverlapCm).length ? linkOverlapCm : DEFAULT_LAYOUT_PARAMS.linkOverlapCm,
  };
}

/** Only PUBLISHED rows reach a visitor. (RLS already enforces this on the
 *  publishable plane; the client repeats it so a secret-key preview payload
 *  cannot leak a draft into a public embed.) */
const isPublished = (row: { status?: unknown }): boolean => {
  const status = str(row.status);
  return status === '' || status === 'published';
};

/**
 * The wire's minor-unit ladder → the MAJOR-unit family the ported money rules
 * read. This is the ONLY place the conversion happens.
 */
export function familyFromWire(family: FamilyView | null | undefined, currency: string): PriceFamily | null {
  if (!family || !family.byGrade) return null;
  const byGrade: PriceFamily['byGrade'] = {};
  for (const [grade, entry] of Object.entries(family.byGrade)) {
    byGrade[grade] = {
      priceUsd: fromMinor(entry?.amountMinor, entry?.currency ?? currency),
      reference: str(entry?.reference),
    } as PriceFamily['byGrade'][string];
  }
  // An absent OR empty ladder list falls back to the keys actually priced: a
  // single-grade catalogue often states no grades at all, and an empty list
  // would make every grade unreachable.
  const stated = Array.isArray(family.grades) ? family.grades.map(str) : [];
  return {
    root: str(family.root),
    name: str(family.root),
    graded: family.graded === true,
    grades: stated.length ? stated : Object.keys(byGrade),
    byGrade,
  };
}

function toPaletteItem(row: ModelView, collectionSlug: string, currency: string): PaletteItem {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name) || str(row.slug),
    widthCm: num(row.widthCm),
    depthCm: num(row.depthCm),
    heightCm: num(row.heightCm),
    tags: Array.isArray(row.tags) ? row.tags.map(str).filter(Boolean) : [],
    collection: collectionSlug,
    mount: row.mount === 'seat' ? 'seat' : null,
    // The mount HEIGHT is a render fact the wire does not carry yet; a seat
    // accessory falls back to the scene's own platform height until it does.
    mountHeightCm: null,
    meshUrl: str(row.meshPath) || null,
    meshParams: obj(row.meshParams),
    planSvg: null,
    sku: str(row.sku),
    defaultRot: num(row.defaultRot),
    priceUsd: row.price ? fromMinor(row.price.amountMinor, row.price.currency || currency) : null,
  };
}

export interface ResolveCatalogInput {
  payload: CatalogPayload | null | undefined;
  /** The collection to open; '' = the first published one. */
  collectionSlug?: string;
}

/**
 * Project the API payload into the widget's whole catalog.
 *
 * Pure and total: an empty payload yields an empty-but-valid catalog (the View
 * renders "not available yet" rather than crashing), a draft model is dropped,
 * and a malformed ruleset is parsed leniently — `parseRuleset` drops and
 * REPORTS the bad rules instead of failing the configurator shut.
 */
export function resolveWidgetCatalog(input: ResolveCatalogInput): WidgetCatalog {
  const payload = input.payload ?? null;
  const currency = str(payload?.currency).toUpperCase() || 'USD';
  const published = (payload?.collections ?? []).filter(isPublished);
  const row = pickCollection(published, input.collectionSlug ?? '');
  const renderParams = obj(row?.renderParams);

  const collection: CollectionSummary = {
    id: str(row?.id),
    slug: str(row?.slug),
    name: str(row?.name) || str(row?.slug),
    layoutParams: layoutParamsOf(renderParams),
    renderParams: obj(renderParams.render ?? renderParams),
    taxonomy: obj(row?.taxonomy),
    // Already applied server-side — carried only so the deck knows whether to
    // print money (see the module header).
    pricingMode: validPricingMode(payload?.dealer?.mode),
    currency,
  };

  const palette: PaletteItem[] = [];
  const modelById: Record<string, ResolvedModel> = {};
  const ruleModels: RuleCatalog['modelById'] = {};

  for (const model of payload?.models ?? []) {
    if (!model || !isPublished(model)) continue;
    if (collection.id && str(model.collectionId) !== collection.id) continue;
    const item = toPaletteItem(model, collection.slug, currency);
    if (!item.id) continue;

    const partFamilies = model.partFamilies
      ? Object.fromEntries(Object.entries(model.partFamilies).map(([role, fam]) => [role, familyFromWire(fam, currency)]))
      : null;

    const resolved: ResolvedModel = {
      ...item,
      // `@veta/catalog` reads the base price as `unitPrice`; `@veta/layout`
      // reads the footprint. One object satisfies both by construction.
      unitPrice: item.priceUsd,
      reference: item.sku || null,
      baseFamily: familyFromWire(model.family, currency),
      partFamilies,
      parts: null,
    };

    palette.push(item);
    modelById[item.id] = resolved;
    ruleModels[item.id] = {
      collection: item.collection,
      tags: item.tags,
      widthCm: item.widthCm,
      depthCm: item.depthCm,
      mount: item.mount,
    };
  }

  // The ACTIVE ruleset for this collection — a draft one is the studio's
  // business and must never judge a visitor's design.
  const rulesetRow = (payload?.rulesets ?? []).find(
    (r) => str(r.collectionId) === collection.id && str(r.status) === 'active',
  );
  const parsed = rulesetRow ? parseRuleset(rulesetRow.rules) : null;
  const { families, colorByCode } = resolveMaterialFamilies(payload?.materials);

  return {
    collection,
    collections: published.map((c) => ({ id: str(c.id), slug: str(c.slug), name: str(c.name) || str(c.slug) })),
    palette: palette.sort((a, b) => a.name.localeCompare(b.name)),
    modelById,
    ruleCatalog: { modelById: ruleModels },
    ruleset: parsed?.ruleset ?? null,
    droppedRules: (parsed?.dropped ?? []).map((d) => `rule #${d.index}: ${d.reason}`),
    families,
    colorByCode,
  };
}

/**
 * The material rows → the picker's TWO LEVELS: families first (one physical
 * weave), colours second. That hierarchy is not cosmetic — it mirrors the money
 * rule (one fabric across the whole piece bills as one complete element; mixed
 * fabrics bill part by part), so the picker teaches the price model by shape.
 */
export function resolveMaterialFamilies(rows: readonly MaterialView[] | null | undefined): {
  families: MaterialFamily[];
  colorByCode: Record<string, MaterialColorOption>;
} {
  const families: MaterialFamily[] = [];
  const colorByCode: Record<string, MaterialColorOption> = {};

  for (const row of rows ?? []) {
    if (!row) continue;
    const id = str(row.id) || str(row.name);
    const name = str(row.name) || id;
    const category = str(row.category) || 'fabric';
    const colors: MaterialColorOption[] = [];
    for (const c of row.colors ?? []) {
      const code = str(c?.code);
      if (!code) continue;
      const option: MaterialColorOption = {
        code,
        name: str(c?.name) || code,
        grade: str(c?.grade),
        rgb: str(c?.rgb) || null,
        textureUrl: str(c?.texturePath) || null,
        normalUrl: str(c?.normalPath) || null,
        familyId: id,
        familyName: name,
        category,
      };
      colors.push(option);
      // First writer wins: a code is unique per material by the schema's own
      // constraint, so a duplicate is a data bug, not a later override.
      if (!colorByCode[code]) colorByCode[code] = option;
    }
    if (colors.length) families.push({ id, name, category, colors });
  }

  return { families, colorByCode };
}

/**
 * Which collection to open: the requested slug, else the first published one.
 * Returns null when the tenant has none — the View's "not available yet" state.
 */
export function pickCollection(rows: readonly CollectionRow[] | null | undefined, slug: string): CollectionRow | null {
  const list = (rows ?? []).filter(Boolean);
  const wanted = str(slug);
  if (wanted) return list.find((c) => str(c.slug) === wanted) ?? null;
  const published = list.filter(isPublished);
  return published.slice().sort((a, b) => num(a.sortOrder) - num(b.sortOrder))[0] ?? null;
}
