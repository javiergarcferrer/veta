// THE TENANT CATALOG READ — every row the engines judge a build against,
// fetched ONCE per request through the caller's own RLS plane.
//
// Two things are deliberate here.
//
//   · Nothing in this file filters by tenant. Every statement runs inside
//     `withTenant`, so the org is the transaction's, not a parameter someone
//     could forget — and the publish gate (a widget never sees a draft model, a
//     draft ruleset or an inactive price list) is a POLICY, not a where-clause
//     an executor re-derives per route. Migration 0002 closes the last three.
//
//   · The engines are pure. `priceBuild` and `deriveVerdict` take this context
//     and no database handle, which is what lets the HTTP parity test replay the
//     `@veta/rules` fixtures through the real routes and lets both engines be
//     unit-tested with a hand-built context.

import type { PoolClient } from 'pg';
import { DEFAULT_LAYOUT_PARAMS } from '@veta/layout';
import type { LayoutParams } from '@veta/layout';
import { fromMinor, lr8DigitGrade, simpleSku } from '@veta/catalog';
import type { PriceProduct, SkuGrammar } from '@veta/catalog';
import type { RuleCatalog, Ruleset } from '@veta/rules';
// The ruleset's PARSE + strictness live in the verdict seam next to the save
// gate they feed; this module only decides which rows to read.
import { parseStoredRuleset } from './verdict.ts';

/** Currency assumed when a brand has no active price list at all. */
export const DEFAULT_CURRENCY = 'USD';

/* --------------------------------- rows ----------------------------------- */

export interface CollectionRow {
  id: string;
  org_id: string;
  brand_id: string;
  slug: string;
  name: string;
  status: string;
  render_params: Record<string, unknown> | null;
  taxonomy: Record<string, unknown> | null;
  sort_order: number;
}

export interface ModelRow {
  id: string;
  collection_id: string;
  slug: string;
  name: string;
  status: string;
  tags: string[] | null;
  width_cm: string | number | null;
  depth_cm: string | number | null;
  height_cm: string | number | null;
  mesh_path: string | null;
  mesh_params: Record<string, unknown> | null;
  mount: unknown;
  default_rot: string | number | null;
  sku: string | null;
  parts: Record<string, unknown> | null;
  sort_order: number;
}

export interface BrandRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  logo_path: string | null;
  theme: Record<string, unknown> | null;
  default_locale: string;
  locales: string[] | null;
}

export interface MaterialRow {
  id: string;
  brand_id: string;
  name: string;
  category: string | null;
  source_adapter: string;
  params: Record<string, unknown> | null;
}

export interface MaterialColorRow {
  id: string;
  material_id: string;
  name: string;
  code: string;
  grade: string;
  rgb: string | null;
  texture_path: string | null;
  normal_path: string | null;
  sort_order: number;
}

export interface PartRoleRow {
  id: string;
  key: string;
  label: Record<string, unknown> | null;
  billing: string;
  sort_order: number;
}

export interface RulesetRow {
  id: string;
  collection_id: string;
  version: number;
  status: string;
  rules: unknown;
}

export interface DealerRow {
  id: string;
  slug: string;
  name: string;
  currency: string;
  pricing: Record<string, unknown> | null;
}

/* ------------------------------- shapes ----------------------------------- */

/** The brand-wide money half: one active price list, its rows, its grammar. */
export interface PriceContext {
  priceListId: string | null;
  currency: string;
  /** Price rows as `@veta/catalog` reads them (MAJOR units, reference strings). */
  products: PriceProduct[];
  grammar: SkuGrammar;
}

/** Everything one collection's build is judged and priced against. */
export interface CollectionContext extends PriceContext {
  collection: CollectionRow;
  models: ModelRow[];
  /** `@veta/rules`' caller-built projection — the engine never fetches. */
  catalog: RuleCatalog;
  /** Collection nesting overlaps (`render_params.linkOverlapCm`) for contacts. */
  layout: LayoutParams;
  /** The ACTIVE ruleset, parsed: resolved params, and the strictness verdict. */
  ruleset: Ruleset | null;
  /**
   * The SAME ruleset as stored. `deriveVerdict` judges against this one so a
   * rule the parser would have dropped surfaces in `unknownRules` instead of
   * quietly not applying (§1.7 — leniency is visible, never silent).
   */
  rulesetRaw: unknown;
  rulesetVersion: number | null;
  /** A collection is STRICT when its ruleset carries at least one error rule. */
  strict: boolean;
}

/* ------------------------------- helpers ---------------------------------- */

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * A model's mount, as the rules engine reads it: `'seat'` or nothing. Stored as
 * jsonb because a mount will grow fields; the ONE thing the engine asks of it is
 * whether the piece floats above the floor plan (seat-mounted accessories never
 * dock and never stretch a run).
 */
export function mountOf(raw: unknown): 'seat' | null {
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'seat' ? 'seat' : null;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['kind', 'type', 'mount', 'on']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim().toLowerCase() === 'seat') return 'seat';
    }
    if (o.seat === true) return 'seat';
  }
  return null;
}

