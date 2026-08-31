import { useCallback, useRef, useState } from 'react';
import { Boxes, Loader2, Square } from 'lucide-react';
import { db, invalidate, productsByBrand } from '../../db/database.js';
import { supabase } from '../../db/supabaseClient.js';
import { useLiveQuery } from '../../db/hooks.js';
import { BRAND_FREDERICIA } from '../../lib/constants.js';
import { userMessageFor } from '../../lib/errorMessages.js';

/**
 * EXTRAER EL 3D DEL FABRICANTE — la respuesta a «en su presscloud no encuentro
 * cómo extraer las URLs de sus 3D» (2026-08-31).
 *
 * No están en presscloud: presscloud es la fototeca. Cada página de producto
 * de fredericia.com publica `files[]`, y de ahí exactamente UNA geometría abre
 * en un navegador — el .obj, en Cloudinary `raw/upload`, con CORS `*` y el
 * peso expuesto a un HEAD. Esta barra recorre las fichas del fabricante y deja
 * cada hallazgo en `fredericia_assets`: la fuente, su nombre y su peso — la
 * mitad EXTRACCIÓN del camino que Carl Hansen ya recorrió entero (después
 * vendrán la conversión a GLB y el binding, que aquí será siempre humano: el
 * .obj llega con `usemtl 191,191,191` y sin .mtl).
 *
 *   • SOLO LO QUE VENDEMOS. La ficha se pide por código de familia del
 *     catálogo importado — recorrer el sitemap entero sería ~289 páginas de
 *     ~1 MB para piezas que no ofrecemos.
 *   • EL PESO ANTES QUE EL ARCHIVO. Un HEAD por hallazgo (unos bytes) deja el
 *     peso en la fila; el rango real medido va de 4.7 MB al Calmo Elements de
 *     165 MB, y quien convierta después decide con el número delante.
 *   • IDEMPOTENTE. Una fila ya extraída no se re-pide; volver a pulsar solo
 *     busca lo que falte. «Detener» para entre fichas, nunca a mitad de una.
 *   • UN «SIN 3D» ES UNA RESPUESTA. 1 de 30 productos medidos no publica .obj;
 *     la fila se guarda igual, con la fuente vacía, para que el censo diga
 *     «no publica» en vez de reintentarlo en cada corrida.
 */

/** Un op contra el lector del fabricante — el invoke vive en la página, no en
 *  `src/brands/**` (la regla de KvadratImport: la capa de marcas no ve red). */
