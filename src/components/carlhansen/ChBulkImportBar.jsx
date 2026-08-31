import { useCallback, useState } from 'react';
import { Loader2, UploadCloud, AlertTriangle, Boxes } from 'lucide-react';
import { db, invalidate } from '../../db/database.js';
import { chPriceRowId, fetchCarlHansenModel, fetchCarlHansenPrices } from '../../lib/carlHansenClient.js';
import { resolveCarlHansenModelPlan, diagnoseCarlHansenBulk as diagnose } from '../../core/catalog/index.js';
import { priceWindowIncoherent } from '../../brands/carl-hansen/price.js';
import { userMessageFor } from '../../lib/errorMessages.js';

/**
 * IMPORTAR TODO — the whole Carl Hansen range in one press.
 *
 * The per-model flow beside this one is right for quoting ONE piece: open a
 * chair, pick the wood, pick the seat, import that configuration. It is the
 * wrong way to GET A CATALOG. Carl Hansen publishes ~165 product pages and the
 * Wishbone alone is 41 buyable variants, so having the range ready to browse
 * was several hundred clicks — and a dealer who wants to SEE what they sell
 * should not have to configure it first.
 *
 * Three phases, in order, each reported while it runs:
 *
 *   1. FICHAS — the two blob reads (master + price list) per model. These are
 *      what the per-model page pulls lazily when you open a chair; here they
 *      are pulled for every model that is missing one. Bounded concurrency,
 *      because 165 models × 2 requests fired at once is a self-inflicted
 *      outage. A model whose blobs fail is COUNTED and skipped — one 404
 *      (CH086 publishes a master and no price list) must not stop the range.
 *   2. PLAN — `resolveCarlHansenModelPlan`, pure, ONE MODEL AT A TIME: every
 *      configuration × every combination through the same resolver the careful
 *      path uses, so every money rule is inherited rather than restated.
 *
 *      It is driven model-by-model with a yield between models, and that is
 *      not a style choice. The whole walk used to be a single synchronous
 *      call: ~200 masters × up to 2,000 selections each is hundreds of
 *      thousands of resolver calls inside one tick, and the browser simply
 *      stopped — no repaint, no progress, no cancel, "page unresponsive".
 *      Yielding costs a few milliseconds per model and buys a tab that stays
 *      alive and a counter that moves.
 *   3. ESCRITURA — chunked upserts. Whole-catalog writes go over the
 *      PostgREST row cap and over what a phone finishes in one request.
 *
 * WHAT IT WILL NOT DO is exactly what the per-model page will not do: write a
 * row whose price key resolved to nothing, or import an identity add-on
 * configuration (CH24 and CH24-H43 claim the SAME EANs $145 apart). Those come
 * back as blockers inside the plan and the rows never appear.
 */

/** How many blob pairs to pull at once. Enough to finish ~165 models in a
 *  couple of minutes, low enough not to look like an attack. */
const FETCH_CONCURRENCY = 4;
/** Rows per upsert. Same reason the Fredericia importer chunks. */
const WRITE_CHUNK = 500;

const IDLE = { busy: false, phase: '', done: 0, total: 0, error: '', result: null };

