/**
 * Figures — the ONE way this app draws a number.
 *
 * Before this file there were twelve. `Kpi` in Atlas, `Kpi` in ConfiguratorOverview,
 * `Kpi` in ConfiguratorActivity, `Stat` in instagram/chrome, `Stat` in DealerPanel,
 * `Stat` in admin/Fredericia, `Metric` in StockCountPanel, `Metric` in
 * Difusión, `StatTile` in CustomerContextPanel, `Tile` and `KpiTile` in
 * Análisis 360, `StatKpi` in Estados, `Figure` in ContractPaper — each one a
 * label over a value, and no two of them the same label or the same value.
 * Seven different eyebrow recipes (`.eyebrow`, `.eyebrow-xs`, and five
 * hand-rolled `text-micro uppercase tracking-…` variants that each missed the
 * primitive by one utility), six containers, and — the part that actually
 * costs a reader something — THREE OF THEM DROPPED `tabular-nums`, so their
 * figures did not line up with the identical tile one card over.
 *
 * ── Why one recipe matters more for figures than for anything else ─────────
 *
 * A dealer does not READ a KPI row, they SCAN it. Scanning works because the
 * eye can compare two shapes in the same position at the same size without
 * spending attention on either — the moment two tiles differ in label case,
 * figure size or digit width, that free comparison turns into two separate
 * acts of reading. So the consistency here is not tidiness; it is the whole
 * mechanism by which the row is faster than a paragraph.
 *
 * ── What this file will not let a call site do ─────────────────────────────
 *
 *   · Paint a direction green without saying which direction is good.
 *     `goodWhen` has no default that flatters: ventas up is good, gastos up
 *     is bad, headcount moving is neither, and a component that guessed would
 *     be wrong on half the accounting boards. (See lib/quant.ts.)
 *   · Show a delta with no baseline. `delta={null}` renders nothing; a
 *     missing comparison is never dressed as "0%".
 *   · Encode meaning in colour alone. Every delta carries a direction glyph
 *     and a signed number; the colour is the third cue, not the only one.
 *   · Print a figure in a mark tone. Valence text uses the `-ink` step
 *     (4.5:1); the arrowhead uses the mark tone (3:1). See index.css.
 *
 * Model lives in `lib/quant.ts` (deltas, tones, compaction); this file is the
 * View — chrome, type roles and layout, nothing derived.
 */
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { formatCount, formatDeltaPct, toneFor } from '../../lib/quant.js';

/* ─────────────────────────────── atoms ──────────────────────────────── */

/**
 * An inline figure that belongs to a SET — a KPI row, a totals dock, a grid
 * of tiles. Carries tabular figures so the digit places stack with whatever
 * sits above and below it.
 *
 * A number inside a SENTENCE does not want this and should not use it: the
 * proportional default is what proportional figures are for. Tables get the
 * treatment structurally (see the base layer), so this is for everything that
 * reads like a table without being one.
 */
export function Num({ children, className = '' }) {
  return <span className={`num ${className}`}>{children}</span>;
}

/**
 * The unit, set quiet and small beside its figure — "RD$ 412,900 /mes",
 * "18 días". Quiet because the unit is constant down a column while the
 * figure is what varies, and the varying part is what should carry the ink.
 */
export function Unit({ children, className = '' }) {
  return <span className={`text-micro font-normal text-ink-500 ${className}`}>{children}</span>;
}

const DELTA_TONE = {
  good: 'text-status-good-ink',
  bad: 'text-status-critical-ink',
  neutral: 'text-ink-500',
};
const DELTA_MARK = {
  good: 'text-status-good',
  bad: 'text-status-critical',
  neutral: 'text-ink-400',
};

/**
 * A change, told honestly.
 *
 * `value` is the SIGNED change — a percentage by default, or anything
 * `format` can write (points, money, a count). `null` renders nothing at all,
 * because a figure with no baseline has no delta and a "0%" in its place is a
 * measurement the app never took.
 *
 * `goodWhen` says which direction is good news: `'up'`, `'down'`, or
 * `'neither'` for a measure that is merely a measure (spend, headcount, days
 * on hand). It has no default — see the header.
 *
 * Three cues, never one: the arrow (position/shape), the sign on the number
 * (text), and the colour (last, and skippable). That is what keeps the chip
 * readable under protanopia, on a projector, and in the dealer's sunlight.
 */
