/**
 * THE CONFIGURED SKU — one build, one stable token, ≤ 255 characters.
 *
 * A configured piece has no variant of its own: the customer invented it thirty
 * seconds ago out of a model, a fabric and a handful of finishes, and Shopify
 * has no SKU waiting for that combination. So the connector MINTS one, and the
 * whole commerce loop hangs off it — the cart line carries it, the order line
 * item stores it, the merchant's exports group by it, and `webhooks.ts` reads
 * it back to recognise its own order weeks later.
 *
 * Four properties, each load-bearing:
 *
 *   · DETERMINISTIC. The same build always encodes to the same token, so an
 *     order placed twice for the same configuration reconciles instead of
 *     looking like two products.
 *   · ORDER-INDEPENDENT. `pieces` is an array because the configurator places
 *     things in the order the customer clicked; that is UI history, not
 *     identity. Identical pieces are grouped into a quantity and the groups are
 *     sorted by their own canonical signature, so shuffling the array — or
 *     placing the same two modules in the other order — cannot change the SKU.
 *   · BOUNDED. Shopify's SKU field stops at 255 characters. A twelve-piece
 *     sectional does not fit as readable text, so the readable half is a
 *     DIGEST (truncation reported, never silent) and the hash is taken over the
 *     FULL canonical form — two builds that share a readable prefix still get
 *     different tokens.
 *   · DECODABLE. `decodeConfiguredSku` reads the token back into its parts so a
 *     round trip is checkable in a test rather than by eye.
 *
 * ⚠️ THE TOKEN IS AN IDENTITY, NOT A RECORD. The readable segments are
 * uppercase-alnum digests of the real ids (capped per field), and a long build
 * drops groups from the readable half entirely. The authoritative pointer back
 * to the exact configuration is the configuration id / share URL that
 * `cartPayload.ts` puts in the line-item properties. Never try to rebuild a
 * configuration out of a SKU.
 *
 * GRAMMAR (four separators, all RFC 3986 unreserved, so the token survives a
 * URL, a CSV and a spreadsheet unescaped; value tokens are `[A-Z0-9]` only and
 * therefore can never contain a separator):
 *
 *   sku      := 'CFG1' '-' <collection> '-' <groups> '-' <hash>
 *   groups   := group ( '.' group )*  [ '.' 'X' <omitted> ]
 *   group    := 'Q' <qty> '_' 'M' <model> [ '_' 'F' <material> ]
 *               ( '_' 'P' <role> '~' <code> )* ( '_' 'N' <group> '~' <option> )*
 */

/** A material pick as this module reads it — a bare code or a catalogue pick. */
export type SkuPick = string | { code?: string | null } | null | undefined;

/** One placed piece, in the only shape the SKU cares about. */
export interface SkuPiece {
  /** The catalogue model this piece is. A piece without one is not a piece. */
  modelId?: string | null;
  /** The piece's own base material pick. */
  material?: SkuPick;
  /** Per-role material picks (role → code). */
  partMaterials?: Record<string, SkuPick> | null;
  /** Per-group finish picks (group key → option id). */
  partFinishes?: Record<string, string | null | undefined> | null;
  [k: string]: unknown;
}

/** What the customer built: a collection plus the pieces they placed. */
export interface SkuBuild {
  /** Collection id or handle — the placeholder product's dimension. */
  collection?: string | null;
  pieces?: readonly SkuPiece[] | null;
  [k: string]: unknown;
}

/** The SKU version rides the prefix: a grammar change is a new prefix. */
export const CONFIGURED_SKU_VERSION = 1;
export const CONFIGURED_SKU_PREFIX = `CFG${CONFIGURED_SKU_VERSION}`;

/** Shopify's hard ceiling on an inventory item's SKU. */
export const MAX_SKU_LENGTH = 255;

/** Two 32-bit halves, base36, zero-padded — a fixed-width tail. */
export const HASH_LENGTH = 14;

/**
 * Pieces read from one build. Far above any real layout and far below anything
 * ruinous: beyond this the extra pieces are dropped AND reported, because the
 * canonical string is what we hash and an unbounded body must not be able to
 * make hashing the expensive part of a checkout.
 */
