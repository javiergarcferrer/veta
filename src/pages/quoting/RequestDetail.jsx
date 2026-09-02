import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, MessageCircle, Mail, FileDown, Loader2, Send, Check, Trash2,
  RotateCcw, Store, AlertTriangle, FileText,
} from 'lucide-react';
import { db, invalidate } from '../../db/database.js';
import { resolveRequestDetail } from '../../core/quote/index.js';
import { planToDxf } from '../../lib/configurator/planToDxf.js';
import { planPlacements } from '../../lib/configurator/planPreview.js';
import { downloadText } from '../../lib/csv.js';
import { formatDateTime } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import CompositionView from '../../components/quote/CompositionView.jsx';
import { fetchRequestDetail, createQuoteFromRequest } from './api.js';

/**
 * ONE web request, opened — the screen the Solicitudes list points at.
 *
 * Everything money-bearing on this page comes PRICED from the server
 * (`togo-embed` → priceRequestRows → priceInboxItems): the same rules the
 * visitor's widget priced their build with and the same numbers that dealer's
 * own inbox reads. This page never multiplies anything; it renders a VM
 * (`resolveRequestDetail`) over that payload.
 *
 * From here the lead goes one of three ways: it becomes a QUOTE (frozen
 * server-side, one tap), it gets marked contacted, or it is set aside.
 */

const TONE = {
  neutral: 'border-ink-200 text-ink-500',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-brand-200 bg-brand-50 text-brand-700',
  bad: 'border-rose-200 bg-rose-50 text-rose-700',
};

