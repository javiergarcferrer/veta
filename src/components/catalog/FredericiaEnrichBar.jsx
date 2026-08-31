import { useCallback, useState } from 'react';
import { Loader2, Factory, AlertTriangle, Sparkles } from 'lucide-react';
import { db, invalidate, productsByBrand } from '../../db/database.js';
import { supabase } from '../../db/supabaseClient.js';
import { planFredericiaMerge, rowsByModelCode } from '../../brands/fredericia/mergeSources.js';
import { mintCatalogPointers, stampPointerIds } from '../../db/catalogPointers.js';
import { splitConfiguration } from '../../lib/variantFacets.js';
import { configurationOf } from '../../core/catalog/variantGroups.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { BRAND_FREDERICIA } from '../../lib/constants.js';

/**
 * TRAER LO QUE FREDERICIA SÍ PUBLICA — sobre las filas que Anthom ya coteja.
 *
 * We buy through Anthom Design House, so Anthom is the source for the USD price
 * and always will be. It is the wrong source for everything else: a reseller
 * publishes a shop, so the options arrive mashed into one string, there is not
 * a single dimension on any of the references, and the photography is whatever
 * the shop chose.
 *
 * This walks the MANUFACTURER's own pages (the `fredericia-catalog` Edge
 * Function — named axes, real SKUs, dimensions, Cloudinary photos) and
 * enriches the rows in place:
 *
 *   • el NOMBRE con las palabras del fabricante, que llegan como ejes NOMBRADOS
 *     (`Upholstery`, `Wood`) en vez de inferirse de una lista de palabras;
 *   • las MEDIDAS, que el catálogo tenía en blanco;
 *   • las FOTOS de Cloudinary, y todas, con sus punteros (`freimg-…`);
 *   • el DISEÑADOR, la COLECCIÓN y el PLAZO;
 *   • el SKU DE FÁBRICA donde el fabricante publica esa variante.
 *
 * ── EL PRECIO NO SE TOCA ────────────────────────────────────────────────────
 * Not once, and not by accident: `planFredericiaMerge` does not even emit the
 * field. The manufacturer's page prices in DKK and EUR plus nine internal
 * groups, one labelled `USD` carrying numbers that are not dollars. Only one
 * source has a number in a unit we can quote, and it is Anthom.
 *
 * ── SE LEE ANTES DE ESCRIBIR ────────────────────────────────────────────────
 * The whole plan is computed first — including which references the
 * manufacturer's page could NOT claim, and why — and only then is there a
 * button. A join that guessed a wood would put a walnut price on an oak chair,
 * and nobody catches that by reading the quote.
 *
 * The invoke lives HERE, not in `src/brands/**` — the brands layer stays
 * ignorant of Supabase (the KvadratImport rule: effects are built at the page
 * and injected; the pure merge never sees a network).
 */