export const MAX_SKU_PIECES = 200;

// Per-field readable caps. The hash carries identity; these carry legibility.
const COLLECTION_TOKEN = 12;
const MODEL_TOKEN = 8;
const MATERIAL_TOKEN = 8;
const ROLE_TOKEN = 4;
const FINISH_TOKEN = 6;
const MAX_QTY = 9999;

/* ------------------------------ normalising ------------------------------- */

/** The raw, full-fidelity form of a value — what the HASH sees. */
function raw(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** A pick → its code, whether it arrived as a string or a catalogue pick. */
export function pickCode(v: SkuPick): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    const code = (v as { code?: unknown }).code;
    if (typeof code === 'string') return code.trim();
  }
  return '';
}

/** The readable form of a value: uppercase alnum, capped. Never a separator. */
function token(v: unknown, max: number): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max);
}

/** Record → sorted [key, value] pairs, empties dropped. Sorting is the whole
 *  point: two builds that differ only in key insertion order are one build. */
function pairs(
  src: Record<string, SkuPick> | null | undefined,
  read: (v: SkuPick) => string,
): [string, string][] {
  if (!src || typeof src !== 'object') return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(src)) {
    const key = raw(k);
    const value = raw(read(v));
    if (key && value) out.push([key, value]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

interface CanonPiece {
  model: string;
  material: string;
  parts: [string, string][];
  finishes: [string, string][];
  /** The full-fidelity signature — the grouping key AND what gets hashed. */
  sig: string;
}

function canonPiece(p: SkuPiece): CanonPiece | null {
  const model = raw(p?.modelId);
  if (!model) return null;
  const material = raw(pickCode(p?.material));
  const parts = pairs(p?.partMaterials, pickCode);
  const finishes = pairs(p?.partFinishes as Record<string, SkuPick> | null | undefined, pickCode);
  const sig = [
    `m:${model}`,
    `f:${material}`,
    `p:${parts.map(([k, v]) => `${k}=${v}`).join(',')}`,
    `n:${finishes.map(([k, v]) => `${k}=${v}`).join(',')}`,
  ].join('|');
  return { model, material, parts, finishes, sig };
}

interface CanonGroup extends CanonPiece {
  qty: number;
}

/* --------------------------------- hashing -------------------------------- */

/**
 * FNV-1a, two independent seeds → 64 bits of tail.
 *
 * Deliberately NOT `node:crypto`: this package runs in a worker, an edge
 * runtime and a test alike, and no sibling package imports `node:*`. The tail
 * is a UNIQUENESS token, never a secret or a signature — the authoritative
 * pointer at a configuration is its id, not its SKU — so a non-cryptographic
 * hash with good distribution is the right tool. Both bytes of each code unit
 * are mixed, so an accented fabric code is not silently folded into its ASCII
 * neighbour.
 */
function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 16777619) >>> 0;
  }
  return h >>> 0;
}

const base36 = (n: number): string => n.toString(36).toUpperCase().padStart(7, '0');

/** A canonical string → its fixed-width, uppercase-alnum tail. */
export function skuHash(canonical: string): string {
  return base36(fnv1a(canonical, 0x811c9dc5)) + base36(fnv1a(canonical, 0x5bf03635));
}

/* -------------------------------- encoding -------------------------------- */

/** A piece the encoder refused, and why — surfaced, never swallowed. */
export interface SkuDropped {
  index: number;
  reason: 'no_model' | 'not_an_object' | 'over_piece_cap';
}

export interface ConfiguredSkuPlan {
  /** The token itself. */
  sku: string;
  /** The fixed-width tail, taken over `canonical`. */
  hash: string;
  /** The full-fidelity string the hash was taken over (never truncated). */
  canonical: string;
  /** Distinct piece groups the build resolved to. */
  groups: number;
  /** Groups the 255-character ceiling kept OUT of the readable half. */
  omitted: number;
  /** True when the readable half is a prefix of the build. */
  truncated: boolean;
  /** Input pieces that never made it into the identity at all. */
  dropped: SkuDropped[];
}

