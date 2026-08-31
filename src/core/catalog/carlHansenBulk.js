/**
 * IMPORTAR TODO — the whole Carl Hansen range, walked model by model.
 *
 * Split out of `carlHansen.js` when that file went over its size mark. It is
 * the bulk pass and nothing else: the per-model resolver, the configurator and
 * the browser stay where they were, and this imports the one rule it loops
 * over rather than restating any of it.
 */
import {
  resolveCarlHansenImportPlan,
  resolveCarlHansenAssets,
} from './carlHansen.js';
import { parseSelectionTree, defaultSelection, configurationIds } from '../../brands/carl-hansen/selectionTree.js';
import { resolveVariantSelection, variantMatchContext } from '../../brands/carl-hansen/variantMatch.js';

const str = (v) => String(v ?? '').trim();

/**
 * ONE MODEL'S SHARE OF THE PLAN — driven by the PUBLISHED VARIANTS, not by
 * enumeration.
 *
 * The first shape of this walk enumerated every combination the axes allow
 * (capped) and kept the ones some variant matched. That direction has a wall
 * it cannot see over: ND52 publishes three 630-leaf fabric axes — 1.75 BILLION
 * combinations against a 2,000-selection cap — so the two variants its page
 * actually sells were never even enumerated, and the model minted nothing
 * while reporting itself truncated. Inverting the walk (for each published
 * variant, solve WHICH selection it is — `resolveVariantSelection`) is
 * O(variants × leaves), cannot miss a published piece, and needs no cap at
 * all, so `truncated` is now always empty and stays in the shape only for the
 * callers that render it.
 *
 * Split out of the bulk pass because the bulk pass is not allowed to be one
 * synchronous call: the caller drives this one model at a time and yields
 * between models, so the tab stays alive and the count moves.
 *
 * Pure and self-contained: it dedupes nothing globally (the caller owns the
 * EAN map, because "first writer wins" is a decision across models).
 */
export function resolveCarlHansenModelPlan(entry, {
  profileId = '',
  now = Date.now(),
  /** Audits are diagnostics, not output. Keeping one per COMBINATION meant a
   *  quarter-million retained objects on a full sweep — a large part of why
   *  the tab died rather than merely slowed. */
  auditCap = 50,
} = {}) {
  const page = entry?.page || null;
  const spec = entry?.spec || null;
  const priceRow = entry?.priceRow || null;
  const modelId = str(spec?.modelId) || str(page?.modelId) || str(entry?.modelId);

  const out = {
    modelId, rows: [], leadTimes: [], audits: [], truncated: [], combinations: 0, skipped: null,
  };
  // NOT AN ERROR, AND IT MATTERS THAT IT IS SAID PLAINLY. Carl Hansen simply
  // does not publish a price file for every model it lists. Those are products
  // outside the export list, not a failed download and not a lost credential.
  if (!spec) { out.skipped = { modelId, why: 'sin ficha del fabricante' }; return out; }
  if (!priceRow) { out.skipped = { modelId, why: 'sin lista de precios' }; return out; }

  const configs = configurationIds(spec);
  const configIds = configs.length ? configs.map((c) => c.id) : [null];

  // Each configuration parsed ONCE, up front — the same axis objects are then
  // reused for every variant (the matcher caches per axis object), and their
  // union is the sibling proof the unspoken-axis waiver requires.
  const axesByConfig = new Map(configIds.map((id) => [id, parseSelectionTree(spec, id ?? undefined)]));
  const modelAxes = [...axesByConfig.values()].flat();

  const variants = Array.isArray(page?.variants) ? page.variants
    : Array.isArray(page?.Variants) ? page.Variants : [];

  for (const configId of configIds) {
    const axes = axesByConfig.get(configId) || [];
    if (!axes.length) continue;

    const context = variantMatchContext({ Variants: variants }, axes, modelAxes, {
      configurations: Array.isArray(spec?.configurations) ? spec.configurations : null,
      configId,
    });
    const defaults = defaultSelection(axes);
    const tried = new Set();

    for (const variant of variants) {
      out.combinations += 1;
      const selection = resolveVariantSelection(axes, variant, context, defaults);
      if (!selection) continue;
      // Two variants can resolve to one selection (the variant-ambiguous
      // pair); the plan already claims both, so run it once.
      const signature = axes.map((a) => selection[a.id] ?? '').join('|');
      if (tried.has(signature)) continue;
      tried.add(signature);

      let plan;
      try {
        // `rawAxes` + `probeAddOns: false` are the bulk pass's perf seams: the
        // axes for this configuration are parsed ONCE above, and the
        // per-option surcharge probes are configurator paint, not plan input.
        plan = resolveCarlHansenImportPlan(spec, page, priceRow, selection, {
          now, profileId, configId, rawAxes: axes, modelAxes, probeAddOns: false,
        });
      } catch {
        // A malformed master must cost its own model, never the sweep.
        continue;
      }
      if (plan.blockers.length) continue;
      for (const row of plan.rows) out.rows.push(row);
      if (plan.rows.length) {
        if (out.audits.length < auditCap) out.audits.push(plan.audit);
        for (const lt of plan.leadTimes || []) out.leadTimes.push(lt);
      }
    }
  }
  if (!out.rows.length) out.skipped = { modelId, why: 'ninguna combinación resolvió precio y variante' };
  return out;
}

