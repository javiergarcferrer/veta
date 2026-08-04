/**
 * ViewModel for the header rate badge — the floating chip that shows Banco
 * Popular's USD→DOP venta at a glance and, expanded, compra/venta + EUR + the
 * recent daily history (`rate_history`, written by the bpd-rate function).
 *
 * The live figure comes from settings.exchangeRate via readExchangeRate — the
 * SAME source every quote prices with, so the chip can never disagree with the
 * app. History only decorates: the trend arrow compares the latest published
 * day against the published day before it (the bank skips weekends/holidays,
 * so "previous" means previous PUBLISHED day, not calendar yesterday), and
 * each listed day compares against its own predecessor the same way.
 */
import { readExchangeRate, drBusinessDay } from '../../../lib/exchangeRate.js';

// "vie, 1 ago" — short es-DO labels for the history rows.
const DAY_LABEL = new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: 'numeric', month: 'short' });

const MAX_DAYS = 14;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function fmt2(n) {
  return n == null ? null : n.toFixed(2);
}
function signed(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}
function trendOf(delta) {
  if (delta == null) return null;
  if (Math.abs(delta) < 0.005) return 'flat';
  return delta > 0 ? 'up' : 'down';
}
function dayLabel(iso, today) {
  if (iso === today) return 'Hoy';
  const [y, m, d] = iso.split('-').map(Number);
  return DAY_LABEL.format(new Date(y, m - 1, d));
}

export function resolveRateBadge({ settings, history, now = Date.now() } = {}) {
  const live = readExchangeRate(settings);
  const today = drBusinessDay(now);

  // Newest-first published days (rate_date is the PK — one row per DR day).
  const rows = (history || [])
    .map((h) => ({
      date: String(h?.rateDate || '').slice(0, 10),
      sell: toNum(h?.usdSell) ?? toNum(h?.usdBuy),
    }))
    .filter((r) => r.date && r.sell != null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const sell = toNum(live.sell) ?? toNum(live.buy) ?? rows[0]?.sell ?? null;
  const buy = toNum(live.buy);
  const eurSell = toNum(settings?.eurRate?.sell);
  const eurBuy = toNum(settings?.eurRate?.buy);

  // Headline movement: the latest published day vs the one before it. When the
  // newest row IS today's, prefer the live settings figure for it (the hourly
  // pull may have refined today's row since the history read).
  const newest = rows[0];
  const prior = newest ? rows.find((r) => r.date < newest.date) : null;
  const delta = newest && prior
    ? (newest.date === today && sell != null ? sell : newest.sell) - prior.sell
    : null;

  const days = rows.slice(0, MAX_DAYS).map((r, i) => {
    const before = rows[i + 1];
    const d = before ? r.sell - before.sell : null;
    return {
      date: r.date,
      label: dayLabel(r.date, today),
      sellLabel: fmt2(r.sell),
      delta: d,
      deltaLabel: d == null ? null : signed(d),
      trend: trendOf(d),
    };
  });

  return {
    hasRate: sell != null,
    sell,
    sellLabel: fmt2(sell),
    buy,
    buyLabel: fmt2(buy),
    hasEur: eurSell != null,
    eurSellLabel: fmt2(eurSell),
    eurBuyLabel: fmt2(eurBuy),
    updatedAt: live.updatedAt ?? null,
    delta,
    deltaLabel: delta == null ? null : signed(delta),
    trend: trendOf(delta),
    days,
  };
}
