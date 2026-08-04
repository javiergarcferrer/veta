// Why a campaign message didn't arrive — and whether trying again can fix it.
//
// A card that says "17 fallidos" and nothing else is a dead end: the dealer
// can't tell an invalid number from a Meta hiccup, so nothing gets done about
// either. Meta's numeric error code is the stable key (the prose varies, and
// arrives in English for anything unmapped), so every failure is explained,
// grouped, and classified retryable-or-not from the code.
//
// Retryable means: the SAME send, unchanged, has a real chance of arriving
// later. It is deliberately conservative — re-sending marketing to a number
// that structurally can't receive it burns money and the number's quality
// rating for nothing.

import { phoneKey, displayPhone, groupKey } from '../../../lib/phone.js';

/**
 * Meta Cloud API send/delivery errors, as they actually reach a campaign.
 * `reason` says what happened, `action` what the dealer can do about it.
 * Sources: Meta's Cloud API error reference + the codes this WABA has really
 * produced (131026 undeliverable, 131049 ecosystem hold, 130472 experiment).
 */
export const WA_FAILURE_REASONS = {
  131026: {
    reason: 'El número no pudo recibir el mensaje',
    action: 'Suele ser un número sin WhatsApp, mal escrito o una cuenta que ya no existe. Verifica el número en la ficha del contacto.',
    retryable: false,
  },
  131049: {
    reason: 'Meta frenó el envío para cuidar la experiencia del usuario',
    action: 'Es el límite de marketing por usuario: Meta le entrega pocos mensajes promocionales al día. Se puede reintentar más tarde; no es culpa del número.',
    retryable: true,
  },
  // 130472 is NOT 131049. Meta holds a random subset of users OUT of marketing
  // template messages for the length of an experiment — every send to them
  // fails again while the hold lasts, so this is structural for the campaign's
  // lifetime even though Meta lifts it on its own eventually. Retrying is a
  // guaranteed failure that still costs money and quality rating.
  130472: {
    reason: 'Meta tiene a este contacto en un experimento',
    action: 'Mientras dura, no recibe marketing de NINGÚN negocio — no es un problema de tu número ni del suyo. Meta lo libera solo; no reintentar.',
    retryable: false,
  },
  131047: {
    reason: 'Ventana de 24 h cerrada',
    action: 'Requiere una plantilla aprobada. Si la campaña ya usa plantilla, reintenta: suele ser temporal.',
    retryable: true,
  },
  131050: {
    reason: 'El contacto se dio de baja del marketing',
    action: 'Meta bloquea el envío. Queda en la lista de bajas y no se le vuelve a escribir — no reintentar.',
    retryable: false,
  },
  131051: { reason: 'Tipo de mensaje no soportado por el destinatario', action: 'Su WhatsApp no puede mostrar este formato. Revisa la plantilla.', retryable: false },
  131053: { reason: 'Meta no pudo procesar el archivo adjunto', action: 'Vuelve a subir la imagen de la promoción (JPG o PNG, máx. 5 MB) y reintenta.', retryable: true },
  130429: { reason: 'Se alcanzó el límite de velocidad de envío', action: 'Meta pidió bajar el ritmo. Reintentar más tarde resuelve esto.', retryable: true },
  131056: { reason: 'Demasiados mensajes a este mismo número', action: 'Límite entre tu número y ese contacto. Reintentar más tarde.', retryable: true },
  131048: { reason: 'Límite de calidad del número', action: 'Meta restringió el envío por la calificación del número. Espera y reintenta; revisa la calidad en Configuración.', retryable: true },
  131045: { reason: 'Problema de certificado del número', action: 'Revisa la conexión de WhatsApp en Configuración.', retryable: false },
  132000: { reason: 'La plantilla no coincide con los parámetros enviados', action: 'El número de variables no cuadra con la plantilla. Revísala en Plantillas.', retryable: false },
  132001: { reason: 'La plantilla no existe en ese idioma', action: 'Revisa el nombre y el idioma de la plantilla en Plantillas.', retryable: false },
  132005: { reason: 'El texto traducido supera el límite', action: 'Acorta el contenido de la plantilla.', retryable: false },
  132007: { reason: 'El contenido de la plantilla infringe las políticas', action: 'Meta rechazó el contenido. Edita la plantilla y vuelve a enviarla a revisión.', retryable: false },
  132012: { reason: 'Formato de parámetro inválido', action: 'Alguna variable lleva un valor que Meta no acepta (vacío o con saltos de línea).', retryable: false },
  132015: { reason: 'La plantilla está pausada por baja calidad', action: 'Meta la pausó. Usa otra plantilla aprobada o espera a que se reactive.', retryable: false },
  132016: { reason: 'La plantilla fue deshabilitada por Meta', action: 'No se puede volver a usar. Crea una plantilla nueva.', retryable: false },
  133010: { reason: 'El número no está registrado en la API', action: 'Revisa la conexión de WhatsApp en Configuración.', retryable: false },
  368: { reason: 'Cuenta restringida temporalmente por Meta', action: 'Restricción a nivel de cuenta. Espera y reintenta.', retryable: true },
  80007: { reason: 'Límite de la cuenta alcanzado', action: 'Superaste el cupo de envíos. Reintenta más tarde.', retryable: true },
  0: {
    reason: 'Error de red o interrupción del envío',
    action: 'El mensaje no llegó a salir. Reintentar suele resolverlo.',
    retryable: true,
  },
};