/**
 * The collection's layout params. `linkOverlapCm` is the load-bearing one: a
 * collection whose modules NEST when docked (the reference's 9 cm Saparella
 * seam) must read as CONTACT, not as a gap or a collision — so the contact graph
 * gets the collection's own table when it has one, and the engine defaults
 * otherwise. A present-but-junk table is used as far as it parses; a junk entry
 * is a missing overlap, never an exception.
 */
export function layoutParamsOf(renderParams: unknown): LayoutParams {
  const rp = obj(renderParams);
  const params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };
  for (const key of ['gridCm', 'edgeSnapCm', 'dockCm'] as const) {
    const v = Number(rp[key]);
    if (Number.isFinite(v) && v >= 0) params[key] = v;
  }
  if (rp.linkOverlapCm && typeof rp.linkOverlapCm === 'object' && !Array.isArray(rp.linkOverlapCm)) {
    const table: Record<string, number> = {};
    for (const [collection, cm] of Object.entries(rp.linkOverlapCm as Record<string, unknown>)) {
      const v = Number(cm);
      const key = String(collection).trim().toLowerCase();
      if (key && Number.isFinite(v) && v >= 0) table[key] = v;
    }
    params.linkOverlapCm = table;
  }
  return params;
}

/** The rules-engine projection of the collection's models. */
export function ruleCatalogOf(collectionSlug: string, models: readonly ModelRow[]): RuleCatalog {
  const modelById: RuleCatalog['modelById'] = {};
  for (const m of models) {
    modelById[m.id] = {
      collection: collectionSlug,
      tags: Array.isArray(m.tags) ? m.tags.map((t) => String(t)) : [],
      widthCm: num(m.width_cm),
      depthCm: num(m.depth_cm),
      mount: mountOf(m.mount),
    };
  }
  return { modelById };
}

/** The brand's SKU grammar adapter — how it encodes a fabric grade into a SKU. */
export function grammarFor(adapter: string | null | undefined): SkuGrammar {
  return String(adapter ?? '').trim() === 'lr-8digit-grade' ? lr8DigitGrade : simpleSku;
}

/**
 * Price rows → the catalogue's product list. `prices` stores (sku, grade) as
 * separate columns; a graded row's REFERENCE is what the grammar composes from
 * them, so a brand that authors full references (`15420000C`, grade blank) and
 * one that authors roots plus grades both land on the same family.
 *
 * Money crosses here and only here: the database holds integer MINOR units, the
 * ported money rules run in MAJOR units.
 */
export function productsFrom(
  rows: ReadonlyArray<{ sku: string; grade: string; amount_minor: string | number }>,
  currency: string,
  grammar: SkuGrammar,
): PriceProduct[] {
  return rows.map((row) => {
    const sku = String(row.sku ?? '');
    const grade = String(row.grade ?? '');
    return {
      reference: grade ? grammar.composeSku(sku, grade) : sku,
      name: '',
      priceUsd: fromMinor(row.amount_minor, currency),
    };
  });
}

/* -------------------------------- loaders --------------------------------- */

export async function loadCollectionBySlug(
  client: PoolClient,
  slug: string,
): Promise<CollectionRow | null> {
  const r = await client.query<CollectionRow>(
    `select id, org_id, brand_id, slug, name, status, render_params, taxonomy, sort_order
       from public.collections where slug = $1 limit 1`,
    [slug],
  );
  return r.rows[0] ?? null;
}

