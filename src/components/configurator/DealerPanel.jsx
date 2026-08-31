import {
  Boxes, Coins, Inbox, Pencil, Power, Trash2, AlertTriangle, Loader2, Package,
} from 'lucide-react';
import { formatDateTime } from '../../lib/format.js';
import { Stat as QuantStat } from '../quant/Figures.jsx';
import { dealerMoneyLabel } from '../../core/quote/index.js';
import DealerKit, { RegenerateTokenButton } from './DealerKit.jsx';
import { DealerPricePreview } from './DealerForm.jsx';
import EmptyState from '../EmptyState.jsx';

/**
 * FICHA DEL DISTRIBUIDOR — one dealer's whole picture on one panel: estado, the
 * catalog they carry, how their prices are presented (with the live example off
 * the real catalog), their install kit, and THEIR solicitudes.
 *
 * Derives nothing: `vm` is `resolveDealerDetail(...)`
 * (core/quote/views/dealerWorkspace). The lead block is honest by construction —
 * zero leads renders an empty state that says zero, never a placeholder row.
 */

/** Prop adapter over the shared figure recipe. */
function Stat({ label, value, tone = '' }) {
  return <QuantStat size="panel" frame="box" label={label} value={value} accentClass={tone} />;
}

function Block({ icon: Icon, title, action, children, flush = false }) {
  return (
    <section className="rounded-xl border border-ink-200/80 bg-surface overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-ink-100">
        <h3 className="font-display text-xs font-semibold flex items-center gap-1.5">
          <Icon size={13} className="text-ink-500" /> {title}
        </h3>
        {action}
      </header>
      <div className={flush ? '' : 'p-4 space-y-3'}>{children}</div>
    </section>
  );
}

