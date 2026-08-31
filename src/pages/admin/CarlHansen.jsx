import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CloudDownload, ExternalLink, Loader2, PackageSearch, Shield, Square,
} from 'lucide-react';
import { db, invalidate, productsByBrand } from '../../db/database.js';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import ChMeshPanel from '../../components/carlhansen/ChMeshPanel.jsx';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDateTime } from '../../lib/format.js';
import {
  CH_PRICE_MARKET, SWEEP_IN_PROGRESS, chPriceRowId, drainCarlHansenSweep,
  fetchCarlHansenModel, fetchCarlHansenPrices,
} from '../../lib/carlHansenClient.js';
import {
  CH_BROWSER_LIMIT,
  chModelName,
  resolveCarlHansenBrowser,
  resolveCarlHansenConfigurator,
  resolveCarlHansenImportPlan,
} from '../../core/catalog/index.js';
import ChModelGrid from '../../components/carlhansen/ChModelGrid.jsx';
import ChConfigurator from '../../components/carlhansen/ChConfigurator.jsx';
import ChImportBar from '../../components/carlhansen/ChImportBar.jsx';
import ChBulkImportBar from '../../components/carlhansen/ChBulkImportBar.jsx';
import { BRAND_CARL_HANSEN } from '../../lib/constants.js';
import VariantBrowser from '../../components/catalog/VariantBrowser.jsx';

/**
 * Catálogo Carl Hansen & Søn — the dealer browses the Danish range, configures
 * a piece against its REAL factory selection tree, sees the ex-VAT USD list
 * price recompute per selection, and imports that exact configuration into
 * `products`.
 *
 * TWO SOURCES, TWO CLOCKS, and that shapes this whole page:
 *   • the PRODUCT PAGES (`carl_hansen_pages`) carry the variant EANs, the
 *     renders and the lead times. They are ~500 KB of HTML each and a full
 *     furniture sweep is ~66 MB against Carl Hansen's own servers, so the
 *     sweep is SERVER-SIDE, batched (25 pages at a time, six concurrent) and,
 *     most importantly here, **MANUAL**. This page NEVER sweeps on mount, and
 *     it always shows `remaining` — a bounded read whose leftovers are hidden
 *     looks exactly like a complete one.
 *     ONE PRESS FINISHES IT. The server drains batch after batch inside one
 *     invocation and this page asks for the next drain while work remains, so
 *     the dealer clicks once instead of seven times (the section pages sort
 *     FIRST, so the early clicks used to import nothing and read as a broken
 *     importer). The browser is never the engine: the cursor is `fetched_at`
 *     in the DB, so closing the tab loses nothing.
 *   • the BLOB reads (`carl_hansen_specs`, `carl_hansen_prices`) are the
 *     configurator and the price list: two small JSON files per model, on
 *     their own refresh clock. Opening a model whose ficha isn't cached pulls
 *     those two ONCE (see `ModelDetail`) — that is a different cost class from
 *     the sweep, and the alternative is a chair that can't be configured until
 *     somebody presses a second button.
 *
 * The page derives nothing: `resolveCarlHansenBrowser` owns the grid,
 * `resolveCarlHansenConfigurator` the configurator, `resolveCarlHansenImportPlan`
 * what the import would write. Money rules (null price is a blocker, expired
 * list is a blocker, cost is never written, stock is never written) live in
 * those resolvers and in the Models beneath them.
 */
/** Nothing has run in this tab yet. Also the shape every field is reset to. */
const IDLE_SWEEP = {
  running: false, stopping: false, totals: null, last: null,
  unresolved: [], errors: [], outcome: '', error: '',
};