export async function loadCollectionById(
  client: PoolClient,
  id: string,
): Promise<CollectionRow | null> {
  const r = await client.query<CollectionRow>(
    `select id, org_id, brand_id, slug, name, status, render_params, taxonomy, sort_order
       from public.collections where id = $1::uuid limit 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function loadCollections(client: PoolClient): Promise<CollectionRow[]> {
  const r = await client.query<CollectionRow>(
    `select id, org_id, brand_id, slug, name, status, render_params, taxonomy, sort_order
       from public.collections order by sort_order, name`,
  );
  return r.rows;
}

const MODEL_COLUMNS = `m.id, m.collection_id, m.slug, m.name, m.status, m.tags,
                       m.width_cm, m.depth_cm, m.height_cm, m.mesh_path, m.mesh_params,
                       m.mount, m.default_rot, m.sku, m.parts, m.sort_order`;

export async function loadModels(
  client: PoolClient,
  where: { collectionId?: string; modelIds?: string[] } = {},
): Promise<ModelRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (where.collectionId) {
    params.push(where.collectionId);
    clauses.push(`m.collection_id = $${params.length}::uuid`);
  }
  if (where.modelIds) {
    if (!where.modelIds.length) return [];
    params.push(where.modelIds);
    clauses.push(`m.id = any($${params.length}::uuid[])`);
  }
  const r = await client.query<ModelRow>(
    `select ${MODEL_COLUMNS}
       from public.models m
      ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
      order by m.sort_order, m.name`,
    params,
  );
  return r.rows;
}

/**
 * The brand's money context. Several price lists may be `active` at once (a
 * scheduled list published early); the winner is deterministic — newest
 * `valid_from`, then id — so two identical requests can never price differently.
 */
export async function loadPriceContext(client: PoolClient, brandId: string): Promise<PriceContext> {
  const grammarRow = await client.query<{ adapter: string }>(
    'select adapter from public.sku_grammars where brand_id = $1::uuid limit 1',
    [brandId],
  );
  const grammar = grammarFor(grammarRow.rows[0]?.adapter);

  const listRow = await client.query<{ id: string; currency: string }>(
    `select id, currency from public.price_lists
      where brand_id = $1::uuid and status = 'active'
      order by valid_from desc nulls last, id
      limit 1`,
    [brandId],
  );
  const list = listRow.rows[0];
  if (!list) return { priceListId: null, currency: DEFAULT_CURRENCY, products: [], grammar };

  const currency = String(list.currency ?? DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY;
  const priceRows = await client.query<{ sku: string; grade: string; amount_minor: string }>(
    `select sku, grade, amount_minor from public.prices
      where price_list_id = $1::uuid
      order by sku, grade`,
    [list.id],
  );
  return {
    priceListId: list.id,
    currency,
    products: productsFrom(priceRows.rows, currency, grammar),
    grammar,
  };
}

export async function loadActiveRuleset(
  client: PoolClient,
  collectionId: string,
): Promise<RulesetRow | null> {
  const r = await client.query<RulesetRow>(
    `select id, collection_id, version, status, rules
       from public.rulesets
      where collection_id = $1::uuid and status = 'active'
      order by version desc
      limit 1`,
    [collectionId],
  );
  return r.rows[0] ?? null;
}

export async function loadBrand(client: PoolClient): Promise<BrandRow | null> {
  // One brand per org in S1 (`brands` carries `unique (org_id)`), so the tenant
  // transaction already names it — there is no id to pass and none to forget.
  const r = await client.query<BrandRow>(
    'select id, org_id, name, slug, logo_path, theme, default_locale, locales from public.brands limit 1',
  );
  return r.rows[0] ?? null;
}

export async function loadMaterials(client: PoolClient): Promise<MaterialRow[]> {
  const r = await client.query<MaterialRow>(
    `select id, brand_id, name, category, source_adapter, params
       from public.materials order by name`,
  );
  return r.rows;
}

export async function loadMaterialColors(client: PoolClient): Promise<MaterialColorRow[]> {
  const r = await client.query<MaterialColorRow>(
    `select id, material_id, name, code, grade, rgb, texture_path, normal_path, sort_order
       from public.material_colors order by sort_order, name`,
  );
  return r.rows;
}

export async function loadPartRoles(client: PoolClient): Promise<PartRoleRow[]> {
  const r = await client.query<PartRoleRow>(
    'select id, key, label, billing, sort_order from public.part_roles order by sort_order, key',
  );
  return r.rows;
}

/** Every ruleset this plane may read — active-only on the publishable plane. */
export async function loadRulesets(client: PoolClient): Promise<RulesetRow[]> {
  const r = await client.query<RulesetRow>(
    `select id, collection_id, version, status, rules
       from public.rulesets order by collection_id, version desc`,
  );
  return r.rows;
}

export async function loadDealer(client: PoolClient, slug: string): Promise<DealerRow | null> {
  const r = await client.query<DealerRow>(
    `select id, slug, name, currency, pricing from public.dealers
      where slug = $1 and status = 'active' limit 1`,
    [slug],
  );
  return r.rows[0] ?? null;
}

/**
 * ONE read for the whole judging surface of a collection. `modelIds` narrows the
 * model read to what a build actually references — a save must not pull a
 * thousand-model catalogue to price four pieces.
 */
export async function loadCollectionContext(
  client: PoolClient,
  collection: CollectionRow,
  opts: { modelIds?: string[] } = {},
): Promise<CollectionContext> {
  // Sequential on purpose: these share ONE pooled client, and overlapping
  // queries on a single connection are a deprecated pg behaviour (it silently
  // queues them today and stops in pg@9). The transaction is already open —
  // nothing is saved by pretending they are parallel.
  const models = await loadModels(client, { collectionId: collection.id, modelIds: opts.modelIds });
  const price = await loadPriceContext(client, collection.brand_id);
  const rulesetRow = await loadActiveRuleset(client, collection.id);

  const parsed = rulesetRow ? parseStoredRuleset(rulesetRow.rules) : null;

  return {
    collection,
    models,
    catalog: ruleCatalogOf(collection.slug, models),
    layout: layoutParamsOf(collection.render_params),
    ruleset: parsed?.ruleset ?? null,
    rulesetRaw: rulesetRow?.rules ?? null,
    rulesetVersion: rulesetRow?.version ?? null,
    strict: parsed?.strict ?? false,
    ...price,
  };
}