/** The catch-all for a code we haven't mapped: unknown ≠ hopeless, but it is
 *  NOT auto-retryable — a code we can't reason about must not silently
 *  re-spend the dealer's money. */
const UNKNOWN = {
  reason: 'Error no catalogado de Meta',
  action: 'Revisa el detalle técnico. Si se repite en muchos contactos, avísanos para clasificarlo.',
  retryable: false,
};

/**
 * Rows written before `error_code` existed carry only the prose. Reading the
 * code off them as "missing" would file every historic failure under "error de
 * red" — and mark an undeliverable number RETRYABLE, which is exactly the
 * mistake that re-spends money for nothing. So a legacy row is classified by
 * the sentence it stored, which we ourselves wrote (or passed through verbatim
 * from Meta).
 */
const LEGACY_PROSE = [
  [/no puede recibir el mensaje|undeliverable|ventana cerrada/i, 131026],
  // The experiment hold (130472) and the per-user marketing limit (131049) are
  // different codes with different retryability — reading both off one pattern
  // is what filed held-out numbers as retryable and re-sent to them for nothing.
  [/part of an experiment|experimento/i, 130472],
  [/healthy ecosystem|límite por usuario/i, 131049],
  [/opt(ed)?[- ]?out|se dio de baja/i, 131050],
  [/rate limit|too many messages|límite de velocidad/i, 130429],
  [/template .*(paused|pausada)/i, 132015],
  [/template .*(disabled|deshabilitada)/i, 132016],
  [/no existe|does not exist|not found/i, 132001],
];

/** The effective Meta code for a failure row: the stored code when we have it,
 *  otherwise inferred from the prose, otherwise 0 (a genuine unknown/no-answer). */
export function failureCodeOf({ errorCode, error } = {}) {
  const n = Number(errorCode);
  if (Number.isFinite(n) && n > 0) return n;
  const text = String(error || '');
  for (const [re, code] of LEGACY_PROSE) if (re.test(text)) return code;
  return 0;
}

/** What a given Meta error code means for a campaign. */
export function failureReason(code) {
  const n = Number(code);
  return WA_FAILURE_REASONS[n] || UNKNOWN;
}

/** A number WhatsApp could never deliver to — too few digits to be a real
 *  line. These must be surfaced as a data problem in the contact's ficha, not
 *  burned as a send attempt (a saved "809-519-43" cost a real send). */
export function isSendablePhone(phone) {
  return String(phone || '').replace(/\D/g, '').length >= 10;
}

