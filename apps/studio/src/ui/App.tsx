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
import { IngestPanel, OptimizePanel } from './RunPanels.tsx';
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

  /** Measured nodes per model — free from ingest, re-measured on demand. */
  const nodes = useRef(new Map<string, MeasuredNode[]>());

  useEffect(() => { void store.listModels().then(setModels); }, [store]);

  const model = useMemo(() => models.find((m) => m.id === selectedId) || null, [models, selectedId]);
  const summary = useMemo(() => resolvePublishSummary(models), [models]);

  // The draft follows the SELECTION, never the row: an edit in flight must not
  // be thrown away because a fan-out rewrote a sibling and the list re-rendered.
  useEffect(() => {
    const row = models.find((m) => m.id === selectedId) || null;
    setDraft(row?.parts ? { ...row.parts } : {});
    setGroups([]);
    setError(null);
  }, [selectedId]);   // eslint-disable-line react-hooks/exhaustive-deps

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
          mesh: {
            url: up.url,
            upAxis: piece.upAxis,
            bytes: up.bytes,
            meshVersion: null,
            sourceName: piece.sourceName,
          },
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
      const result = detectParts({ nodes: measured, upAxis: model.mesh.upAxis, accessories, parts: draft });
      setGroups(result.groups);
      setDraft(result.parts);
    } catch (e) {
      setError((e as Error)?.message || 'Detect failed.');
    } finally {
      setBusy(null);
    }
  }, [model, models, draft, store]);

  const onSetRole = useCallback((groupKey: string, role: string) => {
    setDraft((d) => writeSlot(d, [groupKey], role, null));
  }, []);

  const onBindPart = useCallback((groupKey: string, role: string, root: string) => {
    if (!groupKey) return;
    const plan = planSkuSlot(draft, [groupKey], role, root);
    if (plan.error) { setError(plan.error); return; }
    setError(null);
    setDraft((d) => writeSlot(d, [groupKey], plan.role!, root));
  }, [draft]);

  const onCount = useCallback((role: string, n: number) => {
    setDraft((d) => setPartCount(d, role, n));
  }, []);

  const onSetFinish = useCallback((groupKey: string, spec: unknown) => {
    setDraft((d) => writeFinish(d, groupKey, spec));
  }, []);

  /* ── Commit ───────────────────────────────────────────────────────────────*/

  const onCommit = useCallback(async () => {
    if (!model) return;
    setBusy('Saving');
    try {
      const parts = prunedParts(draft);
      // ONE plan for the whole save — what the Finishes tab already showed as
      // the blast radius is exactly the set of rows written here.
      const plan = planFinishCommit(models, {
        collection: model.collection,
        sourceModelId: model.id,
        before: model.parts?.finishes,
        after: parts.finishes,
        parts,
      });
      const rows: StudioModel[] = [{ ...model, parts, updatedAt: Date.now() }];
      for (const row of plan.rows) {
        const sibling = models.find((m) => m.id === row.id);
        if (sibling) rows.push({ ...sibling, parts: row.parts, updatedAt: Date.now() });
      }
      upsert(await store.saveModels(rows));
      setError(null);
    } catch (e) {
      setError((e as Error)?.message || 'Save failed.');
    } finally {
      setBusy(null);
    }
  }, [model, models, draft, store, upsert]);

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

  /* ── Optimize ─────────────────────────────────────────────────────────────*/

  const optimizable = useMemo(() => optimizableModels(models).length, [models]);

  const onOptimize = useCallback(async () => {
    setOptimizing(true);
    setOptimizeSummary(null);
    const client = createOptimizeClient();
    try {
      const initial = planOptimizeRun(models);
      const final = await runQueue<OptimizeReport>(initial, async (item) => {
        const row = models.find((m) => m.id === item.id)!;
        const bytes = await store.fetchMesh(row.mesh!.url);
        const out = await client.optimize(item.id, bytes, item.label);
        if (!out.skipped && out.buffer) {
          const up = await store.uploadMesh(`${row.name || row.id}.glb`, out.buffer);
          const saved = await store.saveModel({
            ...row,
            mesh: { ...row.mesh!, url: up.url, bytes: up.bytes, meshVersion: out.meshVersion },
            updatedAt: Date.now(),
          });
          upsert([saved]);
        } else {
          upsert([await store.saveModel({ ...row, mesh: { ...row.mesh!, meshVersion: out.meshVersion } })]);
        }
        return { skipped: out.skipped, before: out.before, after: out.after, meshVersion: out.meshVersion };
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
  }, [models, store, upsert]);

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
          <OptimizePanel
            count={optimizable}
            running={optimizing}
            progress={optimizeProgress}
            summary={optimizeSummary}
            onRun={() => { void onOptimize(); }}
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
          onDetect={() => { void onDetect(); }}
          onSetRole={onSetRole}
          onBindPart={onBindPart}
          onCount={onCount}
          onBindBase={(root) => { void onBindBase(root); }}
          onSetFinish={onSetFinish}
          onCommit={() => { void onCommit(); }}
          onPublish={(want) => { void onPublish(want); }}
        />
      ) : (
        <div className="inspector"><div className="pane muted tiny">No model selected.</div></div>
      )}
    </div>
  );
}
