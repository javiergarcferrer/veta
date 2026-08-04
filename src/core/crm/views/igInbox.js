// ViewModel for the Instagram Direct inbox (the CRM's second conversation
// channel, beside the WhatsApp inbox in core/crm/views/inbox.js).
//
// Pure projections over ig_messages rows — no React, no db. Threads group by
// `threadKey` (the counterpart's IG-scoped id, IGSID): a contact's inbound DMs
// and our outbound replies carry the same key, so they land in one thread.
// There's no phone/contact linking here (IG users aren't keyed by phone); the
// thread's display name is the counterpart's @-handle (or name) resolved from
// the webhook. Mirrors the WhatsApp inbox's shapes so the View can render both
// channels with the same components.

/** Instagram's standard-messaging window: free-form replies are allowed for 24h
 *  after the contact's LAST inbound message; outside it Meta rejects the send
 *  (only message tags / the human-agent escalation deliver). The composer
 *  renders off this — the same rule as WhatsApp. */
export const IG_WINDOW_MS = 24 * 60 * 60 * 1000;

function labelForKind(kind) {
  const labels = {
    image: '📷 Imagen', video: '🎬 Video', audio: '🎤 Audio',
    share: '↗️ Publicación compartida', story_mention: 'Mención en historia',
    story_reply: 'Respuesta a tu historia', deleted: 'Mensaje eliminado',
    file: '📎 Archivo', attachment: '📎 Adjunto',
  };
  return labels[kind] || (kind && kind !== 'text' ? `Mensaje (${kind})` : 'Mensaje');
}

/** Index customers + professionals by their linked IGSID (instagramId), so a
 *  thread resolves to the CRM contact that owns it — the WhatsApp phoneKey
 *  pattern, keyed on the IG-scoped id instead. One IGSID ↔ one contact
 *  (lib/instagramDm.linkIgContact releases any previous owner on link). */
function contactIndex(customers, professionals) {
  const byIgsid = new Map();
  for (const p of professionals || []) {
    if (p.instagramId) byIgsid.set(p.instagramId, { contactKind: 'professional', professionalId: p.id, customerId: null, contactName: p.name || p.company || '' });
  }
  // Customers win a (never-expected) double claim — they're the selling side.
  for (const c of customers || []) {
    if (c.instagramId) byIgsid.set(c.instagramId, { contactKind: 'customer', customerId: c.id, professionalId: null, contactName: c.name || c.company || '' });
  }
  return byIgsid;
}

/** Display name for a thread: the @-handle, else the stored name, else the id. */
function threadName(username, name, threadKey) {
  if (username) return `@${username}`;
  if (name) return name;
  return threadKey || 'Instagram';
}

// ── Per-conversation CRM state (assignment / note / snooze) ──────────────────
// IG threads reuse the WhatsApp inbox's wa_conversation_state table, keyed by a
// namespaced `ig:<threadKey>` phone_key (see lib/instagramDm.js — the writer).
// This is the READER side: strip the prefix to merge a state row onto its
// thread, ignoring any WhatsApp rows that share the table. The prefix MUST stay
// in lockstep with lib/instagramDm.js's igStateKey.
export const IG_STATE_PREFIX = 'ig:';

/** Reader-side namespaced key for an IG thread — mirrors the writer in
 *  lib/instagramDm.js so the merge lands on the right row. */
export function igStateKey(threadKey) {
  const key = String(threadKey || '').trim();
  return key ? IG_STATE_PREFIX + key : '';
}

/** Index conversation-state rows by their IG thread key (the `ig:` prefix
 *  stripped); non-IG (WhatsApp) rows sharing the table are skipped. */
function igStateByKey(states) {
  const m = new Map();
  for (const s of states || []) {
    const k = String((s && s.phoneKey) || '');
    if (!k.startsWith(IG_STATE_PREFIX)) continue;
    m.set(k.slice(IG_STATE_PREFIX.length), s);
  }
  return m;
}

/**
 * Group the Instagram message log into a conversation list, newest-activity
 * first.
 *
 *   resolveIgConversations(messages, { needle, now, customers, professionals })
 *     → [{ key, threadKey, name, username, lastBody, lastAt, lastDirection,
 *          lastStatus, unread, awaitingReply, windowOpen,
 *          contactKind, customerId, professionalId }]
 *
 * `needle` filters by @-handle / name (including a linked contact's name);
 * `now` is injectable for tests. `customers`/`professionals` (optional) bind
 * threads to CRM contacts by `instagramId` — a linked thread takes the
 * contact's name and carries the id for the 360 deep-link.
 */
