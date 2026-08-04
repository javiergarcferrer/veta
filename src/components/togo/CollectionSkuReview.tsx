/**
 * REVISIÓN DE SKUs EN LOTE — what «Sugerir SKUs con Claude» opens over the model
 * table, and the only place a collection-wide binding can happen.
 *
 * It is a REVIEW, not an apply. Fifty pieces arrive with a proposed root each,
 * and NOTHING is written until the one button at the bottom is pressed
 * («proponer siempre», owner 2026-08) — the same rule the single-piece
 * SkuSuggestPanel obeys, at fifty times the blast radius.
 *
 * WHAT THE LAYOUT IS FOR (each of these is a way the dealer loses money if it
 * isn't on screen):
 *   • THE PRICE OF WHAT IS ABOUT TO BE BOUND, per row. The whole risk is two
 *     near-identical roots thousands of dollars apart — a review that shows a
 *     reference number and not a price is a review of nothing.
 *   • LOW CONFIDENCE LOOKS DIFFERENT. «baja» is an amber row that starts
 *     UNCHECKED; alta/media start accepted. Accepting fifty suggestions at once
 *     is exactly where an unsure one slips through unread.
 *   • A DUPLICATE IS FLAGGED, NEVER RESOLVED. Two pieces can legitimately share
 *     a catalog root (both «Armchair HighLegs» and «LowLegs» are 128×105); the
 *     row says so and the human decides.
 *   • «Cambiar» is a select over THAT PIECE's own admissible roots — the
 *     deterministic narrower's list, so a manual correction can no more cross a
 *     generation than the suggestion could.
 *   • The chunking log is printed. A batch that split into three calls says so;
 *     a suggestion missing in silence reads as «el catálogo no tiene nada».
 *
 * Pure View: every number here is `resolveCollectionReview` / `planCollectionBind`
 * (core/quote). This file renders and raises events.
 */
import { AlertCircle, Info, Link2, Loader2, Sparkles, X } from 'lucide-react';
import type { resolveCollectionReview } from '../../core/quote/index.js';
import Select from '../primitives/Select.jsx';

type Review = ReturnType<typeof resolveCollectionReview>;
export type ReviewRow = Review['rows'][number];

/** How loudly a row presents itself. `baja` is a colour the eye stops on — the
 *  point of showing a confidence is that the dealer can distrust it. */
