// togo-embed/quotes.ts — THE QUOTE, frozen. The pure Model half of the quoting
// surface, same contract as dealer.ts and payload.ts: no Deno globals, no URL
// imports, no supabase client — just types + pure functions over plain rows, so
// the imperative shell (index.ts) owns every read, write and auth check.
//
// WHAT A QUOTE IS HERE. A visitor builds a composition in the configurator and
// asks for a price; that lands as a `togo_requests` row. The manufacturer turns
// ONE of those into a document it can send: `veta_quotes`. The document carries
// its own copy of everything it states — the pieces, their fabrics, their unit
// prices, the total, the currency, the customer and the brand it was quoted
// under.
//
// WHY IT COPIES INSTEAD OF POINTING AT THE CATALOG (the one rule this file
// exists to hold): a quote is a PROMISE made on a date. Re-deriving its prices
// at render time means tomorrow's price list silently restates yesterday's
// promise — the customer opens the same link and reads a different number.
// So the money is FROZEN here, once, at creation, and after that nothing in this
// codebase can compute it again: `freezeQuoteLines` runs on the priced items
// exactly as the pricer produced them, and every later surface (the internal
// detail, the customer's share page, the list) renders these stored numbers.
// The database enforces the other half — migration 20261130000000 rejects any
// UPDATE that touches lines/totals/currency/customer (see its header).
//
// THERE IS NO PRICING IN THIS FILE. Not a multiplication, not a margin, not a
// rounding step. The prices arrive already resolved from `priceInboxItems`
// (dealer.ts) — the same function the dealer's token-gated inbox prices with and
// the same rules the widget shows a visitor — and this module only chooses which
// of those numbers the document keeps. One pricing implementation, three
// surfaces reading it.

type Row = Record<string, unknown>;

/* --------------------------------- status --------------------------------- */

/** A quote's life: drafted, sent to the customer, then answered either way.
 *  ('archived' is deliberately absent — a quote that goes nowhere is simply an
 *  old draft, and inventing a state for it would only hide it.) */
export const QUOTE_STATUSES: readonly string[] = ['draft', 'sent', 'accepted', 'declined'];

export function isQuoteStatus(v: unknown): boolean {
  return typeof v === 'string' && QUOTE_STATUSES.includes(v);
}

/** The stamp column a status transition writes (null for 'draft' — going back to
 *  a draft clears nothing; the earlier stamp is history, not a claim about now). */
export function statusStampColumn(status: string): string | null {
  if (status === 'sent') return 'sent_at';
  if (status === 'accepted') return 'accepted_at';
  if (status === 'declined') return 'declined_at';
  return null;
}

/* --------------------------------- scope ---------------------------------- */

/**
 * WHO IS ASKING, for every quote op — the one object index.ts threads through
 * the handlers so a single implementation serves three callers:
 *
 *   • `{}`                      — a whole-install member. Sees everything
 *     (today's manufacturer behaviour, unchanged).
 *   • `{ brandIds: [...] }`     — a brand-ASSIGNED member (profiles.brand_access
 *     = 'assigned' + brand_members). Sees only rows stamped with one of their
 *     brands — the same rule the RLS policies apply to direct table reads,
 *     applied HERE because the Edge Function runs on the service role and RLS
 *     cannot see it. An UNSTAMPED row (brand_id null) is visible only to a
 *     whole-install member: "we could not tell whose it was" must not resolve
 *     to "show it to everyone".
 *   • `{ dealerId: '…' }`       — a DEALER, authorized by its inbox token.
 *     Sees only its own rows, full stop; the brand dimension is implied (a
 *     dealer belongs to one brand) and checking the id is the tighter gate.
 *
 * Pure and total on purpose (tests/dealerQuotes.test.js): a scope bug here is a
 * cross-dealer or cross-brand disclosure, so the rule is a function that can be
 * interrogated, not a filter re-typed per handler.
 */
export interface QuoteOpScope {
  dealerId?: string | null;
  brandIds?: readonly string[] | null;
}

/** May this scope see a row carrying (dealer_id, brand_id)? Works for quotes
 *  and leads alike — both carry exactly these two ownership columns. */
export function scopeAllowsRow(
  scope: QuoteOpScope | null | undefined,
  row: { dealer_id?: unknown; brand_id?: unknown } | null | undefined,
): boolean {
  if (!row) return false;
  const s = scope || {};
  if (s.dealerId != null) {
    // A dealer sees its own rows only. `''` can never match a real id.
    return String(row.dealer_id ?? '') === String(s.dealerId) && String(s.dealerId) !== '';
  }
  if (s.brandIds != null) {
    const brand = String(row.brand_id ?? '');
    return brand !== '' && s.brandIds.map(String).includes(brand);
  }
  return true;
}

/* ------------------------------- share token ------------------------------- */

