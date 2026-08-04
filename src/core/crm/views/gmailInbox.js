// ViewModel for the Gmail inbox (the CRM email surface).
//
// Pure projections over gmail_messages — no React, no db. The View fetches the
// stored mail (synced server-side by the google-api `gmailSync` action), calls
// these in useMemo, and renders. Two derivations the inbox is built around:
//
//   • CATEGORY classification — each thread is filed under Ligne Roset (golden)
//     / Internas / Proveedores / Operaciones / Marketing / Otros from the
//     counterpart's address + the subject/snippet wording + Gmail's own labels
//     (see classifyBrand). A per-message manual override (gmail_messages.brand)
//     always wins when it names a current category, so the dealer can re-file a
//     thread; the stored column keeps the name `brand` for back-compat.
//   • INVOICE detection — a message that reads like a bill AND carries a
//     document (or whose attachment names an invoice) feeds the Facturas tab.
//
// Nothing here reaches into the Accounting core — the invoice tab is a filtered
// view; turning one into a gasto is a navigation deep-link the View builds, so
// the CRM↔Accounting wall (tests/architecture.test.js) stays intact.

import { BRAND_LIGNE_ROSET, BRAND_NAMES } from '../../../lib/constants.ts';
import { buildDraftTurns } from './draft.js';

/** The catch-all bucket for mail that matches no category rule. */
export const GMAIL_BRAND_OTHER = 'otros';

// Inbox CATEGORIES (this used to be a per-brand split; it's now intent-based).
// Ligne Roset keeps its own GOLDEN lane — every message from a Roset domain
// lands there untouched, marketing blasts included (the PIB reports and the
// network newsletter ARE dealer comms). Everything else is filed by what it IS
// and who the OTHER party is:
//   • internas    — team-internal mail: the counterpart is on our own domain
//     (@alcover.do). "Anything from our domain → internal", topic aside.
//   • proveedores — other furniture / design houses + the suppliers we order
//     from (real correspondence; their mass-mailings fall to marketing below).
//   • operaciones — running the business: logistics / customs, fleet fuel,
//     HR / recruiting, outside services.
//   • marketing   — the press / media / advertising partners we place ads with
//     (Listín Diario magazines, AAA / Moré Arquitectos) PLUS every newsletter /
//     promotion / marketing blast (bulk-sender markers + the Promotions label).
// (Finanzas was retired — money mail surfaces in the Facturas tab and search;
// bank/collections notes fall to Otros.)
export const GMAIL_CAT_INTERNAL = 'internas';
export const GMAIL_CAT_PROVEEDORES = 'proveedores';
export const GMAIL_CAT_OPERACIONES = 'operaciones';
export const GMAIL_CAT_MARKETING = 'marketing';

/** The inbox's top-level tabs, in display order (the Facturas tab is separate). */
export const GMAIL_BRAND_TABS = [
  { id: BRAND_LIGNE_ROSET, label: BRAND_NAMES[BRAND_LIGNE_ROSET] || 'Ligne Roset' },
  { id: GMAIL_CAT_INTERNAL, label: 'Internas' },
  { id: GMAIL_CAT_PROVEEDORES, label: 'Proveedores' },
  { id: GMAIL_CAT_OPERACIONES, label: 'Operaciones' },
  { id: GMAIL_CAT_MARKETING, label: 'Marketing' },
  { id: GMAIL_BRAND_OTHER, label: 'Otros' },
];

/** The category ids a manual override may legitimately carry. A stale value (e.g.
 *  the retired 'lifestylegarden' brand) is ignored so the message re-classifies
 *  under the current taxonomy instead of vanishing from every tab. */
export const KNOWN_GMAIL_CATEGORIES = new Set(GMAIL_BRAND_TABS.map((t) => t.id));

/**
 * The classifier's knobs (injectable for tests). Ligne Roset and the supplier
 * list match on the sender DOMAIN; the internal check matches the COUNTERPART's
 * domain; marketing/ops also recognise specific senders by name; the keyword
 * list catches unknown ops senders by what they wrote; the bulk markers pull
 * mass-mailings into Marketing.
 */
export const DEFAULT_GMAIL_BRAND_RULES = {
  // GOLDEN lane — any Roset domain.
  ligneRoset: ['roset.fr', 'rosetusa.com', 'ligne-roset', 'ligneroset', 'roset.com'],
  // INTERNAL — our own domain(s). A thread is filed to Internas when the OTHER
  // party (the inbound sender, or the recipient of a mail we sent) is on one of
  // these — "anything from our domain → internal", topic aside. We key off the
  // counterpart, NOT our own address, so an outbound mail to a client is never
  // mistaken for internal.
  internalDomains: ['alcover.do'],
  // MARKETING by known sender — the press / media / advertising partners we buy
  // placements from: Listín Diario's magazine sales (Aldaba, Ritmo Platinum) and
  // AAA / Moré Arquitectos (Patricia Reynoso, who writes from a gmail address).
  // Matched on their real addresses, not a guess at the name.
  marketingSenders: ['listindiario.com', 'aaamag.com.do', 'patricia.morearq'],
  // Operations we deal with by name: fleet fuel, logistics, outside services,
  // recruiters (personal gmail addresses, matched on a distinctive localpart).
  opsSenders: ['totalenergies.com', 'figibox.do', 'henriquez.com.do', 'recluta', 'asenciorh'],
  // Other design houses + suppliers we actually order from.
  suppliers: [
    'kvadrat', 'dedar.com', 'finnjuhl.com', 'carlhansen.dk', 'dwr.com', 'designwithinreach',
    'maharam.com', 'rimadesio', 'portaromana.com', 'svenskttenn.com', 'anthomdesignhouse.com',
    'sampsonmills.com', 'taillardat.fr', 'emblemparis.fr', 'nakamotoforestry.com', 'sidoca.com',
  ],
  // Mass-mailing sender localparts (normalised, separators stripped) + sub-domains
  // + telltale newsletter phrases → Marketing (the noise lane).
  bulkLocalparts: ['news', 'newsletter', 'noreply', 'donotreply', 'nepasrepondre', 'mailer', 'mailing', 'press', 'stories', 'marketing', 'specials', 'product'],
  bulkDomains: ['news.', 'marketing.', 'beehiiv', 'mailchimp', 'sendgrid'],
  bulkText: ['unsubscribe', 'darse de baja', 'publicidad', 'view in a browser', 'view in browser', 'view this newsletter', 'ver en el navegador'],
  // Operations by wording, for senders we don't know by name.
  operacionesWords: ['combustible', 'tarjeta de', 'flota', 'empleado', 'nómina', 'nomina', 'candidat', 'armador', 'instalador', 'perfiles', 'recluta', 'aduana', 'embarque', 'contenedor', 'courier', 'logística', 'logistica', 'flete', 'shipment', 'expédition', 'expedition', 'envío'],
};

