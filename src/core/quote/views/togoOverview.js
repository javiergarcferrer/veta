// ViewModel for the Togo workspace's RESUMEN — the home screen that fuses the
// four sections (solicitudes inbox, configurador widget, modelos catalog,
// distribuidores) into one operational picture, so the workspace reads as one
// application instead of four divorced tabs.
//
// MVVM: pages/TogoOverview.jsx renders THIS. Pure — the workspace passes the
// togo_requests / dealers / togo_models rows plus the admin flag, and renders
// the result. `now` is injectable so every time-derived figure (stale-lead
// alert, the 90-día funnel) stays testable. Money stays USD here; the View
// formats to DOP with the live rate, same as every other money surface.
//
// Two clocks on purpose:
//   • the KPIs are OPERATIONAL (all-time): an open lead from four months ago
//     is still work to do — it must never age out of the counters.
//   • the funnel/conversión are WINDOWED (90 días): a rate over all history
//     stops moving; a windowed one tells the dealer how the widget is doing NOW.

const DAY_MS = 86400000;

export const TOGO_OVERVIEW_WINDOW_DAYS = 90;
// A lead nobody has touched for this long turns the nudge urgent.
export const TOGO_STALE_PENDING_DAYS = 2;
export const TOGO_OVERVIEW_RECENT_MAX = 6;
export const TOGO_OVERVIEW_ALERTS_MAX = 5;

const OPEN_STATUSES = new Set(['pending', 'contacted']);

// status → pill (the same status-pill family every list surface uses).
const STATUS_META = {
  pending:   { label: 'Nueva',      cls: 'status-pill-pending' },
  contacted: { label: 'Contactado', cls: 'status-pill-sent' },
  converted: { label: 'Cotizada',   cls: 'status-pill-accepted' },
  dismissed: { label: 'Descartada', cls: 'status-pill-archived' },
};

