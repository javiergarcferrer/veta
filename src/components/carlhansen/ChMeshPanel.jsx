import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, Boxes, CheckCircle2, Download, ExternalLink, FileArchive,
  Info, Layers, Loader2, RotateCw, ScanSearch, Wand2,
} from 'lucide-react';
import { formatDateTime } from '../../lib/format.js';
import { resolveCarlHansenAssets } from '../../core/catalog/index.js';
import { convertChZip, readChZipDirectory, saveChBindingReview } from './chMeshImport.js';

/**
 * EL 3D DE UN MODELO CARL HANSEN — en qué estado está, convertirlo, y revisar a
 * qué eje del configurador responde cada material de la malla.
 *
 * Deriva NADA: todo el estado sale de `resolveCarlHansenAssets` (core/catalog) y
 * la conversión entera vive en `chMeshImport`. Aquí solo hay pintura, la
 * elección del humano, y los estados vacíos.
 *
 * LOS ESTADOS VACÍOS SON LA MITAD DEL PANEL, no un caso borde. Medido: ~19% de
 * los muebles no publica 3D utilizable, y el `<MODELO>.zip` a secas es un `.rfa`
 * de Revit que el navegador NO puede abrir. Decirlo con todas las letras es
 * mejor que ofrecer un visor que no va a mostrar nada — y es la diferencia entre
 * "esto está roto" y "esta pieza no trae 3D".
 */

/** `state` (código del VM) → cómo se pinta y qué significa, en cristiano. */
const STATE_COPY = {
  'no-asset': {
    pill: 'status-pill-inactive',
    label: 'Sin 3D',
    text: 'Este modelo no publica ningún archivo 3D. Cerca del 19% de los muebles del catálogo está así: no es una falla de la app, sencillamente no existe la pieza.',
  },
  'revit-only': {
    pill: 'status-pill-inactive',
    label: 'Solo Revit',
    text: 'Lo único publicado es un archivo Revit (.rfa): un objeto BIM para arquitectos, no geometría que un navegador pueda abrir. No hay nada que convertir.',
  },
  unclassified: {
    pill: 'status-pill-pending',
    label: 'Sin clasificar',
    text: 'Hay un ZIP publicado y todavía no sabemos qué trae. Leer su directorio cuesta unos pocos KB — el archivo completo pesa entre 8 y 22 MB.',
  },
  'not-web-usable': {
    pill: 'status-pill-declined',
    label: 'No convertible',
    text: 'El ZIP no trae ninguna malla que el navegador pueda abrir.',
  },
  convertible: {
    pill: 'status-pill-sent',
    label: 'Convertible',
    text: 'El ZIP trae malla. Al convertir se bajan solo la malla y sus texturas —nunca el .max, el .dwg ni el .rfa— y se publica un GLB compacto.',
  },
  'needs-review': {
    pill: 'status-pill-pending',
    label: 'Falta revisar',
    text: 'La malla ya está publicada. Falta que una persona confirme qué material corresponde a cada eje del configurador.',
  },
  ready: {
    pill: 'status-pill-accepted',
    label: 'Listo',
    text: 'Malla publicada y binding confirmado.',
  },
};

/** Por qué el ZIP quedó como quedó — el código de `classifyZip`, en cristiano. */
const REASON_COPY = {
  'mesh-with-mtl': 'Trae malla con su biblioteca de materiales: los nombres de material son semánticos y se pueden asignar solos.',
  'mesh-without-mtl': 'Trae malla pero sin biblioteca de materiales: los grupos son genéricos y la única pista son los nombres de las texturas.',
  'revit-only': 'Solo trae Revit (.rfa).',
  'max-only': 'Solo trae la escena de 3ds Max (.max), sin malla exportada.',
  'cad-only': 'Solo trae planos CAD (.dwg/.dxf).',
  'no-mesh': 'Trae archivos, pero ninguno es una malla que se pueda cargar.',
  empty: 'El ZIP no trae entradas utilizables.',
};