function StatusPill({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-micro ${TONE[status.tone] || TONE.neutral}`}>
      {status.label}
    </span>
  );
}

export default function RequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | error
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setPayload(await fetchRequestDetail(id));
      setState('ready');
    } catch (e) {
      setError(e?.message || 'No se pudo abrir la solicitud.');
      setState('error');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const vm = useMemo(() => resolveRequestDetail(payload), [payload]);

  // Triage writes go straight to the row (RLS-backed, like the list) and then
  // re-read the priced payload, so the screen can never show a stale state.
  const setStatus = useCallback(async (status) => {
    setBusy(status);
    setError('');
    try {
      await db.configuratorRequests.update(id, { status, updatedAt: Date.now() });
      await load();
    } catch (e) {
      setError(e?.message || 'No se pudo actualizar la solicitud.');
    } finally {
      setBusy('');
    }
  }, [id, load]);

  // THE FREEZE: the server prices the build one last time, writes the document,
  // and stamps this request converted. Idempotent — a second tap opens the quote
  // that already exists instead of minting another number.
  const quoteIt = useCallback(async () => {
    setBusy('quote');
    setError('');
    try {
      const { quote } = await createQuoteFromRequest(id);
      invalidate('configuratorRequests');
      navigate(`/cotizaciones/${quote.id}`);
    } catch (e) {
      setError(e?.message || 'No se pudo crear la cotización.');
      setBusy('');
    }
  }, [id, navigate]);

  const downloadDxf = useCallback(() => {
    if (!vm) return;
    const dxf = planToDxf(planPlacements(vm.models, vm.planItems), { label: 'Togo' });
    downloadText(`solicitud-${String(vm.id).slice(0, 8)}.dxf`, dxf);
  }, [vm]);

  if (state === 'loading' && !vm) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" aria-hidden /> Cargando la solicitud…
      </div>
    );
  }
  if (!vm) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-3">
        <div className="font-display text-lg font-semibold">No se pudo abrir la solicitud</div>
        <p className="text-sm text-ink-500">{error || 'La solicitud no existe o fue eliminada.'}</p>
        <Link to="/solicitudes" className="btn-secondary text-sm inline-flex">Volver a Solicitudes</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link to="/solicitudes" className="btn-ghost text-xs text-ink-500">
          <ArrowLeft size={14} aria-hidden /> Solicitudes
        </Link>
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro ${vm.dealer.isDirect ? TONE.neutral : TONE.info}`}>
            <Store size={11} aria-hidden /> {vm.dealer.name}
          </span>
          <StatusPill status={vm.status} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-4 items-start">
        {/* ── The build ─────────────────────────────────────────────────── */}
        <div className="space-y-4 min-w-0">
          <div className="card overflow-hidden">
            <CompositionView
              snapshotUrl={vm.snapshotUrl}
              models={vm.models}
              planItems={vm.planItems}
              placed={vm.placed}
              alt={`Composición de ${vm.contact.name}`}
              className="bg-ink-50/40 border-b border-ink-100"
            />
            <div className="card-pad space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display font-semibold text-sm">Piezas</h2>
                <span className="text-micro text-ink-500 tabular-nums">
                  {vm.totals.pieces} pieza{vm.totals.pieces === 1 ? '' : 's'}
                </span>
              </div>

              <div className="divide-y divide-ink-100 border-y border-ink-100">
                {vm.pieces.map((piece) => (
                  <div key={piece.id} className="py-2.5 flex items-start gap-3">
                    {piece.code
                      ? <img src={swatchUrl(piece.code)} alt="" loading="lazy" decoding="async" className="w-9 h-9 rounded-md object-cover border border-ink-100 shrink-0" />
                      : <div className="w-9 h-9 rounded-md bg-ink-100 shrink-0" aria-hidden />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink-900 truncate">{piece.name}</div>
                      <div className="text-micro text-ink-500 truncate">
                        {[piece.dims, piece.fabric].filter(Boolean).join(' · ')}
                      </div>
                      {piece.parts.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {piece.parts.map((part) => (
                            <li key={part.role} className="text-micro text-ink-500 flex items-center gap-1.5">
                              {part.code && <img src={swatchUrl(part.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 rounded-sm object-cover" />}
                              <span className="truncate">{part.label}: {part.fabric || '—'}</span>
                              {piece.complete && <span className="text-ink-400">· incluido</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {piece.finishes.length > 0 && (
                        <div className="mt-0.5 text-micro text-ink-500 truncate">
                          {piece.finishes.map((f) => f.label).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {piece.unpriced ? (
                        <span className="text-micro text-amber-700">sin precio</span>
                      ) : (
                        <span className="text-sm tabular-nums text-ink-900">{piece.priceLabel}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-baseline justify-between">
                <span className="eyebrow">Total</span>
                <span className="text-lg font-semibold tabular-nums">
                  {vm.totals.totalLabel || '—'}
                </span>
              </div>
              {vm.totals.estimate != null && (
                <p className="text-micro text-ink-500">
                  El cliente vio un estimado de {vm.totals.estimateLabel} al enviar su diseño.
                </p>
              )}
              {vm.totals.unpriced > 0 && (
                <p className="text-micro text-amber-700 flex items-start gap-1.5">
                  <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
                  {vm.totals.unpriced} pieza{vm.totals.unpriced === 1 ? '' : 's'} sin precio: la tela elegida no está en la
                  lista de precios de ese modelo.
                </p>
              )}

              <div className="flex justify-end">
                <button type="button" onClick={downloadDxf} className="btn-ghost text-xs text-ink-600" title="Descargar el plano en CAD (DXF)">
                  <FileDown size={14} aria-hidden /> Plano DXF
                </button>
              </div>
            </div>
          </div>

          {vm.note && (
            <div className="card card-pad">
              <h2 className="font-display font-semibold text-sm mb-1.5">Nota del cliente</h2>
              <p className="text-sm text-ink-600 whitespace-pre-wrap">{vm.note}</p>
            </div>
          )}
        </div>

        {/* ── Who, when, and what happens next ──────────────────────────── */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <div>
              <div className="font-display font-semibold text-base">{vm.contact.name}</div>
              <div className="text-micro text-ink-500">{formatDateTime(vm.createdAt ? Date.parse(vm.createdAt) : null)}</div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {vm.contact.phone && (
                <a href={`https://wa.me/${vm.contact.phoneDigits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
                  <MessageCircle size={13} className="text-emerald-600" aria-hidden /> {vm.contact.phone}
                </a>
              )}
              {vm.contact.email && (
                <a href={`mailto:${vm.contact.email}`} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
                  <Mail size={13} className="text-ink-500" aria-hidden /> <span className="truncate max-w-[150px]">{vm.contact.email}</span>
                </a>
              )}
            </div>

            {error && <p className="text-micro text-rose-600 dark:text-rose-400" role="alert">{error}</p>}

            {vm.quote && (
              <Link
                to={`/cotizaciones/${vm.quote.id}`}
                className={`${vm.actions.requoting ? 'btn-secondary' : 'btn-primary'} text-xs w-full justify-center`}
              >
                <FileText size={14} aria-hidden /> Ver cotización #{vm.quote.number}
              </Link>
            )}
            {(!vm.quote || vm.actions.requoting) && (
              <>
                <button
                  type="button"
                  onClick={quoteIt}
                  disabled={!!busy || !vm.actions.canQuote}
                  title={vm.actions.quoteBlocked || 'Crear la cotización con los precios de hoy y congelarla'}
                  className="btn-primary text-xs w-full justify-center disabled:opacity-50"
                >
                  {busy === 'quote' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
                  {vm.actions.requoting ? 'Cotizar de nuevo' : 'Pasar a cotización'}
                </button>
                {vm.actions.quoteBlocked && <p className="text-micro text-ink-500">{vm.actions.quoteBlocked}</p>}
                {vm.actions.requoting && (
                  <p className="text-micro text-ink-500">
                    La cotización anterior quedó rechazada: esta crea un documento nuevo con los precios de hoy.
                  </p>
                )}
              </>
            )}

            <div className="flex flex-wrap gap-1.5">
              {vm.actions.canContact && (
                <button type="button" onClick={() => setStatus('contacted')} disabled={!!busy} className="btn-secondary text-xs grow disabled:opacity-40">
                  <Check size={14} aria-hidden /> Contactado
                </button>
              )}
              {vm.actions.canReopen && (
                <button type="button" onClick={() => setStatus('pending')} disabled={!!busy} className="btn-secondary text-xs grow disabled:opacity-40">
                  <RotateCcw size={14} aria-hidden /> Reabrir
                </button>
              )}
              {vm.actions.canDismiss && (
                <button type="button" onClick={() => setStatus('dismissed')} disabled={!!busy} className="btn-ghost text-xs text-ink-500 grow disabled:opacity-40">
                  <Trash2 size={14} aria-hidden /> Descartar
                </button>
              )}
            </div>
          </div>

          {vm.fabrics.length > 0 && (
            <div className="card card-pad">
              <h2 className="font-display font-semibold text-sm mb-2">Telas elegidas</h2>
              <div className="flex flex-wrap gap-1.5">
                {vm.fabrics.map((f) => (
                  <span key={f.fabric} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2 py-0.5 text-micro">
                    {f.code && <img src={swatchUrl(f.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 rounded-sm object-cover" />}
                    <span className="truncate max-w-[150px]">{f.fabric}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="card card-pad">
            <h2 className="font-display font-semibold text-sm mb-2">Seguimiento</h2>
            <ol className="space-y-2">
              {vm.timeline.map((step) => (
                <li key={step.key} className="flex items-start gap-2.5">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-ink-300 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-xs text-ink-800">{step.label}</div>
                    <div className="text-micro text-ink-500">{formatDateTime(step.at ? Date.parse(step.at) : null)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
