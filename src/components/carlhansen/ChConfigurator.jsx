import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, Clock, Info, Layers, Loader2, Palette, RefreshCw, Search, Shapes, Tag } from 'lucide-react';
import { formatMoney } from '../../lib/format.js';
import { pressCloudSizedUrl } from '../../brands/carl-hansen/materialZips.js';
import {
  cancelPendingSwatches, chSwatchCoverage, knownMissingSwatchIds,
  swatchStats, useChSwatch, useSwatchLoaderVersion,
} from './chSwatchFetch.js';

/**
 * ChConfigurator — ONE Carl Hansen model, configured against its real factory
 * selection tree and priced live.
 *
 * Everything rendered here comes off `resolveCarlHansenConfigurator(...)`: the
 * axes with their options and swatches, the composed price key, the ex-VAT USD
 * list price, the matched EAN variant, the lead times, and every check. The
 * View picks a selection and paints; it decides nothing about money.
 *
 * FOUR CONTRACTS THIS COMPONENT IS BUILT AROUND — each one a real defect:
 *
 *  • A NULL PRICE IS A BLOCKER, NOT A ZERO. `listPriceUsd` comes back null
 *    whenever the Model can't stand behind a figure (no matching key, or a
 *    selected surcharge it couldn't classify). It renders «Sin precio» and the
 *    import is refused. Showing 0 — or falling back to the bare base — is how a
 *    chair gets sold $145 under cost.
 *
 *  • CHECKS ARE DATA (`{code, level, field}`), painted NEXT TO the field they
 *    doubt (the docCapture idiom). Only `level: 'blocker'` stops anything;
 *    warnings render and let the dealer through. Nothing is ever dropped: a
 *    check whose field this layout doesn't own surfaces in the general list at
 *    the top, so a new check code can never fall silent.
 *
 *  • NO STOCK. Carl Hansen is made to order, so the availability answer is the
 *    LEAD TIME. `null`/`0` production days read «sin plazo confirmado» — never
 *    "disponible", never "ships today".
 *
 *  • PRICES ARE EX-VAT USD and are labelled as such. No DOP conversion lives
 *    anywhere near this file; the rate belongs to the quote, not the catalog.
 *
 * A model publishes SEVERAL configurations (CH24: nine, over 29 selection
 * trees) and `configurations` + `onConfigChange` are what make them reachable —
 * without them the VM silently picks the model-named one and the rest of the
 * range is invisible. See `ConfigCard` for why one of them cannot be imported.
 */