/**
 * The delivery-failure report for one campaign.
 *
 *   resolveCampaignFailures({ messages, campaignId, customers, professionals })
 *     → { total, retryable, groups: [{ code, reason, action, retryable, count,
 *                                      detail, recipients: [{ key, name, phone }] }] }
 *
 * Per RECIPIENT, not per row: someone whose first attempt failed and whose
 * retry went through is NOT a failure — they have the message. Groups come
 * back worst-first (biggest count), each carrying who it hit so the dealer can
 * act on the actual contacts.
 */
export function resolveCampaignFailures({ messages, campaignId, customers, professionals } = {}) {
  if (!campaignId) return { total: 0, retryable: 0, groups: [] };

  // Name lookup by phone key — a report that lists bare numbers is barely
  // better than a count.
  const names = new Map();
  for (const row of [...(professionals || []), ...(customers || [])]) {
    const key = phoneKey(row?.phone);
    if (key && !names.has(key)) names.set(key, row.name || row.company || '');
  }

  // Collect per recipient: did anything succeed, and what was the last failure.
  const byRecipient = new Map();
  for (const m of messages || []) {
    if (m.campaignId !== campaignId) continue;
    const key = m.groupId ? groupKey(m.groupId) : phoneKey(m.phone);
    if (!key) continue;
    const prev = byRecipient.get(key) || { key, delivered: false, fail: null, phone: m.phone, groupId: m.groupId || null };
    if (m.status === 'failed') {
      // Keep the LATEST failure — that's the state the dealer must act on.
      if (!prev.fail || (m.createdAt || 0) >= (prev.fail.createdAt || 0)) {
        prev.fail = { code: failureCodeOf(m), detail: m.error || '', createdAt: m.createdAt || 0 };
      }
    } else prev.delivered = true;
    byRecipient.set(key, prev);
  }

  const groups = new Map();
  let total = 0;
  for (const r of byRecipient.values()) {
    if (r.delivered || !r.fail) continue; // a retry that landed is not a failure
    total += 1;
    const code = r.fail.code ?? 0;
    if (!groups.has(code)) {
      const info = failureReason(code);
      groups.set(code, {
        code,
        reason: info.reason,
        action: info.action,
        retryable: info.retryable,
        // Meta's own words, kept for the one case the dealer needs to escalate.
        detail: r.fail.detail || '',
        count: 0,
        recipients: [],
      });
    }
    const g = groups.get(code);
    g.count += 1;
    if (!g.detail && r.fail.detail) g.detail = r.fail.detail;
    g.recipients.push({
      key: r.key,
      name: names.get(r.key) || (r.groupId ? 'Grupo' : displayPhone(r.phone)),
      phone: r.phone || '',
      isGroup: !!r.groupId,
    });
  }

  const out = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const g of out) g.recipients.sort((a, b) => a.name.localeCompare(b.name));
  return {
    total,
    retryable: out.filter((g) => g.retryable).reduce((n, g) => n + g.count, 0),
    groups: out,
  };
}

