import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Copy, Check, Eye, EyeOff, ExternalLink, Inbox, Lock, AlertTriangle,
} from 'lucide-react';
import { resolveQuoteDoc, quoteShareUrl } from '../../core/quote/index.js';
import { formatDateTime } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import CompositionView from '../../components/quote/CompositionView.jsx';
import { fetchQuote, setQuoteStatus, setQuoteShare } from './api.js';

/**
 * ONE quote, from the manufacturer's side.
 *
 * The document itself is rendered from `resolveQuoteDoc` — the SAME VM the
 * customer's `#/q/<token>` page renders, so what the dealer reviews here and
 * what the customer opens can never be two different documents. Around it sits
 * the chrome only this side gets: the state actions, the customer link, and the
 * lead it came from.
 *
 * Everything money-bearing is READ-ONLY and says so. A quote's prices were
 * frozen when it was created; there is no edit affordance here because there is
 * no edit path anywhere — the database itself rejects one (migration
 * 20261130000000). The way to correct a quote is to mark it RECHAZADA and quote
 * its lead again: a new document, a new number, today's prices, and the old one
 * still on the record.
 */

const TONE = {
  neutral: 'border-ink-200 text-ink-500',
  info: 'border-brand-200 bg-brand-50 text-brand-700',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  bad: 'border-rose-200 bg-rose-50 text-rose-700',
};

const NEXT_STATUS = [
  { key: 'sent', label: 'Marcar enviada' },
  { key: 'accepted', label: 'Aceptada' },
  { key: 'declined', label: 'Rechazada' },
  { key: 'draft', label: 'Volver a borrador' },
];

