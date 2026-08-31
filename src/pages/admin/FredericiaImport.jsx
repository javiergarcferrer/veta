/**
 * FREDERICIA — importar el catálogo entero desde Anthom Design House.
 *
 * No somos distribuidores de Fredericia: le compramos a Anthom Design House, y
 * lo que Anthom publica es su tienda. Así que el catálogo con el que se cotiza
 * es EL SUYO — su colección Fredericia, con su precio, su foto y lo que de
 * verdad se puede pedir hoy — y esta página es por donde entra.
 *
 * SE LEE ANTES DE ESCRIBIR, en dos pasos y no en uno. Una importación de
 * catálogo son ~6.700 referencias: cuántas son nuevas, cuántas cambian de
 * precio y —sobre todo— cuántas de las que ya están dejaron de aparecer en la
 * tienda son cosas que quien importa tiene que VER antes de que se escriban, no
 * enterarse después por una lista que creció. El plan se calcula entero
 * (`planCatalogSourceImport`, puro) y sólo entonces hay un botón que lo guarda.
 *
 * NO SE BORRA NADA. Una referencia que desapareció de la tienda se informa y se
 * deja quieta: puede estar descontinuada, o puede ser que la colección se
 * re-etiquetó. Borrar es la única operación que una segunda pasada no deshace.
 *
 * POR QUÉ USA EL MÓDULO FREDERICIA DIRECTAMENTE, y no `moduleSetFor(brand)`:
 * igual que la página de Kvadrat, aquí la fuente la elige LA PÁGINA. La marca
 * destino conserva su propio juego de módulos; lo normal es que sea el juego
 * `fredericia` (el selector lo pone primero), pero exigirlo impediría el caso
 * real de estrenar una marca vacía y llenarla.
 *
 * Los efectos se construyen AQUÍ y se inyectan (`invoke`); `src/brands/**` sigue
 * sin conocer Supabase.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Armchair, ExternalLink, Download, UploadCloud, AlertTriangle } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { db, newId } from '../../db/database.js';
import { supabase } from '../../db/supabaseClient.js';
import { useToast } from '../../components/ConfirmProvider.jsx';
import {
  FREDERICIA_MODULES, planCatalogSourceImport, moduleSetFor,
} from '../../brands/index.js';
import FredericiaEnrichBar from '../../components/catalog/FredericiaEnrichBar.jsx';
import Fredericia3dBar from '../../components/catalog/Fredericia3dBar.jsx';

const SOURCE = FREDERICIA_MODULES.catalog.source;

/** Las otras colecciones Fredericia que Anthom publica, para no obligar a nadie
 *  a ir a buscar el enlace. Todas se filtran por vendor igual que la principal. */
const SHORTCUTS = [
  { label: 'Fredericia Furniture', handle: 'fredericia-furniture' },
  { label: 'Delphi Elements', handle: 'fredericia-delphi-elements' },
  { label: 'Plan Tables', handle: 'fredericia-plan-tables' },
  { label: 'Compliments', handle: 'fredericia-compliments' },
];

const linkFor = (handle) => `https://anthomdesignhouse.com/collections/${handle}`;

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function Stat({ label, value, tone = '' }) {
  return (
    <div className="rounded-lg border border-ink-100 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-400">{label}</div>
      <div className={`text-base font-semibold ${tone || 'text-ink-900'}`}>{value}</div>
    </div>
  );
}