/** Delivery stage of an outbound row, furthest wins. */
const STAGE = { accepted: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Did the campaign actually reach everybody? Measured against the WHOLE contact
 * list, not against the audience that happened to be picked — "se quedó en 167"
 * is answered here.
 *
 *   resolveCampaignCoverage({ messages, campaignId, customers, professionals,
 *                             optOutKeys })
 *     → { audience, reached, delivered, enRoute, read, failed,
 *         missing: [{ key, name, phone, reason }], retryKeys, invalid }
 *
 * The three states that get confused, kept apart on purpose:
 *   • delivered — WhatsApp confirmed it landed.
 *   • enRoute   — Meta accepted it and is still delivering (phone off). NOT a
 *                 failure and NOT something to re-send: doing so double-bills
 *                 and double-messages someone who is about to get it.
 *   • failed    — it will not arrive on its own.
 *
 * `missing` is everyone with no live message: never attempted, or failed.
 * `retryKeys` is the subset worth sending again — never-attempted plus
 * retryable failures, minus opt-outs and unsendable numbers.
 */
export function resolveCampaignCoverage({
  messages, campaignId, customers, professionals, optOutKeys,
} = {}) {
  const suppressed = optOutKeys instanceof Set ? optOutKeys : new Set(optOutKeys || []);

  // Everyone with a phone, deduped the way WhatsApp delivers: by number.
  const contacts = new Map();
  for (const row of [...(professionals || []), ...(customers || [])]) {
    const key = phoneKey(row?.phone);
    if (!key || contacts.has(key)) continue;
    contacts.set(key, { key, name: row.name || row.company || displayPhone(row.phone), phone: row.phone || '' });
  }

  const state = new Map(); // key → { stage, fail }
  for (const m of messages || []) {
    if (!campaignId || m.campaignId !== campaignId) continue;
    const key = m.groupId ? groupKey(m.groupId) : phoneKey(m.phone);
    if (!key) continue;
    const prev = state.get(key) || { stage: 0, fail: null };
    if (m.status === 'failed') {
      if (!prev.fail || (m.createdAt || 0) >= (prev.fail.createdAt || 0)) {
        prev.fail = { code: failureCodeOf(m), createdAt: m.createdAt || 0 };
      }
    } else prev.stage = Math.max(prev.stage, STAGE[m.status] || 0);
    state.set(key, prev);
  }

  let reached = 0;
  let delivered = 0;
  let read = 0;
  for (const s of state.values()) {
    if (s.stage >= 1) reached += 1;
    if (s.stage >= 3) delivered += 1;
    if (s.stage >= 4) read += 1;
  }

  const missing = [];
  const invalid = [];
  const retryKeys = [];
  for (const c of contacts.values()) {
    const s = state.get(c.key);
    if (s && s.stage >= 1) continue; // has the message (delivered or en route)
    const sendable = isSendablePhone(c.phone);
    if (!sendable) invalid.push(c);
    const reason = !sendable ? 'invalid-phone'
      : suppressed.has(c.key) ? 'opted-out'
        : !s ? 'never'
          : failureReason(s.fail?.code).retryable ? 'failed-retryable' : 'failed-structural';
    missing.push({ ...c, reason, code: s?.fail?.code ?? null });
    if (reason === 'never' || reason === 'failed-retryable') retryKeys.push(c.key);
  }
  missing.sort((a, b) => a.name.localeCompare(b.name));

  return {
    audience: contacts.size,
    reached,
    delivered,
    enRoute: Math.max(0, reached - delivered),
    read,
    failed: missing.filter((m) => m.reason.startsWith('failed')).length,
    never: missing.filter((m) => m.reason === 'never').length,
    missing,
    retryKeys,
    invalid,
  };
}

/**
 * The audience keys worth sending again — every recipient in a RETRYABLE
 * failure group. Feed these back through the ordinary campaign send (the
 * server re-checks opt-outs and skips anyone who since received the message).
 *
 *   retryableFailureKeys(report) → string[]
 */
export function retryableFailureKeys(report) {
  const out = [];
  for (const g of report?.groups || []) {
    if (!g.retryable) continue;
    for (const r of g.recipients) out.push(r.key);
  }
  return out;
}

/**
 * A plain-text failure report — what the dealer pastes to their Meta rep, or
 * keeps as the record of a campaign that didn't fully land.
 */
export function formatFailureReport(report, { campaignName = '' } = {}) {
  const lines = [];
  if (campaignName) lines.push(`Campaña: ${campaignName}`);
  lines.push(`No entregados: ${report?.total || 0}`);
  for (const g of report?.groups || []) {
    lines.push('');
    lines.push(`${g.count} · ${g.reason}${g.code ? ` (Meta ${g.code})` : ''}${g.retryable ? ' — reintentable' : ''}`);
    lines.push(`  ${g.action}`);
    for (const r of g.recipients) lines.push(`  - ${r.name}${r.phone ? ` · ${displayPhone(r.phone)}` : ''}`);
  }
  return lines.join('\n');
}