function groupsOf(build: SkuBuild | null | undefined): { groups: CanonGroup[]; dropped: SkuDropped[] } {
  const pieces = Array.isArray(build?.pieces) ? build.pieces : [];
  const dropped: SkuDropped[] = [];
  const byS: Map<string, CanonGroup> = new Map();
  pieces.forEach((p, index) => {
    if (index >= MAX_SKU_PIECES) {
      dropped.push({ index, reason: 'over_piece_cap' });
      return;
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      dropped.push({ index, reason: 'not_an_object' });
      return;
    }
    const canon = canonPiece(p);
    if (!canon) {
      dropped.push({ index, reason: 'no_model' });
      return;
    }
    const seen = byS.get(canon.sig);
    if (seen) seen.qty = Math.min(seen.qty + 1, MAX_QTY);
    else byS.set(canon.sig, { ...canon, qty: 1 });
  });
  const groups = [...byS.values()].sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
  return { groups, dropped };
}

/** One group → its readable segment. */
function segmentOf(g: CanonGroup): string {
  let out = `Q${g.qty}_M${token(g.model, MODEL_TOKEN)}`;
  if (g.material) out += `_F${token(g.material, MATERIAL_TOKEN)}`;
  for (const [k, v] of g.parts) out += `_P${token(k, ROLE_TOKEN)}~${token(v, MATERIAL_TOKEN)}`;
  for (const [k, v] of g.finishes) out += `_N${token(k, ROLE_TOKEN)}~${token(v, FINISH_TOKEN)}`;
  return out;
}

/**
 * The full encode, with everything the caller may need to explain the token:
 * what was hashed, how many groups fit, what was dropped on the way in.
 */
export function planConfiguredSku(build: SkuBuild | null | undefined): ConfiguredSkuPlan {
  const { groups, dropped } = groupsOf(build);
  const collection = raw(build?.collection);

  // The hash sees the FULL build — untruncated ids, untruncated group list —
  // so two builds whose readable halves are identical still get different
  // tokens. This is the line that makes truncation safe.
  const canonical = [
    CONFIGURED_SKU_PREFIX,
    `c:${collection}`,
    groups.map((g) => `${g.qty}*${g.sig}`).join(';'),
  ].join('|');
  const hash = skuHash(canonical);

  const head = `${CONFIGURED_SKU_PREFIX}-${token(collection, COLLECTION_TOKEN)}-`;
  const tail = `-${hash}`;
  const budget = MAX_SKU_LENGTH - head.length - tail.length;

  const segments = groups.map(segmentOf);
  let fit = segments.length;
  let blob = segments.join('.');
  // Drop whole groups from the END of the (sorted, deterministic) list until
  // the readable half plus its "and N more" marker fits. The marker itself is
  // part of the budget — a truncation that hides the fact it truncated is the
  // bug this whole module is written against.
  while (fit > 0) {
    const omitted = segments.length - fit;
    const marker = omitted ? `${fit ? '.' : ''}X${omitted}` : '';
    blob = segments.slice(0, fit).join('.') + marker;
    if (blob.length <= budget) break;
    fit -= 1;
  }
  if (fit === 0) {
    const marker = segments.length ? `X${segments.length}` : '';
    blob = marker.length <= budget ? marker : '';
  }

  const omitted = segments.length - fit;
  return {
    sku: `${head}${blob}${tail}`,
    hash,
    canonical,
    groups: groups.length,
    omitted,
    truncated: omitted > 0,
    dropped,
  };
}

/**
 * A build → its configured SKU. Stable, order-independent, ≤ 255 characters.
 * Use `planConfiguredSku` when you need to know whether anything was dropped.
 */
export function encodeConfiguredSku(build: SkuBuild | null | undefined): string {
  return planConfiguredSku(build).sku;
}

/* -------------------------------- decoding -------------------------------- */

export interface DecodedSkuPiece {
  qty: number;
  model: string;
  material: string;
  /** role token → material token. */
  parts: Record<string, string>;
  /** group token → option token. */
  finishes: Record<string, string>;
}

