/**
 * THE ESTIMATE DECK — the number, the pending count, and the one CTA.
 *
 * It renders three states that must never blur into each other (see
 * `vm/pricing`): a real total, "some pieces still need a fabric" (those pieces
 * are NOT in the total), and a brand that shows no prices at all — where the
 * CTA still reads "request a quote", because a request-a-quote brand converts
 * exactly the same way.
 *
 * The submit CTA is disabled by an `error`-severity rule violation, and the
 * panel says why: a dead button with no explanation is indistinguishable from a
 * broken one.
 */

import { t, type Locale } from '@veta/i18n';
import { formatMoney, type Estimate } from '../vm/pricing.ts';
import { piecesLabel } from '@veta/i18n';

export interface EstimateDeckProps {
  estimate: Estimate;
  locale: Locale;
  canSubmit: boolean;
  blockedReason: string;
  onRequestQuote: () => void;
  onFabricForAll: () => void;
}

export default function EstimateDeck({
  estimate, locale, canSubmit, blockedReason, onRequestQuote, onFabricForAll,
}: EstimateDeckProps) {
  const hasPieces = estimate.pieces > 0;

  return (
    <aside className="deck" aria-label={t(locale, 'estimate.label')}>
      <div className="deck__figures">
        <span className="deck__count">{piecesLabel(locale, estimate.pieces)}</span>
        {/* A build carrying an unpriceable piece has NO total to state: the sum
            would be short by whatever that piece is worth, and a confident
            figure is exactly the wrong thing to show. It says so instead. */}
        {estimate.visible && estimate.unpriced > 0 ? (
          <strong className="deck__total deck__total--none">
            <span className="deck__label">{t(locale, 'estimate.label')}</span>
            {t(locale, 'summary.noPrice')}
          </strong>
        ) : null}
        {estimate.visible && estimate.unpriced === 0 && estimate.total != null ? (
          <strong className="deck__total">
            <span className="deck__label">{t(locale, 'estimate.label')}</span>
            {formatMoney(estimate.total, estimate.currency, locale)}
          </strong>
        ) : null}
      </div>

      {estimate.pending > 0 ? (
        <button type="button" className="deck__pending" onClick={onFabricForAll}>
          {t(locale, 'estimate.pendingFabric', { count: estimate.pending })}
          <span className="deck__hint">{t(locale, 'estimate.chooseFabricAll')}</span>
        </button>
      ) : null}

      {!canSubmit && hasPieces ? <p className="deck__blocked">{blockedReason}</p> : null}

      <button
        type="button"
        className="btn btn--primary"
        disabled={!hasPieces || !canSubmit}
        onClick={onRequestQuote}
      >
        {t(locale, 'estimate.cta')}
      </button>
    </aside>
  );
}
