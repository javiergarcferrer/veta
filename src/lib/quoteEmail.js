// Quote email Model — composes the subject + HTML/plain body for sending a
// quote to a client (or professional) by Gmail. Pure: no React, no network. The
// caller (SendQuoteModal) hands it the resolved share URL and/or signals a PDF
// is attached, and sends the result through lib/google.sendGmail. The greeting
// + lead paragraph is exposed separately (defaultQuoteMessage) so the modal can
// prefill an editable textarea with it; an edited `message` replaces exactly
// that part while the link button and signature stay composed here.

/** Escape a string for safe interpolation into the HTML body. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The name a quote message greets with: the recipient's FIRST name — "Hola
 * Juan," never "Hola Juan Pérez Rodríguez," (matching the WhatsApp sends,
 * which already greet this way). Person name first (contactName is the
 * customer's named contact); a company-only record keeps its full company
 * name — truncating "Deco Studio SRL" to "Deco" would read wrong.
 */
export function firstNameOf(recipient) {
  const person = (recipient?.contactName || recipient?.name || '').trim();
  if (person) return person.split(/\s+/)[0];
  return (recipient?.company || '').trim();
}

/**
 * The post-venta WhatsApp thank-you offered when a quote is marked ENTREGADA —
 * the happiest moment of the relationship, spent on a warm close + care note +
 * a review ask instead of only the invoice queue. Plain editable text; the
 * dealer reviews before sending (human-in-the-loop, like every prefill).
 */
export function deliveryThanksMessage({ quote, customer, settings } = {}) {
  const name = firstNameOf(customer);
  const greeting = name ? `Hola ${name}!` : 'Hola!';
  const company = (settings?.companyName || 'nuestro equipo').trim();
  const num = quote?.number != null ? ` (cotización #${quote.number})` : '';
  return [
    `${greeting} Ya completamos la entrega de tu pedido${num}.`,
    '',
    'Gracias por confiar en nosotros. Si quieres recomendaciones de cuidado y limpieza de tus piezas, dinos y con gusto te las compartimos.',
    '',
    `Nos encantaría saber cómo quedó todo — cualquier detalle, escríbenos por aquí. — ${company}`,
  ].join('\n');
}

/**
 * The default editable message — greeting + lead paragraph, as plain text.
 * This is what the send modal prefills its textarea with; buildQuoteEmail
 * regenerates it when no edited message is handed back.
 */
export function defaultQuoteMessage({ quote, recipient, settings, hasPdf = false }) {
  const company = settings?.companyName || 'Alcover';
  const numberTag = quote?.number ? ` #${quote.number}` : '';
  const greetingName = firstNameOf(recipient);
  const hi = greetingName ? `Hola ${greetingName},` : 'Hola,';
  const lead = `Adjuntamos${hasPdf ? ' el PDF de' : ''} tu cotización${numberTag} de ${company}.`;
  return `${hi}\n\n${lead}`;
}

/**
 * Build a quote email.
 * @param {object}  opts
 * @param {object}  opts.quote      the quote (for its number)
 * @param {object}  opts.recipient  customer or professional (for the greeting)
 * @param {object}  opts.settings   app settings (company name / signature)
 * @param {string}  [opts.url]      the public interactive quote link, if any
 * @param {boolean} [opts.hasPdf]   whether a PDF is attached
 * @param {string}  [opts.message]  edited message body (plain text); replaces
 *                                  the default greeting+lead. The link button
 *                                  and signature are appended either way.
 * @returns {{subject:string, html:string, text:string}}
 */
export function buildQuoteEmail({ quote, recipient, settings, url = '', hasPdf = false, message = '' }) {
  const company = settings?.companyName || 'Alcover';
  const numberTag = quote?.number ? ` #${quote.number}` : '';
  const subject = `Cotización${numberTag} — ${company}`;

  const body = (message || '').trim() || defaultQuoteMessage({ quote, recipient, settings, hasPdf });
  const linkLine = url
    ? `También puedes verla en línea${hasPdf ? '' : ' y elegir telas'} aquí: ${url}`
    : '';
  const sign = `Saludos,\n${company}`;
  const text = [body, linkLine, '', sign].filter((l) => l !== null).join('\n');

  const bodyHtml = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n  ');
  const linkHtml = url
    ? `<p style="margin:0 0 16px"><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Ver la cotización en línea</a></p>`
    : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.55">
  ${bodyHtml}
  ${linkHtml}
  <p style="margin:24px 0 0;color:#666;font-size:13px">${esc(company)}</p>
</div>`;

  return { subject, html, text };
}