export interface DecodedSku {
  ok: true;
  version: number;
  collection: string;
  pieces: DecodedSkuPiece[];
  hash: string;
  /** True when the token says groups were left out of its readable half. */
  truncated: boolean;
  omitted: number;
  /** Segments the decoder could not read — reported, never guessed at. */
  dropped: { segment: string; reason: string }[];
}

export interface UndecodableSku {
  ok: false;
  reason: 'empty' | 'unknown_prefix' | 'malformed' | 'too_long';
  sku: string;
}

const SKU_SHAPE = /^CFG\d+-[A-Z0-9]*-[A-Z0-9._~]*-[A-Z0-9]+$/;

/** Cheap gate: does this string even claim to be one of ours? */
export function isConfiguredSku(value: unknown): boolean {
  const s = String(value ?? '').trim();
  return s.length <= MAX_SKU_LENGTH && SKU_SHAPE.test(s);
}

function decodeSegment(seg: string): DecodedSkuPiece | { error: string } {
  const slots = seg.split('_');
  const first = slots[0] ?? '';
  if (!/^Q\d+$/.test(first)) return { error: 'no_qty' };
  const piece: DecodedSkuPiece = {
    qty: Number(first.slice(1)),
    model: '',
    material: '',
    parts: {},
    finishes: {},
  };
  let sawModel = false;
  for (const slot of slots.slice(1)) {
    const tag = slot[0];
    const body = slot.slice(1);
    if (tag === 'M') {
      piece.model = body;
      sawModel = true;
    } else if (tag === 'F') {
      piece.material = body;
    } else if (tag === 'P' || tag === 'N') {
      const at = body.indexOf('~');
      if (at < 0) return { error: 'unpaired_slot' };
      const key = body.slice(0, at);
      const value = body.slice(at + 1);
      if (tag === 'P') piece.parts[key] = value;
      else piece.finishes[key] = value;
    } else {
      return { error: 'unknown_slot' };
    }
  }
  if (!sawModel) return { error: 'no_model' };
  return piece;
}

/**
 * A token → its parts. The values are the ENCODER'S tokens (capped,
 * uppercase-alnum), not the original ids — see the header. Decoding exists so a
 * round trip is mechanically checkable and so a reader can answer "how many
 * pieces, of what, in what fabric" without a database.
 */
export function decodeConfiguredSku(value: unknown): DecodedSku | UndecodableSku {
  const sku = String(value ?? '').trim();
  if (!sku) return { ok: false, reason: 'empty', sku };
  if (sku.length > MAX_SKU_LENGTH) return { ok: false, reason: 'too_long', sku };
  const fields = sku.split('-');
  if (fields.length !== 4) return { ok: false, reason: 'malformed', sku };
  const [prefix, collection, blob, hash] = fields as [string, string, string, string];
  const version = /^CFG(\d+)$/.exec(prefix)?.[1];
  if (!version) return { ok: false, reason: 'unknown_prefix', sku };
  if (!hash || !/^[A-Z0-9]+$/.test(hash)) return { ok: false, reason: 'malformed', sku };

  const pieces: DecodedSkuPiece[] = [];
  const dropped: { segment: string; reason: string }[] = [];
  let omitted = 0;
  for (const seg of blob ? blob.split('.') : []) {
    if (/^X\d+$/.test(seg)) {
      omitted += Number(seg.slice(1));
      continue;
    }
    const read = decodeSegment(seg);
    if ('error' in read) dropped.push({ segment: seg, reason: read.error });
    else pieces.push(read);
  }
  return {
    ok: true,
    version: Number(version),
    collection,
    pieces,
    hash,
    truncated: omitted > 0,
    omitted,
    dropped,
  };
}

/**
 * Does this token still describe this build? The check is a re-encode, not a
 * decode: the readable half is lossy by design, so only the encoder can answer
 * — and it answers for truncated tokens too, because the hash covers the whole
 * build.
 */
export function verifyConfiguredSku(sku: unknown, build: SkuBuild | null | undefined): boolean {
  const given = String(sku ?? '').trim();
  return !!given && given === encodeConfiguredSku(build);
}