export default function ChConfigurator({
  view, onSelect, onRefresh, refreshing = false,
  configurations = [], onConfigChange, extraIssues = [],
}) {
  // Which checks the dedicated blocks below will paint. Anything left over is
  // rendered in the general list — a check must never vanish because the
  // layout didn't happen to know its field.
  const painted = useMemo(() => {
    const set = new Set(CH_PAINTED_FIELDS);
    for (const axis of view.axes) set.add(axis.id);
    return set;
  }, [view.axes]);

  const all = useMemo(() => [...view.unresolved, ...extraIssues], [view.unresolved, extraIssues]);
  const general = all.filter((i) => !painted.has(i.field));
  const modelIssues = all.filter((i) => i.field === 'model');
  const priceIssues = all.filter((i) => i.field === 'price');
  const variantIssues = all.filter((i) => i.field === 'variant');
  const configIssues = all.filter((i) => i.field === 'configuration');

  return (
    <div className="space-y-4">
      <ChIssues issues={general} axes={view.axes} />
      <ChIssues issues={modelIssues} axes={view.axes} />

      <ConfigCard
        view={view}
        configurations={configurations}
        onConfigChange={onConfigChange}
        issues={configIssues}
      />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2 space-y-3">
          <Gallery images={view.images} alt={view.modelName} />
          <VariantCard view={view} issues={variantIssues} />
        </div>

        <div className="lg:col-span-3 space-y-3">
          <PriceCard view={view} issues={priceIssues} onRefresh={onRefresh} refreshing={refreshing} />
          {view.axes.length === 0 ? (
            <p className="card card-pad text-sm text-ink-500">
              Sin ejes de configuración (ver los avisos arriba).
            </p>
          ) : (
            view.axes.map((axis) => (
              <AxisField
                key={axis.id}
                axis={axis}
                issues={view.unresolved.filter((i) => i.field === axis.id)}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- primitives -- */

/**
 * The check FIELDS this component paints beside their own block (plus every
 * axis id, which it also owns). The import bar reads it to know which checks
 * are already on screen, so it can show a count instead of a second copy —
 * and, crucially, still render IN FULL anything outside this vocabulary
 * (`profile`, which has no block here because it isn't part of a
 * configuration). Extend both together or a check goes unpainted.
 */
export const CH_PAINTED_FIELDS = ['model', 'price', 'variant', 'configuration'];

/**
 * Ex-VAT USD, or null.
 *
 * Null AND zero both answer null: in this catalog a zero is never a real
 * figure — `rowPriceUsd` already refuses to price at `total <= 0`, and the
 * page's own `Price`/`ListedPrice` fields are 0 on the international market
 * (spec §3), which is exactly the poison this whole layer exists to keep out.
 * Every caller renders «Sin precio» on null, so a 0 can never reach the screen
 * dressed as money.
 */
export function usdOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? formatMoney(value, 'USD', { USD: 1 })
    : null;
}

/** Display-only stamp adapter: the cached row carries an ISO string, a raw
 *  published file a naive stamp, and the formatter wants milliseconds. The
 *  MEANING of a validity window is the Model's business (`priceListStateOf`);
 *  this only prints the day. */
function stampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * The validity day, printed IN UTC — deliberately not the shared `formatDate`.
 *
 * `validToDate` is a naive `2026-12-31T00:00:00` stored as UTC midnight, and
 * the Model reads midnight as naming a DAY that the list runs THROUGH
 * (`priceListState`, same inclusive-expiry precedent as `eur1Status`).
 * Rendered in the browser's zone that instant prints as «30 dic» anywhere west
 * of Greenwich, so on 31 December a Santo Domingo dealer would read a green
 * «Lista vigente» chip sitting directly above «vence 30 dic» — the badge and
 * the date contradicting each other on the exact field the staleness money
 * rule hangs off. The shared `formatDate` stays untouched: every other caller
 * stores a real instant and wants the local day.
 */
function formatValidityDay(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/**
 * The made-to-order availability line. A missing or zero figure is «sin plazo
 * confirmado»: the alternative readings ("disponible", "ships today") are both
 * false and both cost a customer promise.
 */
export function leadTimeLabel(days) {
  return days == null || days <= 0
    ? 'Sin plazo confirmado'
    : `≈ ${days} ${days === 1 ? 'día' : 'días'} de fabricación`;
}

const ISSUE_TONE = {
  blocker: 'text-red-800 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/40',
  warn: 'text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/40',
  info: 'text-ink-600 bg-ink-50 border-ink-200',
};

/** Field → the words the dealer sees. Axis ids resolve through the axes when
 *  the caller has them (a price-key gap is reported against the axis id). */
export function chFieldLabel(field, axes) {
  const axis = (axes || []).find((a) => a.id === field);
  if (axis) return axis.label || axis.name || field;
  return { model: 'Modelo', price: 'Precio', variant: 'Variante', profile: 'Perfil' }[field] || field;
}

/**
 * The check list — `{code, level, field, message}` rendered as data.
 * Blockers first (they are what stops the import), then warnings, then info.
 */
export function ChIssues({ issues, axes, className = '' }) {
  if (!issues?.length) return null;
  const rank = { blocker: 0, warn: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
  return (
    <ul className={`list-none space-y-1.5 p-0 ${className}`}>
      {sorted.map((issue, n) => (
        <li
          key={`${issue.code}-${issue.field}-${n}`}
          role={issue.level === 'blocker' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${ISSUE_TONE[issue.level] || ISSUE_TONE.info}`}
        >
          {issue.level === 'info'
            ? <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
            : <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />}
          <span className="min-w-0">
            <span className="font-semibold">{chFieldLabel(issue.field, axes)}: </span>
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- configuration -- */

/**
 * WHICH CONFIGURATION of the model is being configured — and, when it is one
 * the importer must not write, why.
 *
 * A model master publishes several configurations over one set of selection
 * trees. CH24 publishes NINE (plain, painted CHSColors, Ilse Crawford, teak,
 * and a 43 cm `-H43` twin of most of them) across 29 trees. Without this
 * control the ViewModel silently picks the model-named one and everything else
 * is unreachable — the same no-vanish rule the grid honours, broken a level
 * down. Measured on the captured CH24 page: plain CH24 reaches 21 of the 41
 * published EANs, and adding the selector reaches 25 (the painted CHSColors
 * run becomes visible).
 *
 * ── WHY A `-H43` CONFIGURATION IS BROWSABLE BUT NOT IMPORTABLE ──────────────
 * A variant is matched to a selection by the LABEL CHAIN of the selected
 * PRICE axes (`requiredLabels`), and that function deliberately skips ADD-ON
 * axes — a variant's configuration text never mentions gliders. But the whole
 * difference between CH24 and CH24-H43 is an add-on axis: a mandatory
 * `Height: Low` surcharge of $145. So the matcher cannot tell them apart.
 *
 * Measured over every combination of both configurations against the real
 * page: they claim THE SAME 21 EANs, and every one of those 21 prices $145
 * higher under H43. Since a row's id is `ch-<EAN>`, importing under H43 would
 * RESTATE the already-imported Wishbone rows $145 dearer — a silent overcharge
 * across the dealer's own catalogue. It is not a real collision either: none
 * of the page's 41 variants advertises a height at all, so those 21 belong to
 * plain CH24 and H43 simply has no variants published here.
 *
 * The gate is therefore exact and conservative: a selection carrying an
 * IDENTITY add-on (a mandatory surcharge that names a different product) is
 * precisely the case the matcher is blind to, so it is refused. Browsing and
 * pricing still work — only the write is stopped. Verified to block exactly
 * the four `-H43` configurations and nothing else.
 *
 * THIS RULE'S DURABLE HOME IS `core/catalog/carlHansen.js` (a check in
 * `configuratorIssues`), not a component; it lives here only because that file
 * belongs to another agent. It is a REFUSAL, never a price — the View can only
 * ever say no.
 */
function ConfigCard({ view, configurations, onConfigChange, issues }) {
  if (configurations.length <= 1 && !issues.length) return null;
  return (
    <section className="card card-pad space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <Shapes size={14} className="text-ink-500" aria-hidden />
          <span className="eyebrow-xs">Configuración del modelo</span>
        </span>
        <span className="text-micro text-ink-500">
          {view.variantMatches === 1
            ? '1 variante corresponde'
            : `${view.variantMatches} variantes corresponden`}
        </span>
      </div>

      {configurations.length > 1 && (
        <select
          className="input"
          value={view.configId || ''}
          onChange={(e) => onConfigChange?.(e.target.value)}
          aria-label="Configuración del modelo"
        >
          {configurations.map((cfg) => (
            <option key={cfg.id} value={cfg.id}>
              {cfg.label}{cfg.disabled ? ' · descontinuada' : ''}
            </option>
          ))}
        </select>
      )}

      {view.variantMatches === 0 ? (
        <p className="text-xs text-ink-500">
          Esta configuración no tiene variantes en esta página: no hay EAN que importar.
          Puede que la fábrica no la publique aquí, o que haya que elegir otras opciones.
        </p>
      ) : null}

      <ChIssues issues={issues} axes={view.axes} />
    </section>
  );
}

/* ---------------------------------------------------------------- gallery -- */

/**
 * The configuration's own renders when the variant matched, else the model's
 * hero imagery. Hotlinked from the CDN (it sends CORS `*`), never copied.
 *
 * ⚠ THIS HOST DOES NOT RESIZE — measured 2026-08-06, do not "optimise" it with
 * a width param. `admincms.carlhansen.com` returns a byte-identical response
 * for `?width=320`, `?w=320`, `?format=webp` and no param at all
 * (Content-Length 3,259,436 every time), so it must NOT join `RESIZING_CDN` in
 * lib/catalogImages: `sizedExternalUrl` would append a no-op, and
 * `isResizableImageUrl` would start emitting a `srcset` of identical urls —
 * a lie that costs candidate parsing and buys nothing.
 *
 * The originals are enormous: variant renders 2133×2831 PNG ≈ 3.3 MB, media
 * shots up to 7239×9652 JPEG ≈ 7.8 MB. With no resizer the ONLY lever left is
 * to fetch FEWER of them, so the thumb strip loads four and reveals the rest
 * on request — a mount used to pull up to eight originals at once. Intrinsic
 * `width`/`height` come off the published metadata so the browser reserves the
 * box and lazy-loading can actually skip what is off-screen.
 *
 * The real fix is upstream and belongs to whoever owns the sweep:
 * `image.carlhansen.com/r/<code>.webp?size=1024` serves the SAME render at
 * 61,874 bytes — 42× smaller — but only for the codes published in the model
 * master's `modelVariants` (9 of CH24's 41 EANs), so it is not a general
 * substitute today.
 *
 * THE OTHER LEVER, armed here and inert until it has data: PressCloud DOES
 * resize (§12a — `thumb` 15 KB / `preview` 97 KB / `canvas` 524 KB against a
 * 2.4 MB original), so any image url already served from that host is re-pointed
 * at a bounded rendition — `canvas` for the cover, `preview` for the strip.
 * `pressCloudSizedUrl` leaves every other host BYTE-IDENTICAL, which is the
 * whole point: it can never append a no-op param to admincms.
 */
const GALLERY_THUMBS = 4;

function Gallery({ images, alt }) {
  const [at, setAt] = useState(0);
  const [dead, setDead] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const shots = (images || []).filter((img) => !dead.has(img.url));
  const cover = shots[Math.min(at, Math.max(0, shots.length - 1))] || null;
  const thumbs = showAll ? shots : shots.slice(0, GALLERY_THUMBS);
  const hidden = shots.length - thumbs.length;

  return (
    <div className="card overflow-hidden">
      <div className="flex aspect-[4/3] items-center justify-center bg-ink-50">
        {cover ? (
          <img
            src={pressCloudSizedUrl(cover.url, 'canvas')}
            alt={cover.alt || alt || ''}
            width={cover.width || undefined}
            height={cover.height || undefined}
            decoding="async"
            onError={() => setDead((prev) => new Set(prev).add(cover.url))}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-xs text-ink-500">Sin fotos publicadas</span>
        )}
      </div>
      {shots.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-2">
          {thumbs.map((img, n) => (
            <button
              key={img.url}
              type="button"
              onClick={() => setAt(n)}
              className={`h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border bg-ink-50 ${
                img.url === cover?.url ? 'border-brand-400 ring-1 ring-brand-500/30' : 'border-ink-200'
              }`}
              aria-label={`Foto ${n + 1}`}
            >
              <img
                src={pressCloudSizedUrl(img.url, 'preview')}
                alt=""
                width={img.width || undefined}
                height={img.height || undefined}
                loading="lazy"
                decoding="async"
                // Lowercase on a raw element: React 18 renders the camelCase
                // spelling but warns about it (same note as TogoEmbed).
                fetchpriority="low"
                className="h-full w-full object-contain"
              />
            </button>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="h-12 flex-shrink-0 rounded-md border border-dashed border-ink-200 px-2 text-micro text-ink-500 hover:bg-ink-50"
              title="Cada foto pesa varios MB y el CDN de Carl Hansen no las redimensiona"
            >
              +{hidden}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ price -- */

const PRICE_STATE = {
  fresh: { label: 'Lista vigente', tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/40' },
  expiring: { label: 'Lista por vencer', tone: ISSUE_TONE.warn },
  expired: { label: 'Lista vencida', tone: ISSUE_TONE.blocker },
  unknown: { label: 'Vigencia desconocida', tone: ISSUE_TONE.warn },
};

/**
 * The money block. `listPriceUsd` is what a product row would carry — the base
 * plus every MANDATORY surcharge — and it is the only figure shown big. The raw
 * base and the declinable extras ride underneath, labelled, because a dealer
 * reading "$2,595" needs to be able to see where it came from.
 */
function PriceCard({ view, issues, onRefresh, refreshing }) {
  const price = usdOrNull(view.listPriceUsd);
  const base = usdOrNull(view.basePriceUsd);
  const total = usdOrNull(view.totalUsd);
  const state = PRICE_STATE[view.priceState] || PRICE_STATE.unknown;
  const validTo = stampMs(view.priceValidTo);
  const accessories = (view.addOns || []).filter((a) => a.kind === 'accessory');

  return (
    <div className="card card-pad space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow-xs">Precio de lista · {view.currency || 'USD'} sin ITBIS</p>
          {price ? (
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink-900">
              {price} <span className="align-middle text-sm font-medium text-ink-500">USD</span>
            </p>
          ) : (
            <p className="mt-1 font-display text-2xl font-semibold text-red-700 dark:text-red-300">Sin precio</p>
          )}
          <p className="mt-1 text-micro text-ink-500">
            Precio de exportación ex-VAT. No se convierte a pesos aquí: la tasa se fija en la cotización.
          </p>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <span className={`chip border ${state.tone}`}>{state.label}</span>
          {validTo ? (
            <span className="inline-flex items-center gap-1 text-micro text-ink-500">
              <CalendarClock size={12} aria-hidden /> vence {formatValidityDay(validTo)}
            </span>
          ) : null}
          {onRefresh ? (
            <button type="button" onClick={onRefresh} disabled={refreshing} className="chip-action">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} aria-hidden />
              Actualizar ficha y precios
            </button>
          ) : null}
        </div>
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        <Row label="Base de la clave">{base || '—'}</Row>
        <Row label="Clave de precio">
          <span className="font-mono text-micro">{view.priceKey?.key || '—'}</span>
          {view.matched === 'alt' ? <span className="ml-1 text-ink-500">(codificación alterna)</span> : null}
        </Row>
        <Row label="Plazo de fábrica">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} className="text-ink-500" aria-hidden /> {leadTimeLabel(view.leadTimeDays)}
          </span>
        </Row>
      </dl>

      {accessories.length > 0 && (
        <div className="rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2 text-xs text-ink-600">
          <p className="font-medium text-ink-700">Accesorios seleccionados</p>
          <ul className="mt-1 list-none space-y-0.5 p-0">
            {accessories.map((a) => (
              <li key={a.axisId} className="flex items-center justify-between gap-3">
                <span className="truncate">{a.label || a.code || a.axisId}</span>
                <span className="tabular-nums">{usdOrNull(a.amount) || '—'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-micro text-ink-500">
            No entran en el precio del catálogo — el accesorio se agrega como línea en la cotización.
            {total && total !== price ? ` Con accesorios: ${total} USD.` : ''}
          </p>
        </div>
      )}

      <ChIssues issues={issues} />
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-100/70 py-1 last:border-0 sm:border-0">
      <dt className="text-ink-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-ink-700">{children}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- variant -- */

/** The EAN this configuration IS. `Stock` is deliberately not shown anywhere —
 *  see the module header. */
function VariantCard({ view, issues }) {
  const v = view.variant;
  return (
    <div className="card card-pad space-y-2">
      <p className="eyebrow-xs">Variante</p>
      {v ? (
        <>
          <p className="font-mono text-sm font-semibold text-ink-900">{v.sku}</p>
          <p className="text-xs text-ink-500">{v.configuration || 'Sin descripción de configuración'}</p>
          <p className="inline-flex items-center gap-1 text-xs text-ink-600">
            <Clock size={12} className="text-ink-500" aria-hidden /> {leadTimeLabel(v.productionDays)}
          </p>
        </>
      ) : (
        <p className="text-xs text-ink-500">Ninguna variante publicada corresponde todavía a esta combinación.</p>
      )}
      {view.variantMatches > 1 ? (
        <p className="text-micro text-ink-500">{view.variantMatches} variantes coinciden — se importan todas.</p>
      ) : null}
      <ChIssues issues={issues} />
    </div>
  );
}

/* ------------------------------------------------------------------- axes -- */

/** Above this many options an axis gets its own filter box — CH07's upholstery
 *  axis carries 683 leaves and a wall of chips is unusable. */
const BIG_AXIS = 24;

const KIND_LABEL = {
  wood: 'madera',
  cord: 'trenzado',
  upholstery: 'tapicería',
  metal: 'metal',
  finish: 'acabado',
};

/** Presentational grouping only: the ViewModel already decided each option's
 *  `groupLabel` ("Canvas", "FSC™-certified Oak"). This just keeps first-seen
 *  order so the tree reads the way the factory published it. */
function groupOptions(options) {
  const out = [];
  const byLabel = new Map();
  for (const option of options) {
    const label = option.groupLabel || '';
    let group = byLabel.get(label);
    if (!group) {
      group = { label, options: [] };
      byLabel.set(label, group);
      out.push(group);
    }
    group.options.push(option);
  }
  return out;
}

function AxisField({ axis, issues, onSelect }) {
  const [q, setQ] = useState('');
  // Whether THIS axis may spend bandwidth on swatches it hasn't cached yet.
  // Per-axis, not global: a model has one upholstery axis and several wood ones,
  // and only the fabrics have an archive behind them.
  const [live, setLive] = useState(false);
  const groups = useMemo(() => groupOptions(axis.options), [axis.options]);
  // Re-runs when a read PROVES a colourway absent (or the budget runs out), so
  // the caption below subtracts it instead of promising a swatch that isn't
  // there. `knownMissingSwatchIds()` is a live Set whose identity never
  // changes — the version is what makes the memo recompute.
  const loaderVersion = useSwatchLoaderVersion();
  const coverage = useMemo(
    () => chSwatchCoverage(axis.options, { unavailable: knownMissingSwatchIds() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axis.options, loaderVersion],
  );
  const budgetSpent = swatchStats().budgetSpent;

  /** The switch is a BRAKE, not a throttle: turning it off drains the queue and
   *  aborts what is in flight. Without the cancel, ~30 on-screen Canvas options
   *  already queued would keep going and finish ~150 MB after the tap. */
  function toggleLive() {
    setLive((on) => {
      if (on) cancelPendingSwatches();
      return !on;
    });
  }
  const big = axis.options.length > BIG_AXIS;
  const term = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!term) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => `${o.label} ${o.groupLabel}`.toLowerCase().includes(term)),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, term]);

  const hasIdentityAddOn = axis.options.some((o) => o.addOnKind === 'identity');

  return (
    <section className="card overflow-hidden">
      <header className="card-header">
        <span className="flex min-w-0 items-center gap-2">
          <Layers size={14} className="flex-shrink-0 text-ink-500" aria-hidden />
          <span className="truncate font-display text-sm font-semibold text-ink-900">
            {axis.label || axis.name}
          </span>
          {axis.kind ? (
            <span className="chip border border-ink-200 bg-ink-50 text-ink-600">{KIND_LABEL[axis.kind] || axis.kind}</span>
          ) : null}
          {axis.isAddOnAxis ? (
            <span className="chip border border-ink-200 bg-ink-50 text-ink-600" title="Eje de recargo (no compone la clave de precio)">
              <Tag size={10} aria-hidden /> extra
            </span>
          ) : null}
        </span>
        <span className="eyebrow-xs flex-shrink-0">{axis.options.length}</span>
      </header>

      <div className="space-y-3 p-3">
        {axis.selected ? (
          <p className="truncate text-xs text-ink-500">
            Seleccionado: <span className="font-medium text-ink-700">{axis.selected.fullLabel || axis.selected.label}</span>
          </p>
        ) : (
          <p className="text-xs text-amber-700 dark:text-amber-300">Sin selección.</p>
        )}

        {big && (
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrar opciones…"
              aria-label={`Filtrar ${axis.label || axis.name}`}
              className="input search-clean pl-9"
            />
          </div>
        )}

        <SwatchBanner coverage={coverage} live={live} budgetSpent={budgetSpent} onToggle={toggleLive} />

        {shown.length === 0 ? (
          <p className="py-2 text-center text-xs text-ink-500">Ninguna opción coincide con el filtro.</p>
        ) : (
          shown.map((group) => (
            <div key={group.label || '__flat__'}>
              {group.label ? (
                <p className="eyebrow mb-1">{group.label}</p>
              ) : null}
              <div className="grid gap-1.5 sm:grid-cols-2">
                {group.options.map((option) => (
                  <OptionButton key={option.key} axisId={axis.id} option={option} onSelect={onSelect} live={live} />
                ))}
              </div>
            </div>
          ))
        )}

        {axis.isAddOnAxis && (
          <p className="text-micro text-ink-500">
            {hasIdentityAddOn
              ? 'Este recargo forma parte del producto: entra en el precio que se importa al catálogo.'
              : 'Accesorio opcional: no entra en el precio del catálogo, se agrega en la línea de la cotización.'}
          </p>
        )}

        <ChIssues issues={issues} axes={[axis]} />
      </div>
    </section>
  );
}

/**
 * WHAT THE SWATCH LIBRARY COVERS, in numbers, above the options it covers.
 *
 * Carl Hansen's press room publishes nine fabric archives; the configurator
 * offers 683 colourways. ~277 of them — Vidar, Focus Royal, Tiree, Joe, Keiga
 * and essentially every leather — have NO published picture anywhere, and that
 * is a permanent fact, not a pending download. Printing the two numbers is what
 * keeps a grey chip from reading as a broken image or as something still
 * loading; without it the honest state and the failed state look identical.
 *
 * The switch exists because the first copy of a swatch is EXPENSIVE: the source
 * is a 4–7 MB CMYK print master inside a 77–490 MB archive, so the axis fetches
 * only what the dealer asks for (plus the selected material, which is the one
 * being quoted). Every copy after that is a ~10 KB cached chip, for everyone.
 *
 * ── THE COPY SAYS WHAT THE NUMBER ACTUALLY KNOWS ─────────────────────────────
 * «pertenecen a una colección con archivo de fábrica» is the honest claim: the
 * count is over collections that HAVE a published archive, and whether a given
 * archive carries a given colourway is only knowable by reading it (see
 * `chSwatchSource`). Saying "tienen muestra" would have been an upper bound
 * printed as a fact — and when a read came back empty the option would revert
 * to a chip while the caption went on counting it, which is the precise
 * ambiguity this banner exists to remove. Reads that DO come back empty are
 * recorded and subtracted, so the number only ever converges downward onto the
 * truth.
 */
function SwatchBanner({ coverage, live, budgetSpent, onToggle }) {
  if (!coverage.withSource) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2 text-micro text-ink-500">
      <span className="min-w-0 flex items-start gap-1.5">
        <Palette size={12} className="mt-0.5 flex-shrink-0 text-ink-500" aria-hidden />
        <span>
          {coverage.withSource} de {coverage.total} colores pertenecen a una colección
          con archivo de fábrica.
          {coverage.missing > 0
            ? ` Los otros ${coverage.missing} no tienen archivo publicado: se ven como chip.`
            : ''}
          {budgetSpent
            ? ' Se alcanzó el límite de descarga de esta sesión; las muestras ya guardadas se siguen viendo.'
            : ''}
        </span>
      </span>
      <button
        type="button"
        onClick={onToggle}
        className="chip-action flex-shrink-0"
        title="La primera vez cada muestra se baja del archivo de prensa (varios MB) y queda guardada en el catálogo; después es instantánea. Al apagarlo se cancela lo que esté en cola o descargando. Las ya guardadas se ven siempre."
      >
        {live ? 'Dejar de traer muestras' : 'Traer muestras reales'}
      </button>
    </div>
  );
}

function OptionButton({ axisId, option, onSelect, live = false }) {
  const surcharge = usdOrNull(option.addOnUsd);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(axisId, option.key)}
      title={option.description || option.fullLabel || option.label}
      aria-pressed={option.selected}
      className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
        option.selected
          ? 'border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-500/30'
          : 'border-ink-200 bg-surface text-ink-700 hover:border-ink-300 hover:bg-ink-50 active:bg-ink-100'
      }`}
    >
      <SwatchDot option={option} live={live} />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {surcharge && option.addOnUsd ? (
        <span className="flex-shrink-0 tabular-nums text-micro text-ink-500">+{surcharge}</span>
      ) : null}
    </button>
  );
}

/**
 * Is this element on (or near) the screen? An upholstery axis renders 683
 * chips; without this gate, turning swatches on would queue 683 multi-megabyte
 * reads for chips nobody has scrolled to. It latches: once seen, the observer
 * disconnects — a swatch never needs re-deciding.
 *
 * No IntersectionObserver (old engine, test renderer) ⇒ treat everything as
 * visible: the fetch gate above is what bounds the cost, this only bounds when.
 */
function useInView() {
  const ref = useRef(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/**
 * THE REAL FABRIC, when there is one.
 *
 * Three sources in order, and the order is the point:
 *   1. the swatch the selection tree itself published (gliders carry one);
 *   2. the press-archive chip for this colourway — already cached ⇒ free and
 *      automatic; not cached ⇒ only when the axis switch is on, or this is the
 *      SELECTED option (the material actually being quoted);
 *   3. a neutral chip.
 *
 * (3) is a NORMAL answer, not a failure: ~277 colourways have no source and
 * every leather is one of them. Nothing here ever guesses a url — a 404'd <img>
 * in a configurator the dealer shows to a customer is worse than an honest
 * blank, which is the same rule `swatches.js` was written under.
 */
function SwatchDot({ option, live = false }) {
  const [dead, setDead] = useState(false);
  const [ref, seen] = useInView();
  const { url, busy } = useChSwatch(option.groupLabel, option.label, {
    enabled: live || option.selected,
    visible: seen,
  });
  const src = dead ? null : (option.swatch || url);

  if (!src) {
    return (
      <span
        ref={ref}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-ink-200 bg-ink-50"
        aria-hidden
      >
        {busy ? <Loader2 size={11} className="animate-spin text-ink-500" /> : null}
      </span>
    );
  }
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setDead(true)}
      className="h-6 w-6 flex-shrink-0 rounded-full border border-ink-200 object-cover"
    />
  );
}
