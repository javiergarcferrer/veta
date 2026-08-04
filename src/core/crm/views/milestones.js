// ViewModel for the per-CONTACT document HISTORIAL — the milestone strip that
// answers "what did we SEND this client, and when". Pure projection over the
// contact's 1:1 WhatsApp log + their CRM milestones; no React, no db. The View
// fetches, calls this in useMemo, renders.
//
// This is a SEND-log, not a chat log: plain conversational messages never
// surface here (unifiedTimeline owns the full cross-channel chatter). We keep
// only the rows that represent a delivered ARTIFACT — a promoción, an estado de
// cuenta, a contrato, a cotización (link or PDF), a documento — plus the
// quote/order/payment CRM milestones.
//
// Each WhatsApp row is classified by FIRST MATCH against an ordered rule set,
// and the ORDER IS LOAD-BEARING: a plan-card contract send carries BOTH the
// contract template AND a quoteId, so the template rule must win over the
// quoteId rule or it would read as a quote link. A Difusión campaign send wins
// over everything else.

import { phoneKey } from '../../../lib/phone.js';
import { activityKindLabel } from './activities.js';

/**
 * Classify one 1:1 WhatsApp row into a milestone descriptor, or null when the
 * row is plain chatter that never belongs in the historial. FIRST MATCH WINS —
 * the rule order encodes the precedence documented above.
 */
function classifyMessage(m, { statementTemplate, contractTemplate, quoteById }) {
  const body = m.body || '';
  const isDoc = m.kind === 'document';

  // 1. Difusión campaign send — always a promo, whatever template/URL it rides.
  if (m.campaignId) {
    return { type: 'promo', title: 'Promoción enviada', snippet: m.templateName || body };
  }

  // 2. Configured document TEMPLATE — before the quoteId rule (a plan-card
  //    contract send carries the contract template AND a quoteId).
  if (statementTemplate && m.templateName === statementTemplate) {
    return { type: 'statement', title: 'Estado de cuenta enviado', snippet: body };
  }
  if (contractTemplate && m.templateName === contractTemplate) {
    return { type: 'contract', title: 'Contrato enviado', snippet: body };
  }

  // 3. Launcher URL in the body — the same document kinds, sent without a
  //    configured template (older sends / manual links).
  if (body.includes('/p/cuenta.html')) {
    return { type: 'statement', title: 'Estado de cuenta enviado', snippet: body };
  }
  if (body.includes('/p/contrato.html')) {
    return { type: 'contract', title: 'Contrato enviado', snippet: body };
  }

  // 4. A quote artifact — PDF when it's a document row, else the share link.
  if (m.quoteId) {
    const q = quoteById.get(m.quoteId);
    const num = q?.number ?? '—';
    const title = `Cotización #${num}${q?.title ? ` · ${q.title}` : ''}`;
    return { type: isDoc ? 'quote-pdf' : 'quote-link', title, snippet: body, quoteId: m.quoteId };
  }

  // 5. A quote share LINK with no quoteId stamped — sniff the launcher path.
  if (body.includes('/p/cotizacion.html')) {
    return { type: 'quote-link', title: 'Cotización enviada', snippet: body };
  }

  // 6. A bare document attachment with none of the above meaning.
  if (isDoc) {
    return {
      type: 'document',
      title: m.direction === 'in' ? 'Documento recibido' : 'Documento enviado',
      snippet: body,
    };
  }

  // 7. Plain chatter — never part of the historial.
  return null;
}

/**
 * One contact's document milestone historial — the artifacts we sent + the
 * quote/order/payment CRM milestones, newest-first.
 *
 *   resolveContactMilestones({ waMessages, activities, quotes, contact,
 *                              contactKind, settings, cap })
 *     → { events, total }
 *
 *   events — newest-first, capped at `cap`. Each:
 *            { id, at, type, title, snippet, direction, quoteId? }
 *            type ∈ promo | statement | contract | quote-link | quote-pdf |
 *                   document | crm.
 *   total  — the milestone count BEFORE the cap (the true historial depth).
 *
 * `contact` is a customer/professional row (its `phone` scopes the 1:1 WhatsApp
 * rows; `id` + `contactKind` scope the CRM activities). `settings` supplies the
 * configured document template names (`whatsappStatementTemplate` /
 * `whatsappContractTemplate`) used to classify template sends.
 */
export function resolveContactMilestones({
  waMessages = [], activities = [], quotes = [],
  contact = null, contactKind = 'customer', settings = {}, cap = 50,
} = {}) {
  const events = [];
  const quoteById = new Map((quotes || []).map((q) => [q.id, q]));
  const statementTemplate = settings?.whatsappStatementTemplate || null;
  const contractTemplate = settings?.whatsappContractTemplate || null;

  // WhatsApp — 1:1 artifact sends for this contact's phone. Group rows are
  // never this contact; plain chatter is dropped by classifyMessage.
  const wKey = phoneKey(contact?.phone);
  if (wKey) {
    for (const m of waMessages || []) {
      if (m.groupId) continue;
      if (phoneKey(m.phone) !== wKey) continue;
      const c = classifyMessage(m, { statementTemplate, contractTemplate, quoteById });
      if (!c) continue;
      const ev = {
        id: `wa:${m.id}`,
        at: m.createdAt || 0,
        type: c.type,
        title: c.title,
        snippet: c.snippet || '',
        direction: m.direction === 'in' ? 'in' : 'out',
      };
      if (c.quoteId) ev.quoteId = c.quoteId;
      events.push(ev);
    }
  }

  // CRM milestones — quote / order / payment only. Notes, tasks, whatsapp,
  // stage changes, etc. belong to the activity timeline, not this historial.
  const isCustomer = contactKind === 'customer';
  const cid = isCustomer ? (contact?.id || null) : null;
  const pid = !isCustomer ? (contact?.id || null) : null;
  if (cid || pid) {
    for (const a of activities || []) {
      const mine = cid ? a.customerId === cid : a.professionalId === pid;
      if (!mine) continue;
      if (a.kind !== 'quote' && a.kind !== 'order' && a.kind !== 'payment') continue;
      events.push({
        id: `crm:${a.id}`,
        at: a.createdAt || 0,
        type: 'crm',
        title: activityKindLabel(a.kind),
        snippet: a.body || '',
        direction: a.direction === 'in' ? 'in' : (a.direction === 'out' ? 'out' : null),
      });
    }
  }

  const total = events.length;
  events.sort((x, y) => (y.at || 0) - (x.at || 0));
  return { events: events.slice(0, Math.max(0, cap)), total };
}
