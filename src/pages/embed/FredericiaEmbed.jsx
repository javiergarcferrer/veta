import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchFredericiaCatalog, fetchFredericiaFamily } from '../../brands/fredericia/client.js';
import {
  resolveFredericiaFamilies, resolveFredericiaFamilyRows, resolveFredericiaConfigurator,
} from '../../core/catalog/fredericiaConfigurator.js';

/**
 * EL CONFIGURADOR DE FREDERICIA — la tercera instancia, y la primera cuya
 * verdad es NUESTRO propio catálogo.
 *
 * Togo compone GEOMETRÍA (un lienzo); Carl Hansen compone una pieza por sus
 * ejes leyendo carlhansen.com al vuelo. Fredericia compone una pieza por sus
 * ejes también, pero sus filas viven aquí: el import de Anthom las precia en
 * dólares y el catálogo del fabricante (fredericia-catalog) las enriquece con
 * ejes nombrados, medidas y fotografía. `fredericia-embed` re-sirve esa
 * proyección pública; TODA la gramática — qué filas forman un modelo, qué
 * tokens forman un eje, qué significa una selección — es
 * `resolveFredericiaConfigurator`, la MISMA que lee el back-office.
 *
 * Lo que se niega a mostrar es tan deliberado como en Carl Hansen: ni costo,
 * ni margen, ni stock. El precio es el de LISTA que el distribuidor ya publica
 * a cualquiera; una combinación sin fila dice «sin precio» y lo dice en serio.
 */

const money = (n) =>
  n == null ? null : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);

