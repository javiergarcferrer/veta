// togo-embed/leadDedupe.ts — the PURE half of the lead's idempotency.
//
// The widget POSTs a lead over the public internet from a phone on mobile data.
// A timeout AFTER the row lands (or a visitor tapping «Enviar» twice while the
// spinner hangs) used to create a SECOND togo_requests row: the team gets two
// leads, the worker quotes twice, the customer gets two WhatsApps, and Meta
// counts two Leads (the CAPI dedupe key is per requestId, so a fresh id defeats
// it). Nothing downstream could tell the retry from a real second request.
//
// So the lead carries a KEY derived from its own content — same dealer, same
// contact, same build, same note ⇒ same key — and a submit that repeats a key
// seen within a short window REUSES that request instead of inserting.
// Deliberately WINDOWED, not a unique index: the same customer re-sending the
// same configuration weeks later is a NEW lead and must not be swallowed.
//
// Deno-free (no Deno.*, no URL imports) so the node test imports it, and pure
// so the decision is pinned rather than argued about.

type Row = Record<string, unknown>;

/** How long a repeat of the same key counts as the same submission. Long
    enough for a stalled request + a manual retry, far short of a returning
    customer. */
export const LEAD_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** JSON with object keys SORTED at every depth, so two payloads that differ
    only in key order (a re-serialized retry) hash the same. Arrays keep their
    order — a different placement order is a different build. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Row;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a, 64-bit, as 16 hex chars. Sync + dependency-free (Web Crypto's digest
    is async and this sits on the visitor's submit path); the key is a dedupe
    hint over a 10-minute window, never a security token. */
function fnv1a64(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ BigInt(input.charCodeAt(i))) * PRIME & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

export interface LeadKeyInput {
  /** dealers.id, or '' for Alcover's own embed — two dealers' identical builds
      are different leads. */
  dealerId?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  note?: unknown;
  /** The SANITIZED items array (what actually gets stored). */
  items?: unknown;
}

/** The lead's content fingerprint. Contact identity is normalized the way the
    rest of the app identifies a contact (phone → its LAST TEN DIGITS, the
    phoneKey rule, so country-code variants collapse; email → lowercased), which
    is what makes a retype-and-retry the same lead. */
export function leadDedupeKey(input: LeadKeyInput): string {
  const digits = String(input?.phone ?? '').replace(/\D/g, '');
  const source = stableStringify({
    d: String(input?.dealerId ?? ''),
    n: String(input?.name ?? '').trim().toLowerCase(),
    p: digits.length > 10 ? digits.slice(-10) : digits,
    e: String(input?.email ?? '').trim().toLowerCase(),
    t: String(input?.note ?? '').trim(),
    i: Array.isArray(input?.items) ? input.items : [],
  });
  return fnv1a64(source);
}

export type LeadDedupeDecision = { reuse: string } | { insert: true };

/** Given the rows already carrying this key (any order), decide reuse vs
    insert: the NEWEST one inside the window wins. A row with no usable
    created_at can't be aged, so it never suppresses a lead — losing a lead is
    the only outcome worse than a duplicate. */
export function leadDedupeDecision(
  rows: Row[] | null | undefined,
  nowMs: number,
  windowMs: number = LEAD_DEDUPE_WINDOW_MS,
): LeadDedupeDecision {
  let best: { id: string; at: number } | null = null;
  for (const r of rows || []) {
    const id = String(r?.id ?? '');
    if (!id) continue;
    const raw = r?.created_at ?? r?.createdAt;
    const at = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
    if (!Number.isFinite(at)) continue;
    // Outside the window, or stamped in the future by a skewed clock.
    if (nowMs - at > windowMs || at - nowMs > 60_000) continue;
    if (!best || at > best.at) best = { id, at };
  }
  return best ? { reuse: best.id } : { insert: true };
}

/** True when a PostgREST/Postgres error is "that column doesn't exist (yet)".
    A `main` push can put the function bundle live BEFORE its migration lands,
    and in that window a lead must still be recorded — just without its key. */
export function isMissingColumn(
  err: { code?: unknown; message?: unknown } | null | undefined, column: string,
): boolean {
  if (!err || !column) return false;
  const code = String(err.code ?? '');
  const message = String(err.message ?? '');
  if (!message.includes(column)) return false;
  // 42703 = undefined_column (Postgres); PGRST204 = column not in the schema cache.
  return code === '42703' || code === 'PGRST204' || /column/i.test(message);
}
