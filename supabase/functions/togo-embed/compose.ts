// togo-embed/compose.ts — a COMPOSED build, sanitized. The pure Model half of
// direct quote creation, same contract as dealer.ts / payload.ts / quotes.ts:
// no Deno globals, no URL imports, no supabase client — just functions over
// plain values, so the imperative shell (index.ts) owns every read and write.
//
// WHY THIS EXISTS. For its whole life this product had exactly one way to make
// a quote: a VISITOR submits a lead through the public widget, and the
// manufacturer freezes that lead. The manufacturer composing a quote at their
// own desk had to pose as their own customer — build in the widget, submit a
// "lead" to themselves, walk to Solicitudes, freeze it. Three screens of
// charade for the product's central verb.
//
// `createFromBuild` (index.ts) ends that: someone already TRUSTED — a signed-in
// member, or a dealer through its inbox token — posts a build and gets the
// frozen document back in one op. This file holds the two pure rules of that
// door:
//
//   • the ITEMS are sanitized EXACTLY as the lead path sanitizes them
//     (`sanitizeBuildItem` is captureLead's per-item rule, extracted so the two
//     doors cannot drift — a composed build that survived here replays, prices
//     and freezes exactly like a visitor's, because it IS the same shape).
//   • the CONTACT needs only a NAME. The lead path demands a phone or e-mail
//     because the visitor walks away and the dealer must be able to reach them;
//     the composer is standing right there, usually mid-conversation with the
//     customer, and how to reach them can land on the document later. A quote
//     addressed to nobody stays refused — a document states who it is for.
//
// NO PRICING HERE, same as quotes.ts: prices come from the one shared pricer
// (dealer.ts's priceInboxItems via priceRequestRows), and the freeze is the one
// shared freeze (createQuoteFromRequest). This door only decides what a
// composed build is allowed to SAY.

import { sanitizePartFinishes, sanitizePartMaterials } from './dealer.ts';

type Row = Record<string, unknown>;

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown, max = 200): string => String(v ?? '').slice(0, max);

function bag(v: unknown): Row {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
}

/**
 * ONE placement, normalized to the exact shape the stored lead carries and the
 * configurator VM replays. Extracted verbatim from captureLead's map:
 *
 *   • only a literal `partsMode: true` survives (dropping it once made the
 *     replay quote a by-componentes build at the modo-pieza price);
 *   • the base material keeps `{grade, fabric, code}` only when it names a
 *     grade or fabric;
 *   • per-part fabric picks and per-part finish picks ride through the same
 *     sanitizers the lead path uses (dealer.ts), absent when nothing survives.
 *
 * Filtering to KNOWN models stays at the call site: which models exist — and
 * which of them this dealer's scope offers — is a database question, and this
 * module doesn't hold one.
 */
export function sanitizeBuildItem(raw: unknown): Row {
  const it = bag(raw);
  const base: Row = { modelId: String(it.modelId || ''), x: num(it.x), y: num(it.y), rot: num(it.rot) };
  if (it.partsMode === true) base.partsMode = true;
  const mat = it.material && typeof it.material === 'object' ? it.material as Row : null;
  const partMaterials = sanitizePartMaterials(it.partMaterials);
  const withParts = partMaterials ? { ...base, partMaterials } : base;
  const partFinishes = sanitizePartFinishes(it.partFinishes);
  const withFinishes = partFinishes ? { ...withParts, partFinishes } : withParts;
  if (mat && (mat.grade || mat.fabric)) {
    return {
      ...withFinishes,
      material: { grade: str(mat.grade, 8), fabric: str(mat.fabric, 200), code: str(mat.code, 32) },
    };
  }
  return withFinishes;
}

/** The whole build: truncated FIRST (the same cap the lead path applies, so a
 *  45-piece plan drops the same 5 pieces whichever door it enters), then each
 *  placement through the one rule above. */
export function sanitizeBuildItems(rawItems: unknown, max: number): Row[] {
  const rows = Array.isArray(rawItems) ? (rawItems as Row[]).slice(0, max) : [];
  return rows.map(sanitizeBuildItem);
}

/** Who the composed document is FOR. Name required — the rest optional, per the
 *  header. null = refuse the compose (the caller answers 400). */
export function composeContact(raw: unknown): { name: string; phone: string; email: string } | null {
  const c = bag(raw);
  const name = str(c.name, 120).trim();
  if (!name) return null;
  return { name, phone: str(c.phone, 40).trim(), email: str(c.email, 160).trim() };
}