export default function ChBulkImportBar({ profileId, pages, onDone }) {
  const [state, setState] = useState(IDLE);

  const run = useCallback(async () => {
    if (!profileId) {
      setState({ ...IDLE, error: 'Falta el perfil destino.' });
      return;
    }
    setState({ ...IDLE, busy: true, phase: 'Leyendo fichas…' });

    try {
      // A cursor row is not a product — an empty `variants` is the marker (see
      // resolveCarlHansenBrowser). Bulk-importing them would ask the blob store
      // for ~32 model ids that do not exist.
      const products = (pages || []).filter((p) => Array.isArray(p?.variants) && p.variants.length);
      const modelIds = [...new Set(products.map((p) => String(p?.modelId || '').trim()).filter(Boolean))];

      // WHAT ARRIVED, AT EVERY STAGE. The generic "revisa que el barrido haya
      // traído las páginas" was worse than no message: it sent somebody to
      // re-run a sweep that had already brought 169 pages, and said nothing
      // about which of the four joins actually came up empty. A refusal that
      // does not name its own reason costs more than the failure it reports.
      const census = {
        paginas: (pages || []).length,
        conVariantes: products.length,
        modelos: modelIds.length,
        fichas: 0,
        listas: 0,
      };

      // ── 1. FICHAS ────────────────────────────────────────────────────────
      // ONE READ FOR THE WHOLE RANGE, not two per model. The old shape awaited
      // a spec get and a price get per model in sequence: ~400 round trips
      // before the first byte of real work, on a page that then froze anyway.
      //
      // BOTH READS KEY BY `id`. A spec row IS the model — `carl_hansen_specs.id`
      // is the model id, and the table has no `model_id` column (only
      // `carl_hansen_prices` and `carl_hansen_imports`, which point AT a model,
      // carry one). Asking for `modelId` here cost a 42703 from PostgREST on the
      // first press of «Importar todo», and the map that keyed rows by the
      // absent field would have called every model missing and re-read ~200
      // masters the cache already held.
      // NEVER `.map(chPriceRowId)` bare: map hands the array INDEX as the
      // second argument (the market), and the cache was silently asked for
      // `CH23:0`, `CH280:1`, … — zero hits, every model «sin lista», forever.
      const priceRowIds = modelIds.map((modelId) => chPriceRowId(modelId));
      const [specRows, priceRows] = await Promise.all([
        db.carlHansenSpecs.where('id').anyOf(modelIds).toArray(),
        db.carlHansenPrices.where('id').anyOf(priceRowIds).toArray(),
      ]);
      const specById = new Map((specRows || []).map((x) => [String(x?.id || ''), x]));
      const priceById = new Map((priceRows || []).map((x) => [String(x?.id || ''), x]));
      census.fichas = specById.size;
      census.listas = priceById.size;

      const missing = modelIds
        .map((modelId) => ({
          modelId,
          needSpec: !specById.has(modelId),
          // A cached list whose window ends before it starts is the scar of
          // the old cross-generation merge (AB019 and nine friends read as
          // "expired" forever). The server now merges correctly, so the heal
          // is to re-ask — treated exactly like a missing row.
          needPrice: !priceById.has(chPriceRowId(modelId))
            || priceWindowIncoherent(priceById.get(chPriceRowId(modelId))),
        }))
        .filter((j) => j.needSpec || j.needPrice);

      const failures = [];
      let done = 0;
      setState((s) => ({ ...s, phase: 'Leyendo fichas del fabricante…', total: missing.length, done: 0 }));

      const queue = [...missing];
      const worker = async () => {
        for (;;) {
          const job = queue.shift();
          if (!job) return;
          // INDEPENDENT reads: CH086 publishes a master and no price list, and
          // a failure on one must not hide the other.
          if (job.needSpec) {
            try { await fetchCarlHansenModel(job.modelId); }
            catch (e) { failures.push(`${job.modelId}: ${userMessageFor(e)}`); }
          }
          if (job.needPrice) {
            try { await fetchCarlHansenPrices(job.modelId); }
            catch (e) { failures.push(`${job.modelId}: ${userMessageFor(e)}`); }
          }
          done += 1;
          setState((s) => (s.busy ? { ...s, done } : s));
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length || 1) }, worker));
      invalidate(['carlHansenSpecs', 'carlHansenPrices']);

      // ── 2. PLAN ──────────────────────────────────────────────────────────
      // Re-read once (the fetches above filled gaps), then walk model by model.
      const [specRows2, priceRows2] = await Promise.all([
        db.carlHansenSpecs.where('id').anyOf(modelIds).toArray(),
        db.carlHansenPrices.where('id').anyOf(modelIds.map((modelId) => chPriceRowId(modelId))).toArray(),
      ]);
      const spec2 = new Map((specRows2 || []).map((x) => [String(x?.id || ''), x]));
      const price2 = new Map((priceRows2 || []).map((x) => [String(x?.id || ''), x]));

      setState((s) => ({ ...s, phase: 'Armando el catálogo…', total: products.length, done: 0 }));

      // DEDUPE BY EAN, FIRST WRITER WINS — the same rule the single-call plan
      // applied, kept here because it is a decision ACROSS models and so cannot
      // live inside a per-model walk.
      const byReference = new Map();
      const skipped = [];
      const truncated = [];
      let modelsSeen = 0;
      let modelsWithRows = 0;
      let combinations = 0;

      for (let i = 0; i < products.length; i += 1) {
        const page = products[i];
        const modelId = String(page?.modelId || '').trim();
        if (!modelId) continue;
        const one = resolveCarlHansenModelPlan(
          { modelId, page, spec: spec2.get(modelId) || null, priceRow: price2.get(chPriceRowId(modelId)) || null },
          { profileId },
        );
        if (one.skipped && !one.rows.length && one.skipped.why !== 'ninguna combinación resolvió precio y variante') {
          skipped.push(one.skipped);
        } else {
          modelsSeen += 1;
          combinations += one.combinations;
          for (const t of one.truncated) truncated.push(t);
          let rowsForModel = 0;
          for (const row of one.rows) {
            const reference = String(row?.reference || '');
            if (!reference || byReference.has(reference)) continue;
            byReference.set(reference, row);
            rowsForModel += 1;
          }
          if (rowsForModel) modelsWithRows += 1;
          else if (one.skipped) skipped.push(one.skipped);
        }
        // BREATHE. One `await` per model hands the tab back to the browser: the
        // progress bar paints, and a user who wants to leave the page can.
        setState((s) => (s.busy ? { ...s, done: i + 1 } : s));
        await new Promise((r) => { setTimeout(r, 0); });
      }

      const plan = {
        rows: [...byReference.values()],
        skipped,
        truncated,
        summary: {
          models: modelsSeen,
          modelsWithRows,
          combinations,
          rows: byReference.size,
          skipped: skipped.length,
          truncated: truncated.length,
        },
      };

      if (!plan.rows.length) {
        setState({
          ...IDLE,
          error: diagnose(census, skipped),
          result: {
            ...plan.summary,
            census,
            failures: failures.length,
            failureList: failures.slice(0, 5),
            noPriceList: skipped.filter((x) => x.why === 'sin lista de precios').map((x) => x.modelId),
          },
        });
        return;
      }

      // ── 3. ESCRITURA ─────────────────────────────────────────────────────
      setState((s) => ({ ...s, phase: 'Escribiendo el catálogo…', total: plan.rows.length, done: 0 }));
      for (let i = 0; i < plan.rows.length; i += WRITE_CHUNK) {
        await db.products.bulkPut(plan.rows.slice(i, i + WRITE_CHUNK));
        setState((s) => (s.busy ? { ...s, done: Math.min(i + WRITE_CHUNK, plan.rows.length) } : s));
      }
      invalidate(['products']);

      setState({
        ...IDLE,
        result: {
          ...plan.summary,
          census,
          failures: failures.length,
          failureList: failures.slice(0, 5),
          noPriceList: plan.skipped.filter((x) => x.why === 'sin lista de precios').map((x) => x.modelId),
        },
      });
      onDone?.(plan);
    } catch (e) {
      setState({ ...IDLE, error: userMessageFor(e) || 'No se pudo importar el catálogo.' });
    }
  }, [profileId, pages, onDone]);

  const r = state.result;

  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 inline-flex items-center gap-1.5">
            <Boxes size={15} className="opacity-70" aria-hidden />
            Importar todo el catálogo
          </div>
          <p className="text-xs text-ink-500 mt-0.5 max-w-prose">
            Trae la ficha y la lista de precios de cada modelo barrido y escribe TODAS las
            configuraciones con precio — sin tener que abrir y configurar pieza por pieza.
            No se escribe costo ni stock.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state.busy}
          className="btn btn-primary min-h-11 whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0"
        >
          {state.busy ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {state.busy ? 'Importando…' : 'Importar todo'}
        </button>
      </div>

      {state.busy && (
        <div className="space-y-1">
          <div className="text-xs text-ink-600">
            {state.phase}
            {state.total > 0 && <span className="tabular-nums"> {state.done} / {state.total}</span>}
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
        <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-800 inline-flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{state.error}</span>
        </div>
      )}

      {r && !state.busy && (
        <div className="text-xs text-ink-600 space-y-1">
          <div>
            <strong className="text-ink-900">{r.rows}</strong> referencias escritas ·{' '}
            {r.modelsWithRows} de {r.models} modelos · {r.combinations} combinaciones evaluadas
          </div>
          {/* EL CENSO, SIEMPRE. Four joins have to line up for a row to exist,
              and when none does the useful thing is which of the four is zero —
              not a sentence telling somebody to re-run a sweep that already
              worked. Shown on success too: a run that read 40 of 115 models is
              also a fact worth seeing. */}
          {r.census && (
            <div className="font-mono text-micro text-ink-500">
              {r.census.paginas} páginas · {r.census.conVariantes} con variantes ·{' '}
              {r.census.modelos} modelos · {r.census.fichas} fichas · {r.census.listas} listas
            </div>
          )}
          {/* Nothing is hidden: a bounded read whose leftovers are silent reads
              exactly like a complete one. */}
          {r.skipped > 0 && (
            <div className="text-ink-500">
              {r.skipped} modelos sin precio o sin ficha utilizable
              {/* NAMED, because "sin lista de precios" is not a failed download:
                  Carl Hansen does not publish a price file for every model it
                  lists, and a dealer needs to know WHICH ones to ask for. */}
              {r.noPriceList?.length > 0 && (
                <span className="block font-mono text-micro text-ink-500 mt-0.5">
                  sin lista de precios: {r.noPriceList.slice(0, 12).join(' · ')}
                  {r.noPriceList.length > 12 ? ` +${r.noPriceList.length - 12}` : ''}
                </span>
              )}
            </div>
          )}
          {r.truncated > 0 && (
            <div className="text-status-warning-ink">
              {r.truncated} configuraciones superaron el tope de combinaciones y se leyeron en parte
            </div>
          )}
          {r.failures > 0 && (
            <div className="text-status-warning-ink">
              {r.failures} fichas no se pudieron leer
              {r.failureList?.length ? ` — ${r.failureList.join(' · ')}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
