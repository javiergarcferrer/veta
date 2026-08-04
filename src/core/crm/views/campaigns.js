// ViewModels for Difusión — WhatsApp template campaigns (the marketing /
// "ads" side of the Business Platform: outbound MARKETING templates to a
// chosen audience; inbound Click-to-WhatsApp ad traffic lands in the inbox
// with a referral payload, resolved in views/inbox.js).
//
// Pure projections over customers + professionals + wa_campaigns +
// wa_messages — no React, no db, no supabase. The Difusión page fetches,
// calls these in useMemo, renders.

import { phoneKey, displayPhone, groupKey } from '../../../lib/phone.js';
import { quoteLinkSuffix } from '../../../lib/quoteShare.js';

/** What a body variable ({{n}}) is filled with, per recipient:
 *  'firstName' | 'name' | 'company' | 'fixed' (same text for everyone). */
export const VAR_SOURCES = [
  { value: 'firstName', label: 'Nombre (primera palabra)' },
  { value: 'name', label: 'Nombre completo' },
  { value: 'company', label: 'Empresa' },
  { value: 'fixed', label: 'Texto fijo' },
];

/**
 * The selectable audience for a campaign: every contact with a phone, deduped
 * by phoneKey (two contact cards sharing a number collapse into one recipient
 * — WhatsApp delivers to the PHONE, so one send per phone is the invariant).
 *
 *   resolveBroadcastAudience(customers, professionals, { kind, needle })
 *     → [{ key, phone, name, company, contactKind, customerId, professionalId }]
 *
 * `kind`: 'professionals' | 'customers' | 'all'.
 */
