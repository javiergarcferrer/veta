import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchChModels, fetchChConfiguration } from '../../brands/carl-hansen/client.js';
import { resolveCarlHansenConfigurator } from '../../core/catalog/carlHansenConfigurator.js';

/**
 * EL CONFIGURADOR DE CARL HANSEN — la segunda instancia, y la primera que no
 * es Togo.
 *
 * ── POR QUÉ NO ES EL MISMO WIDGET ───────────────────────────────────────────
 * `TogoEmbed` composes GEOMETRY: you place modules on a floor, drag them,
 * rotate them, and the price is the sum of what you placed. That instrument is
 * correct for a modular sofa and wrong for a chair. A Wishbone is ONE chair;
 * what you choose is its wood, its finish and its seat — AXES — and the answer
 * is one composed SKU at one list price. So this brand brings its own
 * instrument (`brands/configurators`), and neither had to be generalised into
 * something bad at both.
 *
 * ── LO QUE MUESTRA, Y LO QUE SE NIEGA A MOSTRAR ─────────────────────────────
 * The whole view is `resolveCarlHansenConfigurator`, a pure projection ported
 * from the dealer back-office because its pricing grammar was MEASURED against
 * the manufacturer's own data rather than inferred. Every money rule comes with
 * it, and the two that show on screen are:
 *
 *   • A price key that resolves to nothing prices NOTHING. The screen says «sin
 *     precio» and means it. Never interpolate, never nearest-match — a null is
 *     recoverable, a plausible wrong number travels into a quote.
 *   • The figure shown is the base PLUS every MANDATORY surcharge. CH24-H43
 *     shares plain CH24's price key and is separated from it only by a
 *     mandatory `Height: LOW` charge; showing the bare base would offer a
 *     $2,450 chair at $2,305.
 *
 * STOCK IS NOT SHOWN AT ALL, and that is not an omission. Carl Hansen is made
 * to order: a zero in Odense means "wait 54 days", not "cannot sell". The lead
 * time is the honest answer to the question the visitor is actually asking.
 *
 * ── UNA MARCA QUE NO ES LA NUESTRA ──────────────────────────────────────────
 * No cost, no margin and no dealer identity reach this widget — it re-serves
 * what carlhansen.com already publishes to anyone. What a dealer charges is a
 * conversation, and the configurator's job is to get the visitor to the right
 * product with the right options, not to quote it.
 */

const money = (n, currency = 'USD') =>
  n == null ? null : new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(n);

/** Models whose page name is a duplicate of the code read badly in the picker. */
const modelLabel = (m) => (m.name && m.name !== m.modelId ? `${m.modelId} · ${m.name}` : m.modelId);

