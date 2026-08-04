// ViewModel for the pedido's "Correo del pedido" card — the Gmail
// conversations the dealer has PINNED to an order (order_email_threads rows
// over the gmail_messages mirror).
//
// Pure projections — no React, no db. The card fetches the mirror + the
// order's link rows, calls these in useMemo, and renders:
//
//   • resolveOrderEmailThreads — one row per linked thread (the standard
//     inbox roll-up, archived included: this is history, not an inbox). A
//     thread whose messages aged out of the mirror still renders from the
//     link's subject snapshot instead of vanishing.
//   • resolveOrderEmailTimeline — every message across the linked threads
//     merged into ONE chronological conversation (the "hilo del pedido"),
//     each contributing only its NEW words (quoted trails stripped, like the
//     reading pane's trimmed content).
//   • orderEmailTokens + resolveOrderEmailSuggestions — candidate threads
//     that mention the order's identifiers (container codes, the order's
//     name), offered as one-tap links. Suggestions are exactly that — the
//     dealer confirms every link; nothing is auto-attached and no AI is
//     involved anywhere in this feature.

import { resolveGmailThreads, splitQuotedText } from './gmailInbox.js';

/** The linked-thread key set from the order's link rows. */
function linkedThreadIds(links) {
  return new Set((links || []).map((l) => l?.threadId).filter(Boolean));
}

/**
 * One row per linked thread, newest activity first — the standard inbox
 * roll-up (subject, unread, count, lastAt, …) decorated with `linkId` so the
 * card can unlink. Archived threads are included (history, not an inbox).
 * A linked thread with NO messages in the mirror (aged out, or synced on
 * another device) falls back to the link's snapshot: `missing: true`, the
 * snapshot subject, and the link date as its timestamp — never dropped.
 *
 *   resolveOrderEmailThreads(messages, links)
 *     → [{ ...threadRow, linkId, missing? }]
 */
