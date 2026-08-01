/**
 * THE CONFIGURATOR — the app the iframe loads.
 *
 * MVVM, the same way the reference is built: this file WIRES, it does not
 * derive. Every non-trivial answer on screen comes from a pure module in
 * `src/vm/` — the catalog projection, the plan reducer, the estimate, the rule
 * verdict, the scene spec, the share codec, the lead payload — so all of them
 * are unit-tested without a browser and none of them can be quietly recomputed
 * a second, different way inside a component.
 *
 * What lives here and nowhere else: fetching, React state, and the postMessage
 * bridge that makes the frame self-sizing and tells the host page when a design
 * changed, was priced, or converted.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createWidgetBridge, handoffUrl } from '@veta/widget-sdk';
import { t } from '@veta/i18n';
import PlanEditor from './components/PlanEditor.tsx';
import SceneView from './components/SceneView.tsx';
import MaterialsPanel from './components/MaterialsPanel.tsx';
import RulesPanel from './components/RulesPanel.tsx';
import EstimateDeck from './components/EstimateDeck.tsx';
import LeadForm from './components/LeadForm.tsx';
import ArViewer from './components/ArViewer.tsx';
import { parseWidgetParams, paramsError } from './vm/params.ts';
import { createApiClient } from './vm/client.ts';
import { resolveWidgetCatalog, type WidgetCatalog } from './vm/catalog.ts';
import {
  editorCanRedo, editorCanUndo, editorReducer, initialEditorState,
  type EditorAction, type EditorContext,
} from './vm/editor.ts';
import { resolveEstimate } from './vm/pricing.ts';
import { resolveRulesFeedback } from './vm/rules.ts';
import { resolveSceneView } from './vm/scene.ts';
import { encodeCurrentBuild, pickBootBuild, readStoredBuild, restoreBuild, writeStoredBuild } from './vm/share.ts';
import { buildLeadPayload, leadDedupeKey, type LeadForm as LeadFormValues } from './vm/lead.ts';
import { availableExports, buildPlanDxf, exportFilename } from './vm/exports.ts';
import { createMaterialSource } from './vm/materials.ts';
import { browserImageOps } from './lib/imageOps.ts';
import { downloadFile, exportGlb, exportObj } from './lib/sceneExport.ts';

/**
 * `card` is the LAUNCH CARD the plain embed opens on: a host page drops the
 * iframe into a content column, and a card that reports its own natural height
 * shrink-wraps to it. `ctx=modal` (an overlay, or a scanned handoff carrying a
 * build) skips it — there is never a card inside a card, and a handed-off design
 * must never be thrown away by a screen that asks the visitor to start.
 */
type Screen = 'card' | 'plan' | 'view' | 'lead' | 'done';

const EMPTY_CATALOG: WidgetCatalog = resolveWidgetCatalog({ payload: null });

