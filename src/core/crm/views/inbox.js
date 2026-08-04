// ViewModel for the WhatsApp inbox (the CRM conversations surface).
//
// Pure projections over wa_messages + customers + professionals — no React,
// no db. The View fetches, calls these in useMemo, renders. Threads group by
// phoneKey (last 10 digits) so country-code variants of the same number land
// in one conversation, and each thread is linked to the customer/professional
// who CURRENTLY owns that number (phone match here) — the id stamped on a
// message at write time is only a fallback for when no contact holds the
// number today. Numbers are unique per contact (enforced at every write, see
// lib/phone:findPhoneOwner), so the current owner is unambiguous.

import { phoneKey, displayPhone, groupKey, isGroupKey, groupIdFromKey } from '../../../lib/phone.js';
import { wamidHash } from '../../../lib/waWamid.js';

/** Meta's customer-service window: free-form replies are allowed for 24h
 *  after the contact's LAST inbound message; outside it only approved
 *  templates deliver. The composer renders off this. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Group the message log into a conversation list, newest-activity first.
 *
 *   resolveConversations(messages, customers, professionals, { needle, now, groups, suppliers })
 *     → [{ key, groupId, phone, name, contactKind, customerId, professionalId,
 *          supplierId, participantCount, lastBody, lastSenderName, lastAt,
 *          lastDirection, lastStatus, unread, windowOpen,
 *          stage, customerTags, customerOwnerId }]
 *
 * A message with a `groupId` lands in its GROUP thread (key `g:<id>`, name from
 * the `groups` mirror, contactKind 'group') instead of a phone thread — so 1:1
 * chats and groups share one inbox. Archived groups are dropped from the active
 * list. `needle` filters by contact/group name and phone digits; `now`,
 * `groups` and `suppliers` are injectable for tests.
 *
 * A 1:1 thread binds to whoever CURRENTLY owns its number, resolved by phone in
 * precedence customer → professional → supplier (`contactKind`). Suppliers
 * (proveedores) are a third contact kind so accounting can reach vendor numbers
 * from the same inbox; they carry `supplierId` and no CRM enrichment. When no
 * `suppliers` list is passed, the inbox behaves exactly as before.
 *
 * CRM enrichment rides each 1:1 row from the CURRENTLY-linked customer:
 * `stage` (lifecycleStage or null), `customerTags` (the customer's tags — named
 * apart from the conversation-state `labels` the View merges on, so the two
 * never collide) and `customerOwnerId` (ownerUserId or null). Group /
 * professional / supplier / unlinked rows carry stage null, customerTags [],
 * customerOwnerId null. These feed the saved-view chips (resolveInboxViews).
 */
