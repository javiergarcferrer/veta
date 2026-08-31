import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Loader2, Search, Eye, Link2, AlertTriangle, Plus } from 'lucide-react';
import { resolveQuotesBoard } from '../../core/quote/index.js';
import { formatDate } from '../../lib/format.js';
import { configuratorShareUrl } from '../../lib/configuratorEmbed.js';
import EmptyState from '../../components/EmptyState.jsx';
import { fetchQuotes } from './api.js';

/**
 * Cotizaciones — every document this workspace has sent or is about to.
 *
 * A list of FROZEN quotes: each row's total is the number that quote was
 * created with, in the currency it was quoted in, and nothing on this screen can
 * recompute it (there is no rate here, and no op that would re-price one). The
 * mixed-currency consequence is deliberate and visible: there is no column
 * total, because adding a euro dealer's quote to a dollar one would be a
 * fabricated number.
 */

const TONE = {
  neutral: 'border-ink-200 text-ink-500',
  info: 'border-brand-200 bg-brand-50 text-brand-700',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  bad: 'border-rose-200 bg-rose-50 text-rose-700',
};

/** The composer IS the configurator: this opens it in a new tab, where the
 *  signed-in session shows «Crear cotización» on the summary form (the team
 *  door — pages/embed/ConfiguratorEmbed). The document then lands on this list. */
function NewQuoteButton() {
  return (
    <a
      href={configuratorShareUrl()}
      target="_blank"
      rel="noreferrer"
      className="btn-primary text-sm"
      title="Abre el configurador: diseña y toca «Crear cotización»"
    >
      <Plus size={14} aria-hidden /> Nueva cotización
    </a>
  );
}

export default function Quotes() {
  const [quotes, setQuotes] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await fetchQuotes();
      setQuotes(data?.quotes || []);
      setState('ready');
    } catch (e) {
      setError(e?.message || 'No se pudieron cargar las cotizaciones.');
      setState('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const board = useMemo(() => resolveQuotesBoard(quotes, { status: tab, query }), [quotes, tab, query]);

  if (state === 'loading' && !quotes.length) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" aria-hidden /> Cargando cotizaciones…
      </div>
    );
  }
  if (state === 'error' && !quotes.length) {
    return (
      <div className="max-w-lg mx-auto text-center py-16 space-y-3">
        <div className="font-display text-lg font-semibold">No se pudieron cargar las cotizaciones</div>
        <p className="text-sm text-ink-500">{error}</p>
        <button type="button" onClick={load} className="btn-secondary text-sm">Reintentar</button>
      </div>
    );
  }
  if (board.empty) {
    return (
      <EmptyState
        icon={FileText}
        title="Todavía no hay cotizaciones"
        description="Diseña en el configurador y toca «Crear cotización» — el documento nace aquí con sus precios congelados y su enlace para el cliente. Las solicitudes que llegan de visitantes también se pasan a cotización desde su detalle."
        action={<NewQuoteButton />}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-1.5 flex-wrap">
          {board.tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                tab === tb.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-500 hover:text-ink-800'
              }`}
            >
              {tb.label}
              <span className="tabular-nums text-ink-400">{tb.count}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
            <input
              className="input pl-8 h-9 text-sm w-56"
              placeholder="Buscar cliente o número…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Buscar cotizaciones"
            />
          </label>
          <NewQuoteButton />
        </div>
      </div>

      {board.noMatches ? (
        <p className="text-xs text-ink-400 py-8 text-center">Sin cotizaciones para este filtro.</p>
      ) : (
        <div className="card overflow-hidden">
          <div className="divide-y divide-ink-100">
            {board.rows.map((row) => (
              <Link
                key={row.id}
                to={`/cotizaciones/${row.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50/60 transition-colors"
              >
                <div className="w-14 shrink-0 text-[13px] tabular-nums text-ink-500">#{row.number}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink-900 truncate">{row.customerName}</div>
                  <div className="text-[11px] text-ink-500 truncate">
                    {[row.brandName, formatDate(row.createdAt ? Date.parse(row.createdAt) : null)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                  {row.unpriced > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-700" title={`${row.unpriced} pieza(s) sin precio`}>
                      <AlertTriangle size={11} aria-hidden /> {row.unpriced}
                    </span>
                  )}
                  {row.shared && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ink-400" title="Enlace del cliente activo">
                      <Link2 size={11} aria-hidden />
                    </span>
                  )}
                  {row.seen && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ink-500" title={`El cliente lo abrió ${row.viewCount} vez/veces`}>
                      <Eye size={11} aria-hidden /> {row.viewCount}
                    </span>
                  )}
                </div>
                <div className="w-28 text-right shrink-0 text-[13px] tabular-nums text-ink-900">
                  {row.totalLabel || '—'}
                </div>
                <span className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${TONE[row.status.tone] || TONE.neutral}`}>
                  {row.status.label}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
