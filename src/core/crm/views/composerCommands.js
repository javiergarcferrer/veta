// Composer command palette — the pure ViewModel behind the "/" inline palette
// in the WhatsApp chat composer (the "customer command center").
//
// `resolveComposerCommands` is a pure projection: the current needle (what the
// dealer typed after "/"), the quick-reply library, the customer's recent
// quotes, and a handful of context flags in → grouped, filtered seller actions
// out. No React, no db, no Supabase — the View
// (components/whatsapp/ComposerCommandPalette.jsx) owns keyboard/selection
// state and dispatches each picked command's `kind`/`payload` to the host.
//
// A command is { id, group, label, hint?, kind, payload? }. `kind` tells the
// host WHAT to do; `payload` carries the parameters it needs. Groups render in
// a fixed order and an empty group is omitted entirely, so the palette never
// shows a bare header.

/** Max recent quotes surfaced in the "Cotizaciones" group. */
export const COMPOSER_QUOTE_CAP = 3;

/** How long "Posponer 3 horas" snoozes a conversation (ms). */
export const SNOOZE_3H_MS = 3 * 60 * 60 * 1000;

/** Case-insensitive substring test; a blank needle matches everything. */
function hit(needle, ...fields) {
  if (!needle) return true;
  return fields.some((f) => f != null && String(f).toLowerCase().includes(needle));
}

/**
 * Normalize a quick-reply row into { label, text }. The library stores rich
 * rows ({ id, label, text }) but a caller may also pass bare strings, so both
 * shapes collapse to the same shape here (a bare string is its own body, with
 * no separate title).
 */
function normalizeQuickReply(r) {
  if (r == null) return { label: '', text: '' };
  if (typeof r === 'string') return { label: r, text: r };
  const text = r.text ?? r.body ?? '';
  return { label: r.label ?? text, text };
}

/**
 * The composer-palette projection.
 *
 * Input (all optional):
 *   needle       — the text typed after "/" (the View strips the slash).
 *   quickReplies — settings.whatsappQuickReplies rows (or bare strings).
 *   quotes       — the customer's quotes ({ id|quoteId, number, statusLabel|status,
 *                  updatedAt }); projected newest-first, capped at 3.
 *   hasCustomer  — thread is linked to a CRM customer (gates Documentos).
 *   hasPhone     — thread has a phone (gates the snooze actions).
 *   windowOpen   — 24h WhatsApp free-text window is open (reserved context;
 *                  every command here inserts/opens rather than sends free
 *                  text, so none is gated on it today).
 *   assignedToMe — the current agent already owns the conversation.
 *   canAssign    — assignment is available (a signed-in agent to claim it).
 *
 * Output: { groups: [{ key, label, commands }], flat: [commands in render order] }.
 * Each `commands` entry is a full command; `flat` is the flattened render order
 * for the composer's ↑/↓/Enter keyboard traversal.
 */
export function resolveComposerCommands({
  needle = '',
  quickReplies = [],
  quotes = [],
  hasCustomer = false,
  hasPhone = false,
  windowOpen = false, // eslint-disable-line no-unused-vars
  assignedToMe = false,
  canAssign = false,
} = {}) {
  const nq = String(needle || '').trim().toLowerCase();

  // 1 — Respuestas rápidas: one command per quick reply, matched on both its
  // title and its body so "/gracias" finds a reply whose label is "Cierre".
  const quickCommands = (quickReplies || [])
    .map(normalizeQuickReply)
    .filter((r) => r.label || r.text)
    .filter((r) => hit(nq, r.label, r.text))
    .map((r, i) => ({
      id: `quick-reply:${i}`,
      group: 'Respuestas rápidas',
      label: r.label || r.text,
      hint: r.label && r.text && r.label !== r.text ? r.text : undefined,
      kind: 'quick-reply',
      payload: { text: r.text },
    }));

  // 2 — Documentos: send the customer their paper. Requires a linked customer
  // (an unlinked thread has no account/quotes/contract to pull).
  const docCommands = (hasCustomer
    ? [
        { id: 'open-docs', label: 'Enviar cotización…', kind: 'open-docs' },
        { id: 'send-statement', label: 'Enviar estado de cuenta', kind: 'send-statement' },
        { id: 'send-contract', label: 'Enviar contrato', kind: 'send-contract' },
      ]
    : []
  )
    .filter((c) => hit(nq, c.label))
    .map((c) => ({ ...c, group: 'Documentos' }));

  // 3 — Cotizaciones: jump to the customer's most-recently-touched quotes.
  const quoteCommands = [...(quotes || [])]
    .sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))
    .slice(0, COMPOSER_QUOTE_CAP)
    .map((q) => {
      const quoteId = q.id ?? q.quoteId ?? null;
      const number = q.number ?? '—';
      const status = q.statusLabel ?? q.status ?? undefined;
      return {
        id: `open-quote:${quoteId}`,
        group: 'Cotizaciones',
        label: `Abrir #${number}`,
        hint: status || undefined,
        kind: 'open-quote',
        payload: { quoteId },
      };
    })
    .filter((c) => hit(nq, c.label));

  // 4 — Conversación: follow-up + ownership + snooze. Assign only when there's
  // someone to claim it and the agent doesn't already own it; snooze needs a
  // phone (the conversation state keys on it).
  const convCommands = [
    { id: 'create-task', label: 'Crear tarea de seguimiento…', kind: 'create-task', enabled: true },
    { id: 'assign-me', label: 'Asignármela a mí', kind: 'assign-me', enabled: canAssign && !assignedToMe },
    {
      id: 'snooze-3h', label: 'Posponer 3 horas', kind: 'snooze',
      payload: { ms: SNOOZE_3H_MS }, enabled: hasPhone,
    },
    {
      id: 'snooze-tomorrow', label: 'Posponer hasta mañana', kind: 'snooze',
      payload: { ms: 'tomorrow' }, enabled: hasPhone,
    },
  ]
    .filter((c) => c.enabled)
    .filter((c) => hit(nq, c.label))
    .map(({ enabled, ...c }) => ({ ...c, group: 'Conversación' }));

  const groups = [
    { key: 'quick', label: 'Respuestas rápidas', commands: quickCommands },
    { key: 'docs', label: 'Documentos', commands: docCommands },
    { key: 'quotes', label: 'Cotizaciones', commands: quoteCommands },
    { key: 'conversation', label: 'Conversación', commands: convCommands },
  ].filter((g) => g.commands.length > 0);

  return { groups, flat: groups.flatMap((g) => g.commands) };
}
