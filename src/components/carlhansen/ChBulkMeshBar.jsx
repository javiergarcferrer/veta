import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, Loader2, Square, Wand2 } from 'lucide-react';
import { db, invalidate } from '../../db/database.js';
import { resolveCarlHansenConfigurator, resolveCarlHansenMeshQueue } from '../../core/catalog/index.js';
import { ALCOVER_MESH_V } from '../configurator/modelLoader.js';
import { convertChZip, readChZipDirectory } from './chMeshImport.js';
import { userMessageFor } from '../../lib/errorMessages.js';

/**
 * CONVERTIR TODO EL 3D — the whole range's meshes in one press.
 *
 * The per-model panel (ChMeshPanel) is right for tuning ONE chair: inspect the
 * archive, convert, review the binding. It is the wrong way to make the
 * CONFIGURATOR usable: ~100 furniture models publish web geometry, and one
 * press per model is the same several-hundred-click hole «Importar todo»
 * closed for prices. This bar drives the SAME pipeline (`convertChZip` — the
 * directory Range-read, the mesh+textures-only download, `sceneImport`, the
 * GLB upload, the binding proposal) over every model the queue resolver says
 * is pending, ONE AT A TIME:
 *
 *   • sequential on purpose. A conversion loads a mesh into three.js and
 *     re-exports it — two at once is how the tab dies. Progress names the
 *     model and the phase, and «Detener» is a real stop between models.
 *   • the QUEUE is the ViewModel's call (`resolveCarlHansenMeshQueue`), never
 *     re-derived here: converted stays converted, a human's reviewed binding
 *     is never recomputed behind their back, and a pipeline-version bump
 *     re-queues from the kept source archive.
 *   • tier-none archives are refused for the price of a directory read (a few
 *     KB), before any megabytes move.
 *   • a model that fails costs ITSELF, never the run — counted and named.
 *
 * WHAT REMAINS HUMAN, deliberately: tier-B bindings arrive «por revisar» — a
 * texture proves a material family exists in the piece, never which mesh
 * group wears it, so the dealer confirms those in the per-model panel. The
 * result line says exactly how many await that click.
 */
const IDLE = { busy: false, stopping: false, done: 0, total: 0, note: '', result: null, error: '' };

const PHASE_NOTE = {
  directory: 'directorio',
  download: 'texturas',
  convert: 'geometría',
  export: 'GLB',
  upload: 'publicando',
  save: 'guardando',
};