export function resolveCarlHansenBulkPlan(models, opts = {}) {
  const byReference = new Map();
  const leadTimes = [];
  const audits = [];
  const skipped = [];
  const truncated = [];
  let modelsSeen = 0;
  let modelsWithRows = 0;
  let combinations = 0;

  for (const entry of models || []) {
    const one = resolveCarlHansenModelPlan(entry, opts);
    if (one.skipped && !one.rows.length) {
      // A model with no spec or no price list never entered the walk at all.
      if (one.skipped.why !== 'ninguna combinación resolvió precio y variante') {
        skipped.push(one.skipped);
        continue;
      }
    }
    modelsSeen += 1;
    combinations += one.combinations;
    for (const t of one.truncated) truncated.push(t);
    let rowsForModel = 0;
    for (const row of one.rows) {
      const reference = str(row?.reference);
      if (!reference || byReference.has(reference)) continue;
      byReference.set(reference, row);
      rowsForModel += 1;
    }
    if (rowsForModel) {
      modelsWithRows += 1;
      for (const a of one.audits) audits.push(a);
      for (const lt of one.leadTimes) leadTimes.push(lt);
    } else if (one.skipped) skipped.push(one.skipped);
  }

  const rows = [...byReference.values()];
  return {
    rows,
    leadTimes,
    audits,
    skipped,
    // Reported, never silent: a bounded walk whose leftovers are hidden reads
    // exactly like a complete one.
    truncated,
    summary: {
      models: modelsSeen,
      modelsWithRows,
      combinations,
      rows: rows.length,
      skipped: skipped.length,
      truncated: truncated.length,
    },
  };
}
/**
 * POR QUÉ NO SALIÓ NADA — la frase que se le enseña a quien apretó el botón.
 *
 * The message this replaces was `Ninguna combinación resolvió precio y
 * variante. Revisa que el barrido haya traído las páginas…`, and it was worse
 * than saying nothing: it sent somebody to re-run a sweep that had already
 * brought 169 pages, and said nothing about which of the four joins actually
 * came up empty. A refusal that does not know its own reason costs more than
 * the failure it reports.
 *
 * The census is read in the order the pipeline consumes it, so the FIRST thing
 * that is zero is the thing to fix — everything downstream of an empty stage is
 * empty by consequence, and reporting those too would bury the cause.
 */