export function resolveOrderEmailThreads(messages, links) {
  const wanted = linkedThreadIds(links);
  if (!wanted.size) return [];
  const relevant = (messages || []).filter((m) => wanted.has(m.threadId || m.id));
  const byThread = new Map(
    resolveGmailThreads(relevant, { includeArchived: true }).map((t) => [t.threadId, t]),
  );
  const out = [];
  for (const link of links || []) {
    if (!link?.threadId) continue;
    const t = byThread.get(link.threadId);
    if (t) {
      out.push({ ...t, linkId: link.id });
    } else {
      out.push({
        threadId: link.threadId,
        subject: link.subject || '(sin asunto)',
        fromName: '', fromEmail: '', snippet: '',
        lastAt: link.createdAt || 0, lastDirection: null,
        count: 0, unread: 0, hasInvoice: false, hasAttachment: false,
        starred: false, canArchive: false, bodyText: '',
        linkId: link.id,
        missing: true,
      });
    }
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return out;
}

/** Chars of body a timeline item carries — enough to read what was said,
 *  hard-capped so one long mail can't bloat the card. */
const TIMELINE_TEXT_MAX = 600;

/**
 * The merged conversation across every linked thread — the "hilo del pedido".
 * Oldest-first (it reads like a chat log); each message contributes only its
 * NEW words (splitQuotedText strips the quoted trail every reply drags
 * along), clamped to a bounded slice. When there are more than `limit`
 * messages the timeline keeps the MOST RECENT ones (still oldest-first) and
 * reports the cut so the card can say "mostrando los últimos N".
 *
 *   resolveOrderEmailTimeline(messages, links, { limit })
 *     → { items: [{ id, threadId, direction, fromName, fromEmail, at,
 *                   subject, text, hasAttachment }], total, truncated }
 */
export function resolveOrderEmailTimeline(messages, links, { limit = 30 } = {}) {
  const wanted = linkedThreadIds(links);
  if (!wanted.size) return { items: [], total: 0, truncated: false };
  const all = (messages || [])
    .filter((m) => wanted.has(m.threadId || m.id))
    .sort((a, b) => (a.receivedAt || a.createdAt || 0) - (b.receivedAt || b.createdAt || 0))
    .map((m) => {
      const raw = String(m.bodyText || m.snippet || '').trim();
      return {
        id: m.id,
        threadId: m.threadId || m.id,
        direction: m.direction || 'in',
        fromName: m.fromName || '',
        fromEmail: m.fromEmail || '',
        at: m.receivedAt || m.createdAt || 0,
        subject: m.subject || '',
        text: splitQuotedText(raw).main.trim().slice(0, TIMELINE_TEXT_MAX),
        hasAttachment: !!m.hasAttachment || (m.attachments || []).length > 0,
      };
    });
  const total = all.length;
  const max = Math.max(1, limit);
  const items = total > max ? all.slice(total - max) : all;
  return { items, total, truncated: total > items.length };
}

/**
 * The order's searchable identifiers — what an email about this pedido would
 * plausibly mention: every container code (as typed AND separator-stripped,
 * so "HLBU 123456-7" and "HLBU1234567" both count) plus the order's name
 * when it's distinctive (≥ 4 chars — a name like "LR" would match half the
 * mailbox). Pure over plain fields; nothing here imports the quote core.
 *
 *   orderEmailTokens({ order, containers }) → ['HLBU1234567', …]
 */
export function orderEmailTokens({ order, containers } = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const t = String(raw || '').trim();
    const key = t.toLowerCase();
    if (t.length < 4 || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const c of containers || []) {
    const code = String(c?.code || '').trim();
    add(code);
    add(code.replace(/[^a-zA-Z0-9]/g, ''));
  }
  // The app's own pedido number in the exact form the "Registro LR" export
  // stamps on its filename/subject ("Registro LR Pedido #N") — the strongest
  // matcher: registering the order by email puts this token in that whole
  // reply thread.
  const num = Number(order?.number);
  if (Number.isFinite(num) && num > 0) add(`Pedido #${num}`);
  add(order?.name);
  return out;
}

/**
 * Candidate threads for the order — every mirror thread (archived included)
 * that mentions one of the order's tokens in its subject / snippet / body,
 * minus the already-linked. Container codes also match SEPARATOR-BLIND
 * (token ≥ 8 alphanumerics): shipping mails write "HLBU 123.456-7" while the
 * app stores "HLBU1234567". Each row carries `matchedToken` so the card can
 * say WHY it's suggested. Purely a suggestion list — the dealer taps to link.
 *
 *   resolveOrderEmailSuggestions(messages, { tokens, excludeThreadIds, limit })
 *     → [{ ...threadRow, matchedToken }]
 */
export function resolveOrderEmailSuggestions(messages, { tokens = [], excludeThreadIds = [], limit = 5 } = {}) {
  const needles = (tokens || [])
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => t.length >= 4);
  if (!needles.length) return [];
  const skip = new Set(excludeThreadIds || []);
  const out = [];
  for (const t of resolveGmailThreads(messages, { includeArchived: true })) {
    if (skip.has(t.threadId)) continue;
    const hay = `${t.subject || ''} ${t.snippet || ''} ${t.bodyText || ''}`.toLowerCase();
    const hayCompact = hay.replace(/[^a-z0-9]/g, '');
    const matchedToken = needles.find((n) => {
      // A token ending in a digit must not match inside a LONGER number —
      // "Pedido #10" is not a mention of "Pedido #101". Enforced on the
      // separator-blind compact pass too.
      const bounded = (needle, s) => {
        const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(esc + (/\d$/.test(needle) ? '(?!\\d)' : '')).test(s);
      };
      if (bounded(n, hay)) return true;
      const compact = n.replace(/[^a-z0-9]/g, '');
      return compact.length >= 8 && bounded(compact, hayCompact);
    });
    if (!matchedToken) continue;
    out.push({ ...t, matchedToken });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}