export default function ChBulkMeshBar({ pages, assets, onDone }) {
  const [state, setState] = useState(IDLE);
  const stopRef = useRef(false);

  const plan = useMemo(
    () => resolveCarlHansenMeshQueue(pages || [], assets || [], { meshV: ALCOVER_MESH_V }),
    [pages, assets],
  );
  const pageByModel = useMemo(() => {
    const out = new Map();
    for (const p of pages || []) {
      const id = String(p?.modelId || '');
      if (id && !out.has(id) && Array.isArray(p?.variants) && p.variants.length) out.set(id, p);
    }
    return out;
  }, [pages]);

  const run = useCallback(async () => {
    if (!plan.queue.length) return;
    stopRef.current = false;
    setState({ ...IDLE, busy: true, total: plan.queue.length });

    const failures = [];
    let readyCount = 0;
    let reviewCount = 0;
    let refused = 0;
    let stopped = false;

    for (let i = 0; i < plan.queue.length; i += 1) {
      if (stopRef.current) { stopped = true; break; }
      const job = plan.queue[i];
      const say = (note) => setState((s) => (s.busy ? { ...s, done: i + 1, note: `${job.modelId} · ${note}` } : s));
      say('directorio');
      try {
        // Refuse a geometry-less archive for the price of a few KB, before
        // any megabytes move.
        const dir = await readChZipDirectory(job.zipUrl);
        if (dir.classification.tier === 'none') { refused += 1; continue; }

        // The binding joins mesh materials onto the configurator's axes, so
        // the axes travel with the conversion — same enrichment (`kind`) the
        // per-model panel hands its own convert button.
        const spec = await db.carlHansenSpecs.get(job.modelId).catch(() => null);
        const axes = spec
          ? resolveCarlHansenConfigurator(spec, null, pageByModel.get(job.modelId) || null).axes
          : [];

        const out = await convertChZip({
          modelId: job.modelId,
          zipUrl: job.zipUrl,
          zipName: job.zipName,
          axes,
          onProgress: ({ phase }) => say(PHASE_NOTE[phase] || phase),
        });
        if (out.binding?.needsReview) reviewCount += 1;
        else readyCount += 1;
        // Each landed row repaints the grid and the per-model panels live.
        invalidate(['carlHansenAssets']);
      } catch (e) {
        failures.push(`${job.modelId}: ${userMessageFor(e)}`);
      }
    }

    setState({
      ...IDLE,
      result: {
        attempted: plan.queue.length,
        ready: readyCount,
        review: reviewCount,
        refused,
        failures,
        stopped,
      },
    });
    onDone?.();
  }, [plan.queue, pageByModel, onDone]);

  const stop = useCallback(() => {
    stopRef.current = true;
    setState((s) => (s.busy ? { ...s, stopping: true } : s));
  }, []);

  const c = plan.counts;
  const r = state.result;

  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 inline-flex items-center gap-1.5">
            <Boxes size={15} className="opacity-70" aria-hidden />
            Convertir el 3D de todo el catálogo
          </div>
          <p className="text-xs text-ink-500 mt-0.5 max-w-prose">
            Baja de cada archivo publicado solo la malla y sus texturas —nunca el .max, el .dwg ni
            el .rfa—, publica un GLB compacto y propone a qué eje del configurador responde cada
            material. Lo ya convertido y lo ya revisado no se toca.
          </p>
        </div>
        {state.busy ? (
          <button
            type="button"
            onClick={stop}
            disabled={state.stopping}
            className="btn-secondary min-h-11 whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0 disabled:opacity-60"
          >
            <Square size={13} aria-hidden /> {state.stopping ? 'Deteniendo…' : 'Detener'}
          </button>
        ) : (
          <button
            type="button"
            onClick={run}
            disabled={!plan.queue.length}
            className="btn btn-primary min-h-11 whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0 disabled:opacity-60"
            title={plan.queue.length ? '' : 'No hay archivos 3D pendientes de convertir'}
          >
            <Wand2 size={14} aria-hidden />
            {plan.queue.length ? `Convertir ${plan.queue.length} modelo(s)` : 'Nada pendiente'}
          </button>
        )}
      </div>

      {/* EL CENSO, SIEMPRE — the whole range's 3D state in one line, shown
          before, during and after: what is usable, what awaits a human, and
          what Carl Hansen simply does not publish. */}
      <div className="font-mono text-micro text-ink-500">
        {plan.models} modelos · {c.ready} listos · {c.needsReview} por revisar · {c.queued} por convertir
        {c.stale > 0 ? ` · ${c.stale} de versión vieja` : ''}
        {' · '}{c.noAsset + c.revitOnly + c.notUsable} sin 3D utilizable
      </div>

      {state.busy && (
        <div className="space-y-1">
          <div className="text-xs text-ink-600">
            Convirtiendo… <span className="tabular-nums">{state.done} / {state.total}</span>
            {state.note ? <span className="font-mono text-ink-500"> · {state.note}</span> : null}
          </div>
          <div className="h-1 rounded bg-ink-100 overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-[width]"
              style={{ width: state.total ? `${Math.round((state.done / state.total) * 100)}%` : '15%' }}
            />
          </div>
        </div>
      )}

      {state.error && (
        <p role="alert" className="notice notice-sm notice-danger">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{state.error}</span>
        </p>
      )}

      {r && !state.busy && (
        <div className="text-xs text-ink-600 space-y-1">
          <div>
            <strong className="text-ink-900">{r.ready + r.review}</strong> de {r.attempted} mallas
            convertidas · {r.ready} listas · {r.review} esperan revisión del binding
            {r.stopped ? ' · detenida a mitad — vuelve a pulsar para seguir' : ''}
          </div>
          {r.review > 0 && (
            <p className="text-ink-500">
              Tier B llega sin confirmar a propósito: una textura prueba que la familia existe en
              la pieza, nunca cuál malla la lleva puesta. Abre cada modelo marcado «Falta revisar»
              y confirma el binding.
            </p>
          )}
          {r.refused > 0 && (
            <p className="text-ink-500">{r.refused} archivo(s) no traen geometría que el navegador pueda abrir.</p>
          )}
          {r.failures.length > 0 && (
            <p className="text-status-warning-ink">
              {r.failures.length} no se pudieron convertir — {r.failures.slice(0, 4).join(' · ')}
              {r.failures.length > 4 ? ` +${r.failures.length - 4}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