export function resolveIgConversations(messages, { needle = '', now = Date.now(), customers = null, professionals = null, states = null } = {}) {
  const byIgsid = contactIndex(customers, professionals);
  const stateByKey = igStateByKey(states);
  const threads = new Map();
  for (const m of messages || []) {
    const key = (m.threadKey || '').trim();
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        key, threadKey: key, username: null, name: null,
        lastBody: '', lastAt: 0, lastDirection: null, lastStatus: null,
        lastInboundAt: 0, unread: 0,
      };
      threads.set(key, t);
    }
    const at = m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.lastBody = m.body || labelForKind(m.kind);
      t.lastDirection = m.direction;
      t.lastStatus = m.status || null;
    }
    if (m.direction === 'in') {
      if (at > t.lastInboundAt) t.lastInboundAt = at;
      if (!m.readAt) t.unread += 1;
    }
    // The counterpart's identity rides inbound rows; keep the freshest non-empty.
    if (m.username) t.username = m.username;
    if (m.name) t.name = m.name;
  }

  const out = [];
  for (const t of threads.values()) {
    const linked = byIgsid.get(t.key) || null;
    // CRM state (assignment / internal note / snooze), merged from the shared
    // wa_conversation_state table by the thread's namespaced key. Name
    // resolution for `assignedTo` is left to the View (profiles aren't passed
    // here) — the VM only surfaces the owner id + the note/snooze flags.
    const state = stateByKey.get(t.key) || null;
    const snoozeExpiresAt = (state && state.snoozeExpiresAt) || null;
    out.push({
      key: t.key,
      threadKey: t.threadKey,
      // A linked CRM contact names the thread; else the @handle → name → id.
      name: (linked && linked.contactName) || threadName(t.username, t.name, t.threadKey),
      username: t.username,
      lastBody: t.lastBody,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      lastStatus: t.lastStatus,
      unread: t.unread,
      // The contact wrote last and we haven't answered — the "ball in our court"
      // signal (distinct from `unread`, which clears on open).
      awaitingReply: t.lastDirection === 'in',
      windowOpen: !!t.lastInboundAt && now - t.lastInboundAt < IG_WINDOW_MS,
      contactKind: linked ? linked.contactKind : null,
      customerId: linked ? linked.customerId : null,
      professionalId: linked ? linked.professionalId : null,
      // CRM-state projection (owner id + note/snooze), same shapes the WhatsApp
      // inbox decorates its conversations with.
      state,
      assignedTo: (state && state.assignedTo) || null,
      note: (state && state.note) || null,
      hasNote: !!(state && state.note && String(state.note).trim()),
      snoozeExpiresAt,
      // A snoozed thread drops from the active list until its expiry passes —
      // exactly like the WhatsApp inbox (the View filters on this flag).
      snoozed: !!(snoozeExpiresAt && snoozeExpiresAt > now),
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const q = needle.trim().toLowerCase();
  if (!q) return out;
  return out.filter((c) =>
    c.name.toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q));
}

/**
 * One Instagram conversation, oldest-first, plus the state the composer needs:
 *
 *   resolveIgThread(messages, { threadKey, now })
 *     → { items, threadKey, lastInboundAt, windowOpen, windowExpiresAt }
 *
 * `windowOpen` ⇒ a free-form reply delivers; closed ⇒ Meta rejects it (the
 * composer disables and explains, same as WhatsApp's 24h gate).
 */
export function resolveIgThread(messages, { threadKey, now = Date.now() } = {}) {
  const key = (threadKey || '').trim();
  const items = (messages || [])
    .filter((m) => (m.threadKey || '').trim() === key)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    // `displayBody` carries the label fallback so a bubble never renders a bare
    // "—": a media / text-less row shows its kind label, the same rule the
    // conversation list uses for `lastBody`.
    .map((m) => ({ ...m, displayBody: m.body || labelForKind(m.kind) }));
  let lastInboundAt = 0;
  for (const m of items) {
    if (m.direction === 'in' && (m.createdAt || 0) > lastInboundAt) lastInboundAt = m.createdAt || 0;
  }
  const windowOpen = !!lastInboundAt && now - lastInboundAt < IG_WINDOW_MS;
  return {
    items,
    threadKey: key || null,
    lastInboundAt: lastInboundAt || null,
    windowOpen,
    windowExpiresAt: windowOpen ? lastInboundAt + IG_WINDOW_MS : null,
  };
}