export function Delta({
  value,
  format = formatDeltaPct,
  goodWhen,
  label,
  chip = true,
  className = '',
}) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const tone = toneFor(dir, goodWhen ?? 'neither');
  const Icon = dir === 'up' ? ArrowUpRight : ArrowDownRight;
  const spoken = dir === 'flat' ? 'sin cambio' : dir === 'up' ? 'sube' : 'baja';
  const body = (
    <>
      {dir !== 'flat' && <Icon size={11} className={`shrink-0 ${DELTA_MARK[tone]}`} aria-hidden />}
      {dir === 'flat' ? '=' : format(v)}
    </>
  );
  const base = `inline-flex items-center gap-0.5 text-micro font-medium num ${DELTA_TONE[tone]}`;
  return (
    <span
      className={chip ? `${base} rounded-full bg-ink-100/70 px-1.5 py-0.5 ${className}` : `${base} ${className}`}
      aria-label={`${spoken} ${dir === 'flat' ? '' : format(v)}${label ? ` ${label}` : ''}`.trim()}
      title={label}
    >
      {body}
    </span>
  );
}

/* ─────────────────────────────── the tile ───────────────────────────────── */

/**
 * The four loudness rungs, straight off the type ladder — this component
 * invents no sizes of its own.
 *
 *   hero   a page's single headline figure (Estados, the accounting board)
 *   kpi    a tile in a KPI row — the default
 *   panel  a metric inside a panel that is about something else
 *   dense  a figure in a row or a context sidebar
 *
 * `leading-none` on the loud rungs is deliberate: a display figure has no
 * descenders to clear and the tight leading is what makes the label sit ON
 * it rather than near it, which is how the pair reads as one object.
 */
const SIZE = {
  hero: {
    label: 'eyebrow',
    value: 'font-display text-2xl sm:text-3xl font-semibold leading-none tracking-tight',
    gap: 'mt-1.5',
  },
  kpi: {
    label: 'eyebrow',
    // `.stat-value` — the one CSS home of the KPI figure's look.
    value: 'stat-value',
    gap: 'mt-1.5',
  },
  panel: {
    label: 'eyebrow-xs',
    value: 'font-display text-lg font-semibold leading-tight',
    gap: 'mt-0.5',
  },
  dense: {
    label: 'eyebrow-xs',
    value: 'text-sm font-semibold leading-tight',
    gap: 'mt-0.5',
  },
};

/**
 * Four chromes, and no fifth. `card` is the KPI tile, `box` the outlined panel
 * metric, `subtle` the faint nested fill a board uses for its second tier, and
 * `bare` no chrome at all. `h-full` on the card is load-bearing: tiles
 * are compared across a row, and a row of cards that end at different heights
 * reads as a row of DIFFERENT things — the eye takes the ragged bottom edge
 * as a grouping cue long before it reads a label.
 */
const FRAME = {
  card: 'stat-card p-3 sm:p-4 min-w-0 h-full',
  box: 'rounded-lg border border-ink-100 bg-surface px-3 py-2 min-w-0 h-full',
  subtle: 'rounded-xl surface-subtle p-3 min-w-0 h-full',
  bare: 'min-w-0',
};

/**
 * The emphasis a figure may carry. Every one resolves to a token measured at
 * 4.5:1 on BOTH surfaces — which is the point: the accounting boards used to
 * spell these with raw Tailwind (`text-emerald-700`, `text-rose-600`,
 * `text-sky-700`, `text-amber-700`) and every one of them measured ~3:1 in
 * dark mode, so an accented figure was the LEAST legible thing on the board
 * exactly where the board was saying "look at this one".
 */
const VALUE_TONE = {
  ink: 'text-ink-900',
  good: 'text-status-good-ink',
  bad: 'text-status-critical-ink',
  warn: 'text-status-warning-ink',
  info: 'text-status-info-ink',
  brand: 'text-brand-700',
  muted: 'text-ink-500',
};