export default function FredericiaEmbed() {
  const [rows, setRows] = useState(null);     // null = loading (lean catalog)
  const [listError, setListError] = useState('');
  const [q, setQ] = useState('');
  const [familyKey, setFamilyKey] = useState('');
  const [familyRows, setFamilyRows] = useState(null); // full rows of the open model
  const [selection, setSelection] = useState({});

  useEffect(() => {
    let alive = true;
    fetchFredericiaCatalog().then((r) => {
      if (!alive) return;
      if (r?.ok !== false && Array.isArray(r?.products)) setRows(r.products);
      else { setRows([]); setListError(r?.error || 'No se pudo leer el catálogo.'); }
    });
    return () => { alive = false; };
  }, []);

  const families = useMemo(
    () => (rows ? resolveFredericiaFamilies(rows, { query: q }) : []),
    [rows, q],
  );

  // Un modelo nuevo es una configuración nueva: la selección anterior nombra
  // ejes que este no tiene (la regla del configurador de Carl Hansen).
  const open = useCallback(async (fam) => {
    setFamilyKey(fam.key);
    setSelection({});
    // El picker pinta AL INSTANTE con las filas lean que ya tenemos (la misma
    // regla de agrupación que formó la portada); la ficha completa — fotos,
    // medidas — llega detrás y lo mejora. Un modelo sin familyCode no tiene
    // `?code=`: se queda con lo lean, honesto.
    setFamilyRows(resolveFredericiaFamilyRows(rows, fam));
    if (fam.familyCode) {
      const res = await fetchFredericiaFamily(fam.familyCode);
      if (res?.ok && Array.isArray(res.products) && res.products.length) setFamilyRows(res.products);
    }
  }, [rows]);

  const vm = useMemo(() => {
    if (!familyRows || !familyRows.length) return null;
    return resolveFredericiaConfigurator(familyRows, { selection });
  }, [familyRows, selection]);

  const pick = useCallback((axisId, key) => {
    setSelection((s) => {
      const next = { ...(s || {}) };
      // Volver a tocar lo elegido lo suelta — un eje siempre tiene salida.
      if (next[axisId] === key) delete next[axisId];
      else next[axisId] = key;
      return next;
    });
  }, []);

  /* ─────────────────────────────── portada ─────────────────────────────── */
  if (!familyKey) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold text-ink-900">Fredericia</h1>
        <p className="text-sm text-ink-500 mt-1">
          Elige una pieza y configúrala por sus ejes. Precios de lista del distribuidor, en dólares.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar — spanish chair, spine, trinidad…"
          className="mt-4 w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm"
        />
        {rows === null && <p className="mt-4 text-sm text-ink-500">Leyendo el catálogo…</p>}
        {listError && <p className="mt-4 text-sm text-red-700">{listError}</p>}
        {rows !== null && !listError && (
          <>
            <p className="mt-4 text-xs text-ink-500">
              {families.length} modelos{q ? ' coinciden' : ' publicados'}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {families.slice(0, 60).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => open(f)}
                  className="text-left rounded-xl border border-ink-100 overflow-hidden hover:bg-ink-50 min-h-11"
                >
                  {f.imageSrc && (
                    <img src={f.imageSrc} alt="" loading="lazy" className="w-full h-36 object-cover bg-ink-50" />
                  )}
                  <span className="block px-3 py-2">
                    <span className="block text-sm font-medium text-ink-900 truncate">{f.model}</span>
                    <span className="block text-xs text-ink-500">
                      {f.count} variante{f.count === 1 ? '' : 's'}
                      {f.priceMin != null ? ` · desde ${money(f.priceMin)}` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </Frame>
    );
  }

  /* ──────────────────────────────── ficha ──────────────────────────────── */
  return (
    <Frame>
      <button
        type="button"
        onClick={() => { setFamilyKey(''); setFamilyRows(null); setSelection({}); }}
        className="text-sm text-ink-500 hover:text-ink-900 min-h-11"
      >
        ← Todas las piezas
      </button>

      {!vm && <p className="mt-4 text-sm text-ink-500">Leyendo el modelo…</p>}

      {vm && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div>
            {vm.photo && (
              <img
                src={vm.photo}
                alt={vm.model}
                className="w-full rounded-xl bg-ink-50 object-contain max-h-[26rem]"
              />
            )}
            <h1 className="mt-4 text-2xl font-semibold text-ink-900">{vm.model}</h1>
            {vm.selectedVariant?.reference && (
              <p className="text-sm text-ink-500 font-mono">{vm.selectedVariant.reference}</p>
            )}

            <div className="mt-5 space-y-5">
              {vm.axes.map((axis) => (
                <Axis key={axis.id} axis={axis} onPick={(key) => pick(axis.id, key)} />
              ))}
            </div>
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start space-y-3">
            <div className="rounded-xl border border-ink-100 bg-surface p-4">
              <div className="text-xs uppercase tracking-wide text-ink-500">Precio de lista</div>
              <div className="text-2xl font-semibold text-ink-900 tabular-nums">
                {vm.price.state === 'exact' && money(vm.price.usd)}
                {vm.price.state === 'from' && `${money(vm.price.minUsd)} – ${money(vm.price.maxUsd)}`}
                {vm.price.state === 'none' && 'Sin precio'}
              </div>
              {/* Una negativa dice su porqué; un rango dice qué falta. */}
              {vm.price.state === 'from' && vm.pending.length > 0 && (
                <p className="mt-1 text-xs text-ink-500">
                  Elige {vm.pending.slice(0, 3).join(', ').toLowerCase()} para precisar.
                </p>
              )}
              {vm.price.state === 'none' && (
                <p className="mt-1 text-xs text-ink-500">
                  Esta combinación no está en la lista publicada. Prueba otra opción.
                </p>
              )}

              <dl className="mt-3 space-y-1 text-xs">
                <Row label="Referencia" value={vm.selectedVariant?.reference || '—'} mono />
                {vm.selectedVariant?.dimensions && (
                  <Row label="Medidas" value={vm.selectedVariant.dimensions} />
                )}
                <Row label="Variantes" value={`${vm.matching} de ${vm.count} casan`} />
              </dl>
            </div>
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
 * Un eje. Un solo valor no es una elección: se pinta como leyenda (la nota de
 * facetLayers), y una opción sin variante que la acompañe se apaga en vez de
 * llevar a «sin precio» tres taps después.
 */
function Axis({ axis, onPick }) {
  if (axis.fixed) {
    return (
      <section className="text-xs text-ink-500">
        <span className="font-medium text-ink-700">{axis.label}:</span>{' '}
        {axis.options[0]?.label || '—'}
      </section>
    );
  }
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-900">{axis.label}</h2>
        <span className="text-xs text-ink-500 truncate">
          {axis.options.find((o) => o.selected)?.label || ''}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {axis.options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onPick(o.key)}
            disabled={!o.available && !o.selected}
            aria-pressed={o.selected}
            className={`min-h-11 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              o.selected
                ? 'border-ink-900 bg-ink-900 text-ink-50'
                : 'border-ink-200 hover:bg-ink-50 text-ink-700 disabled:opacity-35 disabled:pointer-events-none'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}