/** The domain part of an email address ('' when there's no @). */
export function senderDomain(email) {
  const s = String(email || '').toLowerCase();
  const at = s.indexOf('@');
  return at >= 0 ? s.slice(at + 1) : '';
}

/** The OTHER party on a message: the sender for inbound mail, the (first)
 *  recipient for a mail we sent. Used to tell team-internal threads apart — our
 *  own address is never the counterpart, so an outbound mail to a client can't
 *  be mistaken for internal. */
export function counterpartEmail(message) {
  if (message?.direction === 'out') {
    return message.toEmail || (Array.isArray(message.toEmails) ? message.toEmails[0] : '') || '';
  }
  return message?.fromEmail || '';
}

/** Cumulative separator-bounded prefixes of the localpart, lower-cased
 *  (`No-Reply@x` → {no, noreply}) for mass-mailing-sender matching. Boundaries
 *  matter: 'product' must match product@/product-updates@ but NEVER
 *  production@ — a bare startsWith filed real supplier mail as newsletters. */
function senderLocalPrefixes(email) {
  const s = String(email || '').toLowerCase();
  const at = s.indexOf('@');
  const raw = at >= 0 ? s.slice(0, at) : s;
  const out = new Set();
  let acc = '';
  for (const t of raw.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    acc += t;
    out.add(acc);
  }
  return out;
}

/**
 * The category a single message belongs to. A manual override (message.brand)
 * wins when it names a current category; otherwise the message is classified by
 * an ordered set of signals — Ligne Roset first (golden, beats everything), then
 * team-internal (our own domain, by counterpart), then marketing/ops by known
 * sender, then bulk mail → marketing, then the supplier list, then ops by
 * wording. Falls back to 'otros'.
 */
export function classifyBrand(message, rules = DEFAULT_GMAIL_BRAND_RULES) {
  if (message?.brand && KNOWN_GMAIL_CATEGORIES.has(message.brand)) return message.brand;
  const r = rules || DEFAULT_GMAIL_BRAND_RULES;
  const sender = String(message?.fromEmail || '').toLowerCase();
  const domain = senderDomain(sender);
  const local = senderLocalPrefixes(sender);
  const text = `${message?.subject || ''} ${message?.snippet || ''}`.toLowerCase();
  const labels = message?.labelIds || [];
  const inText = (needles) => (needles || []).some((n) => text.includes(n));
  const inSender = (needles) => (needles || []).some((n) => sender.includes(n));
  const inDomain = (list, dom) => !!dom && (list || []).some((n) => dom.includes(n));

  // 1) Ligne Roset — golden lane, beats everything (newsletters included).
  if (inDomain(r.ligneRoset, domain)) return BRAND_LIGNE_ROSET;
  // 2) Internal — the OTHER party is on our own domain (a colleague). Keyed off
  //    the counterpart so a mail WE sent to a client is never mis-filed here.
  const cpDomain = senderDomain(counterpartEmail(message));
  if (cpDomain && (r.internalDomains || []).some((d) => cpDomain === d || cpDomain.endsWith(`.${d}`))) {
    return GMAIL_CAT_INTERNAL;
  }
  // 3) Marketing by known sender — the press / media / advertising partners.
  if (inSender(r.marketingSenders)) return GMAIL_CAT_MARKETING;
  // 4) Ops by known sender — never let the fuel-card statement
  //    (noreply@totalenergies…) fall into the bulk lane below.
  if (inSender(r.opsSenders)) return GMAIL_CAT_OPERACIONES;
  // 5) Bulk / marketing — promo blasts into Marketing. The localpart match is
  //    token-bounded (see senderLocalPrefixes).
  const bulkLocal = (r.bulkLocalparts || []).some((n) => local.has(n));
  if (labels.includes('CATEGORY_PROMOTIONS') || bulkLocal || inDomain(r.bulkDomains, domain) || inText(r.bulkText)) {
    return GMAIL_CAT_MARKETING;
  }
  // 6) Other design houses / suppliers — real correspondence.
  if (inDomain(r.suppliers, domain)) return GMAIL_CAT_PROVEEDORES;
  // 7) Operations by wording (unknown senders).
  if (inText(r.operacionesWords)) return GMAIL_CAT_OPERACIONES;
  return GMAIL_BRAND_OTHER;
}

// Reads like a bill (subject/snippet/attachment name) …
const INVOICE_RE = /\b(factura|facturaci[oó]n|invoice|recibo|receipt|nota de cr[eé]dito|statement|estado de cuenta|cobro|pago|payment)\b/i;
// … and carries a document (invoices arrive as PDF/XML attachments here).
const INVOICE_FILE_RE = /\.(pdf|xml)$/i;

/**
 * Whether a message belongs in the Facturas tab. True when it both reads like an
 * invoice and carries an attachment, or when an attachment's own filename names
 * an invoice (a "Factura-001.pdf" with a terse covering note still counts).
 */