export default function CarlHansenEmbed() {
  const [models, setModels] = useState(null);   // null = loading
  const [listError, setListError] = useState('');
  const [q, setQ] = useState('');
  const [modelId, setModelId] = useState('');
  const [data, setData] = useState(null);       // { spec, priceRow, page, errors }
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchChModels().then((r) => {
      if (!alive) return;
      if (r?.ok) setModels(r.models || []);
      else { setModels([]); setListError(r?.error || 'No se pudo leer el catálogo.'); }
    });
    return () => { alive = false; };
  }, []);

  // A new model is a new configuration: the previous selection names axes this
  // one does not have, and carrying it over would compose a key out of another
  // chair's leaves.
  const open = useCallback(async (id) => {
    setModelId(id);
    setSelection(null);
    setData(null);
    setLoading(true);
    const next = await fetchChConfiguration(id);
    setData(next);
    setLoading(false);
  }, []);

  const vm = useMemo(() => {
    if (!data?.spec) return null;
    return resolveCarlHansenConfigurator(data.spec, data.priceRow, data.page, { selection });
  }, [data, selection]);

  const pick = useCallback((axisId, key) => {
    setSelection((s) => ({ ...(s || {}), [axisId]: key }));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = models || [];
    if (!needle) return all.slice(0, 60);
    return all.filter((m) => `${m.modelId} ${m.path}`.toLowerCase().includes(needle)).slice(0, 60);
  }, [models, q]);

  if (!modelId) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold text-ink-900">Carl Hansen &amp; Søn</h1>
        <p className="text-sm text-ink-500 mt-1">
          Elige una pieza y configúrala. Precios de lista del fabricante, en dólares.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar — CH24, wishbone, lounge…"
          className="mt-4 w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm"
        />
        {models === null && <p className="mt-4 text-sm text-ink-400">Leyendo el catálogo…</p>}
        {listError && <p className="mt-4 text-sm text-red-700">{listError}</p>}
        {models !== null && (
          <>
            <p className="mt-4 text-xs text-ink-400">
              {models.length} piezas publicadas{q ? ` · ${filtered.length} coinciden` : ''}
            </p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((m) => (
                <button
                  key={m.modelId}
                  type="button"
                  onClick={() => open(m.modelId)}
                  className="text-left rounded-lg border border-ink-100 px-3 py-2 hover:bg-ink-50 min-h-11"
                >
                  <span className="font-mono text-sm text-ink-900">{m.modelId}</span>
                  <span className="block text-xs text-ink-400 truncate">
                    {m.path.split('/').filter(Boolean).slice(-2, -1)[0] || ''}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </Frame>
    );
  }

  return (
    <Frame>
      <button type="button" onClick={() => { setModelId(''); setData(null); }} className="text-sm text-ink-500 hover:text-ink-900 min-h-11">
        ← Todas las piezas
      </button>

      {loading && <p className="mt-4 text-sm text-ink-400">Leyendo {modelId}…</p>}

      {/* NAMED, NOT SWALLOWED. Which half is missing is the useful part: a
          model with no price list is still a chair worth looking at, and the
          visitor deserves to know that is what happened. */}
      {!loading && data?.errors?.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {data.errors.map((e) => <div key={e.part}>{e.message}</div>)}
        </div>
      )}

      {vm && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div>
            {vm.images?.[0]?.url && (
              <img
                src={vm.images[0].url}
                alt={vm.modelName}
                className="w-full rounded-xl bg-ink-50 object-contain max-h-[26rem]"
              />
            )}
            <h1 className="mt-4 text-2xl font-semibold text-ink-900">{vm.modelName}</h1>
            <p className="text-sm text-ink-500 font-mono">{vm.modelId}</p>

            <div className="mt-5 space-y-5">
              {vm.axes.map((axis) => (
                <Axis key={axis.id} axis={axis} onPick={(key) => pick(axis.id, key)} />
              ))}
            </div>
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start space-y-3">
            <div className="rounded-xl border border-ink-100 bg-surface p-4">
              <div className="text-xs uppercase tracking-wide text-ink-400">Precio de lista</div>
              <div className="text-2xl font-semibold text-ink-900 tabular-nums">
                {money(vm.listPriceUsd, vm.currency) ?? 'Sin precio'}
              </div>
              {/* A refusal states its reason. "Sin precio" with no explanation
                  reads as a broken page rather than as an unpublished
                  combination. */}
              {vm.listPriceUsd == null && (
                <p className="mt-1 text-xs text-ink-500">
                  {vm.priceState === 'unknown'
                    ? 'Carl Hansen no publica lista de precios para esta pieza.'
                    : 'Esta combinación no tiene precio publicado. Prueba otra opción.'}
                </p>
              )}
              {vm.priceState === 'stale' && (
                <p className="mt-1 text-xs text-amber-700">La lista venció — confirma antes de cotizar.</p>
              )}

              <dl className="mt-3 space-y-1 text-xs">
                <Row label="Referencia" value={vm.variant?.sku || '—'} mono />
                <Row label="Entrega" value={vm.leadTimeDays ? `${vm.leadTimeDays} días` : 'A confirmar'} />
                <Row label="Clave" value={vm.priceKey?.key || '—'} mono />
              </dl>
            </div>

            {vm.unresolved?.length > 0 && (
              <ul className="rounded-xl border border-ink-100 bg-surface p-4 text-xs text-ink-500 space-y-1">
                {vm.unresolved.map((i) => (
                  <li key={i.code} className={i.level === 'blocker' ? 'text-red-700' : ''}>{i.message}</li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className={`text-ink-700 text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * One axis.
 *
 * THE INSTRUMENT FOLLOWS THE MATERIAL, not a hardcoded list of axis ids: a
 * `wood`, `upholstery` or `cord` axis is a swatch grid because those choices
 * are about how something LOOKS, and anything else is a row of buttons because
 * `Height: LOW / HIGH` is not a colour. `chAxisKind` reads that off the tree, so
 * a model Carl Hansen adds next year renders correctly without being listed
 * anywhere here.
 *
 * The group label is what keeps 32 upholstery leaves from being a wall: the
 * nearest visible ancestor — "Canvas", "Loke", "FSC™-certified Oak" — is the
 * heading the leaves sit under.
 */
function Axis({ axis, onPick }) {
  const swatchy = axis.kind === 'wood' || axis.kind === 'upholstery' || axis.kind === 'cord';
  const groups = useMemo(() => {
    const out = new Map();
    for (const o of axis.options) {
      const key = o.groupLabel || '';
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(o);
    }
    return [...out.entries()];
  }, [axis.options]);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-900">{axis.label}</h2>
        <span className="text-xs text-ink-400 truncate">{axis.selected?.label || ''}</span>
      </div>

      {groups.map(([group, options]) => (
        <div key={group} className="mt-2">
          {group && <div className="text-xs text-ink-400 mb-1">{group}</div>}
          <div className={swatchy ? 'flex flex-wrap gap-1.5' : 'flex flex-wrap gap-1.5'}>
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onPick(o.key)}
                title={o.fullLabel || o.label}
                aria-pressed={o.selected}
                className={`min-h-11 rounded-lg border text-xs transition-colors ${
                  o.selected ? 'border-ink-900 bg-ink-900 text-ink-50' : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                } ${swatchy && o.swatch ? 'p-0 overflow-hidden w-11' : 'px-2.5 py-1.5'}`}
              >
                {swatchy && o.swatch
                  ? <img src={o.swatch} alt={o.label} className="w-11 h-11 object-cover" />
                  : (
                    <span>
                      {o.label}
                      {/* Only a DECLINABLE extra shows a surcharge. A mandatory
                          one is already inside the list price, and printing it
                          beside the option would read as "add $145" on a figure
                          that already contains it. */}
                      {o.addOnKind === 'accessory' && o.addOnUsd
                        ? <span className="opacity-60"> +{money(o.addOnUsd)}</span>
                        : null}
                    </span>
                  )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
