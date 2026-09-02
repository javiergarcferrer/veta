/**
 * KVADRAT — importar una colección entera desde su enlace, en su propia página.
 *
 * El panel equivalente vive dentro de la ficha de una marca, pero sólo aparece
 * si ESA marca tiene el juego de módulos `kvadrat`. Como cada marca lleva el
 * suyo, la herramienta quedaba enterrada (y, sin ninguna marca configurada así,
 * era inalcanzable). Esta página la saca al nav: se abre en un clic, se elige a
 * qué marca entran las telas, y se pega el enlace.
 *
 * POR QUÉ USA EL MÓDULO KVADRAT DIRECTAMENTE, y no `moduleSetFor(brand)`: aquí
 * la casa la elige la PÁGINA, no la marca. Importar telas Kvadrat al libro de un
 * fabricante es exactamente el caso de uso —la marca destino conserva su propio
 * juego de módulos para sus propios archivos—, así que exigirle a la marca el
 * juego `kvadrat` sería pedir que se disfrace de casa de materiales para poder
 * recibir sus telas.
 *
 * Los efectos se construyen AQUÍ y se inyectan (`invoke`, `fetchZip`, `upload`);
 * `src/brands/**` sigue sin conocer Supabase ni el proxy.
 */
import { useCallback, useMemo, useState } from 'react';
import { Loader2, UploadCloud, Layers, ExternalLink } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { db, newId } from '../../db/database.js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../db/supabaseClient.js';
import { uploadSwatchTexture, removeSwatchTexture } from '../../db/swatchUpload.js';
import { useToast } from '../../components/ConfirmProvider.jsx';
import { KVADRAT_MODULES, planMaterialImport } from '../../brands/index.js';
import Notice from '../../components/primitives/Notice.jsx';

const SOURCE = KVADRAT_MODULES.materials.source;

/** Colecciones conocidas, para no obligar a nadie a ir a buscar el enlace. */
const SHORTCUTS = [
  { label: 'Asator', slug: '1044-asator' },
  { label: 'Divina 3', slug: '1200-divina-3' },
  { label: 'Hallingdal 65', slug: '1000-hallingdal-65' },
  { label: 'Steelcut Trio 3', slug: '1300-steelcut-trio-3' },
];

