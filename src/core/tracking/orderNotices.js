// Order-stage customer notices — the "Avisar a clientes" projection.
//
// When the dealer advances an order to a stage the customer actually cares
// about (zarpó / en aduanas / recibido), this resolves one prefilled, editable
// WhatsApp message per attached quote whose customer has a number — carrying
// the quote's public link (the live container map the client can watch) when
// the quote has an enabled share token. Pure: the View mints missing tokens
// first, then calls this and renders the composer; nothing is ever auto-sent.

import { shareLinkUrl } from '../../lib/quoteShare.js';
import { quoteSlug } from '../../lib/quoteNaming.js';
import { firstNameOf } from '../../lib/quoteEmail.js';
import { fillTemplateBody, templateButtonSuffix } from '../crm/index.js';

/** The stages worth a proactive client touchpoint, with their message. */
const STAGE_NOTICES = {
  in_transit: ({ hi, url }) =>
    `${hi} Buenas noticias: tu pedido ya zarpó y viene en camino. 🚢${url ? ` Puedes seguir el contenedor en vivo aquí: ${url}` : ''}`,
  in_customs: ({ hi, url }) =>
    `${hi} Tu pedido llegó a puerto y está en el proceso de aduanas. Te avisamos apenas esté liberado.${url ? ` Puedes ver el estado aquí: ${url}` : ''}`,
  received: ({ hi }) =>
    `${hi} ¡Tu pedido ya llegó a nuestro almacén! En breve te contactamos para coordinar la entrega.`,
};

/** Whether advancing to `stageKey` should offer client notices at all. */
export function isNotifiableStage(stageKey) {
  return Object.prototype.hasOwnProperty.call(STAGE_NOTICES, stageKey);
}

// ── Lifecycle templates (approved UTILITY templates ride the notices) ───────
//
// Free-form notices only deliver inside the customer's 24h service window; the
// dealer's WABA carries approved UTILITY templates that deliver ALWAYS. When
// Configuración has a template picked for a slot, the notice carries a ready
// `template` send plan alongside the editable fallback text. Body variables
// follow the dealer's registered shapes: {{1}} = first name, {{2}} = the order
// reference; a URL button's {{1}} takes the share link minus the base Meta
// registered on the button.

/** Which settings slot (if any) covers an order stage. */
const STAGE_TEMPLATE_SLOT = { in_transit: 'ship' };

/** The slot's descriptor out of settings, or null when not configured. */
function templateSlot(settings, slot) {
  const p = slot === 'ship' ? 'whatsappShipTemplate' : 'whatsappDeliveryTemplate';
  const name = String(settings?.[p] || '').trim();
  if (!name) return null;
  return {
    name,
    lang: String(settings?.[`${p}Lang`] || '').trim() || 'es',
    vars: Number(settings?.[`${p}Vars`]) || 0,
    buttonBase: String(settings?.[`${p}ButtonBase`] || '').trim(),
    body: String(settings?.[`${p}Body`] || ''),
  };
}

/**
 * Build the concrete send plan for a lifecycle template:
 *   { template, lang, params, buttonParams?, preview }
 * or null when the slot isn't configured — or when the template carries a URL
 * button but there's no share link to put behind it (a button pointing at the
 * bare domain would strand the customer on the login screen; the free-form
 * fallback handles that case).
 */
export function buildLifecycleTemplatePlan({ tpl, firstName, orderRef, url = '' }) {
  if (!tpl) return null;
  if (tpl.buttonBase && !url) return null;
  const params = [firstName || 'cliente', orderRef].slice(0, tpl.vars);
  return {
    template: tpl.name,
    lang: tpl.lang,
    params,
    ...(tpl.buttonBase ? { buttonParams: [templateButtonSuffix(url, tpl.buttonBase)] } : {}),
    preview: fillTemplateBody(tpl.body, params) || tpl.name,
  };
}

/**
 * The delivery-confirmation send plan for ONE quote (the deliveredAt
 * milestone), or null when unconfigured / not buildable. Same contract as the
 * stage notices' `template` field.
 */
export function resolveDeliveryTemplate({ quote, customer, settings }) {
  const tpl = templateSlot(settings, 'delivery');
  if (!tpl || !quote || !customer) return null;
  const url = quote.shareToken && quote.shareEnabled
    ? shareLinkUrl(quote.shareToken, quoteSlug(quote, customer)) : '';
  return buildLifecycleTemplatePlan({
    tpl,
    firstName: firstNameOf(customer),
    orderRef: quote.number != null ? `#${quote.number}` : 'reciente',
    url,
  });
}

/**
 * One editable notice per attached quote with a phone-bearing customer.
 *
 *   resolveOrderNotices({ stageKey, quotes, customers, settings })
 *     → [{ quoteId, customerId, phone, name, message, template }]
 *
 * `quotes` is the order's ATTACHED quote list (the caller already scoped it);
 * customers dedupe by id so two quotes for the same client produce ONE notice
 * (linked to the first quote — the thread is per-customer anyway). When the
 * stage has a configured lifecycle template (see above), `template` carries
 * the ready send plan and `message` stays as the editable fallback; otherwise
 * `template` is null.
 */
export function resolveOrderNotices({ stageKey, quotes = [], customers = [], settings = null } = {}) {
  const build = STAGE_NOTICES[stageKey];
  if (!build) return [];
  const slot = STAGE_TEMPLATE_SLOT[stageKey];
  const tpl = slot ? templateSlot(settings, slot) : null;
  const byId = new Map((customers || []).map((c) => [c.id, c]));
  const seen = new Set();
  const out = [];
  for (const q of quotes) {
    const c = q.customerId ? byId.get(q.customerId) : null;
    if (!c || !String(c.phone || '').trim() || seen.has(c.id)) continue;
    seen.add(c.id);
    const first = firstNameOf(c);
    const hi = first ? `Hola ${first}!` : 'Hola!';
    const url = q.shareToken && q.shareEnabled ? shareLinkUrl(q.shareToken, quoteSlug(q, c)) : '';
    out.push({
      quoteId: q.id,
      customerId: c.id,
      phone: c.phone,
      name: c.name || c.company || '',
      message: build({ hi, url }),
      template: buildLifecycleTemplatePlan({
        tpl,
        firstName: first,
        orderRef: q.number != null ? `#${q.number}` : 'reciente',
        url,
      }),
    });
  }
  return out;
}