export function resolveConversations(messages, customers, professionals, { needle = '', now = Date.now(), groups = [], suppliers = [] } = {}) {
  const customerByKey = indexByPhone(customers);
  const professionalByKey = indexByPhone(professionals);
  const supplierByKey = indexByPhone(suppliers);
  const groupById = new Map((groups || []).map((g) => [g.id, g]));

  const threads = new Map();
  const albumWrappers = albumWrapperIds(messages);
  for (const m of messages || []) {
    // Album containers never speak for a thread: they'd show the inbox preview
    // as "⚠️ Mensaje no compatible" for a burst of photos that arrived fine.
    if (albumWrappers.has(m.id)) continue;
    const isGroup = !!m.groupId;
    const key = isGroup ? groupKey(m.groupId) : phoneKey(m.phone);
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = { key, isGroup, groupId: isGroup ? m.groupId : null, phone: '', profileName: null,
            customerId: null, professionalId: null, lastBody: '', lastSenderName: null,
            lastAt: 0, lastDirection: null, lastStatus: null, lastInboundAt: 0, unread: 0 };
      threads.set(key, t);
    }
    const at = m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.phone = m.phone;
      t.lastBody = m.templateName && !m.body ? `Plantilla · ${m.templateName}` : (m.body || labelForKind(m.kind, m.payload));
      t.lastDirection = m.direction;
      t.lastStatus = m.status || null;
      // In a group, the inbox row shows WHO spoke last ("Ana: …"); a 1:1 thread
      // has one counterpart, so it stays null.
      t.lastSenderName = isGroup && m.direction === 'in' ? (m.profileName || null) : null;
    }
    if (m.direction === 'in') {
      if (at > t.lastInboundAt) t.lastInboundAt = at;
      if (!m.readAt) t.unread += 1;
      if (m.profileName) t.profileName = m.profileName;
    }
    if (m.customerId && !t.customerId) t.customerId = m.customerId;
    if (m.professionalId && !t.professionalId) t.professionalId = m.professionalId;
  }

  const out = [];
  for (const t of threads.values()) {
    if (t.isGroup) {
      const g = groupById.get(t.groupId) || null;
      // Archived groups leave the active inbox (a local hide; see wa_groups.status).
      if (g && g.status === 'archived') continue;
      out.push({
        key: t.key,
        groupId: t.groupId,
        phone: '',
        name: g?.subject || 'Grupo',
        contactKind: 'group',
        customerId: null,
        professionalId: null,
        supplierId: null,
        participantCount: g?.participantCount ?? null,
        lastBody: t.lastBody,
        lastSenderName: t.lastSenderName,
        lastAt: t.lastAt,
        lastDirection: t.lastDirection,
        lastStatus: t.lastStatus,
        unread: t.unread,
        awaitingReply: t.lastDirection === 'in',
        windowOpen: !!t.lastInboundAt && now - t.lastInboundAt < WA_WINDOW_MS,
        // A group is never a CRM customer → no lifecycle enrichment.
        stage: null,
        customerTags: [],
        customerOwnerId: null,
      });
      continue;
    }
    // The thread's identity is its PHONE NUMBER, so the contact is whoever
    // CURRENTLY owns that number (customerByKey/professionalByKey — unique per
    // key, the relation is watertight at write time). The id stamped on a
    // message is only a FALLBACK, used when no contact holds the number today
    // (e.g. the number was cleared). This ordering keeps a thread from clinging
    // to a stale contact after its number is reassigned — the "Carmen had
    // Alcover's number for testing" bug, where old messages stamped with
    // Carmen kept the thread under her even though Alcover now owns the number.
    const customer = customerByKey.get(t.key) || (t.customerId && (customers || []).find((c) => c.id === t.customerId)) || null;
    const professional = customer ? null
      : (professionalByKey.get(t.key) || (t.professionalId && (professionals || []).find((p) => p.id === t.professionalId)) || null);
    // A supplier (proveedor) only wins the thread when no customer/professional
    // owns the number — vendors are matched purely by phone (messages don't
    // carry a supplierId, so there's no stamped-id fallback here).
    const supplier = (customer || professional) ? null : (supplierByKey.get(t.key) || null);
    const name = customer?.name || customer?.company
      || professional?.name || professional?.company
      || supplier?.name
      || t.profileName || displayPhone(t.phone);
    out.push({
      key: t.key,
      groupId: null,
      phone: t.phone,
      name,
      contactKind: customer ? 'customer' : professional ? 'professional' : supplier ? 'supplier' : null,
      customerId: customer?.id || null,
      professionalId: professional?.id || null,
      supplierId: supplier?.id || null,
      participantCount: null,
      lastBody: t.lastBody,
      lastSenderName: null,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      lastStatus: t.lastStatus,
      unread: t.unread,
      // The client wrote last and we haven't answered — distinct from `unread`
      // (which clears the moment the thread is OPENED, even with no reply). This
      // is the inbox's "ball in our court" signal, used by the "Sin responder"
      // filter so a read-but-unanswered client is never lost.
      awaitingReply: t.lastDirection === 'in',
      windowOpen: !!t.lastInboundAt && now - t.lastInboundAt < WA_WINDOW_MS,
      // CRM segmentation off the CURRENTLY-linked customer (null/[] for a
      // professional or unlinked thread). `customerTags` is deliberately NOT
      // `labels` — the View merges conversation-state `labels` onto the row and
      // the two must not collide.
      stage: customer?.lifecycleStage || null,
      customerTags: customer?.tags || [],
      customerOwnerId: customer?.ownerUserId || null,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const q = needle.trim().toLowerCase();
  if (!q) return out;
  const qDigits = q.replace(/\D/g, '');
  return out.filter((c) =>
    c.name.toLowerCase().includes(q)
    || (qDigits && (c.phone || '').replace(/\D/g, '').includes(qDigits)));
}

/** A conversation is SNOOZED when its `snoozeExpiresAt` (ms, merged onto the row
 *  by the View from conversation-state) is still in the future. A snoozed row is
 *  excluded from EVERY saved view — it's a deliberate "come back later". */
function isSnoozed(c, now) {
  return !!c && typeof c.snoozeExpiresAt === 'number' && c.snoozeExpiresAt > now;
}

/**
 * Saved-view chips for the conversation list — a small ordered set of segments
 * the dealer taps to focus the inbox, each with its LIVE count over the
 * already-decorated conversation rows (resolveConversations output PLUS the
 * View's conversation-state merge: `assignedTo`, `snoozeExpiresAt`, …).
 *
 *   resolveInboxViews(conversations, { myId, maxTagViews, now })
 *     → [{ key, label, kind, count, stage?, tag? }]
 *
 * Fixed chips first — Todas (all non-snoozed), Sin responder (awaiting reply &
 * !snoozed), Mías (assignedTo === myId, ONLY when myId is set), Prospectos
 * (stage 'lead', OMITTED at zero) — then up to `maxTagViews` chips for the
 * most-frequent `customerTags` across the non-snoozed rows (ties broken
 * alphabetically), each with its own count; zero-count tag chips are omitted.
 *
 * Every count excludes snoozed rows (`snoozeExpiresAt > now`). `now` is
 * injectable for tests; the companion predicate is `conversationMatchesView`.
 */
export function resolveInboxViews(conversations, { myId = null, maxTagViews = 3, now = Date.now() } = {}) {
  const rows = (conversations || []).filter((c) => !isSnoozed(c, now));
  const views = [
    { key: 'all', label: 'Todas', kind: 'all', count: rows.length },
    { key: 'awaiting', label: 'Sin responder', kind: 'awaiting', count: rows.filter((c) => c.awaitingReply).length },
  ];
  if (myId) {
    views.push({ key: 'mine', label: 'Mías', kind: 'mine', count: rows.filter((c) => c.assignedTo === myId).length });
  }
  const leads = rows.filter((c) => c.stage === 'lead').length;
  if (leads > 0) views.push({ key: 'leads', label: 'Prospectos', kind: 'stage', stage: 'lead', count: leads });

  // Tag frequency across the non-snoozed rows: most-frequent first, ties alphabetical.
  const freq = new Map();
  for (const c of rows) {
    for (const t of c.customerTags || []) {
      if (!t) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const top = [...freq.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, maxTagViews));
  for (const [tag, count] of top) {
    if (count > 0) views.push({ key: `tag:${tag}`, label: tag, kind: 'tag', tag, count });
  }
  return views;
}

/**
 * Count of unread inbound 1:1 messages in threads ASSIGNED to `myId` — the
 * scoped WhatsApp badge for a non-seller (accounting) whose inbox is limited to
 * the conversations routed to them. `convStates` are the wa_conversation_state
 * rows (each carries `phoneKey` + `assignedTo`); a message counts only when its
 * thread's assignee is `myId`. Group threads have no assignee (no phoneKey) and
 * are excluded. Zero when `myId` is falsy or nothing is assigned.
 *
 *   resolveAssignedUnread(messages, convStates, { myId }) → number
 */
export function resolveAssignedUnread(messages, convStates, { myId = null } = {}) {
  if (!myId) return 0;
  const mine = new Set();
  for (const s of convStates || []) {
    if (s && s.assignedTo === myId && s.phoneKey) mine.add(s.phoneKey);
  }
  if (!mine.size) return 0;
  let n = 0;
  for (const m of messages || []) {
    if (m.direction !== 'in' || m.readAt || m.groupId) continue;
    if (mine.has(phoneKey(m.phone))) n += 1;
  }
  return n;
}

/**
 * Does a conversation belong to a saved view? The View filters the list with
 * this after the dealer picks a chip. Kinds: all/awaiting/mine/stage/tag — a
 * snoozed row matches NOTHING (every view hides snoozed, so 'all' is really
 * "all non-snoozed"). `myId` scopes the 'mine' kind; `now` gates the snooze.
 */
export function conversationMatchesView(conversation, view, { myId = null, now = Date.now() } = {}) {
  if (!conversation || !view) return false;
  if (isSnoozed(conversation, now)) return false;
  switch (view.kind) {
    case 'all': return true;
    case 'awaiting': return !!conversation.awaitingReply;
    case 'mine': return !!myId && conversation.assignedTo === myId;
    case 'stage': return conversation.stage === view.stage;
    case 'tag': return (conversation.customerTags || []).includes(view.tag);
    default: return false;
  }
}

/**
 * One conversation, oldest-first, plus the state the composer needs:
 *
 *   resolveThread(messages, { key, now })
 *     → { items, isGroup, groupId, lastInboundAt, windowOpen, windowExpiresAt }
 *
 * `key` is a phoneKey (1:1) or a `g:<id>` group key (isGroupKey). For a group
 * thread the items are filtered by `groupId` and each inbound bubble carries a
 * `senderName` (who in the group spoke) — a 1:1 thread excludes any group rows
 * that happen to share the counterpart's phoneKey.
 *
 * `windowOpen` ⇒ free-form text delivers; closed ⇒ only an approved template
 * will (Meta error 131047 otherwise).
 *
 * WhatsApp affordances resolved here (not in the View):
 *   • reactions — an inbound `reaction` row decorates its TARGET message
 *     (matched by wamid) as `reactions: [emoji]` instead of rendering as its
 *     own bubble; an empty emoji (the user removed the reaction) clears it.
 *   • quoted replies — a message sent in reply to another (Meta's `context`)
 *     carries `quoted: { direction, body, kind }`, the snippet the bubble
 *     shows above the text.
 */
export function resolveThread(messages, { key, now = Date.now() } = {}) {
  const isGroup = isGroupKey(key);
  const gid = isGroup ? groupIdFromKey(key) : '';
  const raw = (messages || [])
    .filter((m) => (isGroup ? m.groupId === gid : (!m.groupId && phoneKey(m.phone) === key)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let lastInboundAt = 0;
  for (const m of raw) {
    if (m.direction === 'in' && (m.createdAt || 0) > lastInboundAt) lastInboundAt = m.createdAt || 0;
  }

  // wamid → message, the join key reactions and quoted replies resolve on.
  // The HASH index is the second key: WhatsApp is migrating addressing to LID,
  // so a reply can cite the same message under a different wamid (see
  // lib/waWamid). Exact id stays primary; the hash only catches what it misses.
  const byWaId = new Map();
  const byHash = new Map();
  for (const m of raw) {
    if (!m.waId) continue;
    byWaId.set(m.waId, m);
    const h = wamidHash(m.waId);
    if (h && !byHash.has(h)) byHash.set(h, m);
  }
  const findByWaId = (id) => {
    if (!id) return null;
    const exact = byWaId.get(id);
    if (exact) return exact;
    const h = wamidHash(id);
    return (h && byHash.get(h)) || null;
  };

  // Reactions fold onto their target in arrival order (last one wins per
  // sender — in a 1:1 thread that's simply the latest). Unknown targets (the
  // reacted-to message predates our log) keep the reaction as its own row so
  // the emoji isn't silently lost.
  const reactionsByWaId = new Map();
  const albumWrappers = albumWrapperIds(raw);
  const rows = [];
  for (const m of raw) {
    // An album container is a protocol artifact, not a message — its photos
    // render on their own right below it (see albumWrapperIds).
    if (albumWrappers.has(m.id)) continue;
    if (m.kind === 'reaction') {
      const r = m.payload?.reaction;
      const targetId = findByWaId(r?.message_id)?.waId || null;
      const emoji = r?.emoji || m.body || '';
      if (targetId) {
        if (emoji) reactionsByWaId.set(targetId, [emoji]);
        else reactionsByWaId.delete(targetId); // reaction removed
        continue;
      }
      if (!emoji) continue;
    }
    rows.push(m);
  }

  const items = rows.map((m) => {
    const reactions = (m.waId && reactionsByWaId.get(m.waId)) || null;
    const ctxId = m.payload?.context?.id;
    const target = findByWaId(ctxId);
    // A cited message we never logged (sent from the phone before Coexistence
    // echoes existed — Meta never resends those) still renders as a quote, in
    // its `missing` shape: "es una respuesta" is real information, and dropping
    // it left the reply looking like an unprompted message.
    const quoted = target
      ? { direction: target.direction, body: target.body || labelForKind(target.kind, target.payload), kind: target.kind, waId: target.waId || ctxId }
      : (ctxId ? { missing: true, direction: null, body: '', kind: null, waId: ctxId } : null);
    // In a group, every inbound bubble names its sender (there are many
    // counterparts); a 1:1 thread has just one, so it stays unlabeled.
    const senderName = isGroup && m.direction === 'in'
      ? (m.profileName || displayPhone(m.phone) || '') : null;
    if (!reactions && !quoted && !senderName) return m;
    return { ...m, reactions, quoted, ...(senderName ? { senderName } : {}) };
  });

  const windowOpen = !!lastInboundAt && now - lastInboundAt < WA_WINDOW_MS;
  return {
    items,
    isGroup,
    groupId: gid || null,
    lastInboundAt: lastInboundAt || null,
    windowOpen,
    windowExpiresAt: windowOpen ? lastInboundAt + WA_WINDOW_MS : null,
  };
}

/**
 * Contacts a new conversation can start with: every customer/professional (and,
 * when a `suppliers` list is passed, every supplier) that has a phone, minus
 * those already in a thread. Powers the "Nuevo chat" picker (searchable). Pass
 * only the lists a role may reach — accounting gets suppliers alone.
 */
export function resolveNewChatContacts(customers, professionals, conversations, { needle = '', suppliers = [] } = {}) {
  const taken = new Set((conversations || []).map((c) => c.key));
  const q = needle.trim().toLowerCase();
  const pick = (rows, contactKind) => (rows || [])
    .filter((r) => phoneKey(r.phone) && !taken.has(phoneKey(r.phone)))
    .filter((r) => !q
      || (r.name || '').toLowerCase().includes(q)
      || (r.company || '').toLowerCase().includes(q)
      || (r.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000'))
    .map((r) => ({
      key: phoneKey(r.phone),
      phone: r.phone,
      name: r.name || r.company || displayPhone(r.phone),
      contactKind,
      customerId: contactKind === 'customer' ? r.id : null,
      professionalId: contactKind === 'professional' ? r.id : null,
      supplierId: contactKind === 'supplier' ? r.id : null,
    }));
  const out = [...pick(customers, 'customer'), ...pick(professionals, 'professional'), ...pick(suppliers, 'supplier')];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Candidates for LINKING an unknown WhatsApp number to an existing CRM row —
 * the inverse of the Nuevo-chat picker: it must include contacts WITHOUT a
 * phone (they're the most likely link targets) and shows each candidate's
 * current number so the dealer sees what a link would replace. Phone-less
 * rows sort first, then by name; needle matches name / company / email /
 * phone digits.
 *
 *   resolveLinkCandidates(customers, professionals, { needle })
 *     → [{ key, contactKind, customerId, professionalId, name, company,
 *          phone, hasPhone }]
 */
export function resolveLinkCandidates(customers, professionals, { needle = '' } = {}) {
  const q = needle.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const pick = (rows, contactKind) => (rows || [])
    .filter((r) => !q
      || (r.name || '').toLowerCase().includes(q)
      || (r.company || '').toLowerCase().includes(q)
      || (r.email || '').toLowerCase().includes(q)
      || (qDigits && (r.phone || '').replace(/\D/g, '').includes(qDigits)))
    .map((r) => ({
      key: `${contactKind}:${r.id}`,
      contactKind,
      customerId: contactKind === 'customer' ? r.id : null,
      professionalId: contactKind === 'professional' ? r.id : null,
      name: r.name || r.company || '(sin nombre)',
      company: r.company || '',
      phone: r.phone || '',
      hasPhone: !!phoneKey(r.phone),
    }));
  const out = [...pick(customers, 'customer'), ...pick(professionals, 'professional')];
  out.sort((a, b) => (a.hasPhone === b.hasPhone ? a.name.localeCompare(b.name) : a.hasPhone ? 1 : -1));
  return out;
}

/**
 * The thread target for an inbox deep-link (/chats?chat=<phone>) — how the
 * CRM pages' WhatsApp quick actions land on a conversation. Returns the
 * EXISTING conversation when the phone already has a thread; otherwise a
 * draft contact target (same shape as the Nuevo-chat picker rows, so the
 * first send materializes the thread identically); null when the phone is
 * unusable or matches no contact.
 */
export function resolveChatTarget(customers, professionals, conversations, phone, { suppliers = [] } = {}) {
  const key = phoneKey(phone);
  if (!key) return null;
  const existing = (conversations || []).find((c) => c.key === key);
  if (existing) return { key, existing: true, target: existing };
  const find = (rows, contactKind) => {
    const r = (rows || []).find((row) => phoneKey(row.phone) === key);
    if (!r) return null;
    return {
      key,
      phone: r.phone,
      name: r.name || r.company || displayPhone(r.phone),
      contactKind,
      customerId: contactKind === 'customer' ? r.id : null,
      professionalId: contactKind === 'professional' ? r.id : null,
      supplierId: contactKind === 'supplier' ? r.id : null,
    };
  };
  const target = find(customers, 'customer') || find(professionals, 'professional') || find(suppliers, 'supplier');
  return target ? { key, existing: false, target } : null;
}

/**
 * The product order a customer submitted from a catalog / product-list message
 * (Meta's inbound `order` message), normalized for the chat — or null. The
 * client builds a cart out of the product cards we sent and sends it back; this
 * surfaces it in the thread so the dealer can turn it into a quote. `item_price`
 * is a decimal in `currency`; the total is summed here so the bubble and any
 * downstream "crear cotización" read one figure.
 */
export function resolveOrderMessage(message) {
  const o = message?.payload?.order;
  if (!o || !Array.isArray(o.product_items)) return null;
  const items = o.product_items.map((p) => ({
    retailerId: String(p.product_retailer_id || ''),
    quantity: Number(p.quantity) || 0,
    price: Number(p.item_price) || 0,
    currency: String(p.currency || ''),
  })).filter((p) => p.retailerId);
  if (!items.length) return null;
  return {
    catalogId: String(o.catalog_id || ''),
    items,
    currency: items[0].currency,
    total: items.reduce((s, p) => s + p.price * p.quantity, 0),
    text: String(o.text || ''),
  };
}

/**
 * Can this message be FORWARDED? Forwarding re-sends the source's content, so
 * the content must actually be available to us AND the row must be a persisted
 * server message (an optimistic 'sending' draft has no DB id to load, a failed
 * send has nothing that was delivered). Mirrors the server's FORWARDABLE set
 * (wa-send forward handler): text/media/location/contacts; NOT interactive,
 * reactions, orders, templates, system.
 *
 *   isForwardableMessage(m) → boolean
 */
export function isForwardableMessage(m) {
  if (!m || !m.id || m.status === 'sending' || m.status === 'failed') return false;
  const kind = m.kind || 'text';
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(kind)) return !!m.mediaPath;
  if (kind === 'location') return !!(m.payload && m.payload.location);
  if (kind === 'contacts') {
    const p = m.payload || {};
    return !!(Array.isArray(p.contacts) ? p.contacts.length : p.contact);
  }
  if (kind === 'text') return !!(m.body && m.body.trim());
  return false;
}

/**
 * Encode an order's items as a `refs` query value for the quote builder's
 * draft seeder — `reference:qty` pairs, comma-joined, each reference
 * percent-encoded so a SKU's own `:`/`,` can't collide with the separators.
 * The inverse is parseOrderRefs; the pair round-trips (pinned in the test).
 */
export function buildOrderRefsParam(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({ reference: String(it?.reference ?? it?.retailerId ?? '').trim(), qty: Math.max(1, Number(it?.qty ?? it?.quantity) || 1) }))
    .filter((it) => it.reference)
    .map((it) => `${encodeURIComponent(it.reference)}:${it.qty}`)
    .join(',');
}

/** Parse a `refs` query value back into [{ reference, qty }]. Tolerant of a
 *  missing/blank qty (→ 1) and of junk segments (skipped). */
export function parseOrderRefs(str) {
  return String(str || '')
    .split(',')
    .map((seg) => {
      const i = seg.lastIndexOf(':');
      const ref = i >= 0 ? seg.slice(0, i) : seg;
      const qty = i >= 0 ? Number(seg.slice(i + 1)) : 1;
      return { reference: decodeURIComponent(ref || '').trim(), qty: Math.max(1, qty || 1) };
    })
    .filter((it) => it.reference);
}

/**
 * The Click-to-WhatsApp ad referral of an inbound message, normalized for the
 * chat bubble, or null. Meta stamps `referral` on the FIRST message a user
 * sends after tapping a CTWA ad / sponsored post — the inbox surfaces it so
 * the team knows the lead came from a paid placement (and which one).
 */
export function resolveReferral(message) {
  const r = message?.payload?.referral;
  if (!r || typeof r !== 'object') return null;
  return {
    sourceType: r.source_type || 'ad',
    headline: r.headline || '',
    body: r.body || '',
    sourceUrl: r.source_url || '',
  };
}

/**
 * Fill a quick-reply snippet's named placeholders. Supported (case-insensitive):
 *   {{nombre}}  → the contact's name
 *   {{negocio}} → the dealer's business name
 * An UNKNOWN placeholder is left intact (so a typo is visible, not silently
 * dropped); a known key with no value collapses to ''. Distinct from
 * fillTemplateBody's numeric {{1}} scheme — quick replies are free text the
 * dealer authors, so named tokens read better than positional ones.
 */
export function fillQuickReply(text, { nombre = '', negocio = '' } = {}) {
  const map = { nombre, negocio };
  return String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? String(map[k] ?? '') : whole;
  });
}

/**
 * Reconcile optimistic outbound rows against the server-logged messages —
 * SINGLE-CLAIM. `wa-send` doesn't echo back a client id we could pair on
 * exactly, so an optimistic bubble is matched to a durable row by target +
 * message type + a near-coincident timestamp (and body, where a body is
 * meaningful). The window is symmetric (±windowMs): a server row can be stamped
 * slightly BEFORE the local createdAt on clock skew, which a one-sided check
 * would miss, stranding the bubble on "Enviando" forever.
 *
 * "Single-claim" = each server row consumes AT MOST ONE pending row. Sending
 * the same text twice inside the window used to let one server row clear BOTH
 * bubbles (existence-based `.some`), making the second vanish until the next
 * refetch; here a matched row is claimed and can't be reused.
 *
 *   reconcileOptimistic(pending, messages, { windowMs })
 *     → { pending: <still-unmatched rows>, reconciledIds: <ids that matched> }
 *
 * Pure — the View revokes any object URLs on the reconciled rows and sets the
 * remaining pending list. Nothing here reads React or db.
 */
export function reconcileOptimistic(pending, messages, { windowMs = 10000 } = {}) {
  const outbound = (messages || []).filter((m) => m.direction === 'out');
  const claimed = new Set(); // indices into `outbound` already paired
  const remaining = [];
  const reconciledIds = [];
  for (const p of pending || []) {
    let hitIdx = -1;
    for (let i = 0; i < outbound.length; i += 1) {
      if (claimed.has(i)) continue;
      if (optimisticPairs(p, outbound[i], windowMs)) { hitIdx = i; break; }
    }
    if (hitIdx >= 0) { claimed.add(hitIdx); reconciledIds.push(p.id); }
    else remaining.push(p);
  }
  return { pending: remaining, reconciledIds };
}

/** Does server row `m` reconcile optimistic row `p`? Same target + message
 *  CLASS + time window; body must match for text, templateName for a template
 *  (when both name it); any media class pairs on target + window alone (a
 *  caption can be normalized server-side, and single-claim already prevents
 *  double-clearing).
 *
 *  Matching is on the COARSE class (text | template | media), NOT the exact
 *  media kind: the client buckets a File's MIME (any image/* → 'image') while
 *  the server (`wa-send`) buckets tighter (only jpeg/png/webp → 'image', an
 *  iPhone HEIC or a GIF → 'document'). Requiring the exact kind to match would
 *  strand those sends on "Enviando" forever — the very bug reconcile prevents. */
function optimisticPairs(p, m, windowMs) {
  const sameTarget = p.groupId
    ? m.groupId === p.groupId
    : (!m.groupId && phoneKey(m.phone) === phoneKey(p.phone));
  if (!sameTarget) return false;
  const cls = matchClass(optimisticType(p));
  if (cls !== matchClass(serverType(m))) return false;
  if (Math.abs((m.createdAt || 0) - (p.createdAt || 0)) > windowMs) return false;
  if (cls === 'text') return (m.body || '') === (p.body || '');
  if (cls === 'template') {
    if (p.templateName && m.templateName) return p.templateName === m.templateName;
    return true;
  }
  return true; // media (image/video/audio/document/sticker) — coarse class match
}

function optimisticType(p) { return p?.type || p?.kind || 'text'; }
function serverType(m) { return m?.templateName ? 'template' : (m?.kind || 'text'); }
/** Collapse a message type to the class reconciliation pairs on: text,
 *  template, or media (everything else). */
function matchClass(type) {
  if (type === 'text') return 'text';
  if (type === 'template') return 'template';
  return 'media';
}

function indexByPhone(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = phoneKey(r.phone);
    if (key && !map.has(key)) map.set(key, r);
  }
  return map;
}

/** Meta message types that carry no recoverable content: the Cloud API itself
 *  couldn't parse what the customer sent (error 131051 — a poll, event, "view
 *  once", newer sticker/album, etc.), so there is no body and no media to fetch.
 *  'unsupported' rides the live webhook; 'errors' rides history sync; 'unknown'
 *  is our own fallback for a typeless message. Presentation must not surface the
 *  raw Meta type (the cryptic English "(unsupported)") — the dealer reads that
 *  as a failed file or a broken app. */
export function isUnsupportedKind(kind) {
  return kind === 'unsupported' || kind === 'errors' || kind === 'unknown';
}

/** Meta names WHAT the unsupported thing was in payload.unsupported.type.
 *  'edit' = the customer edited an already-sent message — the Cloud API never
 *  delivers edits, so nothing was lost (the original bubble above still holds
 *  the pre-edit text). Presentation must say "edited", not "incompatible":
 *  the generic copy sends the dealer chasing a phantom attachment. */
export function isEditUnsupported(payload) {
  return payload?.unsupported?.type === 'edit';
}

/** History-sync placeholder for a media message that predates the connection:
 *  Meta's coexistence chat-history stream backfills the TEXT of old
 *  conversations but represents every old photo/PDF/audio as a bare
 *  'media_placeholder' with no id and no url — the bytes are never included, so
 *  the file is not recoverable through the API and lives only in the phone's
 *  WhatsApp app. Presentation must say so, not show the raw type. */
export function isMediaPlaceholderKind(kind) {
  return kind === 'media_placeholder';
}

/** 131060 — "This message is unavailable": content Meta itself could not
 *  retrieve. Genuinely lost, so it always keeps its warning (never an album
 *  container, which is an empty wrapper around photos that DID arrive). */
function isUnavailableMessage(payload) {
  return Number(payload?.errors?.[0]?.code) === 131060;
}

/** An ALBUM (several photos sent as one group from the phone) has no type in
 *  the Cloud API. Meta delivers the album CONTAINER as an `unsupported` message
 *  — error 131051, no body, no media — in its OWN webhook delivery, then each
 *  photo separately a second or two later. Rendering that container is a false
 *  alarm: nothing was lost, the photos are right underneath, but the bubble
 *  reads as a failed attachment and trains the dealer to ignore the warning
 *  that does matter.
 *
 *  Nothing in the container names the album, so adjacency is the only signal:
 *  ≥2 same-thread, same-direction photos/videos within ALBUM_WINDOW_MS. In prod
 *  every album lands within 2s, and a LONE photo is never an album — that floor
 *  is what separates a container from a genuinely unsupported message (a poll,
 *  "view once", an event), which must keep its warning.
 *
 *  The rule is self-protecting: it needs the photos to EXIST, so if they never
 *  persisted there is no burst to match and the container stays visible. A
 *  message can never silently vanish. */
export const ALBUM_WINDOW_MS = 5000;
const ALBUM_MIN_PARTS = 2;

function isAlbumCandidate(m) {
  return isUnsupportedKind(m.kind) && !m.body && !m.mediaPath
    && !isEditUnsupported(m.payload) && !isUnavailableMessage(m.payload);
}

/** `${thread}|${direction}` — an album's parts share both. */
function burstKey(m) {
  const key = m.groupId ? groupKey(m.groupId) : phoneKey(m.phone);
  return key ? `${key}|${m.direction || ''}` : '';
}

/**
 * The ids of the album containers in `messages` — the empty `unsupported` rows
 * whose real content is the photo burst beside them. Presentation drops these
 * (thread bubbles and inbox previews alike); the rows stay in wa_messages, this
 * is a rendering decision, not a delete.
 */
export function albumWrapperIds(messages) {
  const rows = messages || [];
  const candidates = rows.filter(isAlbumCandidate);
  if (!candidates.length) return new Set(); // the overwhelmingly common case

  const burstTimes = new Map();
  for (const m of rows) {
    if (m.kind !== 'image' && m.kind !== 'video') continue;
    const k = burstKey(m);
    if (!k) continue;
    let times = burstTimes.get(k);
    if (!times) { times = []; burstTimes.set(k, times); }
    times.push(m.createdAt || 0);
  }

  const wrappers = new Set();
  for (const c of candidates) {
    const times = burstTimes.get(burstKey(c)) || [];
    const at = c.createdAt || 0;
    let parts = 0;
    for (const t of times) {
      if (Math.abs(t - at) <= ALBUM_WINDOW_MS && ++parts >= ALBUM_MIN_PARTS) break;
    }
    if (parts >= ALBUM_MIN_PARTS) wrappers.add(c.id);
  }
  return wrappers;
}

function labelForKind(kind, payload) {
  if (isUnsupportedKind(kind)) return isEditUnsupported(payload) ? '✏️ Editó un mensaje' : '⚠️ Mensaje no compatible';
  if (isMediaPlaceholderKind(kind)) return '📎 Multimedia (historial)';
  const labels = {
    image: '📷 Imagen', video: '🎬 Video', audio: '🎤 Audio', document: '📄 Documento',
    sticker: 'Sticker', location: '📍 Ubicación', contacts: 'Contacto', reaction: 'Reacción',
    order: '🛒 Pedido', system: 'Aviso del sistema',
  };
  return labels[kind] || (kind && kind !== 'text' ? `Mensaje (${kind})` : 'Mensaje');
}