export default function QuoteDetail() {
  const { id } = useParams();
  const [payload, setPayload] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setPayload(await fetchQuote(id));
      setState('ready');
    } catch (e) {
      setError(e?.message || 'No se pudo abrir la cotización.');
      setState('error');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const quote = payload?.quote || null;
  // The manufacturer reads the document in the app's own language; the customer
  // reads it in the brand's (resolveQuoteDoc follows `brand.locale` there).
  const doc = useMemo(
    () => (quote ? resolveQuoteDoc({ quote, models: payload?.models || {}, locale: 'es' }) : null),
    [quote, payload],
  );

  const shareUrl = quote?.shareToken ? quoteShareUrl(quote.shareToken) : '';

  const advance = useCallback(async (status) => {
    setBusy(status);
    setError('');
    try {
      const res = await setQuoteStatus(id, status);
      setPayload((prev) => ({ ...prev, quote: res.quote }));
    } catch (e) {
      setError(e?.message || 'No se pudo cambiar el estado.');
    } finally {
      setBusy('');
    }
  }, [id]);

  const toggleShare = useCallback(async () => {
    setBusy('share');
    setError('');
    try {
      const res = await setQuoteShare(id, !quote.shareEnabled);
      setPayload((prev) => ({ ...prev, quote: res.quote }));
    } catch (e) {
      setError(e?.message || 'No se pudo cambiar el enlace.');
    } finally {
      setBusy('');
    }
  }, [id, quote]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('No se pudo copiar; selecciona el enlace y cópialo a mano.');
    }
  }, [shareUrl]);

  if (state === 'loading' && !doc) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" aria-hidden /> Cargando la cotización…
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-3">
        <div className="font-display text-lg font-semibold">No se pudo abrir la cotización</div>
        <p className="text-sm text-ink-500">{error || 'La cotización no existe.'}</p>
        <Link to="/cotizaciones" className="btn-secondary text-sm inline-flex">Volver a Cotizaciones</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link to="/cotizaciones" className="btn-ghost text-xs text-ink-500">
          <ArrowLeft size={14} aria-hidden /> Cotizaciones
        </Link>
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] ${TONE[doc.status.tone] || TONE.neutral}`}>
          {doc.status.label}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-4 items-start">
        {/* ── The document ─────────────────────────────────────────────── */}
        <div className="card overflow-hidden min-w-0">
          <CompositionView
            snapshotUrl={doc.snapshotUrl}
            models={doc.models}
            planItems={doc.planItems}
            alt={`Composición de ${doc.customerName}`}
            className="bg-ink-50/40 border-b border-ink-100"
          />
          <div className="card-pad space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <h1 className="font-display font-semibold text-base">{doc.title}</h1>
                <p className="text-[11px] text-ink-500">
                  {doc.labels.preparedFor} {doc.customerName} · {formatDateTime(doc.dates.createdAt ? Date.parse(doc.dates.createdAt) : null)}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 text-[10px] text-ink-400" title="Los precios de una cotización no se editan: se congelan al crearla.">
                <Lock size={11} aria-hidden /> Precios congelados
              </span>
            </div>

            <div className="divide-y divide-ink-100 border-y border-ink-100">
              {doc.lines.map((line) => (
                <div key={line.id} className="py-2.5 flex items-start gap-3">
                  {line.code
                    ? <img src={swatchUrl(line.code)} alt="" loading="lazy" decoding="async" className="w-9 h-9 rounded-md object-cover border border-ink-100 shrink-0" />
                    : <div className="w-9 h-9 rounded-md bg-ink-100 shrink-0" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink-900 truncate">{line.name}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {[line.dims, line.fabric].filter(Boolean).join(' · ')}
                    </div>
                    {line.parts.map((part) => (
                      <div key={part.role} className="mt-0.5 text-[11px] text-ink-500 flex items-center gap-1.5">
                        {part.code && <img src={swatchUrl(part.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 rounded-sm object-cover" />}
                        <span className="truncate">{part.label}: {part.fabric || '—'}</span>
                        {line.complete && <span className="text-ink-400">· {line.completeLabel}</span>}
                      </div>
                    ))}
                    {line.finishes.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-ink-400 truncate">
                        {line.finishes.map((f) => f.label).join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 text-[13px] tabular-nums">
                    {line.unpriced
                      ? <span className="text-[11px] text-amber-700">{line.unpricedLabel}</span>
                      : line.totalLabel}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-wide text-ink-500">{doc.totals.label}</span>
              <span className="text-xl font-semibold tabular-nums">{doc.totals.totalLabel || '—'}</span>
            </div>
            {doc.totals.unpriced > 0 && (
              <p className="text-[11px] text-amber-700 flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
                {doc.totals.unpriced} pieza{doc.totals.unpriced === 1 ? '' : 's'} quedó sin precio en esta cotización.
              </p>
            )}
            {doc.note && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">{doc.labels.note}</div>
                <p className="text-[13px] text-ink-600 whitespace-pre-wrap">{doc.note}</p>
              </div>
            )}
          </div>
        </div>

        {/* ── The chrome ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <h2 className="font-display font-semibold text-sm">Enlace para el cliente</h2>
            {quote.shareEnabled && shareUrl ? (
              <>
                <div className="flex items-center gap-1.5">
                  <input readOnly value={shareUrl} className="input h-9 text-[11px] flex-1 select-text" aria-label="Enlace del cliente" />
                  <button type="button" onClick={copyLink} className="btn-secondary text-xs shrink-0" title="Copiar el enlace">
                    {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                  </button>
                  <a href={shareUrl} target="_blank" rel="noreferrer" className="btn-ghost text-xs shrink-0" title="Abrir como lo ve el cliente">
                    <ExternalLink size={14} aria-hidden />
                  </a>
                </div>
                <p className="text-[11px] text-ink-500">
                  {quote.viewCount > 0
                    ? `El cliente lo abrió ${quote.viewCount} ${quote.viewCount === 1 ? 'vez' : 'veces'} · primera vez ${formatDateTime(quote.firstViewedAt ? Date.parse(quote.firstViewedAt) : null)}`
                    : 'El cliente todavía no lo ha abierto.'}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-ink-500">
                El enlace está desactivado: quien lo tenga ya no puede abrir la cotización.
              </p>
            )}
            <button type="button" onClick={toggleShare} disabled={!!busy} className="btn-ghost text-xs text-ink-500 disabled:opacity-40">
              {busy === 'share'
                ? <Loader2 size={14} className="animate-spin" aria-hidden />
                : (quote.shareEnabled ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />)}
              {quote.shareEnabled ? 'Desactivar el enlace' : 'Activar el enlace'}
            </button>
          </div>

          <div className="card card-pad space-y-2">
            <h2 className="font-display font-semibold text-sm">Estado</h2>
            {error && <p className="text-[11px] text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
            <div className="flex flex-wrap gap-1.5">
              {NEXT_STATUS.filter((s) => s.key !== doc.status.key).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => advance(s.key)}
                  disabled={!!busy}
                  className={`text-xs grow disabled:opacity-40 ${s.key === 'sent' ? 'btn-primary' : 'btn-secondary'}`}
                >
                  {busy === s.key && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  {s.label}
                </button>
              ))}
            </div>
            <ul className="pt-1 space-y-1 text-[11px] text-ink-500">
              {doc.dates.sentAt && <li>Enviada · {formatDateTime(Date.parse(doc.dates.sentAt))}</li>}
              {doc.dates.acceptedAt && <li>Aceptada · {formatDateTime(Date.parse(doc.dates.acceptedAt))}</li>}
              {doc.dates.declinedAt && <li>Rechazada · {formatDateTime(Date.parse(doc.dates.declinedAt))}</li>}
            </ul>
          </div>

          <div className="card card-pad space-y-2">
            <h2 className="font-display font-semibold text-sm">Cliente</h2>
            <div className="text-[13px] text-ink-900">{quote.customer?.name || '—'}</div>
            {quote.customer?.phone && <div className="text-[12px] text-ink-600">{quote.customer.phone}</div>}
            {quote.customer?.email && <div className="text-[12px] text-ink-600 break-all">{quote.customer.email}</div>}
            {quote.brandName && <div className="text-[11px] text-ink-400 pt-1">Cotizada como {quote.brandName}</div>}
            {quote.requestId && (
              <Link to={`/solicitudes/${quote.requestId}`} className="btn-ghost text-xs text-ink-500 mt-1">
                <Inbox size={14} aria-hidden /> Ver la solicitud original
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