export default function CarlHansen() {
  const { profileId, isAdmin, currentProfile, realProfile, settings } = useApp();
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState({});
  const [openId, setOpenId] = useState('');
  const [sweep, setSweep] = useState(IDLE_SWEEP);

  // The page cache: ~133 rows carrying their variants verbatim. Cached because
  // the payload is a few hundred KB and every keystroke re-renders off it; a
  // server-side sweep purges it explicitly below (the client can't see a write
  // it didn't make).
  const pagesQ = useLiveQueryStatus(
    () => (profileId
      ? db.carlHansenPages.where('profileId').equals(profileId).cached(60_000).toArray()
      : Promise.resolve([])),
    [profileId],
    [],
  );
  // Presence only — the grid flags "sin ficha" / "sin precio", it doesn't read
  // either payload, so both reads are trimmed to their keys.
  const specsQ = useLiveQueryStatus(
    () => (profileId
      ? db.carlHansenSpecs.where('profileId').equals(profileId).columns(['id']).cached(60_000).toArray()
      : Promise.resolve([])),
    [profileId],
    [],
  );
  const pricesQ = useLiveQueryStatus(
    () => (profileId
      ? db.carlHansenPrices.where('profileId').equals(profileId).columns(['id', 'modelId', 'marketCode']).cached(60_000).toArray()
      : Promise.resolve([])),
    [profileId],
    [],
  );

  // WHAT IS ACTUALLY IN THE CATALOG — the imported `products` rows, not the
  // swept pages. The grid above browses the MANUFACTURER's range; this browses
  // what we can quote, grouped by model (a Wishbone is 41 rows and one chair).
  const importedQ = useLiveQueryStatus(
    () => (profileId ? productsByBrand(profileId, BRAND_CARL_HANSEN) : Promise.resolve([])),
    [profileId],
    [],
  );

  // Only the ex-VAT USD list counts as "this model has a price": the table is
  // keyed for 22 markets and a DKK list is somebody else's money.
  const usdPrices = useMemo(
    () => pricesQ.data.filter((row) => (row.marketCode || CH_PRICE_MARKET) === CH_PRICE_MARKET),
    [pricesQ.data],
  );

  const browser = useMemo(() => resolveCarlHansenBrowser(pagesQ.data, {
    search,
    designer: activeFilters.designer || '',
    category: activeFilters.category || '',
    // Null until loaded: a card must stay silent about a gap nobody has looked
    // for yet, instead of flashing "sin ficha" over every model on first paint.
    specs: specsQ.loaded ? specsQ.data : null,
    prices: pricesQ.loaded ? usdPrices : null,
  }), [pagesQ.data, search, activeFilters, specsQ.loaded, specsQ.data, pricesQ.loaded, usdPrices]);

  const filters = useMemo(() => [
    {
      key: 'designer',
      label: 'Diseñador',
      type: 'select',
      options: browser.designers.map((f) => ({ value: f.value, label: `${f.label} (${f.count})` })),
    },
    {
      key: 'category',
      label: 'Categoría',
      type: 'select',
      options: browser.categories.map((f) => ({ value: f.value, label: `${f.label} (${f.count})` })),
    },
  ], [browser.designers, browser.categories]);

  const openPage = useMemo(
    () => pagesQ.data.find((row) => row.id === openId) || null,
    [pagesQ.data, openId],
  );

  // ── The sync loop ─────────────────────────────────────────────────────────
  //
  // ONE PRESS FINISHES THE JOB. The server drains many batches per invocation
  // and owns the cursor (`carl_hansen_pages.fetched_at`); this loop only asks
  // for the next drain while work remains. So the browser is never the engine:
  // closing the tab, locking the phone or losing the network costs at most the
  // drain in flight, and pressing again resumes exactly where it stopped.
  //
  // Three refs, each load-bearing:
  //   busyRef  — a second press (or a double-click) must not start a second
  //              loop. The server would refuse it anyway (`sweep_in_progress`),
  //              but refusing here keeps that refusal off the dealer's screen.
  //   stopRef  — read by the Model INSIDE the loop, after every await, which is
  //              what makes «Detener» actually stop instead of only relabelling
  //              the button.
  //   tokenRef — retires a run. Bumped on unmount and on a new run, so a reply
  //              that lands late can never write state for a run that is over.
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const tokenRef = useRef(0);
  useEffect(() => () => { tokenRef.current += 1; }, []);

  const runSweep = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopRef.current = false;
    const token = (tokenRef.current += 1);
    const alive = () => tokenRef.current === token;
    setSweep({ ...IDLE_SWEEP, running: true });

    try {
      const result = await drainCarlHansenSweep({
        shouldStop: () => stopRef.current,
        onProgress: ({ report, totals, unresolved, errors }) => {
          if (!alive()) return;
          // Every drain writes server-side, so nothing in this tab knows the
          // cache moved — purge it after each one and the grid fills as it goes.
          invalidate(['carlHansenPages']);
          setSweep((s) => ({ ...s, last: report, totals, unresolved, errors }));
        },
      });
      if (!alive()) return;
      // A stopped run still landed rows in the drain it interrupted; re-read so
      // the grid shows them even though its report was discarded.
      if (result.reason === 'stopped') invalidate(['carlHansenPages']);
      setSweep((s) => ({
        ...s,
        running: false,
        stopping: false,
        outcome: result.reason,
        totals: result.totals,
        last: result.last ?? s.last,
        unresolved: result.unresolved,
        errors: result.errors,
      }));
    } catch (e) {
      console.error('[CarlHansen] sweep failed:', e);
      invalidate(['carlHansenPages']);
      if (!alive()) return;
      // Another tab (or another admin) already owns the sweep. That is the
      // claim working, not a failure — a red alert for it would send the dealer
      // looking for a bug in a system that is doing exactly its job.
      const busy = e?.code === SWEEP_IN_PROGRESS;
      setSweep((s) => ({
        ...s,
        running: false,
        stopping: false,
        outcome: busy ? 'busy' : 'error',
        error: busy ? '' : userMessageFor(e),
      }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  // «Detener» sets the flag the loop re-reads after its await; the drain
  // already in flight finishes server-side (its rows are saved) but its reply
  // is discarded, so it cannot revive the loop.
  const stopSweep = useCallback(() => {
    if (!busyRef.current) return;
    stopRef.current = true;
    setSweep((s) => ({ ...s, stopping: true }));
  }, []);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Carl Hansen & Søn" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden gestionar los catálogos de marca."
        />
      </>
    );
  }

  const userId = realProfile?.id || currentProfile?.id || null;
  // Empty means NO MODELS, not no rows: a sweep can legitimately cache 25 urls
  // and yield zero products if the batch happened to land on section pages, and
  // an unexplained blank grid reads as a broken importer.
  const empty = pagesQ.loaded && browser.catalogued === 0;
  // Never claims completeness: the sweep is bounded, so "en caché" is all this
  // page can honestly say until a run reports its own `remaining`.
  // Count MODELS, not rows. The sweep also stores a cursor row for every url it
  // read that turned out to be a section or redirect page (~32 of ~165), so the
  // raw row count overstates the catalogue by a third and never matches what the
  // grid shows.
  const subtitle = browser.catalogued
    ? `${browser.catalogued} modelo(s) en caché`
      + (browser.skipped ? ` · ${browser.skipped} página(s) sin producto` : '')
      + ' · sincroniza para traer el resto'
    : ' ';

  return (
    <>
      <PageHeader
        title="Carl Hansen & Søn"
        subtitle={subtitle}
        actions={<SweepControls state={sweep} onRun={runSweep} onStop={stopSweep} />}
      />

      <SweepReport state={sweep} syncedAt={settings?.carlHansenSyncedAt ?? null} />

      {/* THE WHOLE RANGE IN ONE PRESS. Configuring piece by piece is still
          there, below, for quoting one chair — this is for having the catalog.
          Hidden while a model is open: it is a list-level action. */}
      {!openPage && (
        <div className="space-y-3 mb-4">
          <ChBulkImportBar
            profileId={profileId}
            pages={pagesQ.data}
            onDone={() => invalidate(['products'])}
          />
          {/* EL CATÁLOGO IMPORTADO, a la vista. It was folded inside a
              `<details>`, so the thing a dealer actually quotes from was the
              one thing you had to go looking for — while the un-imported PIM
              range filled the page below. Same component, same card grid and
              same search header the Fredericia catalogue renders. */}
          {importedQ.loaded && importedQ.data.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-ink-900">
                Catálogo importado · {importedQ.data.length} referencias
              </h2>
              <VariantBrowser products={importedQ.data} />
            </section>
          )}
        </div>
      )}

      {openPage ? (
        <ModelDetail
          key={openPage.id}
          page={openPage}
          profileId={profileId}
          userId={userId}
          onBack={() => setOpenId('')}
        />
      ) : !pagesQ.loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={6} /></div>
      ) : empty ? (
        <EmptyState
          icon={PackageSearch}
          title="Catálogo sin sincronizar"
          description="Carl Hansen publica su PIM completo. «Sincronizar» lee las páginas de producto en el servidor, tanda tras tanda, hasta terminar — un solo clic. Son ~66 MB contra los servidores de Carl Hansen, por eso nunca corre solo. Puedes cerrar la pestaña: el avance queda guardado y al volver continúa donde iba."
          action={<SweepControls state={sweep} onRun={runSweep} onStop={stopSweep} />}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar por modelo, nombre o diseñador…"
            filters={filters}
            activeFilters={activeFilters}
            onFiltersChange={setActiveFilters}
            resultCount={browser.total}
            resultNoun={['modelo', 'modelos']}
          />

          {browser.unresolved.length > 0 && (
            <p className="notice notice-sm notice-warn mb-3">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
              <span>
                {browser.unresolved.length} modelo(s) con datos incompletos (sin ficha, sin lista de
                precios o con el ID sin resolver). Siguen en la parrilla, marcados — nunca se ocultan.
              </span>
            </p>
          )}

          {browser.models.length === 0 ? (
            <div className="card px-4 py-10 text-center text-sm text-ink-500">
              Sin coincidencias para esa búsqueda.
            </div>
          ) : (
            <ChModelGrid models={browser.models} selectedId={openId} onSelect={(card) => setOpenId(card.id)} />
          )}

          {browser.more > 0 && (
            <p className="mt-3 text-micro text-ink-500">
              Mostrando los primeros {CH_BROWSER_LIMIT} de {browser.total}. Afina la búsqueda o los
              filtros para ver el resto.
            </p>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ sweep -- */

/** Pages this session has actually read, whatever the outcome per page. */
const pagesRead = (t) => (t ? t.fetched + t.unchanged + t.skipped : 0);

/**
 * Start it, watch it, stop it.
 *
 * «Detener» is a real control, not a label: pressing it makes the loop drop the
 * drain in flight and exit. It is shown for the whole run precisely because a
 * run is now minutes long — a button the dealer cannot interrupt would be worse
 * than the seven clicks this replaced.
 */
function SweepControls({ state, onRun, onStop }) {
  if (state.running) {
    const read = pagesRead(state.totals);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-600">
          <Loader2 size={13} className="animate-spin" aria-hidden />
          {read ? `Sincronizando… ${read} página(s) leídas` : 'Sincronizando…'}
        </span>
        <button
          type="button"
          onClick={onStop}
          disabled={state.stopping}
          className="btn-secondary disabled:opacity-60"
        >
          <Square size={13} aria-hidden /> {state.stopping ? 'Deteniendo…' : 'Detener'}
        </button>
      </div>
    );
  }
  const remaining = state.last ? state.last.remaining : 0;
  return (
    <button type="button" onClick={onRun} className="btn-primary">
      <CloudDownload size={14} aria-hidden />
      {remaining > 0 ? `Continuar (${remaining} restantes)` : 'Sincronizar'}
    </button>
  );
}

/**
 * What the sync did — and, always, what it did NOT do.
 *
 * `remaining` is never hidden: a drain is bounded by a wall clock, so any run
 * may still be an incomplete read and this counter is the only thing that says
 * so. The four non-«done» outcomes each get their own sentence, because they
 * are genuinely different situations and lumping them under one amber warning
 * is how «se quedó pegado» becomes unanswerable:
 *   stopped   — the dealer ended it; nothing is wrong.
 *   stalled   — a drain came back having read nothing new, so continuing would
 *               ask for exactly the same work. Usually a page Carl Hansen is
 *               no longer serving.
 *   exhausted — the loop hit its own round ceiling. Should never happen.
 *   error     — the run broke; the message says how.
 */
function SweepReport({ state, syncedAt }) {
  const t = state.totals;
  const r = state.last;
  const stampedAt = Number.isFinite(syncedAt) ? formatDateTime(syncedAt) : '';

  if (state.error) {
    return (
      <p role="alert" className="notice notice-sm notice-danger mb-4 items-center">
        <AlertTriangle size={14} className="flex-shrink-0" aria-hidden /> {state.error}
      </p>
    );
  }
  if (state.outcome === 'busy') {
    return (
      <p className="notice notice-sm notice-warn mb-4">
        <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
        <span>
          Ya hay una sincronización corriendo (otra pestaña o alguien más del equipo). Solo puede
          correr una a la vez — se lee mucho de los servidores de Carl Hansen. Espera a que termine
          y vuelve a pulsar.
        </span>
      </p>
    );
  }
  // Nothing has run in this tab: say when the catalogue last finished, so a
  // dealer who closed the tab mid-sync knows the work survived it.
  if (!t && !r) {
    return stampedAt ? (
      <p className="mb-4 text-xs text-ink-500">Última sincronización completa: {stampedAt}.</p>
    ) : null;
  }

  const remaining = r ? r.remaining : 0;
  const done = state.outcome === 'done';
  return (
    <div className="mb-4 space-y-1.5 rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2.5 text-xs text-ink-600">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {done
          ? <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300"><Check size={13} aria-hidden /> Catálogo al día</span>
          : <span className="font-medium text-ink-800">Quedan {remaining} página(s) por leer</span>}
        <span className="tabular-nums">{t ? t.fetched : 0} nuevas</span>
        <span className="tabular-nums">{t ? t.unchanged : 0} sin cambios</span>
        <span className="tabular-nums">{t ? t.skipped : 0} no son producto</span>
        {t && t.failed > 0 ? <span className="tabular-nums text-status-warning-ink">{t.failed} fallaron</span> : null}
      </p>

      {state.running ? (
        <p className="text-ink-500">
          El servidor sigue leyendo por tandas. Puedes cerrar la pestaña: el avance queda guardado
          y al volver continúa donde iba.
        </p>
      ) : null}
      {state.outcome === 'stopped' ? (
        <p>Detenida. La tanda que iba en curso terminó de guardarse; pulsa «Continuar» cuando quieras seguir.</p>
      ) : null}
      {state.outcome === 'stalled' ? (
        <p className="text-amber-700 dark:text-amber-300">
          Se detuvo sola: la última tanda no leyó ninguna página nueva y quedan {remaining} pendientes,
          así que insistir pediría exactamente lo mismo. Suele ser una página que Carl Hansen ya no
          sirve — mira los errores de abajo.
        </p>
      ) : null}
      {state.outcome === 'exhausted' ? (
        <p className="text-amber-700 dark:text-amber-300">
          Se detuvo por seguridad tras demasiadas tandas seguidas. Pulsa «Continuar» para seguir.
        </p>
      ) : null}
      {!state.running && state.outcome !== 'done' && r?.partial ? (
        <p className="text-amber-700 dark:text-amber-300">
          La última tanda se cortó por tiempo del servidor; lo que faltó quedó contado arriba.
        </p>
      ) : null}
      {done && stampedAt ? <p className="text-ink-500">Sincronización completa: {stampedAt}.</p> : null}

      {state.unresolved.length > 0 ? (
        <p>
          {state.unresolved.length} página(s) no resolvieron su modelo en el PIM y quedaron
          marcadas (siguen visibles):{' '}
          <span className="text-ink-500">
            {state.unresolved.slice(0, 3).map((u) => u.productId || u.url).join(' · ')}
            {state.unresolved.length > 3 ? ' …' : ''}
          </span>
        </p>
      ) : null}
      {state.errors.length > 0 ? <p className="text-amber-700 dark:text-amber-300">{state.errors.join(' · ')}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- detail -- */

/**
 * ONE model: its configurator, its live price, and the import.
 *
 * The two blob reads behind it (the PIM master and the VAT0-USD price list)
 * are pulled ONCE per model when the cache has neither — a couple of small
 * JSON files for the chair the dealer just opened, which is a different cost
 * class from the 66 MB page sweep and is why this one is allowed to be
 * automatic. `tried` makes it exactly once: a model with no published master
 * (the measured `FK64_item` singleton) must report its 404 and stop, not
 * re-ask on every render.
 */
function ModelDetail({ page, profileId, userId, onBack }) {
  const modelId = page.modelId || '';
  const priceRowId = modelId ? chPriceRowId(modelId) : '';
  const { code, name } = chModelName(page.name);

  const specQ = useLiveQueryStatus(
    () => (modelId ? db.carlHansenSpecs.get(modelId) : Promise.resolve(null)),
    [modelId],
    null,
  );
  // The model's 3D state. Its own row rather than part of the page cache: a
  // converted mesh is USER STATE and survives a catalogue re-sweep (the
  // migration keeps no FK between the halves for exactly that reason).
  const assetQ = useLiveQueryStatus(
    () => (modelId ? db.carlHansenAssets.get(modelId) : Promise.resolve(null)),
    [modelId],
    null,
  );
  const priceQ = useLiveQueryStatus(
    () => (priceRowId ? db.carlHansenPrices.get(priceRowId) : Promise.resolve(null)),
    [priceRowId],
    null,
  );

  // A selection is keyed on AXIS IDS, and axis ids carry the configuration
  // (`CH24_Frame` vs `CH24-H43_Frame`), so switching configuration must clear
  // it — carrying it over would silently leave every axis on its default while
  // looking like a choice had been made.
  const [config, setConfig] = useState({ id: null, selection: {} });
  const [pull, setPull] = useState({ busy: false, error: '' });
  const tried = useRef(new Set());
  const selection = config.selection;

  const pullBlobs = useCallback(async () => {
    if (!modelId) return;
    setPull({ busy: true, error: '' });
    // The two reads are INDEPENDENT: CH086 publishes a master and no price
    // list, and a failure on one must not hide the other.
    const problems = [];
    try { await fetchCarlHansenModel(modelId); } catch (e) { problems.push(userMessageFor(e)); }
    try { await fetchCarlHansenPrices(modelId); } catch (e) { problems.push(userMessageFor(e)); }
    invalidate(['carlHansenSpecs', 'carlHansenPrices']);
    setPull({ busy: false, error: problems.join(' · ') });
  }, [modelId]);

  useEffect(() => {
    if (!modelId || !specQ.loaded || !priceQ.loaded) return;
    if (specQ.data && priceQ.data) return;
    if (tried.current.has(modelId)) return;
    tried.current.add(modelId);
    pullBlobs();
  }, [modelId, specQ.loaded, specQ.data, priceQ.loaded, priceQ.data, pullBlobs]);

  // Every configuration the master publishes, in published order. A one-step
  // projection of source data the ViewModels don't expose (they each work on
  // ONE configuration); its durable home is a `resolveCarlHansenConfigurations`
  // in core/catalog. NO-VANISH: disabled/discontinued configurations stay in
  // the list, marked — CH24 publishes nine and two of them are disabled.
  const configurations = useMemo(() => {
    const raw = Array.isArray(specQ.data?.configurations) ? specQ.data.configurations : [];
    const seen = new Set();
    const out = [];
    for (const cfg of raw) {
      const id = String(cfg?.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const friendly = String(cfg?.friendlyName ?? '').trim();
      out.push({
        id,
        label: friendly && friendly !== id ? `${id} · ${friendly}` : id,
        disabled: cfg?.isDisabled === true,
      });
    }
    return out;
  }, [specQ.data]);

  const configId = config.id;
  const view = useMemo(
    () => resolveCarlHansenConfigurator(specQ.data, priceQ.data, page, { selection, configId }),
    [specQ.data, priceQ.data, page, selection, configId],
  );
  // NOTE: this re-runs the whole configurator inside the plan — the tree parse
  // and the add-on probes happen TWICE per click. `resolveCarlHansenImportPlan`
  // has no way to take a prebuilt view; reusing one needs a `{ view }` option
  // in core/catalog, which belongs to another agent.
  const plan = useMemo(
    () => resolveCarlHansenImportPlan(specQ.data, page, priceQ.data, selection, { profileId, configId }),
    [specQ.data, page, priceQ.data, selection, profileId, configId],
  );

  // THE VIEW-LEVEL REFUSAL (see ChConfigurator's `ConfigCard` for the full
  // reasoning and the measurements): a selection carrying an IDENTITY add-on
  // is exactly the case `requiredLabels` is blind to, so its matched variants
  // belong to another configuration. Measured on the real CH24 page: CH24 and
  // CH24-H43 claim the SAME 21 EANs, every one $145 dearer under H43, and the
  // row id is `ch-<EAN>` — importing would restate the dealer's own rows at
  // the higher price. Browsing and pricing stay open; only the write stops.
  // NOTE: this refusal USED to be computed here and handed down as
  // `extraIssues`/`extraBlockers`. It now lives in `configuratorIssues`
  // (core/catalog) as `config-identity-addon`, where it is pinned by
  // tests/carlHansenViews.test.js — a rule that decides whether money may be
  // written does not belong in a View, where nothing can hold it still. It
  // arrives on `view.unresolved` and `plan.blockers` like every other check.

  const loading = !specQ.loaded || !priceQ.loaded || pull.busy;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="btn-ghost -ml-2 mb-1 text-xs">
            <ArrowLeft size={14} aria-hidden /> Volver al catálogo
          </button>
          <h2 className="font-display text-xl font-semibold text-ink-900">
            {code ? <span className="font-mono text-base text-ink-500">{code} · </span> : null}
            {view.modelName || name || page.name}
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            {page.designer || 'Sin diseñador'}
            {modelId ? <span className="ml-2 font-mono text-ink-500">{modelId}</span> : null}
          </p>
        </div>
        {page.url ? (
          <a href={page.url} target="_blank" rel="noreferrer" className="chip-action">
            <ExternalLink size={12} aria-hidden /> Ver en carlhansen.com
          </a>
        ) : null}
      </div>

      {pull.error ? (
        <p role="alert" className="notice notice-sm notice-warn">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden /> {pull.error}
        </p>
      ) : null}

      {loading ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : (
        <>
          <ChConfigurator
            view={view}
            onSelect={(axisId, key) => setConfig((prev) => ({
              ...prev,
              selection: { ...prev.selection, [axisId]: key },
            }))}
            configurations={configurations}
            onConfigChange={(id) => setConfig({ id, selection: {} })}
            extraIssues={[]}
            onRefresh={pullBlobs}
            refreshing={pull.busy}
          />

          <ChImportBar
            plan={plan}
            axes={view.axes}
            extraBlockers={[]}
            profileId={profileId}
            userId={userId}
          />

          {/* The 3D half. Its state comes from `resolveCarlHansenAssets` over
              `page` + the model's `carl_hansen_assets` row, and the conversion
              runs entirely in the browser from
              `src/components/carlhansen/chMeshImport.js` — that exact path is
              pinned by tests/carlHansen3d.test.js, which fails if anyone
              rebuilds the mesh machinery there. `axes` feeds the material
              binding, which is why the configurator's axes are passed through
              rather than re-derived. */}
          <ChMeshPanel
            page={page}
            asset={assetQ.data}
            axes={view.axes}
            modelId={modelId}
            onChange={() => invalidate('carlHansenAssets')}
          />
        </>
      )}
    </div>
  );
}