export function isInvoiceEmail(message) {
  if (!message) return false;
  const attachments = message.attachments || [];
  const text = `${message.subject || ''} ${message.snippet || ''}`;
  const readsLikeInvoice = INVOICE_RE.test(text);
  if (readsLikeInvoice && message.hasAttachment) return true;
  return attachments.some((a) => INVOICE_FILE_RE.test(a?.filename || '') && INVOICE_RE.test(a?.filename || ''));
}

const _MONEY_RE = /(US\$|RD\$|EUR|USD|DOP|€|\$)\s?([0-9][0-9.,]{0,15})|([0-9][0-9.,]{0,15})\s?(USD|DOP|EUR)/gi;
function _currency(tok) {
  const t = String(tok || '').toUpperCase();
  if (t === 'RD$' || t === 'DOP') return 'DOP';
  if (t === '€' || t === 'EUR') return 'EUR';
  return 'USD';
}
function _amount(raw) {
  let t = String(raw || '').replace(/ /g, '');
  // European format — dots as thousands, optional comma decimal ("1.234,56",
  // "€1.500"): swap the separators before parsing, or the French suppliers'
  // totals read up to 1000× low ("1.234,56" → 1.23).
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.'); // bare comma decimal
  else t = t.replace(/,/g, ''); // US format — commas are thousands
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Best-effort amount on an invoice email — the LARGEST money figure found in the
 * subject/snippet/body (the total usually dominates the line items). Returns
 * `{ amount, currency }` or null; purely cosmetic (a hint in the Facturas list),
 * never posted to the books.
 */
export function parseInvoiceAmount(message) {
  const body = `${message?.subject || ''} ${message?.snippet || ''} ${message?.bodyText || ''}`;
  let best = null;
  let m;
  const re = new RegExp(_MONEY_RE);
  while ((m = re.exec(body))) {
    const sym = m[1] || m[4] || '$';
    const amt = _amount(m[2] || m[3]);
    if (amt > 0 && (!best || amt > best.amount)) best = { amount: amt, currency: _currency(sym) };
  }
  return best;
}

/**
 * Group the message log into a thread list, newest-activity first.
 *
 *   resolveGmailThreads(messages, { needle, rules, includeArchived })
 *     → [{ threadId, subject, fromName, fromEmail, snippet, brand, lastAt,
 *          lastDirection, count, unread, hasInvoice, hasAttachment, starred }]
 *
 * Threads group by Gmail's `threadId`. A thread's brand follows its latest
 * INBOUND counterpart (so our own replies don't re-file it), unless any message
 * carries a manual override. `needle` filters by subject / sender / snippet.
 * The View filters the returned rows by the active brand tab.
 *
 * ARCHIVED threads are excluded by default (Gmail semantics: a conversation
 * shows in the inbox while ANY of its messages carries the INBOX label). A
 * thread that received mail but has no INBOX message anywhere was archived —
 * here or in Gmail — so it leaves the brand tabs; a new inbound message brings
 * it back. All-outbound threads (a mail we sent, no reply yet) always show.
 * FAIL-SAFE: a thread with NO label data at all (every labelIds null/empty)
 * is UNKNOWN, not archived — it stays visible. Search surfaces pass
 * `includeArchived: true` so, like real Gmail, a search spans All Mail.
 * Each row carries `canArchive` (some message still holds INBOX) so the UI
 * never offers a no-op archive on sent-only or already-archived threads.
 */
export function resolveGmailThreads(messages, { needle = '', rules = DEFAULT_GMAIL_BRAND_RULES, includeArchived = false } = {}) {
  const threads = new Map();
  for (const m of messages || []) {
    const key = m.threadId || m.id;
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        threadId: key, subject: '', fromName: '', fromEmail: '', snippet: '',
        lastAt: 0, lastDirection: null, count: 0, unread: 0, hasInvoice: false,
        hasAttachment: false, starred: false, brand: GMAIL_BRAND_OTHER, _msgs: [],
        _anyInbound: false, _anyInbox: false, _anyLabels: false, bodyText: '',
      };
      threads.set(key, t);
    }
    t.count += 1;
    t._msgs.push(m);
    if (m.direction === 'in') t._anyInbound = true;
    if (m.direction === 'in' && !m.isRead) t.unread += 1;
    if (isInvoiceEmail(m)) t.hasInvoice = true;
    if (m.hasAttachment || (m.attachments || []).length > 0) t.hasAttachment = true;
    if ((m.labelIds || []).length > 0) t._anyLabels = true;
    if ((m.labelIds || []).includes('STARRED')) t.starred = true;
    if ((m.labelIds || []).includes('INBOX')) t._anyInbox = true;
    // Aggregate a bounded slice of every message's body so the inbox search can
    // reach INTO the mail, not just its subject/snippet (the mirror carries
    // bodyText). Sliced on append so the row is HARD-capped at 5000 chars — a
    // long conversation can never bloat it.
    if (m.bodyText && t.bodyText.length < 5000) {
      t.bodyText = (t.bodyText ? `${t.bodyText} ${m.bodyText}` : String(m.bodyText)).slice(0, 5000);
    }
    const at = m.receivedAt || m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.subject = m.subject || t.subject;
      t.fromName = m.fromName || '';
      t.fromEmail = m.fromEmail || '';
      t.snippet = m.snippet || '';
      t.lastDirection = m.direction;
    }
  }

  const out = [];
  for (const t of threads.values()) {
    // Archived: it received mail, label data EXISTS, yet no message carries
    // INBOX anymore. No label data anywhere ⇒ unknown ⇒ keep visible.
    if (!includeArchived && t._anyInbound && t._anyLabels && !t._anyInbox) continue;
    const override = t._msgs.find((m) => m.brand && KNOWN_GMAIL_CATEGORIES.has(m.brand))?.brand;
    if (override) {
      t.brand = override;
    } else {
      const inbound = t._msgs.filter((m) => m.direction === 'in');
      const pool = inbound.length ? inbound : t._msgs;
      const rep = pool.slice().sort((a, b) => (b.receivedAt || b.createdAt || 0) - (a.receivedAt || a.createdAt || 0))[0];
      t.brand = classifyBrand(rep, rules);
    }
    out.push({
      threadId: t.threadId,
      subject: t.subject || '(sin asunto)',
      fromName: t.fromName,
      fromEmail: t.fromEmail,
      snippet: t.snippet,
      brand: t.brand,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      count: t.count,
      unread: t.unread,
      hasInvoice: t.hasInvoice,
      hasAttachment: t.hasAttachment,
      starred: t.starred,
      canArchive: t._anyInbox,
      bodyText: t.bodyText,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return filterGmailThreads(out, needle);
}

/**
 * Needle filter over resolved thread rows (subject / sender / snippet / body).
 * Split out so the View can memoize the expensive grouping on [messages] and
 * re-run only THIS per keystroke. Body text is the aggregated per-thread slice
 * resolveGmailThreads carries, so a search reaches into the mail, not just its
 * headers — like real Gmail.
 */
export function filterGmailThreads(threads, needle = '') {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return threads || [];
  return (threads || []).filter((t) =>
    (t.subject || '').toLowerCase().includes(q)
    || (t.fromName || '').toLowerCase().includes(q)
    || (t.fromEmail || '').toLowerCase().includes(q)
    || (t.snippet || '').toLowerCase().includes(q)
    || (t.bodyText || '').toLowerCase().includes(q));
}

/**
 * Per-tab thread + unread counts for the inbox's tab badges.
 *
 *   resolveGmailTabCounts(messages, { rules })
 *     → { [tabId]: { threads, unread } }   (every GMAIL_BRAND_TABS id present)
 *
 * A thread whose brand somehow isn't a current tab id falls into 'otros' so no
 * conversation is ever uncounted.
 */
export function resolveGmailTabCounts(messages, { rules = DEFAULT_GMAIL_BRAND_RULES } = {}) {
  const counts = {};
  for (const t of GMAIL_BRAND_TABS) counts[t.id] = { threads: 0, unread: 0 };
  for (const t of resolveGmailThreads(messages, { rules })) {
    const bucket = counts[t.brand] || counts[GMAIL_BRAND_OTHER];
    bucket.threads += 1;
    bucket.unread += t.unread;
  }
  return counts;
}

// Spanish month abbreviations — hand-rolled so the label is deterministic in
// every runtime (tests included), not dependent on the host's ICU data.
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * The compact date label the thread list shows (Gmail-style buckets):
 * today → 'HH:MM' · yesterday → 'ayer' · same year → '12 jun' · older →
 * '12 jun 24'. Pure — `now` is injectable for tests.
 */
export function formatGmailDate(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'ayer';
  const label = `${d.getDate()} ${MONTHS_ES[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? label : `${label} ${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

/** Up to two initials for a sender avatar — first + last name initial, falling
 *  back to the first letters of the address. */
export function senderInitials(name, email) {
  const n = String(name || '').trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const second = parts.length > 1 ? (parts[parts.length - 1][0] || '') : (parts[0]?.[1] || '');
    return (first + second).toUpperCase();
  }
  const e = String(email || '').replace(/[^a-zA-Z0-9]/g, '');
  return e ? e.slice(0, 2).toUpperCase() : '?';
}

/**
 * Deterministic bucket index for a sender's avatar color — the same address
 * always lands on the same color, across renders and sessions.
 */
export function avatarColorIndex(seed, buckets = 6) {
  const s = String(seed || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return buckets > 0 ? h % buckets : 0;
}

/** The oldest message timestamp in the mirror (ms) — the "load older" cursor.
 *  Null when there's nothing synced yet. */
export function oldestGmailAt(messages) {
  let oldest = 0;
  for (const m of messages || []) {
    const at = m.receivedAt || m.createdAt || 0;
    if (at && (!oldest || at < oldest)) oldest = at;
  }
  return oldest || null;
}

/**
 * The Gmail search that pulls mail OLDER than the cursor into the mirror — the
 * "Cargar más" pagination. Gmail's `before:` is day-granular and exclusive, so
 * the cursor's own day is included (+1 day) — already-mirrored ids are cheap
 * server-side skips, and no day at the boundary is ever lost.
 *
 *   olderMailQuery(cursorMs) → '(in:inbox OR in:sent) before:2026/03/15' | null
 */
export function olderMailQuery(cursorMs, { scope = '(in:inbox OR in:sent)' } = {}) {
  if (!cursorMs) return null;
  const d = new Date(cursorMs);
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${scope} before:${d.getFullYear()}/${mm}/${dd}`;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Where "Cargar más" starts. The mirror's CONTIGUOUS coverage is the default
 * sync window (now − windowDays → now); the invoice pull sprinkles OLDER
 * outliers (its query reaches a year back). Anchoring the first page on the
 * bare oldest row would jump past the months between the window edge and those
 * outliers forever — so the first cursor is the NEWER of (oldest row, window
 * edge): never older than where contiguous coverage ends. Null when the mirror
 * is empty (nothing to page from yet).
 */
export function initialOlderCursor(messages, { now = Date.now(), windowDays = 180 } = {}) {
  const oldest = oldestGmailAt(messages);
  if (!oldest) return null;
  return Math.max(oldest, now - windowDays * DAY_MS);
}

/**
 * Advance the cursor past a fully-known page. When a `before:` window lists
 * only already-mirrored ids (synced = 0), the next cursor is the timestamp of
 * the PAGE-th mirrored message older than the cursor — exactly the span Gmail
 * just listed — so the next query starts where that page ended. Null when the
 * mirror holds nothing older than the cursor.
 */
export function olderPageAnchor(messages, cursorMs, page = 100) {
  const older = (messages || [])
    .map((m) => m.receivedAt || m.createdAt || 0)
    .filter((at) => at && at < cursorMs)
    .sort((a, b) => b - a);
  if (!older.length) return null;
  return older[Math.min(page, older.length) - 1];
}

/**
 * One thread, oldest-first — the reading pane's content.
 *
 *   resolveGmailThread(messages, { threadId })
 *     → { items, threadId, subject, lastInboundAt }
 */
export function resolveGmailThread(messages, { threadId } = {}) {
  const items = (messages || [])
    .filter((m) => (m.threadId || m.id) === threadId)
    .sort((a, b) => (a.receivedAt || a.createdAt || 0) - (b.receivedAt || b.createdAt || 0));
  let lastInboundAt = 0;
  let subject = '';
  for (const m of items) {
    if (m.direction === 'in') lastInboundAt = Math.max(lastInboundAt, m.receivedAt || m.createdAt || 0);
    if (!subject && m.subject) subject = m.subject;
  }
  return { items, threadId: threadId || null, subject: subject || '(sin asunto)', lastInboundAt: lastInboundAt || null };
}

/** A reply subject — "Re: …" once, never stacking a second prefix. */
export function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re: (sin asunto)';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// The HTML markers every major client wraps its quoted reply history in. A
// split at the EARLIEST marker collapses the whole trailed conversation —
// exactly Gmail's "trimmed content" ellipsis.
const QUOTE_HTML_MARKERS = [
  '<div class="gmail_quote',      // Gmail (also gmail_quote_container)
  '<blockquote type="cite"',      // Apple Mail
  '<div id="divrplyfwdmsg',       // Outlook (reply/forward separator)
  '<div id="appendonsend',        // Outlook (newer)
  // Outlook "filtered medium" Word HTML — the thin rule above the quoted
  // De/Envoyé header (common from European suppliers' Outlook). The marker
  // is the START of that div so the cut never lands mid-tag.
  '<div style="border:none;border-top:solid #e1e1e1',
  '<div class="yahoo_quoted',     // Yahoo
  '<div class="moz-cite-prefix',  // Thunderbird
];

/** Whether an HTML fragment still contains visible text once tags are stripped. */
function _hasVisibleText(html) {
  return /\S/.test(String(html || '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' '));
}

/**
 * Split an email's HTML body into the NEW content and the quoted history every
 * client appends below a reply (Gmail's gmail_quote, Apple's cite blockquote,
 * Outlook's divRplyFwdMsg, …). The reading pane renders `main` and collapses
 * `quoted` behind a "Mostrar contenido citado" toggle — Gmail's trimmed-content
 * ellipsis. No split (quoted='') when there's no marker, or when the quote IS
 * the whole message (a bare forward must not vanish).
 *
 *   splitQuotedHtml(html) → { main, quoted }
 */
export function splitQuotedHtml(html) {
  const s = String(html || '');
  if (!s) return { main: s, quoted: '' };
  const lower = s.toLowerCase();
  let cut = -1;
  for (const marker of QUOTE_HTML_MARKERS) {
    const i = lower.indexOf(marker);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut <= 0) return { main: s, quoted: '' };
  const main = s.slice(0, cut);
  if (!_hasVisibleText(main)) return { main: s, quoted: '' };
  return { main, quoted: s.slice(cut) };
}

/**
 * The unique inline-image references (`cid:…`) in an HTML body, in order of
 * first appearance — `<img src="cid:x">`, srcset entries and CSS `url(cid:x)`
 * all count. A browser cannot fetch a cid: URL (it names a sibling MIME part,
 * not a network resource), so every ref found here needs its bytes substituted
 * in before the mail can show its images.
 *
 *   extractCidRefs(html) → ['imageA@mail', …]
 */
export function extractCidRefs(html) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /cid:([^"'\s)>,\\]+)/gi;
  let m;
  while ((m = re.exec(s))) {
    const cid = m[1];
    const key = cid.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(cid); }
  }
  return out;
}

/**
 * Pair each cid reference with the attachment that carries its bytes.
 * Three passes, strongest first:
 *   1. the attachment's stored Content-ID matches the cid exactly;
 *   2. the attachment's filename appears inside the cid (Outlook writes cids
 *      like "image001.png@01DA…");
 *   3. leftover IMAGE attachments claimed in document order — the fallback for
 *      mail synced before Content-ID was captured, where inline images are
 *      almost always the message's image parts in order.
 * Each attachment is claimed at most once. Returns Map cid → attachment.
 */
export function matchCidAttachments(cids, attachments) {
  const list = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  const refs = Array.isArray(cids) ? cids : [];
  const used = new Set();
  const out = new Map();
  for (const cid of refs) {
    const hit = list.find((a) => !used.has(a)
      && String(a.contentId || '').toLowerCase() === String(cid).toLowerCase());
    if (hit) { out.set(cid, hit); used.add(hit); }
  }
  for (const cid of refs) {
    if (out.has(cid)) continue;
    const hit = list.find((a) => !used.has(a) && a.filename
      && String(cid).toLowerCase().includes(String(a.filename).toLowerCase()));
    if (hit) { out.set(cid, hit); used.add(hit); }
  }
  const spare = list.filter((a) => !used.has(a)
    && String(a.mimeType || '').toLowerCase().startsWith('image/'));
  let i = 0;
  for (const cid of refs) {
    if (out.has(cid) || i >= spare.length) continue;
    out.set(cid, spare[i]);
    i += 1;
  }
  return out;
}

// A plain-text quote starts at an attribution line ("El … escribió:" / "On …
// wrote:") or at the first "> "-prefixed line.
const QUOTE_TEXT_ATTR_RE = /^\s*(El .{0,120} escribi[oó]:|On .{0,160} wrote:)\s*$/i;
// … or at an Outlook-style plain-text reply header: a "De :/From:" line
// naming an address, with another header line (Envoyé/Sent/À/To/Objet/…)
// within the next few lines. French/Spanish/English variants — European
// suppliers' Outlook writes the French pair. The TWO-line requirement keeps
// a sentence that merely starts with "De: …" from splitting the mail.
const QUOTE_TEXT_DE_RE = /^\s*(de|from|van|von)\s*:\s.*@/i;
const QUOTE_TEXT_HDR_RE = /^\s*(envoy[eé]|enviado|sent|date|fecha|[àa]|para|to|cc|objet|asunto|subject)\s*:/i;

/**
 * The plain-text sibling of splitQuotedHtml — splits a text body at the quoted
 * trail (attribution line or the first ">"-quoted line). Same fail-safes: no
 * marker, or nothing readable above it, means no split.
 *
 *   splitQuotedText(text) → { main, quoted }
 */
export function splitQuotedText(text) {
  const s = String(text || '');
  if (!s) return { main: s, quoted: '' };
  const lines = s.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (QUOTE_TEXT_ATTR_RE.test(lines[i]) || /^\s*>/.test(lines[i])) { cut = i; break; }
    if (QUOTE_TEXT_DE_RE.test(lines[i])
        && lines.slice(i + 1, i + 4).some((l) => QUOTE_TEXT_HDR_RE.test(l))) { cut = i; break; }
  }
  if (cut <= 0) return { main: s, quoted: '' };
  const main = lines.slice(0, cut).join('\n');
  if (!/\S/.test(main)) return { main: s, quoted: '' };
  return { main: main.replace(/\s+$/, ''), quoted: lines.slice(cut).join('\n') };
}

/**
 * The seed for a reply composer over a thread.
 *
 *   resolveReplyDraft(thread, { selfEmail })
 *     → { to, allCc, subject, inReplyToId, threadId } | null
 *
 * `to` is the counterpart — the latest INBOUND sender (so we answer whoever
 * wrote last), falling back to the last message's other party when the thread is
 * all outbound. `allCc` is everyone ELSE on that message (its To + Cc lists,
 * minus us and minus `to`) — the "Responder a todos" recipients; empty when the
 * mirror predates the recipient-list columns or the mail was 1:1. `inReplyToId`
 * is the message the reply chains onto (the latest), and `threadId` nests it in
 * the conversation. `selfEmail` (the connected account) is excluded so we never
 * address a reply back to ourselves.
 */
export function resolveReplyDraft(thread, { selfEmail = '' } = {}) {
  const items = thread?.items || [];
  if (!items.length) return null;
  const self = String(selfEmail || '').toLowerCase();
  const last = items[items.length - 1];

  let to = '';
  let src = null; // the message the reply answers — its recipients feed reply-all
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const m = items[i];
    const from = String(m.fromEmail || '').toLowerCase();
    if (m.direction === 'in' && from && from !== self) { to = m.fromEmail; src = m; break; }
  }
  if (!to) {
    const fallback = last.direction === 'out' ? last.toEmail : last.fromEmail;
    if (String(fallback || '').toLowerCase() !== self) to = fallback || '';
    src = last;
  }

  // Reply-all: every other participant on the answered message, deduped,
  // excluding ourselves and the primary recipient.
  const skip = new Set([self, String(to || '').toLowerCase()].filter(Boolean));
  const allCc = [];
  const pool = [
    ...(src?.toEmails || (src?.toEmail ? [src.toEmail] : [])),
    ...(src?.ccEmails || []),
  ];
  for (const raw of pool) {
    const e = String(raw || '').trim();
    const key = e.toLowerCase();
    if (!e || skip.has(key) || !_EMAIL_RE.test(e)) continue;
    skip.add(key);
    allCc.push(e);
  }

  return {
    to: to || '',
    allCc,
    subject: replySubject(thread.subject || last.subject),
    inReplyToId: last.id,
    threadId: thread.threadId || last.threadId || null,
  };
}

/** Escape a plain string for interpolation into quoted-reply HTML. */
function _escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Deterministic Spanish attribution timestamp — '1 jul 2026 a las 10:16'. */
function _quoteWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()} a las ${hh}:${mm}`;
}

/**
 * The quoted trail a reply carries below the typed text — Gmail's
 * "El {fecha}, {remitente} escribió:" attribution plus the answered message,
 * as both HTML (a gmail_quote blockquote, so every client collapses it) and a
 * '>'-prefixed text alternative. Null when the thread is empty.
 *
 *   resolveReplyQuote(thread) → { html, text } | null
 */
export function resolveReplyQuote(thread) {
  const items = thread?.items || [];
  if (!items.length) return null;
  const m = items[items.length - 1];
  const who = m.fromName
    ? `${m.fromName} <${m.fromEmail || ''}>`
    : (m.fromEmail || '');
  const when = _quoteWhen(m.receivedAt || m.createdAt);
  const attribution = `El ${when}, ${who} escribió:`;
  const bodyHtml = m.bodyHtml
    || _escapeHtml(m.bodyText || m.snippet || '').replace(/\r?\n/g, '<br>');
  const html =
    '<div class="gmail_quote">'
    + `<div class="gmail_attr" dir="ltr">${_escapeHtml(attribution)}</div>`
    + '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">'
    + bodyHtml
    + '</blockquote></div>';
  const bodyText = (m.bodyText || _htmlToText(m.bodyHtml) || m.snippet || '').trim();
  const text = `${attribution}\n${bodyText.split('\n').map((l) => `> ${l}`).join('\n')}`;
  return { html, text };
}

/** "Fwd: …" once, never stacking the prefix (case-insensitive on Fwd:/Fw:/Re:). */
export function forwardSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Fwd: (sin asunto)';
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}

/** Minimal HTML→text for quoting (no DOM — runs in the VM/tests). */
function _htmlToText(html) {
  return String(html || '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Seed a Forward from a thread — the composer opens with a "Fwd:" subject and the
 * latest message quoted (Gmail-style header block + body). Recipients are left
 * empty for the dealer to fill.
 *
 *   resolveForwardDraft(thread) → { subject, body } | null
 */
export function resolveForwardDraft(thread) {
  const items = thread?.items || [];
  if (!items.length) return null;
  const m = items[items.length - 1];
  const when = m.receivedAt || m.createdAt;
  let dateStr = '';
  if (when) { try { dateStr = new Date(when).toLocaleString('es-DO'); } catch { dateStr = ''; } }
  const sender = m.fromName ? `${m.fromName} <${m.fromEmail || ''}>` : (m.fromEmail || '');
  const bodyText = (m.bodyText || _htmlToText(m.bodyHtml) || m.snippet || '').trim();
  const body = [
    '', '',
    '---------- Mensaje reenviado ----------',
    `De: ${sender}`,
    dateStr ? `Fecha: ${dateStr}` : null,
    `Asunto: ${m.subject || ''}`,
    m.toEmail ? `Para: ${m.toEmail}` : null,
    '',
    bodyText,
  ].filter((l) => l !== null).join('\n');
  return { subject: forwardSubject(thread.subject || m.subject), body };
}

/**
 * A CONTACT's email threads — the customer-360 "Correos" card. Filters the
 * mirror to messages whose counterpart is the given address (inbound from it,
 * or outbound addressed/CC'd to it) and rolls them up through the standard
 * thread resolver, archived included (this is history, not an inbox).
 *
 *   resolveContactEmailThreads(messages, { email, limit })
 *     → resolveGmailThreads rows, newest first
 */
export function resolveContactEmailThreads(messages, { email, limit = 6 } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  const relevant = (messages || []).filter((m) => {
    if (m.direction === 'in') return String(m.fromEmail || '').toLowerCase() === e;
    const tos = m.toEmails || (m.toEmail ? [m.toEmail] : []);
    return [...tos, ...(m.ccEmails || [])].some((x) => String(x || '').toLowerCase() === e);
  });
  return resolveGmailThreads(relevant, { includeArchived: true }).slice(0, Math.max(1, limit));
}

/**
 * Adapt a Gmail thread's items to the channel-agnostic wa-draft transcript
 * (buildDraftTurns) — the same AI suggest/translate relay the WhatsApp inbox
 * uses. Each email contributes its NEW words only (the quoted trail is split
 * off, exactly like the reading pane's trimmed content) so the model sees the
 * conversation, not five nested copies of it.
 *
 *   buildGmailDraftTurns(items) → { turns, canDraft }
 */
export function buildGmailDraftTurns(items, opts = {}) {
  const shaped = (items || []).map((m) => {
    const raw = (m.bodyText || _htmlToText(m.bodyHtml) || m.snippet || '').trim();
    return { direction: m.direction, kind: 'text', body: splitQuotedText(raw).main };
  });
  return buildDraftTurns(shaped, { maxChars: 1200, ...opts });
}

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Whether a string is a syntactically valid single email address. */
export function isEmailAddress(s) {
  return _EMAIL_RE.test(String(s || '').trim());
}

/**
 * Recipient suggestions for the composer's To/Cc/Bcc autocomplete — the union of
 * CRM contacts (customers + professionals with an email) and people the inbox has
 * corresponded with (synced gmail_messages), deduped by address. CRM contacts
 * rank first (a known name beats a bare correspondent), then by name.
 *
 *   resolveEmailRecipients(customers, professionals, messages, { needle, limit, exclude })
 *     → [{ name, email, kind: 'customer'|'professional'|'contact' }]
 */
export function resolveEmailRecipients(customers, professionals, messages, { needle = '', limit = 8, exclude = [] } = {}) {
  const byEmail = new Map();
  const add = (email, name, kind, rank) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !_EMAIL_RE.test(e)) return;
    const existing = byEmail.get(e);
    if (!existing || rank < existing.rank) {
      byEmail.set(e, { email: e, name: String(name || '').trim() || (existing?.name || ''), kind, rank });
    } else if (!existing.name && name) {
      existing.name = String(name).trim();
    }
  };
  for (const c of customers || []) add(c.email, c.name || c.company, 'customer', 0);
  for (const p of professionals || []) add(p.email, p.name || p.company, 'professional', 1);
  // People we've exchanged mail with — the counterpart of each message.
  for (const m of messages || []) {
    if (m.direction === 'out') add(m.toEmail, '', 'contact', 3);
    else add(m.fromEmail, m.fromName, 'contact', 2);
  }
  const skip = new Set((exclude || []).map((e) => String(e || '').trim().toLowerCase()));
  const q = needle.trim().toLowerCase();
  return [...byEmail.values()]
    .filter((r) => !skip.has(r.email))
    .filter((r) => !q || r.email.includes(q) || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.rank - b.rank || (a.name || a.email).localeCompare(b.name || b.email))
    .slice(0, Math.max(1, limit))
    .map(({ name, email, kind }) => ({ name, email, kind }));
}

/**
 * Read the SPF/DKIM/DMARC verdicts out of a Gmail `Authentication-Results`
 * header value. Gmail stamps this; the sender can't forge it (it reflects
 * Gmail's own check). Returns lower-cased verdicts, or null when a mechanism
 * isn't present in the header.
 */
function parseAuthResults(raw) {
  const s = String(raw || '').toLowerCase();
  const grab = (mech) => {
    const m = new RegExp(`\\b${mech}=(pass|fail|softfail|neutral|none|temperror|permerror)\\b`).exec(s);
    return m ? m[1] : null;
  };
  return { dmarc: grab('dmarc'), spf: grab('spf'), dkim: grab('dkim'), present: !!s };
}

/**
 * The trust verdict for an invoice email — the BEC / fake-invoice defense.
 * Supplier-invoice fraud spoofs the visible `From:` display name, so we NEVER
 * trust it: we key off Gmail's `Authentication-Results` (DMARC alignment) AND an
 * allow-list of known supplier domains. Per FBI/IC3 + Google guidance, auto-trust
 * ONLY when `dmarc=pass` and the sender domain is a known supplier; a failed
 * DMARC is flagged as suspect; everything else routes to human review — an
 * invoice is never auto-posted to the ledger on the strength of the From name.
 *
 * `message.authResults` is the stored Authentication-Results header (populated by
 * the sync). When it's absent (older rows), the verdict is 'review', not
 * 'trusted' — we fail safe, never open.
 *
 * @returns {{ level:'trusted'|'review'|'suspect', domain:string,
 *   dmarc:string|null, spf:string|null, dkim:string|null, reasons:string[] }}
 */
export function resolveInvoiceTrust(message, { supplierAllowlist = [] } = {}) {
  const domain = senderDomain(message?.fromEmail);
  const auth = parseAuthResults(message?.authResults);
  const allow = (supplierAllowlist || []).map((d) => String(d || '').toLowerCase().trim()).filter(Boolean);
  const known = !!domain && allow.some((d) => domain === d || domain.endsWith(`.${d}`));
  const reasons = [];

  // Hard fail: DMARC failed, or both SPF and DKIM failed → likely spoofed.
  if (auth.dmarc === 'fail' || (auth.spf === 'fail' && auth.dkim === 'fail')) {
    reasons.push('La autenticación del remitente falló (posible suplantación).');
    return { level: 'suspect', domain, dmarc: auth.dmarc, spf: auth.spf, dkim: auth.dkim, reasons };
  }
  // Auto-trust ONLY with dmarc=pass AND a known supplier domain.
  if (auth.dmarc === 'pass' && known) {
    return { level: 'trusted', domain, dmarc: auth.dmarc, spf: auth.spf, dkim: auth.dkim, reasons };
  }
  if (!auth.present) reasons.push('Sin datos de autenticación; revisar manualmente.');
  else if (auth.dmarc !== 'pass') reasons.push('DMARC no verificado; revisar el remitente.');
  else if (!known) reasons.push('Remitente autenticado pero no está en la lista de proveedores conocidos.');
  return { level: 'review', domain, dmarc: auth.dmarc, spf: auth.spf, dkim: auth.dkim, reasons };
}

/**
 * The Facturas tab — every invoice-like message, newest first, decorated with
 * its brand, a best-effort amount, and a sender-trust verdict (BEC defense).
 * `brand` (optional) narrows to one bucket. `supplierAllowlist` (optional)
 * feeds the trust gate.
 *
 *   resolveGmailInvoices(messages, { needle, brand, rules, supplierAllowlist })
 *     → [{ ...message, brand, amount, trust }]
 */
export function resolveGmailInvoices(messages, { needle = '', brand = null, rules = DEFAULT_GMAIL_BRAND_RULES, supplierAllowlist = [] } = {}) {
  const out = (messages || [])
    .filter(isInvoiceEmail)
    .map((m) => ({ ...m, brand: classifyBrand(m, rules), amount: parseInvoiceAmount(m), trust: resolveInvoiceTrust(m, { supplierAllowlist }) }))
    .filter((m) => (brand ? m.brand === brand : true))
    .sort((a, b) => (b.receivedAt || b.createdAt || 0) - (a.receivedAt || a.createdAt || 0));
  return filterGmailInvoices(out, needle);
}

/**
 * Needle filter over resolved invoice rows (subject / sender). Split out so the
 * View can memoize the expensive resolve on [messages] and re-run only this per
 * keystroke (and derive the tab count from the unfiltered list).
 */
export function filterGmailInvoices(invoices, needle = '') {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return invoices || [];
  return (invoices || []).filter((m) =>
    (m.subject || '').toLowerCase().includes(q)
    || (m.fromName || '').toLowerCase().includes(q)
    || (m.fromEmail || '').toLowerCase().includes(q));
}

/**
 * The Adjuntos view — every attachment across the mailbox, newest first, one row
 * PER file (a message with three files yields three rows) so the dealer can find
 * "that PDF" without opening threads. Each row carries the message it rode on
 * (sender, subject, thread, direction) plus the full sibling-attachment list +
 * index, so a click opens the lightbox already paging that message's files.
 * Archived mail is included — this is a file index, not the inbox. `needle`
 * filters by filename / subject / sender.
 *
 *   resolveGmailAttachments(messages, { needle })
 *     → [{ messageId, threadId, attachmentId, filename, mimeType, size,
 *          attachments, index, fromName, fromEmail, subject, direction, receivedAt }]
 */
export function resolveGmailAttachments(messages, { needle = '' } = {}) {
  const out = [];
  for (const m of messages || []) {
    const atts = m.attachments || [];
    atts.forEach((a, index) => {
      if (!a || !(a.filename || a.attachmentId)) return;
      out.push({
        messageId: m.id,
        threadId: m.threadId || m.id,
        attachmentId: a.attachmentId || '',
        filename: a.filename || 'archivo',
        mimeType: a.mimeType || '',
        size: a.size || 0,
        attachments: atts,
        index,
        fromName: m.fromName || '',
        fromEmail: m.fromEmail || '',
        subject: m.subject || '',
        direction: m.direction || 'in',
        receivedAt: m.receivedAt || m.createdAt || 0,
      });
    });
  }
  out.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return filterGmailAttachments(out, needle);
}

/** Needle filter over resolved attachment rows (filename / subject / sender).
 *  Split out so the View memoizes the flatten on [messages] and re-runs only
 *  this per keystroke (and derives the count from the unfiltered list). */
export function filterGmailAttachments(rows, needle = '') {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter((r) =>
    (r.filename || '').toLowerCase().includes(q)
    || (r.subject || '').toLowerCase().includes(q)
    || (r.fromName || '').toLowerCase().includes(q)
    || (r.fromEmail || '').toLowerCase().includes(q));
}