export function resolveBroadcastAudience(customers, professionals, { kind = 'professionals', needle = '' } = {}) {
  const rows = [];
  if (kind === 'professionals' || kind === 'all') {
    for (const p of professionals || []) rows.push({ row: p, contactKind: 'professional' });
  }
  if (kind === 'customers' || kind === 'all') {
    for (const c of customers || []) rows.push({ row: c, contactKind: 'customer' });
  }

  const q = needle.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const seen = new Set();
  const out = [];
  for (const { row, contactKind } of rows) {
    const key = phoneKey(row.phone);
    if (!key || seen.has(key)) continue;
    const name = row.name || row.company || displayPhone(row.phone);
    if (q) {
      const hit = name.toLowerCase().includes(q)
        || (row.company || '').toLowerCase().includes(q)
        || (qDigits && String(row.phone || '').replace(/\D/g, '').includes(qDigits));
      if (!hit) continue;
    }
    seen.add(key);
    out.push({
      key,
      phone: row.phone,
      name,
      company: row.company || '',
      contactKind,
      customerId: contactKind === 'customer' ? row.id : null,
      professionalId: contactKind === 'professional' ? row.id : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The selectable audience for an EMAIL campaign: every contact with an email,
 * deduped by lowercased email (one send per address). Mirrors
 * resolveBroadcastAudience but keyed on email rather than phone, and carries the
 * first name for a personalized greeting.
 *
 *   resolveEmailAudience(customers, professionals, { kind, needle })
 *     → [{ key, email, name, firstName, company, contactKind, customerId, professionalId }]
 *
 * `kind`: 'professionals' | 'customers' | 'all'.
 */
export function resolveEmailAudience(customers, professionals, { kind = 'customers', needle = '' } = {}) {
  const rows = [];
  if (kind === 'professionals' || kind === 'all') {
    for (const p of professionals || []) rows.push({ row: p, contactKind: 'professional' });
  }
  if (kind === 'customers' || kind === 'all') {
    for (const c of customers || []) rows.push({ row: c, contactKind: 'customer' });
  }
  const q = needle.trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const { row, contactKind } of rows) {
    const email = String(row.email || '').trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) continue;
    const name = row.name || row.company || email;
    if (q) {
      const hit = name.toLowerCase().includes(q)
        || (row.company || '').toLowerCase().includes(q)
        || key.includes(q);
      if (!hit) continue;
    }
    seen.add(key);
    out.push({
      key,
      email,
      name,
      firstName: (name || '').trim().split(/\s+/)[0] || name,
      company: row.company || '',
      contactKind,
      customerId: contactKind === 'customer' ? row.id : null,
      professionalId: contactKind === 'professional' ? row.id : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** A contact's value for one variable spec ({ source, text? }). Falls back to
 *  the full name so an empty company never sends a blank into the template
 *  (Meta rejects empty parameters). */
function varValue(contact, spec) {
  const name = (contact.name || '').trim();
  switch (spec?.source) {
    case 'fixed': return String(spec.text || '').trim() || '—';
    case 'company': return (contact.company || '').trim() || name || '—';
    case 'name': return name || '—';
    case 'firstName':
    default:
      return name.split(/\s+/)[0] || '—';
  }
}

/**
 * Selected contacts + per-variable specs → the wa-send broadcast recipients.
 * Deduped by phoneKey (the one-send-per-phone invariant, kept even if the
 * caller passes duplicates).
 *
 *   buildBroadcastRecipients(contacts, varSpecs)
 *     → [{ to, params, customerId, professionalId }]
 */
export function buildBroadcastRecipients(contacts, varSpecs = []) {
  const seen = new Set();
  const out = [];
  for (const c of contacts || []) {
    const key = phoneKey(c.phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      to: String(c.phone || '').replace(/\D/g, ''),
      params: (varSpecs || []).map((spec) => varValue(c, spec)),
      customerId: c.customerId || null,
      professionalId: c.professionalId || null,
    });
  }
  return out;
}

/** Replace the {nombre}/{nombre_completo}/{empresa} tokens for one contact, for
 *  an EMAIL campaign body or subject (the Difusión → Correo personalization).
 *  Falls back to the full name when there's no first name, and to '' for an
 *  unknown token target so nothing renders a literal placeholder. */
export function fillEmailTokens(text, contact = {}) {
  return String(text || '')
    .replace(/\{nombre_completo\}/gi, contact.name || '')
    .replace(/\{nombre\}/gi, contact.firstName || contact.name || '')
    .replace(/\{empresa\}/gi, contact.company || '');
}

/** Escape the four HTML-significant chars so a plain-text email body can be
 *  safely interpolated into the HTML wrapper. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Normalize WhatsApp group audience rows to the same shape the campaign picker
 * renders for contacts ({ key, name }), carrying `subject` + `isGroup` so the
 * send/preview path can branch on a group vs a 1:1 contact.
 *
 *   normalizeGroupRows([{ key, id, subject, participantCount }])
 *     → [{ key, id, name, subject, participantCount, isGroup: true }]
 */
export function normalizeGroupRows(groups) {
  return (groups || []).map((row) => ({
    key: row.key,
    id: row.id,
    name: row.subject,
    subject: row.subject,
    participantCount: row.participantCount,
    isGroup: true,
  }));
}

/** Fill a template body's {{1}}, {{2}}… with params for a preview. */
export function fillTemplateBody(bodyText, params = []) {
  return String(bodyText || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v == null || v === '' ? `{{${n}}}` : String(v);
  });
}

/**
 * A URL button's {{1}} value: the target link minus the BASE Meta registered
 * on the button (Meta glues base + suffix back together at tap time, so the
 * base must never be doubled). Plain prefix-strip when the link starts with
 * the base; otherwise anchor on the base's path tail — a share link may carry
 * a query the base doesn't (`?lp=N` in the old hash generation), so a base
 * registered as `…/#/q/` never plain-prefixes `…/?lp=4#/q/slug/token` even
 * though the tail is right there. Quote bases span TWO generations — `#/q/`
 * (pre-launcher hash links) and `p/cotizacion.html?d=` (the launcher) — and
 * an approved template can be one generation behind the minted link; both
 * carry the same `slug/token` payload, so when base and link are both
 * quote-shaped the suffix is extracted canonically (quoteLinkSuffix). No
 * match at all → the full link rides as the suffix (works for bases that are
 * a bare origin + '/').
 */
export function templateButtonSuffix(url, base) {
  const u = String(url || '');
  const b = String(base || '');
  if (!b) return u;
  if (u.startsWith(b)) return u.slice(b.length);
  const tail = b.replace(/^https?:\/\/[^/#?]+\/?/, ''); // '#/q/' from 'https://…/#/q/'
  if (tail === '#/q/' || tail.startsWith('p/cotizacion.html')) {
    const q = quoteLinkSuffix(u);
    if (q) return q;
  }
  if (tail) {
    const i = u.indexOf(tail);
    if (i >= 0) return u.slice(i + tail.length);
  }
  return u;
}

/** The registered base of a dynamic URL button = its url minus the trailing
 *  {{n}} placeholder Meta appends the suffix onto. Strips ANY trailing variable
 *  ({{1}} or a named one), since a URL-button variable is always at the end. */
export function campaignButtonBase(buttonUrl) {
  return String(buttonUrl || '').replace(/\{\{[^}]+\}\}\s*$/, '');
}

/**
 * Everything a "what will the client receive" render needs, resolved from a
 * template row (wa-send listTemplates shape) + the send-time inputs:
 *
 *   resolveTemplatePreview(template, { params, buttonParam })
 *     → { header: { kind:'text', text } | { kind:'image'|'video'|'document' } | null,
 *         body, footer, buttons: [{ text, url }] }
 *
 * `body` is the filled copy (missing params stay visible as {{n}}, same as
 * fillTemplateBody — the dealer sees exactly what's still blank). A dynamic
 * URL button resolves to the FULL destination Meta will build (registered
 * base + suffix); without a param yet, the registered url shows with its
 * {{1}} visible. Header TEXT is static on our templates (wa-send never sends
 * header text params), so it passes through unfilled.
 */
export function resolveTemplatePreview(template = {}, { params = [], buttonParam = '' } = {}) {
  const headerFormat = template.headerFormat || (template.headerText ? 'TEXT' : '');
  let header = null;
  if (headerFormat === 'TEXT' && template.headerText) header = { kind: 'text', text: template.headerText };
  else if (headerFormat && headerFormat !== 'TEXT') header = { kind: String(headerFormat).toLowerCase() };
  const buttons = [];
  if (template.buttonText || template.buttonUrl) {
    const url = template.buttonUrlVar && buttonParam
      ? campaignButtonBase(template.buttonUrl) + buttonParam
      : template.buttonUrl || '';
    buttons.push({ text: template.buttonText || 'Abrir', url });
  }
  return {
    header,
    body: fillTemplateBody(template.bodyText, params),
    footer: template.footerText || '',
    buttons,
  };
}

/**
 * Validate a campaign's promo link for a dynamic-URL-button template and return
 * the {{1}} suffix wa-send should ride on the button, OR a human-readable error.
 *
 *   resolveCampaignButtonParam(link, { buttonUrl, buttonText })
 *     → { param } | { error }
 *
 * A dynamic button ALWAYS needs a NON-EMPTY suffix: Meta rejects an empty value
 * with "Button at index 0 of type Url requires a parameter" (and the empty
 * string is dropped server-side, sending the template with no button component
 * at all). So a blank link — or one that merely repeats the registered base and
 * leaves an empty suffix — is refused HERE with an actionable message, instead
 * of surfacing Meta's raw error mid-broadcast.
 */
export function resolveCampaignButtonParam(link, { buttonUrl = '', buttonText = '' } = {}) {
  const base = campaignButtonBase(buttonUrl);
  const url = String(link || '').trim();
  const label = buttonText || 'URL';
  if (!url) return { error: `Pega el enlace de la promoción — el botón «${label}» lo necesita.` };
  // The button URL is base + suffix; a link outside the registered base would
  // render a broken URL on every send — reject it upfront.
  if (base && !url.startsWith(base)) {
    return { error: `El enlace debe empezar con ${base} (es la base registrada en el botón de esta plantilla).` };
  }
  const param = templateButtonSuffix(url, base);
  if (!param) {
    return { error: `El enlace debe incluir un destino después de ${base} — el botón «${label}» no puede quedar vacío.` };
  }
  return { param };
}

// Delivery-state precedence: a message's CURRENT state is the furthest stage
// it reached (the webhook overwrites status in place).
const OUT_STAGE = { accepted: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Campaign history with the LIVE delivery rollup — counts come from the
 * campaign-tagged wa_messages rows, which the webhook keeps updating after the
 * send (delivered/read trickle in for hours), not from the frozen counters on
 * the campaign row. Newest first.
 *
 * A DRAFT (status 'draft', built but never sent) surfaces with `isDraft: true`
 * and all rollups zero — it has no wa_messages, and any stray campaign-tagged
 * message must NOT resurrect delivery metrics for it; its `recipients` is the
 * count it was BUILT for. Sent rows carry `isDraft: false`.
 *
 * Every row also carries its `schedule` (resolveCampaignSchedule): a programmed
 * send is a state of the campaign, not a separate object, so one list feeds the
 * card's metrics AND its queued/failed schedule chip.
 *
 *   resolveCampaignsList({ campaigns, messages })
 *     → [{ campaign, isDraft, schedule, recipients, sent, delivered, read, failed }]
 */
export function resolveCampaignsList({ campaigns, messages, now = Date.now() }) {
  const byCampaign = new Map();
  for (const m of messages || []) {
    if (!m.campaignId) continue;
    if (!byCampaign.has(m.campaignId)) byCampaign.set(m.campaignId, []);
    byCampaign.get(m.campaignId).push(m);
  }
  const out = (campaigns || []).map((campaign) => {
    // A draft has nothing sent — skip the messages scan and the frozen-counter
    // fallback entirely so stray tagged rows can't inflate its metrics.
    if (campaign.status === 'draft') {
      return {
        campaign,
        isDraft: true,
        schedule: resolveCampaignSchedule(campaign, now),
        recipients: campaign.recipientCount ?? 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        billable: 0,
      };
    }
    const rows = byCampaign.get(campaign.id) || [];
    // Roll up PER RECIPIENT, not per message row. A contact can carry more than
    // one row for the same campaign — a failure the dealer retried, or (before
    // the send-slot claim existed) a genuine double-send — and counting rows
    // made the card read "199 enviados /81", a numerator bigger than the
    // audience. One person is one recipient at the furthest stage they reached.
    const byRecipient = new Map();
    let billable = 0; // messages Meta charged for — BILLING counts messages, so
    // a duplicate legitimately bills twice and must stay visible as two.
    for (const [i, m] of rows.entries()) {
      if (m.pricingBillable === true) billable += 1;
      // Key exactly like the audience does; a row with neither phone nor group
      // still counts as its own recipient (no-vanish) rather than collapsing
      // into some other row's tally.
      const key = m.groupId ? groupKey(m.groupId) : (phoneKey(m.phone) || `m:${m.id ?? i}`);
      const prev = byRecipient.get(key) || { stage: 0, failed: false };
      if (m.status === 'failed') prev.failed = true;
      else prev.stage = Math.max(prev.stage, OUT_STAGE[m.status] || 0);
      byRecipient.set(key, prev);
    }
    let sent = 0;
    let delivered = 0;
    let read = 0;
    let failed = 0;
    for (const r of byRecipient.values()) {
      // A failure superseded by a successful retry is not a failed recipient —
      // that person has the message.
      if (r.stage >= 1) {
        sent += 1;
        if (r.stage >= 3) delivered += 1;
        if (r.stage >= 4) read += 1;
      } else if (r.failed) failed += 1;
    }
    // Before the messages land (or for legacy rows) fall back to the counters
    // frozen on the campaign at send time.
    if (!rows.length) {
      sent = campaign.sentCount || 0;
      failed = campaign.failedCount || 0;
    }
    return {
      campaign,
      isDraft: false,
      schedule: resolveCampaignSchedule(campaign, now),
      // The audience is whoever the campaign actually reached. The frozen
      // counter undercounts by design — an append only adds what it ATTEMPTED,
      // so everyone it skipped (already messaged by a parallel send) never
      // entered it — and a denominator below the numerator is nonsense on its
      // face. Take whichever is larger: the count can only be wrong low.
      recipients: Math.max(campaign.recipientCount ?? 0, byRecipient.size),
      sent,
      delivered,
      read,
      failed,
      billable,
    };
  });
  out.sort((a, b) => (b.campaign.createdAt || 0) - (a.campaign.createdAt || 0));
  return out;
}

/**
 * The audience label for a campaign card, WITHOUT the recipient count baked
 * into it.
 *
 *   campaignAudienceLabel({ audience: 'Clientes · 1 contactos' }) → 'Clientes'
 *
 * The stored label is frozen at the FIRST send and never rewritten by an
 * append, so its count goes stale the moment more people are added — the card
 * ended up reading "Clientes · 1 contactos" above metrics saying 199 were sent.
 * The live rollup already carries the number; the label only has to say WHO.
 */
export function campaignAudienceLabel(campaign) {
  return String(campaign?.audience || '')
    .replace(/\s*·\s*\d+\s*(contactos?|grupos?)\s*$/i, '')
    .trim();
}

/* ------------------------- scheduled campaign sends ----------------------- */

/** A scheduled send must be at least this far out — enough for the per-minute
 *  worker to pick it up, and a floor against "programar" meaning "ahora". */
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;

/**
 * Validate the moment a campaign is being scheduled for.
 *
 *   validateScheduleAt(ms, now) → { at } | { error }
 *
 * The past is refused outright (the worker's late-window guard would kill it
 * anyway, after the dealer already believed it was queued).
 */
export function validateScheduleAt(at, now = Date.now()) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return { error: 'Elige la fecha y la hora del envío.' };
  if (ms < now + SCHEDULE_MIN_LEAD_MS) {
    return { error: 'La hora ya pasó — elige un momento al menos dos minutos en el futuro.' };
  }
  return { at: ms };
}

/**
 * Freeze a send: exactly the recipients the dealer confirmed, plus the template
 * config the worker needs to reproduce the broadcast. Stored on
 * `wa_campaigns.schedule_payload` and consumed chunk by chunk by
 * wa-campaign-worker (see its plan.ts for the reading side).
 *
 * FROZEN, not re-resolved: what shows in the confirm dialog is what goes out —
 * a contact added to the list tomorrow is never swept into a send approved
 * today. `kind`/`keys` ride along only so cancelling can put the pending queue
 * back exactly as it was.
 *
 *   buildSchedulePayload({ template, lang, name, audience, varSpecs,
 *                          buttonParam, bodyText, kind, keys, recipients })
 *     → { …, total, recipients }
 */
export function buildSchedulePayload({
  template, lang, name, audience, varSpecs, buttonParam, bodyText, kind, keys, recipients,
} = {}) {
  const rows = (recipients || []).filter((r) => r && (r.to || r.groupId));
  return {
    template: String(template || ''),
    lang: String(lang || 'es'),
    name: String(name || ''),
    audience: String(audience || ''),
    varSpecs: Array.isArray(varSpecs) ? varSpecs : null,
    buttonParam: buttonParam ? String(buttonParam) : null,
    bodyText: bodyText ? String(bodyText) : null,
    kind: kind ? String(kind) : null,
    keys: (keys || []).map(String),
    total: rows.length,
    recipients: rows,
  };
}

/**
 * The schedule as a campaign card renders it.
 *
 *   resolveCampaignSchedule(campaign) → {
 *     state, at, total, remaining, done, error, active
 *   }
 *
 * `active` (queued | sending) is the LOCK: a broadcast that is queued — or
 * mid-flight — must not have its audience edited underneath it, so the card
 * offers only "cancelar" until it clears. Terminal states (done/failed/
 * canceled) are not active; `error` keeps a failure visible instead of letting
 * a scheduled send die silently.
 */
export function resolveCampaignSchedule(campaign, now = Date.now()) {
  const state = campaign?.scheduleState || null;
  const payload = campaign?.schedulePayload || null;
  const total = Number(payload?.total) || 0;
  const remaining = Array.isArray(payload?.recipients) ? payload.recipients.length : 0;
  const at = campaign?.scheduledAt || null;
  const active = state === 'queued' || state === 'sending';
  // Two very different things wear the same 'queued': a send waiting for a
  // future hour, and one due NOW that the worker is about to pick up (or is
  // mid-flight). The dealer must never read "programada" while messages are
  // going out, so the card branches on this, not on the raw state.
  const mode = !active ? null
    : (state === 'sending' || !at || at <= now) ? 'sending'
      : 'scheduled';
  const done = Math.max(0, total - remaining);
  return {
    state,
    mode,
    at,
    total,
    remaining,
    done,
    /** 0–100, for the progress bar while sending. */
    pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    error: campaign?.scheduleError || null,
    active,
  };
}

/**
 * The audience keys already reached in a campaign — so "add recipients"
 * (appending to a sent campaign) never re-sends (and never re-bills) a contact
 * or group that already got it. Keyed the SAME way the audience rows are
 * (phoneKey for a 1:1 contact, groupKey for a group) so the picker can filter
 * against it directly.
 *
 *   resolveCampaignSentKeys(messages, campaignId) → Set<string>
 */
export function resolveCampaignSentKeys(messages, campaignId) {
  const out = new Set();
  if (!campaignId) return out;
  for (const m of messages || []) {
    if (m.campaignId !== campaignId) continue;
    if (m.groupId) out.add(groupKey(m.groupId));
    else if (m.phone) out.add(phoneKey(m.phone));
  }
  return out;
}

/**
 * The set of phoneKeys that opted OUT of WhatsApp marketing (bajas) — so the
 * campaign picker never offers a suppressed contact. Keyed by phoneKey (the
 * one-send-per-phone matching key), same as a 1:1 audience row's `key`, so the
 * picker can filter directly. wa_optouts already stores `phoneKey`, but we
 * re-derive from `phone` too so a legacy/hand-inserted row without the column
 * still suppresses. Marketing-only: this NEVER affects the 1:1 inbox.
 *
 *   resolveOptOutKeys(optouts) → Set<string>
 */
export function resolveOptOutKeys(optouts) {
  const out = new Set();
  for (const o of optouts || []) {
    const key = o.phoneKey || phoneKey(o.phone);
    if (key) out.add(key);
  }
  return out;
}