/** The secret in `#/q/<token>`. 32 hex chars of CSPRNG — the token IS the
 *  authorization for a login-less page, so it is never derived from the quote's
 *  id, number or customer (all of which are guessable or enumerable). */
export function mintShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/* ------------------------------ the frozen line ---------------------------- */

export interface FrozenLine {
  id: string;
  modelId: string;
  name: string;
  collection: string;
  widthCm: number;
  depthCm: number;
  /** Where the piece sits on the customer's plan — the drawing is part of the
   *  document, so it freezes with the money. */
  plan: { x: number; y: number; rot: number };
  material: { grade: string; fabric: string; code: string } | null;
  parts: Array<{ role: string; grade: string; fabric: string; code: string }>;
  finishes: Array<{ group: string; option: string }>;
  qty: number;
  /** In the quote's `currency` — already factored (markup × FX) by the pricer. */
  unit: number | null;
  total: number | null;
  /** The elemento completo fold resolved: this ONE price bought the componentes
   *  too, so they print «incluido» instead of a price nobody is charging. */
  complete: boolean;
  /** A pick no ladder prices. It KEEPS ITS LINE (no-vanish) and says so. */
  unpriced: boolean;
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown, max = 200): string => String(v ?? '').slice(0, max);

function bag(v: unknown): Row {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
}

function materialOf(raw: unknown): { grade: string; fabric: string; code: string } | null {
  const m = bag(raw);
  const grade = str(m.grade, 8).trim();
  const fabric = str(m.fabric, 200).trim();
  const code = str(m.code, 32).trim();
  if (!grade && !fabric && !code) return null;
  return { grade, fabric, code };
}

/**
 * The priced items of ONE request → the document's frozen lines.
 *
 * `items` are `priceInboxItems`' output verbatim (each carrying `priceUsd` in
 * the dealer's own currency and, when the fold resolved, `complete: true`), and
 * `models` is the `inboxModelShape` map the same call already loaded — so a line
 * states the piece's name and real dimensions instead of an id. A model that has
 * since vanished still yields a line (its geometry reads 0 and its name falls
 * back to the id): the customer's build is not edited by our catalog moving.
 */
export function freezeQuoteLines(items: unknown[], models: Row): FrozenLine[] {
  const rows = Array.isArray(items) ? items : [];
  return rows.map((raw, i) => {
    const it = bag(raw);
    const modelId = str(it.modelId, 80);
    const m = bag(models[modelId]);
    const price = it.priceUsd == null ? null : num(it.priceUsd);
    const partPicks = bag(it.partMaterials);
    const parts: FrozenLine['parts'] = [];
    for (const [role, pick] of Object.entries(partPicks)) {
      const mat = materialOf(pick);
      if (mat) parts.push({ role: str(role, 40), ...mat });
    }
    const finishPicks = bag(it.partFinishes);
    const finishes: FrozenLine['finishes'] = [];
    for (const [group, option] of Object.entries(finishPicks)) {
      const value = typeof option === 'string' || typeof option === 'number' ? String(option).trim() : '';
      if (value) finishes.push({ group: str(group, 64), option: value.slice(0, 32) });
    }
    return {
      // Stable within the document (position + model), so a React key, an
      // anchor or a print order can never renumber a sent quote.
      id: `${i + 1}-${modelId || 'pieza'}`,
      modelId,
      name: str(m.name, 200) || modelId || '—',
      collection: str(m.collection, 80) || 'Togo',
      widthCm: num(m.widthCm),
      depthCm: num(m.depthCm),
      plan: { x: num(it.x), y: num(it.y), rot: num(it.rot) },
      material: materialOf(it.material),
      parts,
      finishes,
      qty: 1,
      unit: price,
      total: price,
      complete: it.complete === true,
      unpriced: price == null,
    };
  });
}

export interface FrozenTotals {
  currency: string;
  /** The pricer's own sum, carried across verbatim — never re-added here: two
   *  additions of the same numbers is exactly how a document starts disagreeing
   *  with the surface it was made from. */
  total: number | null;
  pieces: number;
  priced: number;
  unpriced: number;
}

export function freezeQuoteTotals(
  lines: FrozenLine[],
  totalFromPricer: number | null,
  currency: string,
): FrozenTotals {
  return {
    currency: currency || 'USD',
    total: totalFromPricer == null ? null : num(totalFromPricer),
    pieces: lines.length,
    priced: lines.filter((l) => !l.unpriced).length,
    unpriced: lines.filter((l) => l.unpriced).length,
  };
}

/* ------------------------------- projections ------------------------------- */

// Coerce a stored timestamp to ISO, guarding an unparseable value (mirrors
// dealer.ts's toIso — each function folder stays self-contained).
function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function linesOf(row: Row): FrozenLine[] {
  return Array.isArray(row.lines) ? (row.lines as FrozenLine[]) : [];
}