async function fredericiaOp(body) {
  const { data, error } = await supabase.functions.invoke('fredericia-catalog', { body });
  if (error) {
    let msg = error.message || 'El catálogo de Fredericia no respondió.';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  return data;
}

/** El peso por un HEAD — Cloudinary expone Content-Length con CORS `*`.
 *  null si no contesta: el peso es un dato útil, nunca un bloqueo. */
async function headBytes(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const n = Number(r.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

const IDLE = { busy: false, stopping: false, done: 0, total: 0, note: '', result: null, error: '' };

const mb = (n) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);

export default function Fredericia3dBar({ profileId }) {
  const [state, setState] = useState(IDLE);
  const stopRef = useRef(false);

  // EL CENSO, SIEMPRE — cuántas piezas tienen ya su 3D localizado, cuántas no
  // publican, y el peso total de lo localizado.
  const assets = useLiveQuery(() => db.fredericiaAssets.toArray(), [], []);
  const withSource = (assets || []).filter((a) => a.sourceUrl);
  const without = (assets || []).length - withSource.length;
  const totalBytes = withSource.reduce((s, a) => s + (a.sourceBytes || 0), 0);

  const run = useCallback(async () => {
    if (!profileId) { setState((s) => ({ ...s, error: 'Falta el perfil destino.' })); return; }
    stopRef.current = false;
    setState({ ...IDLE, busy: true, note: 'Leyendo el catálogo importado…' });
    try {
      const mine = await productsByBrand(profileId, BRAND_FREDERICIA);
      const codes = new Set((mine || []).map((p) => String(p.familyCode || '').trim()).filter(Boolean));
      if (!codes.size) throw new Error('El catálogo Fredericia está vacío — importa el catálogo primero.');

      const known = new Set((await db.fredericiaAssets.toArray()).map((a) => String(a.id)));

      setState((s) => ({ ...s, note: 'Preguntando a Fredericia qué publica…' }));
      const list = await fredericiaOp({ op: 'models' });
      if (!list?.ok) throw new Error(list?.error || 'El sitemap no respondió.');
      const wanted = (list.models || []).filter((m) => m.code && codes.has(m.code) && !known.has(m.code));
      // Piezas que vendemos y cuyo código el sitemap del fabricante no lista.
      const absent = [...codes].filter((c) => !(list.models || []).some((m) => m.code === c)).length;

      let found = 0; let sinObj = 0; let failed = 0; let stopped = false;
      setState((s) => ({ ...s, total: wanted.length }));
      for (let i = 0; i < wanted.length; i += 1) {
        if (stopRef.current) { stopped = true; break; }
        const m = wanted[i];
        setState((s) => (s.busy ? { ...s, done: i + 1, note: `${m.code} · ficha` } : s));
        const res = await fredericiaOp({ op: 'product', slug: m.slug }).catch(() => null);
        if (!res?.ok) { failed += 1; continue; }
        const p = res.product || {};
        const hit = p.file3d || null;
        const bytes = hit ? await headBytes(hit.url) : null;
        // La fila se escribe TAMBIÉN sin hallazgo: «no publica 3D» es una
        // respuesta del fabricante, y guardarla evita re-pedir la ficha en
        // cada corrida.
        await db.fredericiaAssets.put({
          id: String(m.code),
          profileId,
          slug: String(m.slug || ''),
          name: String(p.name || ''),
          sourceUrl: hit ? hit.url : null,
          sourceName: hit ? hit.name : '',
          sourceBytes: bytes,
          meshTier: 'none',
          ingestedAt: Date.now(),
          updatedAt: Date.now(),
        });
        if (hit) found += 1; else sinObj += 1;
        invalidate(['fredericiaAssets']);
      }
      setState({ ...IDLE, result: { attempted: wanted.length, found, sinObj, failed, absent, stopped } });
    } catch (e) {
      setState({ ...IDLE, error: userMessageFor(e) || e?.message || 'No se pudo extraer el 3D.' });
    }
  }, [profileId]);

  const stop = useCallback(() => {
    stopRef.current = true;
    setState((s) => (s.busy ? { ...s, stopping: true } : s));
  }, []);

  const r = state.result;

  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 inline-flex items-center gap-1.5">
            <Boxes size={15} className="opacity-70" aria-hidden />
            Extraer el 3D del fabricante
          </div>
          <p className="text-xs text-ink-500 mt-0.5 max-w-prose">
            El 3D no está en presscloud: cada ficha de fredericia.com publica sus archivos, y de
            ahí sale el .obj — la única geometría que un navegador abre. Esto localiza el de cada
            pieza que vendemos y guarda su URL y su peso. Convertir y vestir vienen después.
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
            className="btn btn-primary min-h-11 whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0"
          >
            <Boxes size={14} aria-hidden /> Extraer
          </button>
        )}
      </div>

      <div className="font-mono text-micro text-ink-500">
        {withSource.length} con 3D localizado · {without} sin 3D publicado · {mb(totalBytes)} en total
      </div>

      {state.busy && (
        <div className="space-y-1">
          <div className="text-xs text-ink-600 inline-flex items-center gap-2">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {state.total
              ? <span className="tabular-nums">{state.done} / {state.total}</span>
              : null}
            {state.note ? <span className="font-mono text-ink-500">{state.note}</span> : null}
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
        <p role="alert" className="notice notice-sm notice-danger"><span>{state.error}</span></p>
      )}

      {r && !state.busy && (
        <div className="text-xs text-ink-600 space-y-1">
          <div>
            <strong className="text-ink-900">{r.found}</strong> de {r.attempted} fichas traen 3D
            {r.sinObj > 0 ? ` · ${r.sinObj} no lo publican` : ''}
            {r.absent > 0 ? ` · ${r.absent} piezas nuestras no están en su sitemap` : ''}
            {r.stopped ? ' · detenida a mitad — vuelve a pulsar para seguir' : ''}
          </div>
          {r.failed > 0 && (
            <p className="text-status-warning-ink">{r.failed} ficha(s) no respondieron — vuelve a pulsar para reintentarlas.</p>
          )}
        </div>
      )}
    </div>
  );
}