export function diagnose(census, skipped = []) {
  const c = census || {};
  if (!c.paginas) {
    return 'La página no recibió ninguna ficha del barrido. Vuelve a abrir Carl Hansen y espera a que cargue el catálogo antes de importar.';
  }
  if (!c.conVariantes) {
    return `Llegaron ${c.paginas} páginas pero ninguna trae variantes. El barrido guardó las páginas de sección, no las de producto: vuelve a sincronizar.`;
  }
  if (!c.modelos) {
    return `${c.conVariantes} páginas traen variantes pero ninguna resolvió su ID de modelo contra el PIM, así que no hay ficha ni lista de precios que pedir.`;
  }
  if (!c.fichas && !c.listas) {
    return `${c.modelos} modelos, y la caché no devolvió ni una ficha ni una lista de precios. Es una lectura vacía, no un catálogo incompleto — reintenta.`;
  }
  if (!c.fichas) return `${c.modelos} modelos con lista de precios y ninguna ficha del fabricante en caché.`;
  if (!c.listas) return `${c.modelos} modelos con ficha y ninguna lista VAT0-USD en caché.`;

  // Everything arrived, so the models themselves were refused. Name the reason
  // that refused the most of them.
  const tally = new Map();
  for (const s of skipped || []) tally.set(s?.why || '—', (tally.get(s?.why || '—') || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    return `${c.modelos} modelos leídos y ninguno produjo filas. El motivo más común: ${top[0]} (${top[1]} modelos).`;
  }
  return `${c.modelos} modelos leídos, ${c.fichas} fichas y ${c.listas} listas — y ninguna combinación resolvió precio y variante.`;
}

/* ============================================================ the 3D queue == */

/**
 * EL 3D DE TODO EL CATÁLOGO — what one press should convert, and what it must
 * honestly report it cannot.
 *
 * The per-model panel (ChMeshPanel) converts ONE archive: inspect, convert,
 * review the binding. Right for tuning one chair; the wrong way to GET the
 * range usable — ~100 of 133 furniture models ship web geometry, and clicking
 * them one by one is the same several-hundred-click hole the bulk import
 * closed for prices.
 *
 * This resolver decides the QUEUE, pure, from the same inputs the panel reads
 * (`resolveCarlHansenAssets` over page + asset row), so the two can never
 * disagree about a model's state:
 *
 *   • `convertible` / `unclassified`  → queued (why: 'nuevo'). Unclassified
 *     archives are queued too — the driver reads the directory (a few KB)
 *     and refuses tier-none BEFORE downloading megabytes.
 *   • a converted mesh on an older pipeline version → queued (why: 'version')
 *     when the caller says which version is current. Re-converting from the
 *     kept source is exactly what `meshSourceUrl` exists for.
 *   • `ready` / `needs-review`        → counted, never re-done: a reviewed
 *     binding is a human's signature and a pending review is a human's turn,
 *     not the machine's.
 *   • `no-asset` / `revit-only` / `not-web-usable` → counted and NAMED. ~19%
 *     of the range publishes no usable 3D; saying so plainly is the difference
 *     between "esto está roto" and "esta pieza no trae 3D".
 *
 * One model can span several pages (BM0488's two bench lengths); the first
 * page that yields a zip wins and the model is queued once.
 */
export function resolveCarlHansenMeshQueue(pages, assets, { meshV = null } = {}) {
  const byId = new Map();
  for (const row of assets || []) {
    const id = str(row?.id);
    if (id) byId.set(id, row);
  }

  const queue = [];
  const counts = {
    ready: 0, needsReview: 0, queued: 0, stale: 0, noAsset: 0, revitOnly: 0, notUsable: 0,
  };
  const seen = new Set();

  for (const page of pages || []) {
    const modelId = str(page?.modelId);
    if (!modelId || seen.has(modelId)) continue;
    if (!Array.isArray(page?.variants) || !page.variants.length) continue; // cursor rows
    seen.add(modelId);

    const view = resolveCarlHansenAssets(page, byId.get(modelId) || null);
    switch (view.state) {
      case 'ready':
        if (meshV != null && view.meshV !== meshV && view.zipUrl) {
          counts.stale += 1;
          queue.push({ modelId, zipUrl: view.zipUrl, zipName: view.zipName || '', why: 'version' });
        } else counts.ready += 1;
        break;
      case 'needs-review':
        counts.needsReview += 1;
        break;
      case 'convertible':
      case 'unclassified':
        counts.queued += 1;
        queue.push({ modelId, zipUrl: view.zipUrl, zipName: view.zipName || '', why: 'nuevo' });
        break;
      case 'revit-only':
        counts.revitOnly += 1;
        break;
      case 'not-web-usable':
        counts.notUsable += 1;
        break;
      default:
        counts.noAsset += 1;
    }
  }

  return { queue, counts, models: seen.size };
}
