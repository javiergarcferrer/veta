// Server-side pricing. A price the client asserts is data about the client, not
// about the product: every stored amount is recomputed here from the tenant's
// own price_lists, read through the same RLS the caller is subject to.
//
// Thin by intent — WP-1.4 replaces the arithmetic with `@veta/catalog`
// (placementTotal / applyDealerPricing). What must not change is the direction:
// the payload never supplies a number that gets stored.

import type { PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BuildPiece {
  uid?: string;
  modelId?: string;
  count?: number;
}

export interface Build {
  pieces?: BuildPiece[];
}

export interface PricingSnapshot {
  amount_minor: number;
  currency: string;
  priced_at: string;
  priced_pieces: number;
  unpriced_models: string[];
}

export function piecesOf(build: unknown): BuildPiece[] {
  const raw = (build as Build | null | undefined)?.pieces;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is BuildPiece => !!p && typeof p === 'object');
}

function modelIdsOf(pieces: BuildPiece[]): string[] {
  const ids = new Set<string>();
  for (const p of pieces) {
    if (typeof p.modelId === 'string' && UUID_RE.test(p.modelId)) ids.add(p.modelId);
  }
  return [...ids];
}

function countOf(piece: BuildPiece): number {
  const n = Number(piece.count ?? 1);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.floor(n), 20);
}

export async function priceBuild(
  client: PoolClient,
  collectionId: string,
  build: unknown,
  fallbackCurrency = 'USD',
): Promise<PricingSnapshot> {
  const pieces = piecesOf(build);
  const ids = modelIdsOf(pieces);
  const snapshot: PricingSnapshot = {
    amount_minor: 0,
    currency: fallbackCurrency,
    priced_at: new Date().toISOString(),
    priced_pieces: 0,
    unpriced_models: [],
  };
  if (ids.length === 0) return snapshot;

  // One active price list per brand wins deterministically (newest valid_from).
  const { rows } = await client.query<{ model_id: string; amount_minor: string | null; currency: string | null }>(
    `select distinct on (m.id)
            m.id                      as model_id,
            p.amount_minor            as amount_minor,
            pl.currency               as currency
       from public.models m
       join public.collections col on col.id = m.collection_id
       left join public.price_lists pl
              on pl.brand_id = col.brand_id and pl.status = 'active'
       left join public.prices p
              on p.price_list_id = pl.id and p.sku = m.sku
      where m.id = any($1::uuid[])
        and m.collection_id = $2::uuid
      order by m.id, pl.valid_from desc nulls last, pl.id`,
    [ids, collectionId],
  );

  const byModel = new Map(rows.map((r) => [r.model_id, r]));
  for (const piece of pieces) {
    const id = typeof piece.modelId === 'string' ? piece.modelId : '';
    const row = byModel.get(id);
    if (!row || row.amount_minor == null) {
      if (id && !snapshot.unpriced_models.includes(id)) snapshot.unpriced_models.push(id);
      continue;
    }
    snapshot.amount_minor += Number(row.amount_minor) * countOf(piece);
    snapshot.priced_pieces += countOf(piece);
    if (row.currency) snapshot.currency = row.currency;
  }
  return snapshot;
}