export default function FredericiaImport() {
  const { profileId, brands, brand: activeBrand } = useApp();
  const toast = useToast();

  const options = useMemo(() => (brands || []).filter(Boolean), [brands]);
  /** La marca que YA corre el juego Fredericia va primero: es la que este
   *  catálogo describe, y ofrecerla por defecto evita el error caro (escribir
   *  6.700 referencias en el `catalogBrand` de otro fabricante). */
  const preferred = useMemo(
    () => options.find((b) => moduleSetFor(b).setId === FREDERICIA_MODULES.id) || activeBrand || options[0] || null,
    [options, activeBrand],
  );
  const [brandId, setBrandId] = useState('');
  useEffect(() => { if (!brandId && preferred?.id) setBrandId(preferred.id); }, [preferred, brandId]);
  const target = useMemo(() => options.find((b) => b.id === brandId) || null, [options, brandId]);
  const catalogBrand = target?.settings?.catalogBrand || target?.slug || '';

  const [url, setUrl] = useState(linkFor(SHORTCUTS[0].handle));
  const [stage, setStage] = useState('idle');   // idle | reading | planning | writing
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);       // { rows, missing, summary, read, source }
  const [result, setResult] = useState(null);

  const busy = stage !== 'idle';

  // Cambiar de marca o de colección invalida un plan ya calculado: se hizo
  // contra OTRO catálogo, y guardarlo escribiría precios en el sitio
  // equivocado.
  useEffect(() => { setPlan(null); setResult(null); }, [brandId, url]);

  const read = useCallback(async () => {
    if (!target) { setError('Elige a qué marca entra el catálogo.'); return; }
    if (!catalogBrand) {
      setError('Esa marca no tiene catálogo de precios asignado. Ponle uno en «Marcas» antes de importar.');
      return;
    }
    setError(null); setResult(null); setPlan(null);
    setStage('reading');
    try {
      const invoke = (name, opts) => supabase.functions.invoke(name, opts);
      const payload = await SOURCE.fetch(url, { invoke });

      setStage('planning');
      const decoded = SOURCE.rows(payload);
      if (!decoded.rows.length) {
        setError('No se pudo leer ninguna referencia con precio en esa colección.');
        setStage('idle');
        return;
      }
      // El catálogo ENTERO de esta marca, no sólo los SKU que llegan: es lo que
      // permite decir cuáles dejaron de estar (`fullScope`) y lo que conserva
      // en la fila lo que la tienda no opina (costo, dimensiones, foto propia).
      const existing = await db.products.where('brand').equals(catalogBrand).toArray();
      const next = planCatalogSourceImport({
        rows: decoded.rows, brand: target, profileId, existing, fullScope: true, newId,
      });
      // Sólo el plan y el recuento de la lectura. El payload de la tienda son
      // 1,7 MB y ya está decodificado: guardarlo en el estado lo mantendría vivo
      // en memoria hasta que alguien cambie de página, sin que nada lo lea.
      setPlan({ ...next, read: decoded.summary });
    } catch (e) {
      setError(e?.message || 'No se pudo leer el catálogo.');
    } finally {
      setStage('idle');
    }
  }, [target, catalogBrand, url, profileId]);

  const write = useCallback(async () => {
    if (!plan?.rows?.length) return;
    setError(null);
    setStage('writing');
    setProgress({ done: 0, total: plan.rows.length });
    try {
      await db.products.bulkPut(plan.rows, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult({ ...plan.summary, catalogBrand });
      setPlan(null);
      toast?.(`${plan.summary.total} referencias importadas`);
    } catch (e) {
      setError(e?.message || 'No se pudieron guardar las referencias.');
    } finally {
      setStage('idle');
      setProgress({ done: 0, total: 0 });
    }
  }, [plan, catalogBrand, toast]);

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Armchair size={18} className="text-ink-400" aria-hidden />
          <h1 className="text-lg font-semibold text-ink-900">Fredericia</h1>
        </div>
        <p className="text-[13px] text-ink-500">
          Importa el catálogo Fredericia (y Erik Jørgensen) tal y como lo publica Anthom Design House:
          referencia, grupo de tapizado, precio, fotos y disponibilidad. Se lee primero y se guarda después.
        </p>
      </header>

      <div className="rounded-xl border border-ink-100 p-4 space-y-3">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">Marca destino</span>
          <select
            value={brandId}
            disabled={busy}
            onChange={(e) => setBrandId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm disabled:opacity-60"
          >
            {!options.length && <option value="">(no hay marcas)</option>}
            {options.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {moduleSetFor(b).setId === FREDERICIA_MODULES.id ? ' — módulos Fredericia' : ''}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-400">
            {catalogBrand
              ? <>Las referencias entran en el catálogo <code className="font-mono">{catalogBrand}</code>.</>
              : 'Esta marca no tiene catálogo de precios asignado todavía.'}
          </span>
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">Colección en Anthom</span>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={SOURCE.placeholder}
              className="flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-sm disabled:opacity-60"
            />
            <button
              type="button"
              onClick={read}
              disabled={busy || !url.trim() || !target}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:border-brand-300 disabled:opacity-50"
            >
              {stage === 'reading' || stage === 'planning'
                ? <Loader2 size={15} className="animate-spin" aria-hidden />
                : <Download size={15} aria-hidden />}
              Leer catálogo
            </button>
          </div>
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-400">Colecciones:</span>
          {SHORTCUTS.map((s) => (
            <button
              key={s.handle}
              type="button"
              disabled={busy}
              onClick={() => setUrl(linkFor(s.handle))}
              className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
          <a
            href={linkFor(SHORTCUTS[0].handle)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-500 hover:text-brand-600"
          >
            Ver la tienda <ExternalLink size={11} aria-hidden />
          </a>
        </div>

        {busy && stage !== 'writing' && (
          <div className="text-[12px] text-ink-600">
            {stage === 'reading' && 'Leyendo la colección en anthomdesignhouse.com…'}
            {stage === 'planning' && 'Comparando con el catálogo que ya tienes…'}
          </div>
        )}
        {stage === 'writing' && (
          <div className="space-y-1">
            <div className="text-[12px] text-ink-600">Guardando {progress.done}/{progress.total}…</div>
            <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 px-3 py-2 text-[12px] text-red-800 dark:text-red-200">
            {error}
          </div>
        )}
      </div>

      {plan && (
        <div className="rounded-xl border border-ink-100 p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink-900">Esto es lo que se va a escribir</h2>
            <span className="text-[11px] text-ink-400">
              {plan.read.products} productos · {plan.read.variants} variantes en la tienda
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Nuevas" value={plan.summary.created} tone="text-emerald-700" />
            <Stat label="Actualizadas" value={plan.summary.updated} />
            <Stat label="Con foto" value={plan.summary.photos} />
            <Stat
              label="Ya no están"
              value={plan.summary.missing}
              tone={plan.summary.missing ? 'text-amber-700' : ''}
            />
          </div>

          {/* Lo que la tienda repite o no pudo decirse: siempre a la vista, para
              que «6.665 de 6.849» nunca sea una diferencia que haya que ir a
              buscar. */}
          <p className="text-[11px] text-ink-500 leading-relaxed">
            {plan.read.duplicates > 0 && (
              <>{plan.read.duplicates} variantes repetían un SKU ya leído (la tienda lista varias piezas
                dos veces, una de ellas «- ADH»); se importa una sola vez. </>
            )}
            {plan.read.skipped > 0 && (
              <>{plan.read.skipped} variantes no se pudieron leer (sin SKU o sin precio). </>
            )}
            {plan.summary.unavailable > 0 && (
              <>{plan.summary.unavailable} entran marcadas como no disponibles y no se podrán cotizar. </>
            )}
            Ni el costo ni las dimensiones se tocan: la tienda publica su precio de venta, no lo que
            pagamos nosotros.
          </p>

          {plan.summary.missing > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-900">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                <div>
                  <strong>{plan.summary.missing} referencias</strong> del catálogo{' '}
                  <code className="font-mono">{catalogBrand}</code> ya no aparecen en esta colección.
                  No se borran ni se desactivan — revísalas antes de darlas por descontinuadas:{' '}
                  <span className="font-mono">{plan.missing.slice(0, 6).join(' · ')}</span>
                  {plan.missing.length > 6 && <> … y {plan.missing.length - 6} más</>}.
                </div>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-ink-400">
                  <th className="py-1 pr-3 font-medium">Referencia</th>
                  <th className="py-1 pr-3 font-medium">Modelo</th>
                  <th className="py-1 pr-3 font-medium">Grado</th>
                  <th className="py-1 pr-3 font-medium text-right">Precio</th>
                </tr>
              </thead>
              <tbody>
                {plan.sample.map((r) => (
                  <tr key={r.reference} className="border-t border-ink-100">
                    <td className="py-1 pr-3 font-mono text-ink-700">{r.reference}</td>
                    <td className="py-1 pr-3 text-ink-800 truncate max-w-[22ch]" title={r.name}>{r.name}</td>
                    <td className="py-1 pr-3 text-ink-600">{r.subtype || '—'}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-ink-900">{money(r.priceUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={write}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {stage === 'writing' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <UploadCloud size={15} aria-hidden />}
            Importar {plan.summary.total} referencias
          </button>
        </div>
      )}

      {result && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-[12px] text-emerald-800">
          {result.total} referencias en <code className="font-mono">{result.catalogBrand}</code>
          {' · '}{result.created} nuevas
          {result.updated > 0 && <> · {result.updated} actualizadas</>}
          {result.missing > 0 && <> · {result.missing} que ya no están se dejaron intactas</>}
        </div>
      )}

      {/* SEGUNDA FUENTE, SEGUNDO PASO: sobre lo que Anthom ya trajo (y precia),
          el catálogo del FABRICANTE pone lo que un revendedor no publica —
          ejes con nombre, medidas, fotos, el SKU de fábrica. Vive debajo del
          importador porque enriquece SUS filas: sin importar primero, no hay
          nada que cruzar. */}
      <FredericiaEnrichBar profileId={profileId} />

      {/* LA MITAD 3D del mismo camino: localizar el .obj de cada pieza que
          vendemos y dejarlo en fredericia_assets — la extracción que la
          pregunta del 2026-08-31 no encontraba en presscloud. */}
      <Fredericia3dBar profileId={profileId} />

      <p className="text-[11px] text-ink-400 leading-relaxed">
        Una referencia Fredericia es <span className="font-mono">FRE-modelo-grupo-acabados</span>, y el
        grupo de tapizado va EN MEDIO — así que la familia que el cotizador agrupa es el SKU con ese hueco
        vacío (<span className="font-mono">FRE-1731--ABL-CH</span>), y cada acabado lleva su propia
        escalera de precios. Las telas no vienen de aquí: la mayoría son Kvadrat, que ya es una casa de
        materiales en esta app.
      </p>
    </div>
  );
}
