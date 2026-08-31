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
} from './carlHansen.js';
import { parseSelectionTree, enumerateSelections, configurationIds } from '../../brands/carl-hansen/selectionTree.js';

const str = (v) => String(v ?? '').trim();

/**
 * ONE MODEL'S SHARE OF THE PLAN.
 *
 * Split out of the bulk pass because the bulk pass is not allowed to be one
 * synchronous call any more. Walking ~200 masters × up to `comboCap`
 * selections each is millions of resolver calls, and doing them all inside a
 * single tick froze the browser solid — no progress, no cancel, "page
 * unresponsive". The caller now drives this one model at a time and yields
 * between them, so the tab stays alive and the count moves.
 *
 * Pure and self-contained: it dedupes nothing globally (the caller owns the
 * EAN map, because "first writer wins" is a decision across models).
 */
export function resolveCarlHansenModelPlan(entry, {
  profileId = '',
  now = Date.now(),
  comboCap = 2000,
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
  // does not publish a price file for every model it lists — BA103 and AJ52
  // 404 in USD, EUR and DKK alike, from the blob, unauthenticated. Those are
  // products outside the export list, not a failed download and not a lost
  // credential.
  if (!spec) { out.skipped = { modelId, why: 'sin ficha del fabricante' }; return out; }
  if (!priceRow) { out.skipped = { modelId, why: 'sin lista de precios' }; return out; }

  const configs = configurationIds(spec);
  const configIds = configs.length ? configs.map((c) => c.id) : [null];

  for (const configId of configIds) {
    const axes = parseSelectionTree(spec, configId ?? undefined);
    if (!axes.length) continue;

    const { selections, truncated: cut, total } = enumerateSelections(axes, { cap: comboCap });
    if (cut) out.truncated.push({ modelId, configId, kept: selections.length, total });

    for (const selection of selections) {
      out.combinations += 1;
      let plan;
      try {
        plan = resolveCarlHansenImportPlan(spec, page, priceRow, selection, { now, profileId, configId });
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
 * brought 169 pages, and named none of the four joins that could actually have
 * come up empty. A refusal that does not know its own reason costs more than
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
