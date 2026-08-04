// ViewModel for WhatsApp template HEALTH — the approval state of each message
// template plus, when Meta REJECTED one, a human-readable reason.
//
// Two inputs, both already fetched by the View:
//   • templates  — the live Meta list (lib listWaTemplates), each carrying
//     name/status/category/language and, for rejected ones, `rejectedReason`
//     (Meta's machine code, e.g. INVALID_FORMAT).
//   • rejections — the durable wa_template_rejections rows wa-webhook persists
//     (camelCase via rowMapping: { templateName, language, rejectedReason }).
//     They cover the case where Meta rejected a template asynchronously and the
//     live `rejectedReason` is no longer populated.
//
// Pure projection — no React, no db, no supabase. The Difusión page fetches,
// calls this in useMemo, renders.

import { resolveLinkPreview } from './linkPreview.js';

/** Meta's machine rejection codes → dealer-readable Spanish. Unknown codes
 *  fall back to a humanized version of the code itself. */
const REJECTION_REASONS = {
  ABUSIVE_CONTENT: 'Contenido considerado abusivo o que infringe las políticas de WhatsApp.',
  INVALID_FORMAT: 'Formato inválido — revisa las variables ({{1}}), el encabezado, el pie o los botones.',
  SCAM: 'Meta lo marcó como posible estafa o engaño. Reformula el mensaje.',
  TAG_CONTENT_MISMATCH: 'La categoría no coincide con el contenido (p. ej. una promoción enviada como Utilidad). Cámbiala a Marketing.',
  PROMOTIONAL: 'Contenido promocional en una plantilla de Utilidad. Crea la plantilla como Marketing.',
  INCORRECT_CATEGORY: 'La categoría elegida no corresponde al contenido. Cambia entre Marketing y Utilidad.',
  NONE: '',
};

/** Humanize a raw reason code (UPPER_SNAKE → "Upper snake") for unknown ones. */
function humanizeReason(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  return REJECTION_REASONS[c.toUpperCase()] !== undefined
    ? REJECTION_REASONS[c.toUpperCase()]
    : c.replace(/_/g, ' ').toLowerCase().replace(/^./, (m) => m.toUpperCase());
}

/**
 * Merge the live template list with the durable rejection records.
 *
 *   resolveTemplateHealth(templates, rejections)
 *     → [{ name, language, status, category, rejected, reasonCode, reason }]
 *
 * `rejected` is true when status is REJECTED. `reasonCode` is Meta's raw code
 * (from the live list, or the persisted record as fallback); `reason` is the
 * Spanish, dealer-readable text ('' when there's no usable reason).
 * The output preserves the input template order.
 */
/** The registered URL-button base of a template minus its {{1}} suffix — what
 *  Meta prefixes the send-time link with (mirrors cardForTemplate/pick in the
 *  chat modal). '' when the template has no URL button. */
function buttonUrlBase(t) {
  return String(t?.buttonUrl || '').replace(/\{\{1\}\}\s*$/, '');
}

/**
 * Group the WABA templates for the chat attach-tray send flow — turn the ones
 * that "make sense" into one-tap ACTIONS, keep the lifecycle ones the program
 * sends by itself OUT of the manual picker, and surface promos on their own.
 *
 *   resolveTemplateGroups(templates, { slotNames, library }) → {
 *     actions:   [{ template, kind, entry }],  // one-tap sendables, library order
 *     promos:    [template…],                  // quick-send marketing promos
 *     automatic: [{ template, slot }],         // program-event slots — NOT manual
 *     others:    [template…],                  // everything else (incl. non-APPROVED)
 *   }
 *
 * Inputs (both already resolved by the View):
 *   • slotNames — the settings PROGRAM-EVENT slots as
 *     [{ name: 'cotizacion_enviar', slot: 'Cotización' }, …]. Empty names are
 *     skipped. A template whose `name` matches a slot lands in `automatic` (with
 *     that slot label) REGARDLESS of anything else — the program sends these on
 *     its own lifecycle events (quote send / embarque / entrega), so a manual
 *     duplicate send from the tray is exactly the bug this prevents.
 *   • library — resolvePreviewLibrary(origin) entries [{ kind, label, … }]; the
 *     kinds define BOTH which URL-button templates become actions AND the order
 *     the actions render in.
 *
 * Classification (a template lands in exactly one bucket, input order preserved
 * within each unless noted):
 *   1. name matches a slot                         → automatic  (wins over all)
 *   2. not APPROVED                                → others
 *   3. name starts with `promo` (case-insensitive) → promos  (a promo may carry
 *      a tienda button; the name marks the intent and beats a kind match)
 *   4. URL-button base resolves to a library kind  → actions   (any category)
 *   5. category MARKETING (no kind match)          → promos
 *   6. otherwise                                   → others
 *
 * `actions` is sorted by the library's kind order, then template name.
 * Pure: no React, no db.
 */