/**
 * Label + figure, with everything optional around it.
 *
 * ```jsx
 * <Stat label="Comprometido" value={formatDop(total)} hint="12 pedidos"
 *       delta={d?.pct} goodWhen="up" deltaLabel="vs. mes anterior"
 *       icon={Wallet} tint="tint-brand" to="/pedidos" />
 * ```
 *
 * `value` is rendered as given — the caller owns the formatting, because only
 * the caller knows the currency, the precision and whether the figure is a
 * rate. A bare number gets `formatCount` so a count can be passed raw without
 * a call site inventing its own thousands separator.
 *
 * `fluid` swaps the fixed size for a container-query clamp. Money on a narrow
 * tile is the one place a figure may not simply overflow: `.stat-card` clips
 * (it has to, for its corner bloom), and a figure chopped mid-digit —
 * "RD$ 110,000.0C" — reads as a number that is not the number.
 */
export function Stat({
  label,
  value,
  hint,
  unit,
  delta = null,
  deltaFormat,
  deltaLabel,
  goodWhen,
  size = 'kpi',
  frame = 'card',
  tone = 'ink',
  accentClass = '',
  valueClass,
  icon: Icon,
  tint = 'tint-ink',
  to,
  onClick,
  title,
  fluid = false,
  className = '',
  chip,
  children,
}) {
  const s = SIZE[size] || SIZE.kpi;
  // Three ways to size a figure, in order of preference: a ladder rung
  // (default), a container-query clamp (`fluid` — money on a tile that clips),
  // and an explicit rung the board picked (`valueClass`). The third exists so
  // a band can pin one figure louder than its neighbours WITHOUT reaching for
  // an arbitrary px value; it is still expected to be a rung of the ladder.
  const valueSize = valueClass
    ? `stat-value ${valueClass}`
    : fluid
      ? 'stat-value text-[clamp(0.8rem,9.5cqi,1.4rem)] whitespace-nowrap'
      : s.value;
  const shown = typeof value === 'number' ? formatCount(value) : value;
  const deltaNode =
    delta == null || typeof delta === 'object'
      ? delta
      : <Delta value={delta} format={deltaFormat} goodWhen={goodWhen} label={deltaLabel} />;

  const inner = (
    <>
      {/* Icon LEADS the label, on one line. This is the accounting band's
          grammar — the most-used and most-tested tile in the app — and the
          rest of the surfaces were brought onto it rather than the other way
          round: the plate and the word it qualifies belong to each other, and
          an icon parked on the far right of the tile reads as a second,
          unrelated object competing with the figure below. */}
      <div className="flex items-center gap-2 min-w-0">
        {Icon && <span className={`icon-tile ${tint} w-7 h-7 rounded-lg`}><Icon size={14} /></span>}
        <span className={`${s.label} min-w-0 truncate`}>{label}</span>
      </div>
      <div className={`${s.gap} flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0`}>
        <span className={`num truncate ${valueSize} ${VALUE_TONE[tone] || VALUE_TONE.ink} ${accentClass}`}>{shown}</span>
        {unit && <Unit>{unit}</Unit>}
        {deltaNode}
      </div>
      {chip}
      {hint && <div className="mt-1 text-xs text-ink-500 truncate">{hint}</div>}
      {children}
    </>
  );

  const cls = `${FRAME[frame] || FRAME.card} ${className}`;
  if (to) {
    return (
      <Link
        to={to}
        title={title}
        className={`${cls} block text-left transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99]`}
      >
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={`${cls} block w-full text-left active:scale-[0.99] transition-transform`}>
        {inner}
      </button>
    );
  }
  return <div className={cls} title={title}>{inner}</div>;
}

/**
 * The row a set of `<Stat>`s lives in.
 *
 * Tiles are compared ACROSS, so they have to be the same width and land on
 * the same baseline — which means the grid is part of the primitive, not a
 * decision each board makes again. Two columns on a phone (one is a list, not
 * a comparison; three is too narrow for money), then the requested count.
 */
export function StatGrid({ cols = 4, className = '', children }) {
  const wide = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4', 5: 'sm:grid-cols-3 lg:grid-cols-5', 6: 'sm:grid-cols-3 lg:grid-cols-6' }[cols] || 'sm:grid-cols-4';
  return <div className={`grid grid-cols-2 ${wide} gap-3 ${className}`}>{children}</div>;
}