export default function App() {
  const params = useMemo(
    () => parseWidgetParams(globalThis.location?.href ?? '', {
      navigator: globalThis.navigator?.languages ?? null,
      defaultApiBase: import.meta.env?.VITE_API_BASE ?? '',
    }),
    [],
  );
  const locale = params.locale;

  const [catalog, setCatalog] = useState<WidgetCatalog>(EMPTY_CATALOG);
  const [loadError, setLoadError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>(params.straightIn ? 'plan' : 'card');
  const [arOpen, setArOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const client = useMemo(
    () => createApiClient({
      apiBase: params.apiBase, publishableKey: params.publishableKey, dealer: params.dealer,
    }),
    [params.apiBase, params.publishableKey, params.dealer],
  );

  const ctx: EditorContext = useMemo(
    () => ({ modelById: catalog.modelById, params: catalog.collection.layoutParams }),
    [catalog],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [state, rawDispatch] = useReducer(
    (prev: ReturnType<typeof initialEditorState>, action: EditorAction) => editorReducer(prev, action, ctxRef.current),
    undefined,
    initialEditorState,
  );
  const dispatch = useCallback((action: EditorAction) => rawDispatch(action), []);

  // ── the catalog: ONE bootstrap read ───────────────────────────────────────
  useEffect(() => {
    if (paramsError(params)) { setLoading(false); return undefined; }
    let alive = true;
    (async () => {
      try {
        const payload = await client.catalog();
        if (!alive) return;
        const resolved = resolveWidgetCatalog({ payload, collectionSlug: params.collection });
        if (!resolved.collection.id) { setLoadError('error.unavailable'); setLoading(false); return; }
        setCatalog(resolved);
        setLoading(false);
      } catch {
        if (alive) { setLoadError('error.load'); setLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, [client, params]);

  // ── restore a handed-off / stored build once the catalog is known ─────────
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || loading || !catalog.palette.length) return;
    restoredRef.current = true;
    const stored = readStoredBuild(globalThis.localStorage, catalog.collection.slug);
    const encoded = pickBootBuild(params.build, stored);
    if (!encoded) return;
    const { placed, room } = restoreBuild(encoded, catalog.modelById);
    if (placed.length) dispatch({ type: 'restore', placed, room });
  }, [loading, catalog, params.build, dispatch]);

  // ── derived views (every one of them a pure VM) ───────────────────────────
  const estimate = useMemo(
    () => resolveEstimate(state.placed, catalog.modelById, {
      mode: catalog.collection.pricingMode, currency: catalog.collection.currency,
    }),
    [state.placed, catalog],
  );
  const feedback = useMemo(
    () => resolveRulesFeedback(catalog.ruleset, state.placed, catalog.ruleCatalog, locale),
    [catalog, state.placed, locale],
  );
  const sceneView = useMemo(() => resolveSceneView(state.placed, catalog.modelById), [state.placed, catalog]);
  const build = useMemo(() => encodeCurrentBuild(state.placed, state.room), [state.placed, state.room]);
  const materialSource = useMemo(() => createMaterialSource(catalog.colorByCode), [catalog]);
  const exportOptions = useMemo(
    () => ({ source: materialSource, imageOps: browserImageOps, renderParams: catalog.collection.renderParams }),
    [materialSource, catalog],
  );

  // ── the host bridge: self-sizing + the three milestone events ─────────────
  const bridge = useMemo(() => createWidgetBridge({}), []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const report = () => {
      const height = rootRef.current?.getBoundingClientRect().height ?? 0;
      bridge.emitHeight(height);
    };
    report();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    if (rootRef.current && observer) observer.observe(rootRef.current);
    return () => observer?.disconnect();
  }, [bridge]);

  useEffect(() => { bridge.emit('ready', { locale, collection: catalog.collection.slug }); }, [bridge, locale, catalog.collection.slug]);

  useEffect(() => {
    // The design changed: tell the host, and snapshot it on the device so a
    // reload resumes instead of starting over.
    writeStoredBuild(globalThis.localStorage, catalog.collection.slug, build);
    bridge.emit('configured', { build, pieces: state.placed.length, ok: feedback.canSubmit });
    bridge.emit('priced', { total: estimate.total, currency: estimate.currency, pieces: estimate.pieces });
  }, [bridge, build, state.placed.length, feedback.canSubmit, estimate, catalog.collection.slug]);

  // ── actions ───────────────────────────────────────────────────────────────
  const submitLead = async (form: LeadFormValues) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = buildLeadPayload({
        form,
        placed: state.placed,
        room: state.room,
        collectionSlug: catalog.collection.slug,
        build,
        dedupeKey: leadDedupeKey(form, build),
        source: { locale, embed: params.context, referrer: globalThis.document?.referrer ?? '' },
      });
      const result = await client.submitLead(payload);
      bridge.emit('submitted', { id: result.id ?? null, deduped: !!result.deduped });
      setScreen('done');
    } catch {
      // The typed contact stays on screen; the dedupe key makes a retry safe.
      setSubmitError(t(locale, 'form.errorSend'));
    } finally {
      setSubmitting(false);
    }
  };

  const download = async (kind: 'dxf' | 'glb' | 'obj') => {
    const stem = `${catalog.collection.name || 'veta'}`;
    try {
      if (kind === 'dxf') {
        const dxf = buildPlanDxf(state.placed, catalog.modelById, { label: catalog.collection.name });
        downloadFile(dxf, exportFilename(stem, 'dxf'), 'application/dxf');
        return;
      }
      if (kind === 'obj') {
        const obj = await exportObj(sceneView, exportOptions);
        downloadFile(obj, exportFilename(stem, 'obj'), 'model/obj');
        return;
      }
      const glb = await exportGlb(sceneView, exportOptions);
      downloadFile(glb, exportFilename(stem, 'glb'), 'model/gltf-binary');
    } catch {
      bridge.emit('error', { scope: 'export', kind });
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  const fatal = paramsError(params);
  if (fatal || loadError) {
    return (
      <div className="widget widget--error" ref={rootRef}>
        <p>{t(locale, fatal === 'missing_key' ? 'error.dealerUnavailable' : (loadError || 'error.load'))}</p>
      </div>
    );
  }

  if (loading) {
    return <div className="widget widget--loading" ref={rootRef}><p>{t(locale, 'inbox.loading')}</p></div>;
  }

  if (screen === 'card') {
    return (
      <div className="widget widget--card" ref={rootRef}>
        <h1 className="card__title">{catalog.collection.name}</h1>
        <p className="card__tagline">{t(locale, 'launch.tagline')}</p>
        <button type="button" className="btn btn--primary" onClick={() => setScreen('plan')}>
          {t(locale, 'launch.cta')}
        </button>
      </div>
    );
  }

  if (screen === 'done') {
    return (
      <div className="widget widget--done" ref={rootRef}>
        <h1>{t(locale, 'done.title')}</h1>
        <p>{t(locale, 'done.subtitle', { store: catalog.collection.name })}</p>
        <button type="button" className="btn" onClick={() => { dispatch({ type: 'clear' }); setScreen('plan'); }}>
          {t(locale, 'done.reset')}
        </button>
      </div>
    );
  }

  if (screen === 'lead') {
    return (
      <div className="widget" ref={rootRef}>
        <LeadForm
          locale={locale}
          brandName={catalog.collection.name}
          submitting={submitting}
          error={submitError}
          onSubmit={submitLead}
          onBack={() => setScreen('plan')}
        />
      </div>
    );
  }

  const exports = availableExports(state.placed.length, true);

  return (
    <div className="widget" ref={rootRef}>
      <header className="toolbar">
        <div className="toolbar__tabs" role="tablist">
          <button
            type="button" role="tab" aria-selected={screen === 'plan'}
            className={`tab${screen === 'plan' ? ' is-on' : ''}`} onClick={() => setScreen('plan')}
          >
            {t(locale, 'toolbar.plan')}
          </button>
          <button
            type="button" role="tab" aria-selected={screen === 'view'}
            className={`tab${screen === 'view' ? ' is-on' : ''}`} onClick={() => setScreen('view')}
          >
            {t(locale, 'toolbar.view')}
          </button>
        </div>
        <div className="toolbar__actions">
          <button type="button" className="btn btn--quiet" disabled={!editorCanUndo(state)} onClick={() => dispatch({ type: 'undo' })}>
            {t(locale, 'action.undo')}
          </button>
          <button type="button" className="btn btn--quiet" disabled={!editorCanRedo(state)} onClick={() => dispatch({ type: 'redo' })}>
            {t(locale, 'action.redo')}
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setArOpen(true)} disabled={!state.placed.length}>
            {t(locale, 'tools.ar')}
          </button>
          {exports.map((kind) => (
            <button key={kind} type="button" className="btn btn--quiet" onClick={() => download(kind)}>
              {kind.toUpperCase()}
            </button>
          ))}
          <button type="button" className="btn btn--quiet" onClick={() => dispatch({ type: 'clear' })} disabled={!state.placed.length}>
            {t(locale, 'tools.clear')}
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="palette" aria-label={t(locale, 'panel.pieces')}>
          <h2 className="palette__title">{t(locale, 'panel.pieces')}</h2>
          <ul className="palette__list">
            {catalog.palette.map((item) => (
              <li key={item.id}>
                <button type="button" className="palette__item" onClick={() => dispatch({ type: 'add', pieceId: item.id })}>
                  <span className="palette__name">{item.name}</span>
                  <span className="palette__dims">{Math.round(item.widthCm)} × {Math.round(item.depthCm)} cm</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="canvas">
          {screen === 'view' ? (
            <SceneView
              view={sceneView}
              source={materialSource}
              imageOps={browserImageOps}
              renderParams={catalog.collection.renderParams}
              locale={locale}
            />
          ) : (
            <PlanEditor
              state={state}
              ctx={ctx}
              modelById={catalog.modelById}
              locale={locale}
              flagged={feedback.flagged}
              dispatch={dispatch}
            />
          )}
          <RulesPanel feedback={feedback} locale={locale} />
        </main>

        <MaterialsPanel
          families={catalog.families}
          locale={locale}
          targetUid={state.selectedUid}
          activeCode={
            String((state.placed.find((p) => p.uid === state.selectedUid)?.material as { code?: string } | null)?.code ?? '')
          }
          onPick={(uid, pick) => dispatch({ type: 'setMaterial', uid, material: pick as unknown as Record<string, unknown> })}
          onClear={(uid) => dispatch({ type: 'setMaterial', uid, material: null })}
        />
      </div>

      <EstimateDeck
        estimate={estimate}
        locale={locale}
        canSubmit={feedback.canSubmit}
        blockedReason={t(locale, 'rules.blocked')}
        onRequestQuote={() => setScreen('lead')}
        onFabricForAll={() => dispatch({ type: 'select', uid: null })}
      />

      <ArViewer
        open={arOpen}
        view={sceneView}
        exportOptions={exportOptions}
        locale={locale}
        brandName={catalog.collection.name}
        phoneUrl={handoffUrl({
          origin: globalThis.location?.origin ?? '',
          publishableKey: params.publishableKey,
          apiBase: params.apiBase,
          collection: catalog.collection.slug,
          dealer: params.dealer,
          locale,
          build,
        })}
        onClose={() => setArOpen(false)}
      />
    </div>
  );
}
