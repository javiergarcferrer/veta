import { useState } from 'react';
import { Check, Clock, Download, Loader2 } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { mintCatalogPointers, stampPointerIds } from '../../db/catalogPointers.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { CH_PAINTED_FIELDS, ChIssues, leadTimeLabel, usdOrNull } from './ChConfigurator.jsx';

/**
 * ChImportBar — the money path: what pressing «Importar» writes, everything
 * standing in the way, and the write itself.
 *
 * The plan (`resolveCarlHansenImportPlan`) already decided the rows, the
 * blockers and the audit trail. This component adds exactly three things the
 * ViewModel can't: the confirmation surface, the `images` POINTER pass, and the
 * append of the audit rows.
 *
 * ── WHAT IS AND IS NOT WRITTEN ──────────────────────────────────────────────
 *  • `products` rows carry the ex-VAT USD LIST PRICE and nothing else about
 *    money. `cost` is not a key on them and is never added here: cost arrives
 *    from the landed-cost engine when the expediente is posted (the LSG
 *    `costInUsd` precedent — a fabricated cost poisoned every margin
 *    downstream and nobody saw it for weeks). Because a PostgREST upsert only
 *    touches the columns in the payload, re-importing also never clears a cost
 *    the landed-cost engine already wrote.
 *  • `stock_qty` is likewise absent — Carl Hansen is made to order and a
 *    tracked row at qty ≤ 0 is refused by all three quote pickers. Lead time,
 *    shown below, is the availability figure that is actually true.
 *  • A single `level: 'blocker'` yields NO rows from the plan, so the button
 *    is disabled and there is nothing to write. Warnings render and let the
 *    dealer through.
 *
 * ── THE PHOTO POINTERS ──────────────────────────────────────────────────────
 * Carl Hansen's variant renders live on their CDN, so each url becomes a
 * SHARED `images` POINTER row (`external_url`, no bytes in our bucket) with a
 * content-addressed id, exactly like the LSG catalog's `lsgimg-…` and the LR
 * matcher's `lrimg-…`. Two consequences, both load-bearing:
 *   • the on-screen photo would work off `imageSrc` alone, but the PDF embeds
 *     BYTES and reads them through `images.externalUrl` — without a pointer the
 *     printed quote shows an empty tile;
 *   • `chimg-` is registered in `isSharedCatalogImage`, so `deleteImage`
 *     refuses these rows: several configurations of one chair legitimately
 *     share a shot, and clearing one quote line must never blank the others.
 * Nothing is ever swept or deleted here — an id that stops being referenced
 * simply stops being referenced.
 */