const CONFIDENCE = {
  alta: { chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', label: 'Alta' },
  media: { chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', label: 'Media' },
  baja: { chip: 'bg-red-500/15 text-red-700 dark:text-red-300', label: 'Poco seguro' },
} as const;

const usdFrom = (n: number | null) => (n == null ? 'sin precio' : `desde US$${Math.round(n).toLocaleString('en-US')}`);

/** One option as the select renders it: reference, name and PRICE in one line,
 *  because the price is the difference the reviewer is actually judging. */
const optionLabel = (o: { root: string; name: string; fromUsd: number | null }) =>
  `${o.root} · ${o.name || 'sin nombre'} · ${usdFrom(o.fromUsd)}`;

export type Props = {
  /** The colección under review — just the header label. */
  collection: string;
  stage: 'waiting' | 'thinking' | 'done' | 'error';
  /** Lotes finished / total, so a chunked batch shows movement. */
  progress: { done: number; total: number };
  review: Review | null;
  /** Roots proposed for more than one piece — a warning, never auto-resolved. */
  duplicates: { root: string; modelIds: string[] }[];
  /** Rows the validators refused, with the reason. Reported, never silent. */
  dropped: { modelId: string | null; root: string | null; reason: string }[];
  /** Chunking + clamping notes from both sides of the wire. */
  log: string[];
  /** True when any lote fell back to the deterministic mapping. */
  degraded: boolean;
  error: string | null;
  thumbs: Record<string, string>;
  accepted: Set<string>;
  overrides: Record<string, string>;
  binding: boolean;
  onToggle: (modelId: string) => void;
  onToggleAll: (on: boolean) => void;
  onOverride: (modelId: string, root: string) => void;
  /** Clicking a row selects the piece, so the stage to the right shows it. */
  onSelect: (modelId: string) => void;
  onBind: () => void;
  onRetry: () => void;
  onClose: () => void;
};

export default function CollectionSkuReview({
  collection, stage, progress, review, duplicates, dropped, log, degraded, error,
  thumbs, accepted, overrides, binding,
  onToggle, onToggleAll, onOverride, onSelect, onBind, onRetry, onClose,
}: Props) {
  const rows = review?.rows || [];
  const counts = review?.counts;
  const rootOf = (r: ReviewRow) => (Object.prototype.hasOwnProperty.call(overrides, r.modelId) ? overrides[r.modelId] : r.root);
  // What the button is about to write — computed the same way `planCollectionBind`
  // will: accepted, with a root that is one of the piece's own options.
  const bindable = rows.filter((r) => accepted.has(r.modelId) && rootOf(r) && r.options.some((o) => o.root === rootOf(r)));
  const allOn = rows.length > 0 && rows.every((r) => accepted.has(r.modelId));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-brand-200 bg-surface dark:border-brand-900/50">
      {/* Header — stays put; the list below is the only scroller. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-200 px-3 py-2">
        <Sparkles size={14} className="shrink-0 text-brand-500" aria-hidden />
        <span className="text-xs font-medium text-ink-900">
          Sugerencia de SKUs{collection ? ` · ${collection}` : ''}
        </span>
        {counts && (
          <span className="text-[11px] tabular-nums text-ink-500">
            {counts.total} pieza{counts.total === 1 ? '' : 's'}
            {counts.alta > 0 && <> · <b className="text-emerald-600 dark:text-emerald-400">{counts.alta}</b> alta</>}
            {counts.media > 0 && <> · <b className="text-amber-600 dark:text-amber-400">{counts.media}</b> media</>}
            {counts.baja > 0 && <> · <b className="text-red-600 dark:text-red-400">{counts.baja}</b> poco seguras</>}
            {counts.sinSugerencia > 0 && <> · {counts.sinSugerencia} sin sugerencia</>}
          </span>
        )}
        <button type="button" onClick={onClose} disabled={binding} className="btn-ghost ml-auto text-[11px] disabled:opacity-50" title="Cerrar la revisión sin vincular nada">
          <X size={12} /> Cerrar
        </button>
      </div>

      {(stage === 'waiting' || stage === 'thinking') && (
        <p className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-ink-500">
          <Loader2 size={14} className="animate-spin" />
          {stage === 'waiting'
            ? 'Cargando el catálogo…'
            : progress.total > 1
              ? `Claude está mapeando la colección — lote ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…`
              : 'Claude está mapeando la colección…'}
        </p>
      )}

      {stage === 'error' && (
        <div className="space-y-2 px-3 py-8 text-center">
          <p role="alert" className="flex items-center justify-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle size={14} /> {error || 'No se pudo obtener la sugerencia.'}
          </p>
          <button type="button" onClick={onRetry} className="btn-secondary text-xs">Reintentar</button>
        </div>
      )}

      {stage === 'done' && (
        <>
          {/* Everything the batch did to itself, before the rows: a degrade, a
              split, a clamp, a refused row. None of it is allowed to be silent. */}
          {(degraded || duplicates.length > 0 || dropped.length > 0 || log.length > 1) && (
            <div className="shrink-0 space-y-1 border-b border-ink-100 bg-ink-50/60 px-3 py-2 text-[11px] leading-tight text-ink-500 dark:bg-ink-100/5">
              {degraded && (
                <p className="text-amber-600 dark:text-amber-400">
                  Claude no respondió a todo: las filas marcadas «sin Claude» vienen del cálculo determinista y no leyeron los nombres.
                </p>
              )}
              {duplicates.length > 0 && (
                <p className="text-amber-600 dark:text-amber-400">
                  {duplicates.length} referencia{duplicates.length === 1 ? '' : 's'} propuesta{duplicates.length === 1 ? '' : 's'} para más de una pieza
                  {' '}({duplicates.slice(0, 3).map((d) => d.root).join(' · ')}{duplicates.length > 3 ? ' …' : ''}).
                  {' '}Puede ser correcto — dos variantes publican bajo un mismo root — pero decídelo tú.
                </p>
              )}
              {dropped.length > 0 && (
                <p>
                  Se descartaron {dropped.length} fila{dropped.length === 1 ? '' : 's'} inválida{dropped.length === 1 ? '' : 's'} de la respuesta:
                  {' '}{[...new Set(dropped.map((d) => d.reason))].slice(0, 2).join(' ')}
                </p>
              )}
              {log.map((line, i) => <p key={i} className="flex items-start gap-1"><Info size={11} className="mt-0.5 shrink-0" aria-hidden />{line}</p>)}
            </div>
          )}

          {/* The list. Its own scroller so the header and the bind bar stay
              reachable with fifty rows under them. */}
          <div className="scroll-thin min-h-0 flex-1 overflow-auto overscroll-contain">
            <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-1.5">
              <input
                type="checkbox"
                checked={allOn}
                onChange={() => onToggleAll(!allOn)}
                aria-label={allOn ? 'Rechazar todas' : 'Aceptar todas'}
              />
              <span className="text-[11px] text-ink-500">
                {allOn ? 'Rechazar todas' : 'Aceptar todas'} · las «poco seguras» empiezan sin aceptar
              </span>
            </div>

            {rows.map((r) => {
              const root = rootOf(r);
              const picked = r.options.find((o) => o.root === root) || null;
              const conf = r.confidence ? CONFIDENCE[r.confidence] : null;
              const on = accepted.has(r.modelId);
              return (
                <div
                  key={r.modelId}
                  onClick={() => onSelect(r.modelId)}
                  className={`flex cursor-pointer items-start gap-2 border-b border-ink-100 px-3 py-2 last:border-b-0 hover:bg-ink-50/70 ${
                    r.confidence === 'baja' ? 'border-l-2 border-l-red-400/70' : r.root ? '' : 'border-l-2 border-l-ink-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={on}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggle(r.modelId)}
                    disabled={!root}
                    aria-label={`Aceptar la sugerencia para ${r.name || 'modelo'}`}
                  />
                  <div className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded bg-ink-50 text-ink-300">
                    {thumbs[r.modelId]
                      ? <img src={thumbs[r.modelId]} alt="" draggable={false} className="h-full w-full select-none object-contain" />
                      : <span className="text-[9px]">3D</span>}
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="truncate text-xs font-medium text-ink-900" title={r.name}>{r.name || 'Sin nombre'}</span>
                      <span className="text-[10px] tabular-nums text-ink-400">
                        {Math.round(r.widthCm || 0)}×{Math.round(r.depthCm || 0)} cm
                      </span>
                      {conf && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${conf.chip}`}>{conf.label}</span>}
                      {r.source === 'fallback' && (
                        <span className="rounded-full bg-ink-200 px-1.5 py-0.5 text-[9px] text-ink-600">sin Claude</span>
                      )}
                      {r.duplicate && (
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300" title="Esta referencia también se propuso para otra pieza">
                          repetida
                        </span>
                      )}
                    </div>

                    {r.options.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" onClick={(e) => e.stopPropagation()}>
                        {/* The «cambiar»: only this piece's own admissible roots.
                            The empty option is how a row is rejected outright. */}
                        <Select
                          variant="chip"
                          className="max-w-full !min-h-7 !py-0.5 !text-[11px]"
                          value={root}
                          onChange={(v) => onOverride(r.modelId, v)}
                          aria-label={`SKU para ${r.name || 'modelo'}`}
                        >
                          <option value="">— sin vincular —</option>
                          {r.options.map((o) => (
                            <option key={o.root} value={o.root}>{optionLabel(o)}</option>
                          ))}
                        </Select>
                        {/* The price of what is about to be bound, in the row. */}
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-ink-700">{usdFrom(picked?.fromUsd ?? null)}</span>
                      </div>
                    ) : (
                      <p className="text-[11px] text-ink-400">Sin candidatos admisibles en el catálogo.</p>
                    )}

                    {r.why && <p className="text-[10px] leading-tight text-ink-500">{r.why}</p>}
                  </div>
                </div>
              );
            })}

            {!rows.length && (
              <p className="px-3 py-10 text-center text-xs text-ink-500">No hay piezas que revisar.</p>
            )}
          </div>

          {/* THE ONE WRITE. Everything above is a proposal until this is clicked,
              and it rides a single round-trip (never a per-row loop). */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-ink-200 px-3 py-2">
            <span className="text-[11px] tabular-nums text-ink-500">
              {bindable.length} de {rows.length} se vincularán
            </span>
            <button
              type="button"
              onClick={onBind}
              disabled={binding || !bindable.length}
              className="btn-primary ml-auto text-xs disabled:opacity-50"
              title="Escribe el SKU de las piezas aceptadas — en una sola operación"
            >
              {binding ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Vincular {bindable.length} SKU{bindable.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