export function resolveTemplateGroups(templates, { slotNames = [], library = [] } = {}) {
  // Slot name → program-event label (skip empty slot names).
  const slotByName = new Map();
  for (const s of slotNames || []) {
    const name = (s?.name || '').trim();
    if (name) slotByName.set(name, s.slot || '');
  }
  // Library kind → { entry, order } for the action match + ordering.
  const kindOrder = new Map();
  (library || []).forEach((e, i) => { if (e?.kind) kindOrder.set(e.kind, { entry: e, order: i }); });

  const actions = [];
  const promos = [];
  const automatic = [];
  const others = [];

  for (const t of templates || []) {
    const name = t?.name || '';
    // 1. Program-event slot wins over everything — never manually sendable here.
    if (slotByName.has(name)) { automatic.push({ template: t, slot: slotByName.get(name) }); continue; }
    // 2. Non-APPROVED (PENDING/REJECTED/…) → others (rendered disabled with reason).
    if (String(t?.status || '').toUpperCase() !== 'APPROVED') { others.push(t); continue; }
    const isPromo = /^promo/i.test(name);
    const kind = resolveLinkPreview(buttonUrlBase(t))?.kind;
    const match = kind ? kindOrder.get(kind) : null;
    // 3. A `promo*` name marks marketing intent and beats a kind match.
    if (isPromo) { promos.push(t); continue; }
    // 4. URL button that points at one of OUR link kinds → one-tap action.
    if (match) { actions.push({ template: t, kind, entry: match.entry }); continue; }
    // 5. Marketing without a kind match is still a quick-send promo.
    if (String(t?.category || '').toUpperCase() === 'MARKETING') { promos.push(t); continue; }
    // 6. Everything else (UTILITY without a card, etc.).
    others.push(t);
  }

  // Order actions by the library's kind order, then name — a stable, dealer-
  // predictable row order independent of Meta's list order.
  actions.sort((a, b) => {
    const oa = kindOrder.get(a.kind)?.order ?? 0;
    const ob = kindOrder.get(b.kind)?.order ?? 0;
    return oa - ob || (a.template?.name || '').localeCompare(b.template?.name || '');
  });

  return { actions, promos, automatic, others };
}

export function resolveTemplateHealth(templates, rejections) {
  // Index the durable rejections by name+language (and a name-only fallback,
  // since a status update may not carry the language).
  const byKey = new Map();
  const byName = new Map();
  for (const r of rejections || []) {
    const name = r?.templateName || '';
    if (!name) continue;
    const lang = r?.language || '';
    byKey.set(`${name}:${lang}`, r);
    if (!byName.has(name)) byName.set(name, r);
  }

  return (templates || []).map((t) => {
    const name = t?.name || '';
    const language = t?.language || '';
    const status = String(t?.status || '').toUpperCase();
    const rejected = status === 'REJECTED';

    // Prefer the live reason; fall back to the persisted record (exact
    // name+language, then name-only).
    const persisted = byKey.get(`${name}:${language}`) || byName.get(name) || null;
    const reasonCode = String(t?.rejectedReason || persisted?.rejectedReason || '').trim();

    return {
      name,
      language,
      status,
      category: String(t?.category || '').toUpperCase(),
      rejected,
      reasonCode: rejected ? reasonCode : '',
      reason: rejected ? humanizeReason(reasonCode) : '',
    };
  });
}
