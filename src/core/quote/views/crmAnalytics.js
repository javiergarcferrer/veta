// ViewModel for pages/CrmAnalytics.jsx — the "Análisis de clientes" admin view
// (CRM Phase 5: customer analytics + the re-engagement/retention queue).
//
// Pure projection: the page fetches the raw rows (customers, quotes, quoteLines,
// profiles) and reads this straight through — no React, no db, no supabase.
// Every USD figure routes through the shared per-quote money helpers
// (quoteGrandTotal + linesByQuoteId) exactly as resolveCustomersList does, so
// the numbers here agree to the cent with the Clientes list, CustomerDetail and
// the dashboard. USD figures are plain USD-base sums (no per-quote rate juggling
// — the aggregate has no single rate, mirroring how lists.js sums totals).
import { linesByQuoteId, quoteGrandTotal } from '../totals.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * resolveCrmAnalytics({ customers, quotes, lines, profiles, now, dormantDays })
 *   → { totals, topCustomers, dormant, ownerConversion, leadSources, stageCounts }
 *
 * A "buyer" is a customer with ≥1 ACCEPTED quote; lifetime value is the sum of
 * that customer's accepted quotes' grand totals. The dormant list is the
 * re-engagement queue (see below).
 */
export function resolveCrmAnalytics({
  customers = [], quotes = [], lines = [], profiles = [],
  now = Date.now(), dormantDays = 180,
} = {}) {
  const linesByQuote = linesByQuoteId(lines);
  const grandTotal = (qu) => quoteGrandTotal(qu, linesByQuote.get(qu.id) || []);

  // Per-customer rollup: accepted lifetime USD, accepted count, and the latest
  // quote activity timestamp (max updatedAt across the customer's quotes) — the
  // quote side of "last touch".
  const rollup = new Map();
  const ensure = (id) => {
    if (!rollup.has(id)) rollup.set(id, { lifetimeUsd: 0, acceptedCount: 0, lastQuoteAt: 0 });
    return rollup.get(id);
  };
  for (const qu of quotes) {
    if (!qu.customerId) continue;
    const r = ensure(qu.customerId);
    if ((qu.updatedAt || 0) > r.lastQuoteAt) r.lastQuoteAt = qu.updatedAt || 0;
    if (qu.status === 'accepted') {
      r.lifetimeUsd += grandTotal(qu);
      r.acceptedCount += 1;
    }
  }

  // ── totals ────────────────────────────────────────────────────────────────
  let leads = 0;
  let buyers = 0;
  let repeatBuyers = 0;
  for (const c of customers) {
    if (c.lifecycleStage === 'lead') leads += 1;
    const r = rollup.get(c.id);
    if (r && r.acceptedCount >= 1) buyers += 1;
    if (r && r.acceptedCount >= 2) repeatBuyers += 1;
  }
  const totals = {
    customers: customers.length,
    leads,
    buyers,
    repeatBuyers,
    // Share of buyers who came back — the retention headline.
    repeatPct: buyers > 0 ? Math.round((repeatBuyers / buyers) * 100) : 0,
  };

  // "Last touch" = the freshest of a hand-logged lastContactedAt and the
  // customer's latest quote activity, so a client we quoted yesterday isn't
  // flagged dormant just because nobody logged a call.
  const lastTouchOf = (c) => {
    const r = rollup.get(c.id);
    return Math.max(c.lastContactedAt || 0, r?.lastQuoteAt || 0);
  };

  // ── topCustomers: top 10 by lifetime accepted USD ──────────────────────────
  const topCustomers = customers
    .map((c) => {
      const r = rollup.get(c.id);
      return {
        customer: c,
        lifetimeUsd: r?.lifetimeUsd || 0,
        acceptedCount: r?.acceptedCount || 0,
        lastTouchAt: lastTouchOf(c) || null,
      };
    })
    .filter((e) => e.lifetimeUsd > 0)
    .sort((a, b) => b.lifetimeUsd - a.lifetimeUsd)
    .slice(0, 10);

  // ── dormant: the RE-ENGAGEMENT QUEUE ───────────────────────────────────────
  // Buyers (lifetimeUsd>0) whose last touch is older than dormantDays — the
  // most valuable relationships going cold, most-valuable first so the biggest
  // wins to save surface at the top. 'churned' is EXCLUDED (already written off;
  // this queue is for winning back the still-savable). Boundary rule: a touch
  // exactly dormantDays old is still "inside" (not dormant) — a customer becomes
  // dormant only once STRICTLY more than dormantDays have elapsed.
  const dormantCutoff = now - dormantDays * DAY;
  const dormant = customers
    .filter((c) => c.lifecycleStage !== 'churned')
    .map((c) => {
      const r = rollup.get(c.id);
      const lastTouchAt = lastTouchOf(c);
      return {
        customer: c,
        lifetimeUsd: r?.lifetimeUsd || 0,
        lastTouchAt: lastTouchAt || null,
        daysSince: lastTouchAt ? Math.floor((now - lastTouchAt) / DAY) : null,
      };
    })
    .filter((e) => e.lifetimeUsd > 0 && e.lastTouchAt != null && e.lastTouchAt < dormantCutoff)
    .sort((a, b) => b.lifetimeUsd - a.lifetimeUsd);

  // ── ownerConversion: per-seller pipeline conversion ────────────────────────
  // Keyed by quote.createdByUserId (who authored the quote). `sent` counts
  // quotes that ever LEFT draft — either they carry a sentAt or their status is
  // past draft (accepted/declined/archived can lack a sentAt but were clearly
  // worked). `winRatePct` uses a DECIDED-ONLY denominator (accepted /
  // (accepted+declined)): a quote still open (draft/sent) isn't a loss yet, so
  // counting it against the seller would understate a healthy pipeline. Sellers
  // with zero quotes are skipped entirely.
  const nameByProfile = new Map(profiles.map((p) => [p.id, p.name]));
  const ownerAgg = new Map();
  const ensureOwner = (id) => {
    if (!ownerAgg.has(id)) ownerAgg.set(id, { userId: id, sent: 0, accepted: 0, declined: 0, wonUsd: 0 });
    return ownerAgg.get(id);
  };
  for (const qu of quotes) {
    const id = qu.createdByUserId || null;
    const o = ensureOwner(id);
    if (qu.sentAt || (qu.status && qu.status !== 'draft')) o.sent += 1;
    if (qu.status === 'accepted') { o.accepted += 1; o.wonUsd += grandTotal(qu); }
    if (qu.status === 'declined') o.declined += 1;
  }
  const ownerConversion = [...ownerAgg.values()]
    .map((o) => {
      const decided = o.accepted + o.declined;
      return {
        userId: o.userId,
        name: (o.userId != null && nameByProfile.get(o.userId)) || 'Equipo',
        sent: o.sent,
        accepted: o.accepted,
        winRatePct: decided > 0 ? Math.round((o.accepted / decided) * 100) : 0,
        wonUsd: o.wonUsd,
      };
    })
    .sort((a, b) => b.wonUsd - a.wonUsd);

  // ── leadSources: acquisition-channel breakdown ─────────────────────────────
  // Per customer.leadSource (null → 'Sin origen'); wonUsd is the summed lifetime
  // accepted value of the customers from that source. Sorted by headcount desc.
  const sourceAgg = new Map();
  for (const c of customers) {
    const key = c.leadSource || 'Sin origen';
    if (!sourceAgg.has(key)) sourceAgg.set(key, { source: key, count: 0, wonUsd: 0 });
    const s = sourceAgg.get(key);
    s.count += 1;
    s.wonUsd += rollup.get(c.id)?.lifetimeUsd || 0;
  }
  const leadSources = [...sourceAgg.values()].sort((a, b) => b.count - a.count);

  // ── stageCounts: lifecycle distribution ────────────────────────────────────
  const stageCounts = { lead: 0, active: 0, dormant: 0, churned: 0, unset: 0 };
  for (const c of customers) {
    const s = c.lifecycleStage;
    if (s === 'lead' || s === 'active' || s === 'dormant' || s === 'churned') stageCounts[s] += 1;
    else stageCounts.unset += 1;
  }

  return { totals, topCustomers, dormant, ownerConversion, leadSources, stageCounts };
}