export default function ChImportBar({
  plan, axes, profileId, userId = null, onImported, extraBlockers = [],
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const rows = plan.rows || [];
  // `extraBlockers` are View-level REFUSALS the ViewModel can't express yet
  // (today: the identity-add-on configuration gate — see ChConfigurator's
  // `ConfigCard`). They can only ever stop an import, never permit one.
  const blockers = plan.blockers.length + extraBlockers.length;
  const canImport = blockers === 0 && rows.length > 0 && !busy;
  // Checks the configurator has no block for (today: `profile`). Everything
  // else is already on screen beside its own field.
  const unpainted = [...plan.blockers, ...plan.warnings].filter((i) => (
    !CH_PAINTED_FIELDS.includes(i.field) && !(axes || []).some((a) => a.id === i.field)
  ));

  async function runImport() {
    if (!canImport) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      setNote('Creando punteros de foto…');
      const { byUrl, skipped } = await mintCatalogPointers(rows, {
        prefix: 'chimg', kind: 'catalog-carl-hansen', ownerId: 'carl-hansen-catalog',
      });

      setNote('Escribiendo el catálogo…');
      // EVERY ROW IN A BATCH MUST CARRY THE SAME KEYS — PostgREST refuses a
      // bulk upsert whose objects disagree (PGRST102). So the pointer columns
      // are decided for the WHOLE batch: minted ⇒ every row carries them (a
      // photo-less variant legitimately writes null); not minted ⇒ no row
      // carries them, and an earlier import's good pointer survives untouched
      // instead of being blanked by a pass that simply couldn't hash a url.
      const products = stampPointerIds(rows, byUrl, skipped);
      await db.products.bulkPut(products);

      // APPEND-ONLY, LITERALLY: one row per import EVENT, with a generated id.
      // Keying this by `ch-<EAN>` (the product's own id) would make a re-import
      // RESTATE the row and silently destroy the previous list price — which is
      // precisely the question this table exists to answer once a price list
      // has rolled over. `productId` carries the link to the (single, upserted)
      // product; the history reads through the (modelId, importedAt) index.
      const importedAt = Date.now();
      await db.carlHansenImports.bulkPut(products.map((row) => ({
        id: newId(),
        profileId,
        modelId: plan.audit.modelId || '',
        ean: row.reference,
        configId: plan.audit.configId || '',
        selection: plan.audit.selection,
        priceKey: plan.audit.priceKey || '',
        // The price that was actually WRITTEN on this row. Identical to the
        // plan's figure today (one price per plan), but reading it off the row
        // is what keeps the audit true the day a per-variant price appears.
        listPriceUsd: row.priceUsd ?? plan.audit.listPriceUsd,
        // THE FIGURE THE AUDIT EXISTS FOR. `configId` and `priceState` are
        // recoverable from other columns; the raw base is recoverable from
        // NOTHING — without it, a row reading $2,450 can never be traced back
        // to $2,305 plus a $145 mandatory surcharge.
        basePriceUsd: plan.audit.basePriceUsd,
        // `price_valid_to` is a timestamptz and this field doesn't end in `At`,
        // so the row mapper leaves it alone — hand Postgres an ISO string.
        priceValidTo: isoStamp(plan.audit.priceValidTo),
        productId: row.id,
        importedAt,
        importedBy: userId,
      })));

      setNote(
        `${products.length} ${products.length === 1 ? 'producto importado' : 'productos importados'} al catálogo.`
        + (skipped ? ' No se pudieron crear los punteros de foto en este contexto; reimporta desde https para que el PDF traiga las fotos.' : ''),
      );
      onImported?.(products);
    } catch (e) {
      console.error('[CarlHansen] import failed:', e);
      setNote('');
      setError(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow-xs">Importar al catálogo</p>
          <p className="mt-1 text-sm text-ink-700">
            {rows.length > 0
              ? `${rows.length} ${rows.length === 1 ? 'producto' : 'productos'} · ${usdOrNull(plan.audit.listPriceUsd) || 'sin precio'} USD c/u`
              : 'Nada que importar con esta combinación.'}
          </p>
          <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-500">
            <Clock size={12} className="text-ink-500" aria-hidden /> {leadTimeLabel(plan.leadTimeDays)}
          </p>
        </div>
        <button
          type="button"
          onClick={runImport}
          disabled={!canImport}
          className="btn-primary disabled:opacity-50"
          title={blockers ? 'Resuelve los bloqueos antes de importar' : 'Escribir estas referencias en el catálogo'}
        >
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Download size={14} aria-hidden />}
          Importar al catálogo
        </button>
      </div>

      {/* The configurator already paints every check beside the field it
          doubts, so repeating the list here would put each blocker on screen
          twice. What it CANNOT paint — a check whose field it has no block for
          — still renders in full: nothing vanishes, nothing doubles. */}
      <ChIssues issues={unpainted} axes={axes} />
      {(blockers > 0 || plan.warnings.length > 0) && (
        <p className={`text-xs ${blockers ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
          {blockers > 0
            ? `${blockers} ${blockers === 1 ? 'bloqueo' : 'bloqueos'} impiden importar — ver el detalle arriba, junto a cada campo.`
            : `${plan.warnings.length} aviso(s) arriba; se puede importar igual.`}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="list-none divide-y divide-ink-100 rounded-lg border border-ink-100 p-0 text-xs">
          {rows.map((row) => {
            const lead = plan.leadTimes.find((lt) => lt.reference === row.reference) || null;
            return (
              <li key={row.id} className="flex items-center gap-2 px-3 py-2">
                <span className="font-mono text-micro text-ink-500">{row.reference}</span>
                <span className="min-w-0 flex-1 truncate text-ink-600" title={row.name}>{row.subtype || row.name}</span>
                <span className="flex-shrink-0 text-micro text-ink-500">{leadTimeLabel(lead?.productionDays ?? null)}</span>
                <span className="flex-shrink-0 tabular-nums font-medium text-ink-800">
                  {usdOrNull(row.priceUsd) || <span className="text-red-700 dark:text-red-300">sin precio</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-micro text-ink-500">
        Se importa el precio de lista (USD, ex-VAT). El costo NO se escribe: llega del cálculo de
        landed cost cuando se contabiliza el expediente. Tampoco se escribe stock — la pieza es
        bajo pedido y el dato real es el plazo de fábrica.
      </p>

      {note && !error && (
        <p role="status" className="notice notice-sm notice-success items-center">
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="notice notice-sm notice-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** A validity stamp as Postgres wants it. Kept out of the ViewModel: the plan
 *  hands back whatever the source spelled, and only the writer needs ISO. */
function isoStamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
