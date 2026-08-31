import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';
import { invalidate } from '../../db/database.js';
import { userMessageFor } from '../../lib/errorMessages.js';

/**
 * CATÁLOGO OFICIAL LIGNE ROSET — one button.
 *
 * It was four (catálogo, cambios, telas, dibujos), and that was the mistake: it
 * made the dealer the scheduler. To use it they had to know the catalog runs
 * before the change log, that the fabrics are independent, and that the drawings
 * drain 120 at a time and need pressing twenty-three times. None of that is
 * theirs to know — so `{sync:true}` now does the whole thing in the right order
 * and this component just keeps calling it until nothing is left.
 *
 * THE LOOP IS THE POINT. One invocation does the catalog, the fabrics and the
 * change log — which always fit — then mirrors drawings until its time budget
 * runs out and reports how many remain. So pressing once and walking away is
 * enough: the button carries on by itself and the line above it says where it
 * is. Nothing here asks the dealer to press it again.
 *
 * And normally they never press it at all: the same operation runs nightly
 * (`lr-etiquette-nightly`), so the button is for "I want it now", not for
 * upkeep.
 */
export default function LrEtiquetteBar() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');
  const [result, setResult] = useState(null);
  const [sync, setSync] = useState(null);
  const [feed, setFeed] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');

  const call = useCallback(async (body) => {
    const { data, error: fnErr } = await supabase.functions.invoke('lr-etiquette', { body });
    if (fnErr) {
      let msg = fnErr.message || 'No se pudo leer el feed de Ligne Roset.';
      try { const b = await fnErr.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await call({ probe: true });
      setFeed(data); setSync(data.sync || null);
    } catch (e) {
      console.error('[LrEtiquette] probe failed:', e);
      setError(userMessageFor(e));
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Run until there is nothing left to run.
   *
   * ONE CALL IS ONE STEP, and that is the runtime's rule, not a preference: an
   * Edge Function is killed at 2 seconds of CPU, and the catalog alone spends
   * about 1.4 of them. So the server does one phase per invocation — catalog,
   * then the book and the change log, then drawings 120 at a time — and says
   * which phase comes next. This loop just keeps calling until it says `done`.
   *
   * The cap is a safety valve, not a schedule: ~2,900 drawings at 120 a pass is
   * well inside it. It exists so a server that kept answering "still more"
   * could never spin here forever.
   */
  async function syncAll() {
    setBusy(true); setError(''); setResult(null); setStep('Leyendo el feed…');
    let total = { products: 0, mirrored: 0, deactivated: 0, priceMoves: 0, fabrics: null, remaining: 0 };
    try {
      for (let pass = 0; pass < 120; pass++) {
        const out = await call({ sync: true });
        total = {
          products: out.products || total.products,
          mirrored: total.mirrored + (out.drawings?.mirrored || 0),
          deactivated: total.deactivated + (out.deactivated || 0),
          priceMoves: out.priceMoves || total.priceMoves,
          fabrics: out.fabrics || total.fabrics,
          remaining: out.drawings?.remaining ?? total.remaining,
          errors: out.errors?.length ? out.errors : total.errors,
          ungradable: out.ungradable?.length ? out.ungradable : total.ungradable,
          upToDate: out.upToDate ?? total.upToDate,
        };
        if (out.done) break;
        setStep(stepLabel(out, total));
      }
      setResult(total);
      invalidate('products'); invalidate('materials');
      await refresh();
    } catch (e) {
      console.error('[LrEtiquette] sync failed:', e);
      setError(userMessageFor(e));
    } finally {
      setBusy(false); setStep('');
    }
  }

  async function saveLink() {
    const clean = link.trim();
    if (!clean) return;
    setBusy(true); setError('');
    try {
      const { error: rpcErr } = await supabase.rpc('save_lr_etiquette_config', { p_base_url: clean });
      if (rpcErr) throw new Error(rpcErr.message);
      setLink(''); setLinkOpen(false);
      await refresh();
    } catch (e) {
      console.error('[LrEtiquette] save link failed:', e);
      setError(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-sm font-semibold">Catálogo oficial Ligne Roset</h3>
          <p className="text-xs text-ink-500 max-w-prose">
            Artículos, precios por grado, telas, bajas y dibujos técnicos — todo del feed del
            fabricante. Se actualiza solo cada noche; este botón es para traerlo ahora.
          </p>
        </div>
        <button
          type="button" onClick={syncAll} disabled={busy}
          className="btn-primary shrink-0"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Sincronizar
        </button>
      </header>

      <FeedState feed={feed} sync={sync} />

      {busy && step ? <p className="text-xs text-ink-500">{step}</p> : null}

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-rose-700">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          {error}
        </p>
      ) : null}

      {result ? <RunResult r={result} /> : null}

      <div>
        <button
          type="button" onClick={() => setLinkOpen((v) => !v)} disabled={busy}
          className="btn-ghost text-xs"
        >
          <KeyRound className="size-4" />
          {feed?.ok ? 'Cambiar enlace del feed' : 'Configurar enlace del feed'}
        </button>
      </div>

      {linkOpen ? (
        <div className="surface-subtle p-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="label">Enlace del feed «Étiquette»</span>
            <input
              type="url" value={link} onChange={(e) => setLink(e.target.value)}
              placeholder="https://etiq.grouperoset.net/TOKEN/"
              className="input" autoComplete="off" spellCheck="false"
            />
          </label>
          <p className="text-xs text-ink-500">
            El enlace incluye el token y vale por todo el catálogo, así que se guarda como una
            credencial: se escribe pero no se vuelve a leer desde la app.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary text-xs" onClick={saveLink} disabled={!link.trim() || busy}>
              Guardar
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => { setLinkOpen(false); setLink(''); }}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Where the run is, in the dealer's terms — the server names the phase it is
 * about to do, so a long sync says "copiando dibujos" rather than spinning.
 */
function stepLabel(out, total) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  if (out.phase === 'catalog') {
    const p = out.progress;
    return p ? `Escribiendo el catálogo… ${n(p.at)} de ${n(p.of)} SKU` : 'Leyendo el catálogo…';
  }
  if (out.phase === 'book') return 'Telas y cambios de Roset…';
  if (out.phase === 'images') {
    return total.remaining
      ? `Copiando dibujos… faltan ${n(total.remaining)}`
      : 'Copiando dibujos…';
  }
  return 'Terminando…';
}

/** What the feed says now, and what the last run did. */
function FeedState({ feed, sync }) {
  if (!feed && !sync) return null;
  const modified = feed?.files?.article?.modified || null;
  const upToDate = modified && sync?.feedModified && modified === sync.feedModified;

  return (
    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-sm">
      <Row label="Feed">
        {feed?.ok === undefined ? '—'
          : feed.ok
            ? <span className="text-emerald-700">Accesible</span>
            : <span className="text-rose-700">No responde</span>}
      </Row>
      <Row label="Publicado por Roset">{modified || '—'}</Row>
      <Row label="Última sincronización">
        {sync?.lastRunAt ? new Date(sync.lastRunAt).toLocaleString('es-DO') : 'Nunca'}
      </Row>
      <Row label="Catálogo">
        {sync == null ? '—'
          : sync.lastOk === false
            ? <span className="text-rose-700">{sync.lastError || 'Falló'}</span>
            : upToDate
              ? <span className="text-emerald-700">Al día</span>
              : <span>{(sync.lastWritten ?? 0).toLocaleString('en-US')} SKU</span>}
      </Row>
    </dl>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-100 py-1">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** What the run actually did — one line, then only what needs a human. */
function RunResult({ r }) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');

  // Roset publishes once a week or so; most presses land on a day when there is
  // genuinely nothing to bring down. Saying that is a better answer than
  // "0 SKU · 0 telas", which reads like a failure.
  if (r.upToDate) {
    return (
      <p className="flex items-start gap-2 text-sm surface-subtle p-3">
        <CheckCircle2 className="size-4 text-emerald-700 shrink-0 mt-0.5" />
        <span>Ya estaba al día: Roset no ha publicado nada nuevo y no faltan dibujos.</span>
      </p>
    );
  }

  return (
    <div className="surface-subtle p-3 flex flex-col gap-2 text-sm">
      <p className="flex items-start gap-2">
        <CheckCircle2 className="size-4 text-emerald-700 shrink-0 mt-0.5" />
        <span>
          {n(r.products)} SKU · {n(r.fabrics?.created)} telas nuevas
          {r.fabrics?.updated ? `, ${n(r.fabrics.updated)} actualizadas` : ''} · {n(r.mirrored)} dibujos
          {r.deactivated ? ` · ${n(r.deactivated)} retirados por Roset` : ''}
          {r.priceMoves ? ` · ${n(r.priceMoves)} cambios de precio` : ''}
        </span>
      </p>

      {r.remaining ? (
        <p className="text-ink-500">
          Quedan {n(r.remaining)} dibujos; se terminan de copiar esta noche.
        </p>
      ) : null}

      {r.fabrics?.colorsDeduped ? (
        <p className="text-ink-500">
          {n(r.fabrics.colorsDeduped)} colores repetidos unificados: Roset escribe algunos códigos
          con cero inicial («0973») y el libro los tenía sin él («973»), así que la misma tela
          figuraba dos veces.
        </p>
      ) : null}

      {r.ungradable?.length ? (
        <p className="text-ink-500">
          {r.ungradable.length} códigos tarifan por grado pero su referencia no admite la letra
          ({r.ungradable.slice(0, 4).join(', ')}{r.ungradable.length > 4 ? '…' : ''}). Se omiten a propósito.
        </p>
      ) : null}

      {r.errors?.length ? (
        <p className="text-rose-700">{r.errors.join(' · ')}</p>
      ) : null}
    </div>
  );
}