const TIER_LABEL = { a: 'Tier A · auto-asignable', b: 'Tier B · necesita criterio humano', none: 'Sin geometría web' };

const PHASE_COPY = {
  directory: 'Leyendo el directorio del ZIP…',
  download: 'Bajando la malla y sus texturas…',
  convert: 'Cargando la geometría…',
  export: 'Exportando el GLB…',
  upload: 'Publicando la malla…',
  save: 'Guardando…',
  done: 'Listo.',
};

const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;

function Row({ label, children }) {
  return (
    <div className="flex items-baseline gap-2 text-micro">
      <span className="text-ink-500 shrink-0">{label}</span>
      <span className="text-ink-700 font-mono truncate min-w-0">{children}</span>
    </div>
  );
}

export default function ChMeshPanel({
  page = null,
  asset = null,
  axes = null,
  modelId = '',
  onChange = null,
}) {
  // `probe` = el directorio leído a mano (Inspeccionar). `result` = lo que
  // acaba de escribir una conversión, para que el panel no dependa de que el
  // padre haya vuelto a leer la fila todavía.
  const [probe, setProbe] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);      // nombre de grupo → axisId ('' = sin eje)
  const [saving, setSaving] = useState(false);

  const id = modelId || page?.modelId || asset?.id || '';
  // La fila recién escrita gana solo mientras sea más nueva que la del padre.
  const row = result?.row && (result.row.ingestedAt || 0) >= (asset?.ingestedAt || 0) ? result.row : asset;
  const reviewed = !!row?.bindingReviewedAt;

  const view = useMemo(() => resolveCarlHansenAssets(page, row, {
    // UN BINDING YA CONFIRMADO NO SE RECALCULA a espaldas del humano: si alguien
    // firmó el mapa, el guardado es la verdad y una propuesta fresca lo taparía.
    zipEntries: reviewed ? null : (probe?.entries?.length ? probe.entries : null),
    materialNames: reviewed ? null : (result?.materialNames || null),
    axes,
  }), [page, row, axes, probe, result, reviewed]);

  const zipInfo = probe?.classification || result?.classification || null;
  const copy = STATE_COPY[view.state] || STATE_COPY.unclassified;
  const groups = view.binding?.groups || [];
  const axisList = useMemo(() => (axes || []).filter((a) => a?.id), [axes]);
  const busy = !!progress || saving;

  const axisOf = useCallback(
    (group) => (draft && group.name in draft ? draft[group.name] : (group.axisId || '')),
    [draft],
  );

  const inspect = useCallback(async () => {
    setError(null);
    setProgress({ phase: 'directory', note: view.zipName || '' });
    try {
      setProbe(await readChZipDirectory(view.zipUrl));
    } catch (e) {
      setError(e?.message || 'No se pudo leer el directorio del ZIP.');
    } finally {
      setProgress(null);
    }
  }, [view.zipUrl, view.zipName]);

  const convert = useCallback(async () => {
    setError(null);
    setDraft(null);
    setProgress({ phase: 'directory', note: view.zipName || '' });
    try {
      const out = await convertChZip({
        modelId: id,
        zipUrl: view.zipUrl,
        zipName: view.zipName || '',
        axes: axisList,
        onProgress: setProgress,
      });
      const { classification, materialNames, failed, ...saved } = out;
      setResult({ row: saved, classification, materialNames, failed });
      setProbe(null);
      onChange?.();
    } catch (e) {
      setError(e?.message || 'No se pudo convertir el archivo 3D.');
    } finally {
      setProgress(null);
    }
  }, [id, view.zipUrl, view.zipName, axisList, onChange]);

  const confirmBinding = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await saveChBindingReview(id, groups.map((g) => ({ ...g, axisId: axisOf(g) || null })));
      // A partir de aquí manda la fila guardada: se limpia todo lo que podría
      // volver a proponer por encima de lo que el humano acaba de firmar.
      setDraft(null);
      setProbe(null);
      setResult(null);
      onChange?.();
    } catch (e) {
      setError(e?.message || 'No se pudo guardar el binding.');
    } finally {
      setSaving(false);
    }
  }, [id, groups, axisOf, onChange]);

  return (
    <section className="rounded-xl border border-ink-200/80 bg-surface overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-ink-100">
        <h3 className="font-display text-xs font-semibold flex items-center gap-1.5 text-ink-900">
          <Boxes size={13} className="text-ink-500" /> Modelo 3D
        </h3>
        <div className="flex items-center gap-1.5">
          {view.tier ? (
            <span className="eyebrow">
              {TIER_LABEL[view.tier]}
            </span>
          ) : null}
          <span className={`status-pill ${copy.pill}`}>{copy.label}</span>
        </div>
      </header>

      <div className="p-4 space-y-3">
        <p className="text-xs text-ink-500 leading-relaxed">
          {copy.text}
          {view.state === 'not-web-usable' && view.reason ? ` ${REASON_COPY[view.reason] || ''}` : ''}
        </p>

        {/* ── acciones ───────────────────────────────────────────────────── */}
        {view.zipUrl ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={inspect}
              disabled={busy}
              className="btn-secondary text-xs disabled:opacity-50"
              title="Lee solo el directorio del ZIP (unos KB), sin bajar el archivo"
            >
              <ScanSearch size={13} /> Inspeccionar ZIP
            </button>
            {view.tier && view.tier !== 'none' ? (
              <button
                type="button"
                onClick={convert}
                disabled={busy || !id}
                className="btn-primary text-xs disabled:opacity-50"
              >
                {view.meshUrl ? <RotateCw size={13} /> : <Wand2 size={13} />}
                {view.meshUrl ? 'Volver a convertir' : 'Convertir a GLB'}
              </button>
            ) : null}
            <a
              href={view.zipUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost text-xs"
              title={view.zipName || view.zipUrl}
            >
              <Download size={13} /> ZIP original
            </a>
          </div>
        ) : null}

        {!id && view.zipUrl ? (
          <p className="text-micro text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            La página no resolvió su modelo en el PIM, así que no hay dónde guardar la malla. Resuélvelo antes de convertir.
          </p>
        ) : null}

        {progress ? (
          <p className="text-micro text-ink-500 flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin shrink-0" />
            {PHASE_COPY[progress.phase] || 'Trabajando…'}
            {progress.note ? <span className="font-mono text-ink-500 truncate">{progress.note}</span> : null}
          </p>
        ) : null}

        {error ? (
          <p className="notice notice-sm notice-danger">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
          </p>
        ) : null}

        {/* ── qué trae el ZIP ────────────────────────────────────────────── */}
        {zipInfo ? (
          <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2.5 space-y-1">
            <div className="eyebrow flex items-center gap-1">
              <FileArchive size={11} /> Contenido del ZIP
            </div>
            <Row label="Malla">{zipInfo.mesh || '—'}</Row>
            <Row label="Materiales">{zipInfo.mtl || 'sin .mtl'}</Row>
            <Row label="Texturas">
              {zipInfo.textures?.length ? `${zipInfo.textures.length} · ${zipInfo.textures.map((t) => t.split('/').pop()).join(', ')}` : 'ninguna'}
            </Row>
            <p className="text-micro text-ink-500 leading-relaxed pt-0.5">{REASON_COPY[zipInfo.reason] || ''}</p>
            {probe?.truncated ? (
              <p className="text-micro text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                El directorio llegó incompleto: la lista de arriba puede estar a medias.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── la malla publicada ─────────────────────────────────────────── */}
        {view.meshUrl ? (
          <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2.5 space-y-1">
            <div className="eyebrow flex items-center gap-1">
              <CheckCircle2 size={11} /> Malla publicada
            </div>
            <Row label="GLB">
              <a href={view.meshUrl} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1">
                {view.meshUrl.split('/').pop()} <ExternalLink size={10} />
              </a>
            </Row>
            <Row label="Versión">{view.meshV != null ? `v${view.meshV}` : '—'}</Row>
            <Row label="Convertida">
              {view.ingestedAt ? `${formatDateTime(view.ingestedAt)}${view.ageDays != null ? ` · hace ${view.ageDays} d` : ''}` : '—'}
            </Row>
            {result?.failed?.length ? (
              <p className="text-micro text-amber-700 dark:text-amber-300">
                No se pudieron leer: {result.failed.map((f) => f.name).join(', ')}.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── revisión del binding ───────────────────────────────────────── */}
        {groups.length ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="eyebrow flex items-center gap-1">
                <Layers size={11} /> Binding de materiales
              </div>
              {view.needsBindingReview ? (
                <span className="status-pill status-pill-pending">Sin confirmar</span>
              ) : (
                <span className="status-pill status-pill-accepted">
                  Confirmado{row?.bindingReviewedAt ? ` · ${formatDateTime(row.bindingReviewedAt)}` : ''}
                </span>
              )}
            </div>

            <p className="text-micro text-ink-500 leading-relaxed flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 shrink-0 text-ink-500" />
              La máquina propone; una persona confirma. Tier B siempre llega sin confirmar: sin biblioteca de materiales,
              una textura prueba que la familia EXISTE en la pieza, nunca cuál malla la lleva puesta.
            </p>

            {!axisList.length ? (
              <p className="text-micro text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                No hay ejes del configurador cargados, así que no hay a qué asignar los materiales.
              </p>
            ) : null}

            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100 overflow-hidden">
              {groups.map((group) => (
                <li key={group.name} className="flex flex-wrap items-center gap-2 px-3 py-2 bg-surface">
                  <span className="font-mono text-micro text-ink-900 truncate min-w-0 flex-1">{group.name}</span>
                  <span className="eyebrow shrink-0">
                    {group.source === 'texture' ? 'textura' : 'mtl'}
                  </span>
                  <span
                    className={`text-micro tabular-nums shrink-0 ${group.confidence >= 0.8 ? 'text-status-good-ink' : group.confidence > 0 ? 'text-status-warning-ink' : 'text-ink-500'}`}
                    title="Qué tan seguro está el emparejamiento automático"
                  >
                    {pct(group.confidence)}
                  </span>
                  <select
                    value={axisOf(group)}
                    onChange={(e) => setDraft((d) => ({ ...(d || {}), [group.name]: e.target.value }))}
                    disabled={busy || !axisList.length}
                    className="input text-xs w-auto min-w-[9rem] shrink-0 disabled:opacity-50"
                  >
                    <option value="">— sin eje —</option>
                    {axisList.map((axis) => (
                      <option key={axis.id} value={axis.id}>
                        {axis.label || axis.name || axis.id}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={confirmBinding}
              disabled={busy || !id || !view.meshUrl}
              className="btn-secondary text-xs disabled:opacity-50"
              title={view.meshUrl ? 'Guardar el mapa material → eje' : 'Primero hay que convertir la malla'}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              Confirmar binding
            </button>
            {!view.meshUrl ? (
              <p className="text-micro text-ink-500">
                Esto es una propuesta leída del ZIP: no hay nada que confirmar hasta que la malla esté convertida.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── NO-VANISH: todo lo que la página publica, aunque el pipeline no
             pueda usarlo. Alguien pide el DWG tarde o temprano. ───────────── */}
        {view.assets?.length ? (
          <div className="pt-1">
            <div className="eyebrow mb-1">
              Archivos publicados
            </div>
            <ul className="space-y-0.5">
              {view.assets.map((link) => (
                <li key={link.url} className="text-micro flex items-center gap-1.5 min-w-0">
                  <span className="text-ink-500 uppercase tracking-[0.06em] w-10 shrink-0">{link.kind}</span>
                  <a href={link.url} target="_blank" rel="noreferrer" className="text-ink-700 hover:underline truncate min-w-0">
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