function totalsOf(row: Row): Row {
  return bag(row.totals);
}

/** One stored quote → the row the manufacturer's LIST renders. No lines (a list
 *  of 200 quotes must not ship 200 frozen documents), just what a row shows. */
export function quoteListShape(row: Row) {
  const totals = totalsOf(row);
  const customer = bag(row.customer);
  return {
    id: str(row.id, 80),
    number: num(row.number),
    status: str(row.status, 20) || 'draft',
    currency: str(row.currency, 8) || 'USD',
    total: totals.total == null ? null : num(totals.total),
    pieces: num(totals.pieces),
    unpriced: num(totals.unpriced),
    customerName: str(customer.name, 120),
    brandName: str(row.brand_name, 120),
    brandId: row.brand_id == null ? null : str(row.brand_id, 80),
    dealerId: row.dealer_id == null ? null : str(row.dealer_id, 80),
    requestId: row.request_id == null ? null : str(row.request_id, 80),
    shared: !!row.share_token && row.share_enabled !== false,
    shareToken: row.share_token == null ? null : str(row.share_token, 80),
    viewCount: num(row.view_count),
    firstViewedAt: toIso(row.first_viewed_at),
    sentAt: toIso(row.sent_at),
    acceptedAt: toIso(row.accepted_at),
    declinedAt: toIso(row.declined_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** One stored quote → the FULL document the manufacturer's detail page renders:
 *  the list shape plus everything frozen inside it. Still internal — it carries
 *  the customer's phone/email and the originating lead. */
export function quoteDetailShape(row: Row) {
  const customer = bag(row.customer);
  return {
    ...quoteListShape(row),
    customer: {
      name: str(customer.name, 120),
      phone: str(customer.phone, 40),
      email: str(customer.email, 160),
    },
    note: row.note == null ? null : str(row.note, 1000),
    snapshotImageId: row.snapshot_image_id == null ? null : str(row.snapshot_image_id, 120),
    shareEnabled: row.share_enabled !== false,
    lines: linesOf(row),
    totals: totalsOf(row),
  };
}

/** The brand a quote was made under, as the customer's page shows it. */
export interface QuoteBrand {
  name: string;
  logoUrl: string | null;
  locale: string;
  currency: string;
}

/**
 * THE PUBLIC BUNDLE — everything the login-less `#/q/<token>` page renders, and
 * NOTHING else. Whitelisted by construction (the row is never spread): no
 * profile, no dealer id, no request id, no share token echoed back, no
 * internal timestamps beyond the document's own dates, and none of the
 * customer's contact details except the name the quote is addressed to (the page
 * is opened FROM a message already sent to them; re-printing their phone and
 * e-mail on a URL-addressable page adds exposure and tells them nothing).
 *
 * `models` rides along so the page can draw the plan of what they built — plain
 * catalogue geometry, the same shape the dealer inbox already receives.
 */
export function publicQuoteBundle(
  row: Row,
  ctx: { brand: QuoteBrand; models: Row; snapshotUrl: string | null },
) {
  const customer = bag(row.customer);
  const totals = totalsOf(row);
  return {
    quote: {
      number: num(row.number),
      status: str(row.status, 20) || 'draft',
      currency: str(row.currency, 8) || 'USD',
      customerName: str(customer.name, 120),
      note: row.note == null ? null : str(row.note, 1000),
      lines: linesOf(row),
      totals: {
        currency: str(totals.currency, 8) || str(row.currency, 8) || 'USD',
        total: totals.total == null ? null : num(totals.total),
        pieces: num(totals.pieces),
        unpriced: num(totals.unpriced),
      },
      snapshotUrl: ctx.snapshotUrl,
      createdAt: toIso(row.created_at),
      sentAt: toIso(row.sent_at),
      acceptedAt: toIso(row.accepted_at),
      declinedAt: toIso(row.declined_at),
    },
    brand: ctx.brand,
    models: ctx.models,
  };
}

/* ------------------------- the internal request view ------------------------ */

/**
 * `shapeInboxRequest`'s output + the fields only the MANUFACTURER may see: which
 * dealer routed it, whether it already became a quote, the composition snapshot
 * and the row's own clock. The dealer-facing inbox deliberately drops all of
 * these (it must not learn about other people's routing or the app's quote ids),
 * which is why this extension lives here instead of widening that shape.
 */
export function withInternalRequestFields<T extends Row>(shaped: T, row: Row) {
  return {
    ...shaped,
    dealerId: row.dealer_id == null ? null : str(row.dealer_id, 80),
    quoteId: row.quote_id == null ? null : str(row.quote_id, 80),
    snapshotImageId: row.snapshot_image_id == null ? null : str(row.snapshot_image_id, 120),
    updatedAt: toIso(row.updated_at),
  };
}