export default function DealerPanel({
  vm, onEdit, onToggleActive, onRegenerateToken, onDelete, busy = false,
  // The MANUFACTURER this dealer sells — it titles the embed iframe on their
  // own site. Null ⇒ the neutral title (never another brand's name).
  brandName = null,
}) {
  if (!vm) return null;
  const { catalog, pricing, leads } = vm;

  return (
    <div className="space-y-3">
      {/* Identity + the actions that change the dealer's state. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          {vm.logoUrl ? (
            <img
              src={vm.logoUrl}
              alt=""
              className="w-11 h-11 rounded-xl object-contain bg-white border border-ink-100 shrink-0"
            />
          ) : (
            <span className="icon-tile tint-brand w-11 h-11 rounded-xl"><Package size={18} /></span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-display text-base font-semibold truncate">{vm.name}</h2>
              <span className={`status-pill ${vm.statusCls}`}>{vm.statusLabel}</span>
            </div>
            <p className="text-micro text-ink-500 font-mono truncate">/{vm.slug}</p>
            <p className="text-micro text-ink-500 truncate">
              {[vm.localeLabel, vm.contactEmail, vm.createdAt ? `alta ${formatDateTime(vm.createdAt)}` : null]
                .filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onEdit} className="btn-secondary text-xs">
            <Pencil size={13} /> Editar
          </button>
          <button type="button" onClick={onToggleActive} disabled={busy} className="btn-ghost text-xs disabled:opacity-50" title={vm.active ? 'Apagar su enlace y su embed' : 'Volver a publicar su widget'}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} {vm.active ? 'Desactivar' : 'Activar'}
          </button>
          <button type="button" onClick={onDelete} className="btn-icon-danger" title="Eliminar distribuidor" aria-label={`Eliminar ${vm.name}`}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {vm.warnings.length > 0 && (
        <ul className="notice notice-warn space-y-1">
          {vm.warnings.map((w, i) => (
            <li key={i} className="text-micro text-amber-800 dark:text-amber-200 flex items-start gap-1.5 leading-snug">
              <AlertTriangle size={12} className="mt-px shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}

      {/* The four numbers that answer "is this dealer working?". */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Piezas que sirve" value={catalog.servedPieces} />
        <Stat label="Solicitudes" value={leads.total} />
        <Stat label="Pendientes" value={leads.pending} tone={leads.pending > 0 ? 'text-brand-600' : ''} />
        <Stat label="Convertidas" value={leads.converted} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Block icon={Boxes} title="Su catálogo">
          <p className="text-sm text-ink-800">{catalog.summary}</p>
          {catalog.all ? (
            <p className="text-micro text-ink-500 leading-relaxed">
              Sirve el catálogo completo: cada colección que se publique en Modelos le llega sin tocar esta ficha.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {catalog.options.filter((o) => o.selected).map((o) => (
                <span key={o.key} className="chip bg-ink-100 text-ink-700 normal-case tracking-normal text-micro font-medium">
                  {o.label} <span className="text-ink-500 tabular-nums">{o.count}</span>
                </span>
              ))}
              {catalog.selectedLabels.length === 0 && (
                <span className="text-micro text-amber-700 dark:text-amber-300">Ninguna colección asignada.</span>
              )}
            </div>
          )}
          {!catalog.all && catalog.catalogPieces > catalog.servedPieces && (
            <p className="text-micro text-ink-500 tabular-nums">
              {catalog.catalogPieces - catalog.servedPieces} piezas del catálogo quedan fuera de su configurador.
            </p>
          )}
        </Block>

        <Block icon={Coins} title="Su presentación de precios">
          <div className="flex flex-wrap items-center gap-1.5 text-micro">
            <span className="chip bg-ink-100 text-ink-700 normal-case tracking-normal font-medium">{pricing.pricingLabel}</span>
            <span className="chip bg-ink-100 text-ink-700 normal-case tracking-normal font-medium">{pricing.currency}</span>
            <span className="chip bg-ink-100 text-ink-700 normal-case tracking-normal font-medium">tasa ×{pricing.usdRate}</span>
            <span className="chip bg-ink-100 text-ink-700 normal-case tracking-normal font-medium">margen ×{pricing.priceMultiplier}</span>
          </div>
          <p className="text-micro text-ink-500 leading-snug">{pricing.pricingHint}</p>
          <DealerPricePreview pricing={pricing} />
        </Block>
      </div>

      <Block icon={Inbox} title="Kit de instalación" flush action={<RegenerateTokenButton onRegenerate={onRegenerateToken} busy={busy} />}>
        <DealerKit slug={vm.slug} inboxToken={vm.inboxToken} name={vm.name} brandName={brandName} />
      </Block>

      <Block
        icon={Inbox}
        title="Sus solicitudes"
        action={leads.total > 0 ? (
          <span className="text-micro text-ink-500 tabular-nums">
            {leads.open} abierta{leads.open === 1 ? '' : 's'}
            {leads.pipelineUsd > 0 && ` · ${dealerMoneyLabel(leads.pipelineUsd, 'USD', { locale: 'en-US', display: 'code' })} en juego`}
          </span>
        ) : null}
        flush={leads.empty}
      >
        {leads.empty ? (
          <div className="p-4">
            <EmptyState
              icon={Inbox}
              title="Todavía no ha recibido solicitudes"
              description="Cuando alguien arme un sofá en su configurador, el lead aparece aquí y en su bandeja privada."
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 text-micro">
              <span className="status-pill status-pill-pending">Pendientes {leads.pending}</span>
              <span className="status-pill status-pill-sent">Contactadas {leads.contacted}</span>
              <span className="status-pill status-pill-accepted">Convertidas {leads.converted}</span>
              {leads.dismissed > 0 && <span className="status-pill status-pill-archived">Descartadas {leads.dismissed}</span>}
            </div>
            <ul className="divide-y divide-ink-100 -mx-4">
              {leads.recent.map((r) => (
                <li key={r.id} className="px-4 py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-ink-900 truncate">{r.name}</div>
                    <div className="text-micro text-ink-500 truncate">
                      {[formatDateTime(r.createdAt), r.contact, `${r.pieces} ${r.pieces === 1 ? 'pieza' : 'piezas'}`]
                        .filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-micro tabular-nums text-ink-700">
                      {r.estimateUsd != null
                        ? dealerMoneyLabel(r.estimateUsd, 'USD', { locale: 'en-US', display: 'code' })
                        : 'Sin estimado'}
                    </div>
                    <span className={`status-pill ${r.statusCls} mt-0.5`}>{r.statusLabel}</span>
                  </div>
                </li>
              ))}
            </ul>
            {leads.total > leads.recent.length && (
              <p className="text-micro text-ink-500">
                Mostrando las {leads.recent.length} más recientes de {leads.total}. El resto está en Solicitudes.
              </p>
            )}
          </>
        )}
      </Block>

      {vm.notes && (
        <div className="rounded-xl border border-ink-200/80 bg-surface px-4 py-3">
          <div className="text-micro uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1">Notas internas</div>
          <p className="text-xs text-ink-600 whitespace-pre-wrap leading-relaxed">{vm.notes}</p>
        </div>
      )}
    </div>
  );
}
