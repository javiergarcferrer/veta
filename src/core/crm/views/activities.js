// ViewModels for CRM activities — the contact TIMELINE and the follow-up TASK
// queue. Pure projections over `activities` rows (+ the contact they belong
// to); no React, no db. The View fetches, calls these in useMemo, renders.
//
// An activity is one timeline event; a row with `dueAt` set is a follow-up,
// and with `doneAt` null it is still OPEN. `kind='task'` is the pure to-do.

/** The relationship stages a contact moves through (customers primarily). */
export const LIFECYCLE_STAGES = [
  { key: 'lead', label: 'Prospecto', tone: 'amber' },
  { key: 'active', label: 'Activo', tone: 'emerald' },
  { key: 'dormant', label: 'Inactivo', tone: 'ink' },
  { key: 'churned', label: 'Perdido', tone: 'red' },
];
const LIFECYCLE_BY_KEY = new Map(LIFECYCLE_STAGES.map((s) => [s.key, s]));
export function lifecycleLabel(key) { return LIFECYCLE_BY_KEY.get(key)?.label || null; }
export function lifecycleTone(key) { return LIFECYCLE_BY_KEY.get(key)?.tone || 'ink'; }

/** Every activity kind → its Spanish label. `manual` flags the kinds a person
 *  can log by hand from the composer (the rest are auto-logged milestones). */
export const ACTIVITY_KINDS = [
  { key: 'note', label: 'Nota', manual: true },
  { key: 'call', label: 'Llamada', manual: true },
  { key: 'meeting', label: 'Reunión', manual: true },
  { key: 'task', label: 'Tarea', manual: true },
  { key: 'whatsapp', label: 'WhatsApp', manual: false },
  { key: 'instagram', label: 'Instagram', manual: false },
  { key: 'email', label: 'Correo', manual: false },
  { key: 'quote', label: 'Cotización', manual: false },
  { key: 'order', label: 'Pedido', manual: false },
  { key: 'payment', label: 'Pago', manual: false },
  { key: 'stage_change', label: 'Etapa', manual: false },
  { key: 'system', label: 'Evento', manual: false },
];
const KIND_BY_KEY = new Map(ACTIVITY_KINDS.map((k) => [k.key, k]));
export function activityKindLabel(kind) { return KIND_BY_KEY.get(kind)?.label || 'Evento'; }
export const MANUAL_ACTIVITY_KINDS = ACTIVITY_KINDS.filter((k) => k.manual);

/** Decorate one activity with the derived flags every surface reads. */
function decorate(a, now) {
  const isFollowUp = !!a.dueAt;
  const isDone = !!a.doneAt;
  const isOpen = isFollowUp && !isDone;
  return {
    ...a,
    isTask: a.kind === 'task',
    isFollowUp,
    isDone,
    isOpen,
    isOverdue: isOpen && a.dueAt < now,
  };
}

function belongsToContact(a, customerId, professionalId) {
  if (customerId) return a.customerId === customerId;
  if (professionalId) return a.professionalId === professionalId;
  return false;
}

/**
 * One contact's timeline + its open follow-ups.
 *
 *   resolveContactTimeline(activities, { customerId | professionalId, now })
 *     → { timeline, openTasks, pinned, count, lastActivityAt }
 *
 * `timeline` is newest-first (pinned rows are ALSO listed inline in time
 * order — `pinned` is a separate spotlight, not a removal). `openTasks` are the
 * unresolved follow-ups, soonest-due first (overdue floats to the top).
 */
export function resolveContactTimeline(activities, { customerId = null, professionalId = null, now = Date.now() } = {}) {
  const mine = (activities || [])
    .filter((a) => belongsToContact(a, customerId, professionalId))
    .map((a) => decorate(a, now));
  const timeline = [...mine].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const openTasks = mine
    .filter((a) => a.isOpen)
    .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  const pinned = timeline.filter((a) => a.pinned);
  return {
    timeline,
    openTasks,
    pinned,
    count: timeline.length,
    lastActivityAt: timeline[0]?.createdAt || null,
  };
}

/** Local midnight bounds of the day containing `now`. */
function dayBounds(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

/**
 * The follow-up TASK queue — every open follow-up bucketed by when it's due,
 * for the Seguimiento page and the dashboard widget.
 *
 *   resolveTaskQueue(activities, { assignedTo, now, includeDone, doneWindowDays })
 *     → { overdue, today, upcoming, done, counts, contactRef(a) }
 *
 * When `assignedTo` is set the queue is scoped to that owner (a member's "Mis
 * tareas"); omit it for the whole team. Each item keeps its contact ids so the
 * View can link to the customer/professional. `done` lists recently-completed
 * follow-ups (last `doneWindowDays`, newest first) when `includeDone`.
 */
export function resolveTaskQueue(activities, { assignedTo = null, now = Date.now(), includeDone = true, doneWindowDays = 7 } = {}) {
  const { start, end } = dayBounds(now);
  const followUps = (activities || [])
    .filter((a) => !!a.dueAt)
    .filter((a) => (assignedTo ? a.assignedTo === assignedTo : true))
    .map((a) => decorate(a, now));

  const open = followUps.filter((a) => a.isOpen);
  const byDue = (a, b) => (a.dueAt || 0) - (b.dueAt || 0);
  const overdue = open.filter((a) => a.dueAt < start).sort(byDue);
  const today = open.filter((a) => a.dueAt >= start && a.dueAt < end).sort(byDue);
  const upcoming = open.filter((a) => a.dueAt >= end).sort(byDue);

  const doneCutoff = now - doneWindowDays * 24 * 60 * 60 * 1000;
  const done = includeDone
    ? followUps.filter((a) => a.isDone && (a.doneAt || 0) >= doneCutoff)
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    : [];

  return {
    overdue,
    today,
    upcoming,
    done,
    counts: {
      overdue: overdue.length,
      today: today.length,
      upcoming: upcoming.length,
      open: open.length,
    },
  };
}

/** The contact a task points at, normalized for linking. Returns
 *  { kind: 'customer'|'professional'|null, id }. */
export function taskContactRef(a) {
  if (a?.customerId) return { kind: 'customer', id: a.customerId };
  if (a?.professionalId) return { kind: 'professional', id: a.professionalId };
  return { kind: null, id: null };
}