export default function KvadratImport() {
  const { profileId, brands, brand: activeBrand } = useApp();
  const toast = useToast();

  const options = useMemo(() => (brands || []).filter(Boolean), [brands]);
  const [brandId, setBrandId] = useState(activeBrand?.id || options[0]?.id || '');
  const target = useMemo(() => options.find((b) => b.id === brandId) || null, [options, brandId]);

  const [url, setUrl] = useState('');
  const [state, setState] = useState({ stage: 'idle', done: 0, total: 0, current: '' });
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = useCallback(async () => {
    const link = url.trim();
    if (!link) { setError('Pega el enlace de la colección.'); return; }
    if (!target) { setError('Elige a qué marca entran las telas.'); return; }
    setError(null); setResult(null);
    setState({ stage: 'enumerate', done: 0, total: 0, current: '' });

    const invoke = (name, opts) => supabase.functions.invoke(name, opts);
    let colours = [];
    let productName = null;
    try {
      const col = await SOURCE.fetch(link, { invoke });
      colours = col.colours || [];
      productName = col.productName || null;
    } catch (e) {
      setError(e?.message || 'No se pudo leer la colección.');
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
      return;
    }

    setState({ stage: 'importing', done: 0, total: colours.length, current: '' });
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || SUPABASE_ANON_KEY;
    const fetchZip = async (zurl) => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/kvadrat-zip?url=${encodeURIComponent(zurl)}`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      return res.blob();
    };
    const upload = (blob, name) => uploadSwatchTexture(blob, { folder: target.slug || target.id, name });

    let colors = [];
    try {
      colors = await SOURCE.import({
        colours, fetchZip, upload,
        onProgress: (p) => setState((s) => ({ ...s, done: p.done, total: p.total, current: p.code || '' })),
      });
    } catch (e) {
      setError(e?.message || 'Falló la importación.');
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
      return;
    }
    if (!colors.length) {
      setError('No se pudo importar ningún color de esa colección.');
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
      return;
    }
    // UNA COLECCIÓN SIN UNA SOLA IMAGEN NO ES UNA IMPORTACIÓN BUENA. Entró el
    // código, el tono y el tamaño de cada color —el ZIP se leyó entero— pero si
    // ninguna textura llegó a guardarse, la pared de materiales sale en blanco.
    // Es exactamente lo que pasó importando Asator contra un proyecto sin
    // buckets de Storage, y se informó como éxito. Se para aquí, con el motivo.
    const stored = colors.filter((c) => c.textureUrl).length;
    if (!stored) {
      setError(
        `Se leyeron ${colors.length} colores pero no se pudo guardar ninguna imagen`
        + `${colors.uploadError ? ` (${colors.uploadError})` : ''}. `
        + 'Revisa el bucket «togo-textures» en Storage; sin él las telas entran sin foto.',
      );
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
      return;
    }

    setState((s) => ({ ...s, stage: 'writing' }));
    const uploaded = colors.map((c) => c.textureUrl).filter(Boolean);
    try {
      const existing = await db.materials.where('brandId').equals(target.id).toArray();
      const plan = planMaterialImport({
        colors, existing, profileId, brandId: target.id, newId,
        fallbackName: productName || 'Kvadrat',
      });
      if (plan.rows.length) await db.materials.bulkPut(plan.rows);
      // `stored` viaja al resumen: una importación parcial (algunas telas sin
      // foto) se dice, en vez de descubrirse en la pared.
      setResult({ ...plan.summary, productName, stored, read: colors.length });
      toast?.(`${plan.summary.colors} colores importados`);
    } catch (e) {
      // Las texturas ya están pagadas y nada apuntaría a ellas si falla el write.
      await Promise.all(uploaded.map((u) => removeSwatchTexture(u)));
      setError(e?.message || 'No se pudieron guardar los materiales.');
    } finally {
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
    }
  }, [url, target, profileId, toast]);

  const busy = state.stage !== 'idle';
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Layers size={18} className="text-ink-400" aria-hidden />
          <h1 className="text-lg font-semibold text-ink-900">Kvadrat</h1>
        </div>
        <p className="text-sm text-ink-500">
          Importa una colección entera de Kvadrat: cada color llega con su tejido escaneado,
          su tono exacto, el relieve y su tamaño físico real.
        </p>
      </header>

      <div className="rounded-xl border border-ink-100 p-4 space-y-3">
        <label className="block">
          <span className="label">Marca destino</span>
          <select
            value={brandId}
            disabled={busy}
            onChange={(e) => setBrandId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm disabled:opacity-60"
          >
            {!options.length && <option value="">(no hay marcas)</option>}
            {options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>

        {/* The caption row's field shares its box with a button, so the label
            binds by id: a <label> that wrapped both would fire the button on
            every click of the word (design-system §12). */}
        <div>
          <label htmlFor="kvadrat-source-url" className="label">Enlace de la colección</label>
          <div className="flex gap-2">
            <input
              id="kvadrat-source-url"
              type="text"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={SOURCE.placeholder}
              className="flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-sm disabled:opacity-60"
            />
            <button
              type="button"
              onClick={run}
              disabled={busy || !url.trim() || !target}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} aria-hidden />}
              Importar
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-micro text-ink-500">Rápido:</span>
          {SHORTCUTS.map((s) => (
            <button
              key={s.slug}
              type="button"
              disabled={busy}
              onClick={() => setUrl(`https://www.kvadrat.dk/en/products/upholstery/${s.slug}`)}
              className="rounded-full border border-ink-200 px-2 py-0.5 text-micro text-ink-600 hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
          <a
            href="https://www.kvadrat.dk/en/products/upholstery"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-micro text-ink-500 hover:text-brand-600"
          >
            Ver catálogo <ExternalLink size={11} aria-hidden />
          </a>
        </div>

        {busy && (
          <div className="space-y-1">
            <div className="text-xs text-ink-600">
              {state.stage === 'enumerate' && 'Leyendo la colección…'}
              {state.stage === 'importing' && `Bajando ${state.done}/${state.total}${state.current ? ` · ${state.current}` : ''}`}
              {state.stage === 'writing' && 'Guardando materiales…'}
            </div>
            {state.stage === 'importing' && state.total > 0 && (
              <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
                <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}

        {error && (
          <Notice tone="danger" dense>{error}</Notice>
        )}
        {result && (
          <Notice tone="success" dense>
            {result.productName ? <><strong>{result.productName}</strong> · </> : null}
            {result.materials} material{result.materials === 1 ? '' : 'es'} · {result.newColors} colores nuevos
            {result.updatedColors > 0 && <> · {result.updatedColors} actualizados</>}
            {result.stored < result.read && (
              <> · <strong>{result.read - result.stored} sin imagen</strong></>
            )}
          </Notice>
        )}
      </div>

      <p className="text-micro text-ink-500 leading-relaxed">
        Cada export son cientos de MB a resolución original; los mapas se reescalan al
        decodificarlos. Importa unas pocas colecciones a la vez.
      </p>
    </div>
  );
}
