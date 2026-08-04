import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { resolveQuoteDoc } from '../../core/quote/index.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import CompositionView from '../../components/quote/CompositionView.jsx';
import { fetchPublicQuote } from './api.js';

/**
 * THE CUSTOMER'S QUOTE — public, login-less, read-only (route `#/q/<token>`).
 *
 * The token in the URL is the whole authorization: the `togo-embed` Edge
 * Function resolves it with the service role and answers with ONE quote's
 * whitelisted bundle (no ids, no contact details, no token echoed back). This
 * page has no session, no table access and no write of any kind.
 *
 * What it renders is `resolveQuoteDoc` — the SAME ViewModel the manufacturer's
 * own quote screen renders, which is what keeps the two from drifting — in the
 * BRAND's language, with the brand's identity at the top.
 *
 * Look: the dealer's paper on a customer's device. White ground, near-black ink,
 * hairline rules, no cards, no chrome — the same editorial register as the
 * distributor inbox, and forced light like every public surface (`#/q/` is
 * already in `isPublicRoute`, so the theme boot script never darkens it).
 */

const EYEBROW = 'text-[11px] uppercase tracking-[0.15em] text-neutral-500';

export default function QuoteShare() {
  const { token } = useParams();
  const [payload, setPayload] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | error

  useEffect(() => {
    let active = true;
    setState('loading');
    fetchPublicQuote(token)
      .then((data) => { if (active) { setPayload(data); setState('ready'); } })
      .catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [token]);

  const doc = useMemo(
    () => (payload?.quote
      ? resolveQuoteDoc({ quote: payload.quote, brand: payload.brand, models: payload.models || {} })
      : null),
    [payload],
  );

  // Title the tab like the other public links; restore on unmount so the app's
  // own title isn't left overwritten.
  useEffect(() => {
    if (!doc) return undefined;
    const prev = document.title;
    document.title = `${doc.title}${doc.brand?.name ? ` — ${doc.brand.name}` : ''}`;
    return () => { document.title = prev; };
  }, [doc]);

  if (state === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex items-center justify-center bg-white">
        <span className={EYEBROW}>Cargando…</span>
      </div>
    );
  }
  if (state === 'error' || !doc) {
    return (
      <div className="h-full flex items-center justify-center bg-white px-6">
        <p className={`${EYEBROW} max-w-xs text-center leading-relaxed`}>
          Este enlace ya no está disponible.
        </p>
      </div>
    );
  }

  const dateFmt = new Intl.DateTimeFormat(doc.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const quoteDate = doc.dates.createdAt ? dateFmt.format(new Date(doc.dates.createdAt)) : '';

  return (
    <div className="h-full overflow-y-auto scroll-thin bg-white text-neutral-900">
      <div className="max-w-3xl mx-auto px-6 sm:px-10 pb-[max(4rem,env(safe-area-inset-bottom))]">
        {/* Brand lockup — the identity this quote was made under. */}
        <header className="pt-10 sm:pt-14 pb-8 border-b border-neutral-200">
          {doc.brand?.logoUrl
            ? <img src={doc.brand.logoUrl} alt={doc.brand.name} className="h-10 sm:h-12 w-auto select-none" draggable={false} />
            : <div className="font-display text-xl tracking-tight">{doc.brand?.name}</div>}
          <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h1 className="text-2xl sm:text-3xl font-light tracking-tight leading-tight">{doc.title}</h1>
            {quoteDate && <span className={EYEBROW}>{quoteDate}</span>}
          </div>
          {doc.customerName && (
            <p className={`${EYEBROW} mt-2 normal-case tracking-normal text-neutral-500`}>
              {doc.labels.preparedFor} {doc.customerName}
            </p>
          )}
        </header>

        {/* What they built. */}
        <CompositionView
          snapshotUrl={doc.snapshotUrl}
          models={doc.models}
          planItems={doc.planItems}
          alt={doc.labels.plan}
          className="mt-8 border border-neutral-200 bg-white"
        />

        {/* The pieces — one hairline row each, exactly as the dealer sees them. */}
        <div className="mt-10">
          <div className={`${EYEBROW} pb-3`}>{doc.labels.pieces}</div>
          <div className="border-t border-neutral-200">
            {doc.lines.map((line) => (
              <div key={line.id} className="flex items-start gap-4 py-4 border-b border-neutral-200">
                {line.code
                  ? <img src={swatchUrl(line.code)} alt="" loading="lazy" decoding="async" className="w-10 h-10 object-cover bg-neutral-100 shrink-0" />
                  : <div className="w-10 h-10 bg-neutral-100 shrink-0" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="text-base leading-snug">{line.name}</div>
                  {(line.dims || line.fabric) && (
                    <div className="mt-0.5 text-[11px] tracking-wide text-neutral-500">
                      {[line.dims, line.fabric].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {line.parts.map((part) => (
                    <div key={part.role} className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
                      {part.code && <img src={swatchUrl(part.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 object-cover bg-neutral-100" />}
                      <span className="truncate">{part.label}: {part.fabric || '—'}</span>
                      {/* «Incluido»: this piece bills as ONE complete element, so
                          its componentes are listed but not charged again. */}
                      {line.complete && <span className="text-neutral-400">· {line.completeLabel}</span>}
                    </div>
                  ))}
                  {line.finishes.length > 0 && (
                    <div className="mt-1 text-[11px] text-neutral-400">
                      {line.finishes.map((f) => f.label).join(' · ')}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-sm tabular-nums text-right">
                  {line.unpriced
                    ? <span className="text-[11px] text-neutral-400">{line.unpricedLabel}</span>
                    : line.totalLabel}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* The total. */}
        <div className="mt-6 flex items-baseline justify-between border-t border-neutral-200 pt-5">
          <span className={EYEBROW}>{doc.totals.label}</span>
          <span className="text-2xl sm:text-3xl font-light tracking-tight tabular-nums">
            {doc.totals.totalLabel || '—'}
          </span>
        </div>
        <div className={`${EYEBROW} mt-2 normal-case tracking-normal text-neutral-400`}>
          {doc.totals.piecesLabel} · {doc.totals.currency}
        </div>

        {doc.note && (
          <div className="mt-10">
            <div className={`${EYEBROW} mb-2`}>{doc.labels.note}</div>
            <p className="text-sm leading-relaxed text-neutral-600 whitespace-pre-wrap">{doc.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}
