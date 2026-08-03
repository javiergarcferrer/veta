/**
 * THE SHELL — rail / stage / inspector, and nothing else.
 *
 * Every decision this component makes is a call into `vm/*`; every byte it
 * moves goes through a worker. What is left here is React: which model is
 * selected, which tab is open, what is in flight, and the async plumbing that
 * ties a store to a worker to a ViewModel.
 *
 * The one rule the reference studio broke and this app keeps: THE VIEW DERIVES
 * NOTHING. If a number needs computing, it is a `resolve*` or a `plan*`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectParts } from '../vm/parts.ts';
import type { PartGroupBox } from '../vm/parts.ts';
import { initialIngestState, reduceIngest } from '../vm/ingest.ts';
import type { IngestState } from '../vm/ingest.ts';
import { planFinishCommit, prunedParts, writeFinish } from '../vm/finishes.ts';
import { bindBaseProduct, planSkuSlot, setPartCount, writeSlot } from '../vm/sku.ts';
import { resolvePublishSummary, setPublishState } from '../vm/publish.ts';
import { fidelityVerdict, resolveFidelityChecks } from '../vm/fidelity.ts';
import type { BuildReport } from '../vm/fidelity.ts';
import { optimizableModels, planOptimizeRun, summarizeOptimizeRun } from '../vm/optimize.ts';
import type { OptimizeReport, OptimizeRunSummary } from '../vm/optimize.ts';
import {
  planAutoDetect, planAutoOptimize, resolvePipelineStatus, stampFreshUpload, stampOptimized,
} from '../vm/pipeline.ts';
import { armAutosave, createSaveQueue, resolveSaveStatus, runPool } from '../vm/save.ts';
import type { SaveQueue } from '../vm/save.ts';
import { applyPickGesture, resolveStudioKey, separateMembers } from '../vm/gesture.ts';
import { queueProgress, runQueue } from '../vm/queue.ts';
import type { QueueProgress, QueueState } from '../vm/queue.ts';
import { emptyModel } from '../vm/types.ts';
import type { MeasuredNode, PartsDraft, StudioModel } from '../vm/types.ts';
import type { StudioStore } from '../store/types.ts';
import { createMemoryStore } from '../store/memory.ts';
import { createOptimizeClient, ingestInWorker, measureInWorker } from '../workers/client.ts';
import { FidelityPanel } from './FidelityPanel.tsx';
import { INSPECTOR_TABS, Inspector } from './Inspector.tsx';
import type { InspectorTab } from './Inspector.tsx';
import { ModelRail } from './ModelRail.tsx';
import { IngestPanel, PipelinePanel } from './RunPanels.tsx';
import { Stage } from './Stage.tsx';

export function App({ store = createMemoryStore() }: { store?: StudioStore }) {
  const [models, setModels] = useState<StudioModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>('parts');
  const [draft, setDraft] = useState<PartsDraft>({});
  const [groups, setGroups] = useState<PartGroupBox[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BuildReport | null>(null);
  const [building, setBuilding] = useState(false);
  const [ingest, setIngest] = useState<IngestState>(initialIngestState);
  const [optimizeProgress, setOptimizeProgress] = useState<QueueProgress | null>(null);
  const [optimizeSummary, setOptimizeSummary] = useState<OptimizeRunSummary | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // The parts draft's own write state. There is no «Save» button: `dirty` is
  // what arms the clock, and `saveError` is what STOPS it (see vm/save).
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fanoutFailed, setFanoutFailed] = useState(0);
  // The join/separate mode and the part it joins INTO. The selection IS the
  // target, which is why arming with nothing selected is refused.
  const [joinMode, setJoinMode] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  /** Measured nodes per model — free from ingest, re-measured on demand. */
  const nodes = useRef(new Map<string, MeasuredNode[]>());
  /** The draft and the row list as the SAVE CHAIN sees them. A save can settle
   *  after the stage has swapped models, so it must never read React state
   *  through a closure that has moved on. */
  const draftRef = useRef<PartsDraft>({});
  const modelsRef = useRef<StudioModel[]>([]);
  const baselineRef = useRef<Record<string, unknown> | undefined>(undefined);
  const draftOwnerRef = useRef<string | null>(null);
  /** ONCE PER SESSION for the drain, ONCE PER MODEL for the tagging. */
  const drained = useRef(false);
  const autoDetected = useRef(new Set<string>());

  useEffect(() => { void store.listModels().then(setModels); }, [store]);

  const model = useMemo(() => models.find((m) => m.id === selectedId) || null, [models, selectedId]);
  const summary = useMemo(() => resolvePublishSummary(models), [models]);

  // The draft follows the SELECTION, never the row: an edit in flight must not
  // be thrown away because a fan-out rewrote a sibling and the list re-rendered.
  useEffect(() => {
    const row = modelsRef.current.find((m) => m.id === selectedId) || null;
    const next: PartsDraft = row?.parts ? { ...row.parts } : {};
    setDraft(next);
    draftRef.current = next;
    draftOwnerRef.current = row?.id ?? null;
    // THIS model's finishes are the baseline the collection fan-out diffs
    // against. Carrying the previous model's would re-fan its palettes across
    // the wrong family.
    baselineRef.current = row?.parts?.finishes as Record<string, unknown> | undefined;
    setGroups([]);
    setError(null);
    setDirty(false);
    setSaveError(null);
    setFanoutFailed(0);
    // The mode clears with the selection: armed with nothing to join INTO, the
    // next click would be swallowed.
    setSelectedKey(null);
    setJoinMode(false);
  }, [selectedId]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { modelsRef.current = models; }, [models]);
  // The mode needs a target at all times, not only at the moment it is armed.
  useEffect(() => { if (!selectedKey) setJoinMode(false); }, [selectedKey]);

  const checks = useMemo(
    () => resolveFidelityChecks({ model, report, building }),
    [model, report, building],
  );

  const upsert = useCallback((rows: StudioModel[]) => {
    setModels((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const r of rows) byId.set(r.id, r);
      return [...byId.values()];
    });
  }, []);

  /** Every edit to the draft goes through here — and a new edit IS the retry
   *  that re-arms the clock a failed save stopped. */
  const editParts = useCallback((fn: (d: PartsDraft) => PartsDraft) => {
    setDraft((d) => {
      const next = fn(d || {});
      draftRef.current = next;
      return next;
    });
    setDirty(true);
    setSaveError(null);
    setFanoutFailed(0);
  }, []);

  /* ── Ingest ───────────────────────────────────────────────────────────────*/

  const onFiles = useCallback(async (files: File[]) => {
    setError(null);
    setIngest(reduceIngest(initialIngestState(), { type: 'start', total: files.length }));
    try {
      const out = await ingestInWorker(files, {
        onProgress: (p) => setIngest((s) => reduceIngest(s, { type: 'progress', ...p })),
        onFailure: (failure) => setIngest((s) => reduceIngest(s, { type: 'failed', failure })),
        onPiece: (piece) => setIngest((s) => reduceIngest(s, { type: 'piece', piece })),
      });
      setIngest((s) => reduceIngest(s, { type: 'done' }));
      // Upload each piece's bytes, THEN create its row: a model pointing at a
      // URL that does not exist yet is the one shape every later check reads as
      // valid.
      const now = Date.now();
      const created: StudioModel[] = [];
      for (const piece of out.pieces) {
        if (!piece.glb) continue;
        const up = await store.uploadMesh(`${piece.name || piece.id}.glb`, piece.glb);
        const row: StudioModel = {
          ...emptyModel(piece.id, piece.name, now),
          collection: piece.proposal.collection || '',
          group: piece.proposal.group,
          category: piece.proposal.category,
          plan: piece.plan,
          // A file that just came out of `exportPieceGlb` IS the current
          // pipeline — it is already one mesh per solid. Saying so is what stops
          // the automatic pass from downloading and re-exporting it for nothing,
          // and what lets it be tagged straight away instead of waiting for a
          // re-export it does not need. A GLB we PASS THROUGH untouched
          // (`piece.glb` null) deliberately does NOT get the stamp: nothing
          // re-exported it, so the pass still owes it a look.
          mesh: stampFreshUpload(
            { url: up.url, upAxis: piece.upAxis, bytes: up.bytes, sourceName: piece.sourceName },
            { reExported: !!piece.glb },
          ),
        };
        nodes.current.set(row.id, piece.nodes);
        created.push(await store.saveModel(row));
      }
      upsert(created);
      if (created.length && !selectedId) setSelectedId(created[0]!.id);
    } catch (e) {
      setError((e as Error)?.message || 'Ingest failed.');
      setIngest((s) => reduceIngest(s, { type: 'done' }));
    }
  }, [store, upsert, selectedId]);

  /* ── Parts ────────────────────────────────────────────────────────────────*/

  const onDetect = useCallback(async () => {
    if (!model?.mesh?.url) return;
    setBusy('Detecting parts');
    setDetecting(true);
    setError(null);
    try {
      let measured = nodes.current.get(model.id);
      if (!measured) {
        // Not ingested this session: re-read the published GLB in the worker.
        const bytes = await store.fetchMesh(model.mesh.url);
        const out = await measureInWorker(bytes, model.mesh.upAxis);
        measured = out.nodes;
        nodes.current.set(model.id, measured);
      }
      // The collection's loose accessory models are the reference fingerprints.
      const accessories = models
        .filter((m) => m.id !== model.id && m.collection === model.collection && nodes.current.has(m.id))
        .map((m) => ({ name: m.name, nodes: nodes.current.get(m.id)!, upAxis: m.mesh?.upAxis ?? 'y' }));
      const result = detectParts({ nodes: measured, upAxis: model.mesh.upAxis, accessories, parts: draftRef.current });
      setGroups(result.groups);
      // A detect only ever ADDS keys, so it is an edit like any other — it arms
      // the same clock and the tagging saves itself.
      if (result.added.length) editParts(() => result.parts);
      else { setDraft(result.parts); draftRef.current = result.parts; }
    } catch (e) {
      setError((e as Error)?.message || 'Detect failed.');
    } finally {
      setDetecting(false);
      setBusy(null);
    }
  }, [model, models, store, editParts]);

  const detectRef = useRef(onDetect);
  useEffect(() => { detectRef.current = onDetect; }, [onDetect]);

  const onSetRole = useCallback((groupKey: string, role: string) => {
    editParts((d) => writeSlot(d, [groupKey], role, null));
  }, [editParts]);

  const onBindPart = useCallback((groupKey: string, role: string, root: string) => {
    if (!groupKey) return;
    const plan = planSkuSlot(draftRef.current, [groupKey], role, root);
    if (plan.error) { setError(plan.error); return; }
    setError(null);
    editParts((d) => writeSlot(d, [groupKey], plan.role!, root));
  }, [editParts]);

  const onCount = useCallback((role: string, n: number) => {
    editParts((d) => setPartCount(d, role, n));
  }, [editParts]);

  const onSetFinish = useCallback((groupKey: string, spec: unknown) => {
    editParts((d) => writeFinish(d, groupKey, spec));
  }, [editParts]);

  /* ── Commit — automatic, serialized per model, and never a wait ───────────*/

  // ONE write chain per model. `commit` writes THIS row (the dealer is released
  // there); `fanout` writes the siblings the palette reaches, in a BOUNDED POOL
  // — they cannot collapse into one bulk patch (each sibling carries its own
  // payload) and firing a wide collection all at once is how a tab stalls.
  const saves = useRef<SaveQueue<{ parts: PartsDraft; before: Record<string, unknown> | undefined; collection: string }> | null>(null);
  if (!saves.current) {
    saves.current = createSaveQueue({
      async commit(id, { parts }) {
        const row = modelsRef.current.find((m) => m.id === id);
        if (!row) return;
        upsert([await store.saveModel({ ...row, parts, updatedAt: Date.now() })]);
      },
      async fanout(id, { parts, before, collection }) {
        const rows = modelsRef.current;
        // ONE plan for the whole save — what the Finishes tab showed as the
        // blast radius is exactly the set of rows written here.
        const plan = planFinishCommit(rows, {
          collection, sourceModelId: id, before, after: parts.finishes, parts,
        });
        if (!plan.rows.length) { setFanoutFailed(0); return; }
        const { failed } = await runPool(plan.rows, async (r) => {
          const sibling = modelsRef.current.find((m) => m.id === r.id);
          if (!sibling) return;
          upsert([await store.saveModel({ ...sibling, parts: r.parts, updatedAt: Date.now() })]);
        });
        setFanoutFailed(failed);
      },
    });
  }

  /** Write the draft. Returns the moment THIS row is written — the fan-out keeps
   *  running behind it, and the next save on this model queues behind THAT. */
  const saveParts = useCallback(async () => {
    const id = draftOwnerRef.current;
    if (!id) return;
    const row = modelsRef.current.find((m) => m.id === id);
    if (!row) return;
    const parts = prunedParts(draftRef.current);
    const before = baselineRef.current;
    // Marked clean SYNCHRONOUSLY, so a debounce landing on top of an in-flight
    // save queues behind it instead of firing a second write over the same row.
    setDirty(false);
    setSaving(true);
    const handles = saves.current!.save(id, { parts, before, collection: row.collection });
    // The save ADVANCES the baseline: the fan-out is a DIFF against it, and a
    // writer that never moved it would re-fan the same palettes every tick.
    baselineRef.current = parts.finishes as Record<string, unknown> | undefined;
    handles.done.catch(() => {});
    try {
      await handles.committed;
      setSaveError(null);
    } catch (e) {
      // A FAILED SAVE STOPS THE CLOCK. The draft is dirty again, so re-arming on
      // it would spin — one commit, one read and one fan-out every 900 ms for as
      // long as the network is down. The next EDIT is the retry.
      setDirty(true);
      setSaveError((e as Error)?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [store]);

  const saveRef = useRef(saveParts);
  useEffect(() => { saveRef.current = saveParts; }, [saveParts]);

  // THE CLOCK. `armAutosave` owns the rule; this effect owns only the timer.
  useEffect(() => {
    const { arm, delayMs } = armAutosave({ dirty, error: saveError, saving });
    if (!arm) return undefined;
    const t = setTimeout(() => { void saveRef.current(); }, delayMs);
    return () => clearTimeout(t);
  }, [dirty, saveError, saving]);

  // The debounce window is the one place work can still be in the air, and a tab
  // switch is when it is most likely to be: `hidden` fires with the page still
  // alive, so the write really does go out. A page reload runs no React cleanup,
  // which is exactly why the unmount path was never enough.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const flush = () => { if (draftOwnerRef.current) void saveRef.current(); };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  /* ── Join / separate — ONE gesture, both directions ───────────────────────*/

  const onSeparate = useCallback((memberKeys: string[]) => {
    editParts((d) => separateMembers(d, memberKeys));
  }, [editParts]);

  const onJoin = useCallback((target: string, memberKeys: string[]) => {
    if (!target || !memberKeys.length) return;
    editParts((d) => applyPickGesture(d, { kind: 'join', target, members: memberKeys }));
    setSelectedKey(target);
  }, [editParts]);

  // KEYBOARD. U toggles the mode (it needs a selected part — that IS what you
  // join into), Esc leaves it and then deselects, ←/→ walk the rail. The rule
  // lives in `resolveStudioKey`; this only dispatches what it returned.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { action, preventDefault } = resolveStudioKey(e as unknown as Parameters<typeof resolveStudioKey>[0], {
        joinMode,
        selected: selectedKey,
        modelIds: models.map((m) => m.id),
        activeId: selectedId,
      });
      if (preventDefault) e.preventDefault();
      if (action.kind === 'toggle-join') setJoinMode((v) => !v);
      else if (action.kind === 'exit-join') setJoinMode(false);
      else if (action.kind === 'deselect') setSelectedKey(null);
      else if (action.kind === 'model') setSelectedId(action.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [joinMode, selectedKey, models, selectedId]);

  const onBindBase = useCallback(async (root: string) => {
    if (!model) return;
    upsert([await store.saveModel(bindBaseProduct(model, root, Date.now()))]);
  }, [model, store, upsert]);

  const onPublish = useCallback(async (want: 'draft' | 'published') => {
    if (!model) return;
    const next = setPublishState(model, want, Date.now());
    if (!next.changed) {
      setError(next.blocked.map((c) => `${c.label}: ${c.detail}`).join(' ') || null);
      return;
    }
    setError(null);
    upsert([await store.saveModel(next.model)]);
  }, [model, store, upsert]);

  /* ── The pipeline runs itself ─────────────────────────────────────────────*/

  const optimizable = useMemo(() => optimizableModels(models).length, [models]);

  const onOptimize = useCallback(async () => {
    setOptimizing(true);
    setOptimizeSummary(null);
    const client = createOptimizeClient();
    try {
      const initial = planOptimizeRun(modelsRef.current);
      const final = await runQueue<OptimizeReport>(initial, async (item) => {
        const row = modelsRef.current.find((m) => m.id === item.id)!;
        const bytes = await store.fetchMesh(row.mesh!.url);
        const out = await client.optimize(item.id, bytes, item.label);
        const report: OptimizeReport = {
          skipped: out.skipped, before: out.before, after: out.after, meshVersion: out.meshVersion,
        };
        // BOTH BRANCHES WRITE THE VERSION BACK, `skipped` included: a file that
        // was already current INSIDE has just cost a download to discover, and
        // recording that is what stops it costing another one next session.
        const upload = !out.skipped && out.buffer
          ? await store.uploadMesh(`${row.name || row.id}.glb`, out.buffer)
          : null;
        upsert([await store.saveModel(stampOptimized(row, report, upload, Date.now()))]);
        return report;
      }, {
        onState: (s: QueueState<OptimizeReport>) => {
          setOptimizeProgress(queueProgress(s));
          setOptimizeSummary(summarizeOptimizeRun(s));
        },
      });
      setOptimizeSummary(summarizeOptimizeRun(final));
    } finally {
      client.dispose();
      setOptimizing(false);
    }
  }, [store, upsert]);

  // THE DRAIN. Maintenance, not a decision — nobody should have to know that a
  // 3D file predates the current pipeline. Once per session, only when the ROW
  // stamp says there is work (`planAutoOptimize`), so an up-to-date catalogue
  // costs zero requests to verify.
  useEffect(() => {
    const plan = planAutoOptimize(models, { started: drained.current, running: optimizing });
    if (!plan.run) return;
    drained.current = true;
    void onOptimize();
  }, [models, optimizing, onOptimize]);

  // THE TAGGING. It WAITS for the re-export (a pre-split mesh is one node per
  // material, so tagging against it would key the parts off the OLD grouping —
  // and those keys are what the dealer's corrections hang on), and it runs in
  // the IDLE GAP after the model paints rather than inside the click that
  // selected it: tagging loads this model's mesh AND every accessory in its
  // collection to fingerprint against, so firing it on the click made opening a
  // piece feel slow — the opposite of what automating it was for. Cancelled if
  // the dealer moves on, so walking the list costs nothing.
  useEffect(() => {
    const plan = planAutoDetect({
      model, draft, seen: autoDetected.current, detecting, optimizing,
    });
    if (!plan.detect || !model) return undefined;
    const id = model.id;
    const start = () => { autoDetected.current.add(id); void detectRef.current(); };
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const handle = idle ? idle(start, { timeout: 4000 }) : globalThis.setTimeout(start, 600);
    return () => {
      const cancel = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle as number); else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
  }, [model, draft, detecting, optimizing]);

  const pipeline = useMemo(() => resolvePipelineStatus({
    detecting,
    optimizing,
    done: optimizeProgress?.finished ?? 0,
    total: optimizeProgress?.total ?? 0,
    owed: optimizable,
  }), [detecting, optimizing, optimizeProgress, optimizable]);

  const saveStatus = useMemo(
    () => resolveSaveStatus({ dirty, saving, error: saveError, fanoutFailed }),
    [dirty, saving, saveError, fanoutFailed],
  );

  return (
    <div className="studio">
      <header className="topbar">
        <h1>Veta Studio</h1>
        <span className="tiny muted">{summary.published}/{summary.total} published</span>
        <span className="spacer" />
        <div className="tabs" style={{ border: 0, padding: 0 }}>
          {INSPECTOR_TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <ModelRail models={models} selectedId={selectedId} summary={summary} onSelect={setSelectedId} />

      <main style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) auto', minHeight: 0 }}>
        <Stage model={model} onReport={setReport} onBuilding={setBuilding} />
        <div className="pane" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))' }}>
          <IngestPanel state={ingest} onFiles={onFiles} />
          {/* PASSIVE. Detecting and re-exporting are maintenance, not
              decisions, so both run themselves (the effects above). What is
              left here is the read-out: work in flight, never a button. */}
          <PipelinePanel
            status={pipeline}
            progress={optimizeProgress}
            summary={optimizeSummary}
          />
          <FidelityPanel checks={checks} verdict={fidelityVerdict(checks)} />
        </div>
      </main>

      {model ? (
        <Inspector
          tab={tab}
          model={model}
          models={models}
          draft={draft}
          groups={groups}
          busy={busy}
          error={error}
          saveStatus={saveStatus}
          selectedKey={selectedKey}
          joinMode={joinMode}
          onSelectKey={setSelectedKey}
          onToggleJoinMode={() => setJoinMode((v) => !v)}
          onJoin={onJoin}
          onSeparate={onSeparate}
          onSetRole={onSetRole}
          onBindPart={onBindPart}
          onCount={onCount}
          onBindBase={(root) => { void onBindBase(root); }}
          onSetFinish={onSetFinish}
          onPublish={(want) => { void onPublish(want); }}
        />
      ) : (
        <div className="inspector"><div className="pane muted tiny">No model selected.</div></div>
      )}
    </div>
  );
}