/** One op against the manufacturer walker. Throws with the server's message. */
async function fredericiaOp(body) {
  const { data, error } = await supabase.functions.invoke('fredericia-catalog', { body });
  if (error) {
    let msg = error.message || 'El catálogo de Fredericia no respondió.';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  return data;
}

export default function FredericiaEnrichBar({ profileId, onDone }) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);

  /** Read the manufacturer for every model we already carry, and plan. */
  const analyze = useCallback(async () => {
    if (!profileId) { setError('Falta el perfil destino.'); return; }
    setBusy(true); setError(''); setPlan(null);
    try {
      setPhase('Leyendo el catálogo importado…');
      const mine = await productsByBrand(profileId, BRAND_FREDERICIA);
      const byCode = rowsByModelCode((mine || []).map((p) => ({
        // The id is what makes this a PATCH and not an insert — see mergeSources.
        id: p.id,
        reference: p.reference,
        familyCode: p.familyCode,
        // The configuration as ANTHOM spelled it — the same split the browser
        // uses, so what the merge reads is what the catalogue shows.
        configuration: splitConfiguration(configurationOf(p)),
      })));

      setPhase('Preguntando a Fredericia qué publica…');
      const list = await fredericiaOp({ op: 'models' });
      if (!list?.ok) throw new Error(list?.error || 'El sitemap no respondió.');
      // Only the models we actually carry. Walking the whole sitemap to enrich
      // the few we sell would be hundreds of requests for nothing.
      const wanted = (list.models || []).filter((m) => m.code && byCode.has(m.code));

      const rows = [];
      const unmatched = [];
      const missing = [];
      for (let i = 0; i < wanted.length; i += 1) {
        const m = wanted[i];
        setPhase(`Leyendo fichas… ${i + 1}/${wanted.length}`);
        const res = await fredericiaOp({ op: 'product', slug: m.slug }).catch(() => null);
        if (!res?.ok) { missing.push(m.code); continue; }
        const one = planFredericiaMerge(res.product, byCode.get(m.code));
        rows.push(...one.rows);
        unmatched.push(...one.unmatched);
      }
      setPlan({
        rows,
        unmatched,
        missing,
        models: wanted.length,
        // Models we carry that the manufacturer's sitemap does not list at all.
        absent: [...byCode.keys()].filter((c) => !wanted.some((m) => m.code === c)).length,
      });
    } catch (e) {
      setError(userMessageFor(e) || e?.message || 'No se pudo leer el catálogo del fabricante.');
    } finally {
      setBusy(false); setPhase('');
    }
  }, [profileId]);

  const apply = useCallback(async () => {
    if (!plan?.rows?.length) return;
    setBusy(true); setError('');
    try {
      setPhase('Registrando fotos…');
      const { byUrl, skipped } = await mintCatalogPointers(plan.rows, {
        prefix: 'freimg', kind: 'catalog-fredericia', ownerId: 'fredericia-catalog',
      });
      const rows = stampPointerIds(plan.rows, byUrl, skipped);

      setPhase('Guardando…');
      const CHUNK = 300;
      for (let i = 0; i < rows.length; i += CHUNK) {
        // A PATCH keyed on `id`: PostgREST's merge-duplicates upsert sets only
        // the columns present, so the price, the cost and the stock — none of
        // which are in this payload — are left exactly as the Anthom import
        // wrote them.
        await db.products.bulkPut(rows.slice(i, i + CHUNK));
      }
      invalidate(['products']);
      setPlan(null);
      onDone?.(rows.length);
    } catch (e) {
      setError(userMessageFor(e) || e?.message || 'No se pudo guardar.');
    } finally {
      setBusy(false); setPhase('');
    }
  }, [plan, onDone]);

  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 inline-flex items-center gap-1.5">
            <Factory size={15} className="opacity-70" aria-hidden />
            Enriquecer con el catálogo de Fredericia
          </div>
          <p className="text-xs text-ink-500 mt-0.5 max-w-prose">
            Anthom pone el precio en dólares; Fredericia pone lo demás — ejes con
            nombre, medidas, fotos del fabricante, diseñador y plazo.
            <strong> El precio no se toca.</strong>
          </p>
        </div>
        <button
          type="button"
          onClick={plan ? apply : analyze}
          disabled={busy}
          className="btn btn-secondary min-h-11 whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? (phase || 'Trabajando…') : plan ? `Enriquecer ${plan.rows.length}` : 'Analizar'}
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {plan && (
        <div className="text-xs text-ink-600 space-y-1">
          <div>
            <strong className="text-ink-900">{plan.rows.length}</strong> referencias se enriquecen ·{' '}
            {plan.models} modelos leídos del fabricante
          </div>
          {/* Nothing hidden: a join that quietly dropped what it could not read
              would look exactly like one that read everything. */}
          {plan.unmatched.length > 0 && (
            <details className="text-ink-500">
              <summary className="cursor-pointer">{plan.unmatched.length} no cruzaron — ver por qué</summary>
              <ul className="mt-1 space-y-0.5 font-mono text-micro">
                {plan.unmatched.slice(0, 20).map((u) => (
                  <li key={u.reference}>{u.reference}: {u.why}</li>
                ))}
              </ul>
            </details>
          )}
          {plan.absent > 0 && (
            <div className="text-ink-500">{plan.absent} modelos nuestros no están en el sitemap de Fredericia.</div>
          )}
          {plan.missing.length > 0 && (
            <div className="text-amber-700">{plan.missing.length} fichas no respondieron.</div>
          )}
        </div>
      )}
    </div>
  );
}