const TONE_RANK = { urgent: 0, warn: 1, info: 2 };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function resolveTogoOverview({ requests, dealers, models, admin = false, now = Date.now() } = {}) {
  const reqs = Array.isArray(requests) ? requests : [];
  const deal = Array.isArray(dealers) ? dealers : [];
  const mods = Array.isArray(models) ? models : [];

  // ── Operational counters (all-time). ──────────────────────────────────
  const open = reqs.filter((r) => OPEN_STATUSES.has(r.status));
  const fresh = open.filter((r) => r.status === 'pending');
  const contacted = open.filter((r) => r.status === 'contacted');

  // Pipeline = what the OPEN leads priced themselves at in the widget. Unpriced
  // leads (hidden-price dealers) count as leads but add nothing to the money.
  let pipelineUsd = 0;
  let pipelinePriced = 0;
  for (const r of open) {
    const v = Number(r.estimateUsd);
    if (v > 0) { pipelineUsd += v; pipelinePriced += 1; }
  }

  // ── Windowed funnel. ───────────────────────────────────────────────────
  const cutoff = now - TOGO_OVERVIEW_WINDOW_DAYS * DAY_MS;
  const inWindow = reqs.filter((r) => (r.createdAt || 0) >= cutoff);
  const funnel = {
    windowDays: TOGO_OVERVIEW_WINDOW_DAYS,
    received: inWindow.length,
    open: inWindow.filter((r) => OPEN_STATUSES.has(r.status)).length,
    converted: inWindow.filter((r) => r.status === 'converted').length,
    dismissed: inWindow.filter((r) => r.status === 'dismissed').length,
  };
  const conversionPct = funnel.received > 0
    ? Math.round((funnel.converted / funnel.received) * 100)
    : null;

  // ── Catalog health (admin — the models are an admin surface). ─────────
  const activeModels = mods.filter((m) => m.active !== false);
  const catalog = admin ? {
    total: mods.length,
    active: activeModels.length,
    draft: mods.length - activeModels.length,
    // An ACTIVE model without a product binding is served without a price;
    // without a mesh it renders as the flat silhouette. Drafts are parked on
    // purpose, so only published models count as health problems.
    unbound: activeModels.filter((m) => !m.productRoot).length,
    noMesh: activeModels.filter((m) => !m.meshUrl).length,
  } : null;

  // ── Per-source rollup (admin board): every dealer + the Directo row. ───
  const statsByKey = new Map();
  for (const r of reqs) {
    const key = r.dealerId || 'direct';
    const s = statsByKey.get(key) || { total: 0, pending: 0, converted: 0, lastAt: 0 };
    s.total += 1;
    if (r.status === 'pending') s.pending += 1;
    if (r.status === 'converted') s.converted += 1;
    if ((r.createdAt || 0) > s.lastAt) s.lastAt = r.createdAt || 0;
    statsByKey.set(key, s);
  }
  const ZERO = { total: 0, pending: 0, converted: 0, lastAt: 0 };
  const board = admin
    ? [
      { id: null, filterKey: 'direct', name: 'Directo', active: true, ...(statsByKey.get('direct') || ZERO) },
      ...deal.map((d) => ({
        id: d.id, filterKey: d.id, name: d.name || 'Distribuidor',
        active: d.active !== false, ...(statsByKey.get(d.id) || ZERO),
      })),
    ].sort((a, b) => (b.pending - a.pending) || (b.total - a.total) || a.name.localeCompare(b.name))
    : null;

  // ── Recent activity (all statuses — the workspace's shared timeline). ──
  const dealerNameById = new Map(deal.map((d) => [d.id, d.name]));
  const recent = [...reqs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, TOGO_OVERVIEW_RECENT_MAX)
    .map((r) => ({
      id: r.id,
      name: r.contact?.name || 'Sin nombre',
      createdAt: r.createdAt || 0,
      status: STATUS_META[r.status] || { label: r.status || '—', cls: 'status-pill-draft' },
      estimateUsd: Number(r.estimateUsd) > 0 ? Number(r.estimateUsd) : null,
      pieces: (r.items || []).length,
      dealerLabel: r.dealerId ? (dealerNameById.get(r.dealerId) || 'Distribuidor') : 'Directo',
      direct: !r.dealerId,
      // A converted lead deep-links to the quote it became — the row is the
      // bridge into the regular pipeline.
      quoteId: r.status === 'converted' ? (r.quoteId || null) : null,
    }));

  // ── Alerts — the "intelligent" strip: derived nudges, worst first. ─────
  // Each carries the section (and optional dealer filter) it deep-links to.
  const alerts = [];
  let oldestPending = null;
  for (const r of fresh) {
    if (r.createdAt && (!oldestPending || r.createdAt < oldestPending.createdAt)) oldestPending = r;
  }
  if (oldestPending && oldestPending.createdAt <= now - TOGO_STALE_PENDING_DAYS * DAY_MS) {
    const days = Math.floor((now - oldestPending.createdAt) / DAY_MS);
    alerts.push({
      id: 'stale-pending', tone: 'urgent', section: 'solicitudes',
      text: `La solicitud de ${oldestPending.contact?.name || 'un visitante'} lleva ${plural(days, 'día', 'días')} sin atender.`,
    });
  } else if (fresh.length > 0) {
    alerts.push({
      id: 'fresh-pending', tone: 'info', section: 'solicitudes',
      text: `${plural(fresh.length, 'solicitud nueva espera', 'solicitudes nuevas esperan')} revisión.`,
    });
  }
  if (admin && catalog.unbound > 0) {
    alerts.push({
      id: 'models-unbound', tone: 'warn', section: 'modelos',
      text: `${plural(catalog.unbound, 'modelo publicado', 'modelos publicados')} sin producto vinculado — el widget los muestra sin precio.`,
    });
  }
  if (admin && catalog.noMesh > 0) {
    alerts.push({
      id: 'models-no-mesh', tone: 'warn', section: 'modelos',
      text: `${plural(catalog.noMesh, 'modelo publicado', 'modelos publicados')} sin modelo 3D — salen como silueta plana.`,
    });
  }
  if (admin && board) {
    // The two hottest dealer inboxes; the board below carries the rest.
    for (const row of board.filter((b) => b.id && b.pending > 0).slice(0, 2)) {
      alerts.push({
        id: `dealer-${row.id}`, tone: 'info', section: 'solicitudes', dealer: row.filterKey,
        text: `«${row.name}» tiene ${plural(row.pending, 'solicitud', 'solicitudes')} sin atender.`,
      });
    }
  }
  alerts.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const cappedAlerts = alerts.slice(0, TOGO_OVERVIEW_ALERTS_MAX);

  // ── Masthead status line. ──────────────────────────────────────────────
  const statusParts = [plural(open.length, 'solicitud abierta', 'solicitudes abiertas')];
  if (admin && catalog) {
    statusParts.push(plural(catalog.active, 'modelo publicado', 'modelos publicados'));
    const activeDealers = deal.filter((d) => d.active !== false).length;
    if (activeDealers > 0) statusParts.push(plural(activeDealers, 'distribuidor', 'distribuidores'));
  }

  return {
    kpis: {
      open: { count: open.length, fresh: fresh.length, contacted: contacted.length },
      pipeline: { usd: pipelineUsd, priced: pipelinePriced },
      conversion: { pct: conversionPct, converted: funnel.converted, received: funnel.received },
      catalog,
    },
    alerts: cappedAlerts,
    funnel,
    recent,
    board,
    statusParts,
  };
}
