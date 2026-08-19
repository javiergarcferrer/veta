import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Inbox, MessageCircle, Mail, Send, Trash2, Loader2, FileDown, Box, Store, Check,
  RotateCcw, ArrowRight, FileText,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, invalidate } from '../db/database.js';
import { formatDateTime } from '../lib/format.js';
import { downloadText } from '../lib/csv.js';
import { PRODUCT_LIST_COLUMNS } from '../lib/constants.js';
import { swatchUrl, swatchProxyUrl } from '../lib/swatchImage.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import {
  resolveTogoModels, resolveTogoDxf, placementsFromPlaced, resolveRequestsBoard,
  resolveTogoScene, scenePlacementsFromPlaced,
} from '../core/quote/index.js';
import EmptyState from '../components/EmptyState.jsx';
import ImageView from '../components/ImageView.jsx';
import CompositionView from '../components/quote/CompositionView.jsx';
import { useMeshPlans, applyMeshPlans } from '../components/togo/useMeshPlans.js';
import { loadTogoModels } from '../components/togo/togoModelLoader.js';
import { disposeGroup } from '../components/togo/togoSceneBuilder.js';
import { createQuoteFromRequest } from './quoting/api.js';

/**
 * SOLICITUDES — the inbox of web leads the public configurator captured
 * (`togo_requests`), and the front door of the quoting surface.
 *
 * Each card shows what the visitor built (their own composition snapshot, or the
 * plan drawn from the same mesh outlines the widget used), who they are, and the
 * estimate THEY were shown. From here a lead is opened, turned into a quote —
 * frozen server-side with prices resolved by the same rules the widget and the
 * dealer's own inbox price with — marked contacted, or set aside.
 *
 * The card carries no prices of its own beyond that stored estimate: a lead's
 * real per-piece pricing is resolved by the server when it is opened, so a list
 * of forty cards never re-prices forty builds in the browser.
 */

const TONE = {
  neutral: 'border-ink-200 text-ink-500',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-brand-200 bg-brand-50 text-brand-700',
  bad: 'border-rose-200 bg-rose-50 text-rose-700',
};

export default function TogoRequests() {
  const navigate = useNavigate();
  const { profileId } = useApp();

  const requests = useLiveQuery(
    () => (profileId
      ? db.togoRequests.where('profileId').equals(profileId).toArray()
      : Promise.resolve([])),
    [profileId], [],
  );
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  // PROJECTED (PRODUCT_LIST_COLUMNS): resolveTogoModels only prices off the
  // declared Product fields, and `select *` also shipped the search columns on
  // every catalog-wide read. The Distribuidores tab projects the SAME list, so
  // the two still share one cached corpus.
  const products = useLiveQuery(
    () => (profileId
      ? db.products.where('profileId').equals(profileId).columns(PRODUCT_LIST_COLUMNS).cached(300_000).toArray()
      : Promise.resolve([])),
    [profileId], [],
  );
  // Dealers that route leads here → the source badge (dealerId → name; null =
  // "Directo", the manufacturer's own embed) and the source filter.
  const dealers = useLiveQuery(
    () => (profileId ? db.dealers.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState('open');
  const [dealerFilter, setDealerFilter] = useState(() => searchParams.get('dealer') || 'all');

  const board = useMemo(
    () => resolveRequestsBoard(requests, { dealers, tab, dealerFilter }),
    [requests, dealers, tab, dealerFilter],
  );

  const base = useMemo(() => resolveTogoModels(models, products), [models, products]);

  // The same FBX-derived outlines the customer built with — ONLY for the models
  // these leads actually placed. Pulling every model's mesh to draw a couple of
  // thumbnails saturated the connection the 3D itself needs.
  const meshEntries = useMemo(() => {
    const used = new Set(board.rows.flatMap((r) => (r.items || []).map((it) => it.modelId)));
    return models
      .filter((m) => m.meshUrl && used.has(m.id))
      .map((m) => ({ id: m.id, url: m.meshUrl, upAxis: m.meshUpAxis }));
  }, [models, board.rows]);
  const meshPlans = useMeshPlans(meshEntries);
  const { svgById, resolvedById } = useMemo(
    () => applyMeshPlans(meshPlans, base.svgById, base.resolvedById),
    [meshPlans, base],
  );

  // The geometry map the shared drawing component speaks (the same shape the
  // dealer inbox is served): each model's dimensions + its plan outline.
  const planModels = useMemo(() => {
    const out = {};
    for (const [id, r] of Object.entries(resolvedById)) out[id] = { ...r, svg: svgById[id] || null };
    return out;
  }, [resolvedById, svgById]);

  const [busyId, setBusyId] = useState(null);
  const [errors, setErrors] = useState({});

  const setStatus = useCallback(async (req, status) => {
    // `update()` invalidates the table itself, so the board repaints.
    await db.togoRequests.update(req.id, { status, updatedAt: Date.now() });
  }, []);

  // THE FREEZE, from the list: the server prices the build, writes the document
  // and stamps the lead converted, then we open it. Idempotent — a second tap
  // opens the quote that already exists.
  const quoteIt = useCallback(async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    setErrors((m) => ({ ...m, [req.id]: '' }));
    try {
      const { quote } = await createQuoteFromRequest(req.id);
      invalidate('togoRequests');
      navigate(`/cotizaciones/${quote.id}`);
    } catch (e) {
      setErrors((m) => ({ ...m, [req.id]: e?.message || 'No se pudo crear la cotización.' }));
      setBusyId(null);
    }
  }, [busyId, navigate]);

  if (board.empty) {
    return (
      <EmptyState
        icon={Inbox}
        title="Sin solicitudes todavía"
        description="Las solicitudes que los clientes envíen desde el configurador embebido en tu web (o en la de tus distribuidores) aparecerán aquí para que las revises y las pases a cotización."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-1.5 flex-wrap">
          {board.tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                tab === tb.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-500 hover:text-ink-800'
              }`}
            >
              {tb.label}
              <span className="tabular-nums text-ink-400">{tb.count}</span>
            </button>
          ))}
        </div>
        {dealers.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {board.sources.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setDealerFilter(s.key)}
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  dealerFilter === s.key ? 'border-ink-800 text-ink-900' : 'border-ink-200 text-ink-500 hover:text-ink-800'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {board.noMatches ? (
        <p className="text-xs text-ink-400 py-8 text-center">Sin solicitudes para este filtro.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {board.rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              planModels={planModels}
              resolvedById={resolvedById}
              svgById={svgById}
              busy={busyId === row.id}
              error={errors[row.id] || ''}
              onQuote={() => quoteIt(row)}
              onStatus={(status) => setStatus(row, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({ row, planModels, resolvedById, svgById, busy, error, onQuote, onStatus }) {
  // The visitor's layout as a CAD plan (DXF) — the inverse of the model import:
  // the placed pieces handed back OUT as drawing geometry an architect drops
  // into AutoCAD.
  const downloadDxf = useCallback(() => {
    const placements = placementsFromPlaced(row.placed, resolvedById, svgById);
    const { dxf, filename } = resolveTogoDxf(placements, { name: row.name || 'solicitud' });
    downloadText(filename, dxf);
  }, [row, resolvedById, svgById]);

  // 3D — the visitor's layout as ONE textured GLB: the same fabric-baked scene
  // the snapshot renders (real meshes, their chosen fabrics embedded, metres),
  // dequantized to core glTF so it opens in Twinmotion / Blender / SketchUp /
  // the OS 3D viewers. Everything heavy loads on demand, only on tap.
  const scene3d = useMemo(
    () => resolveTogoScene(scenePlacementsFromPlaced(row.placed, planModels)),
    [row.placed, planModels],
  );
  const [glbBusy, setGlbBusy] = useState(false);
  const downloadGlb = useCallback(async () => {
    if (!scene3d?.pieces?.length || glbBusy) return;
    setGlbBusy(true);
    try {
      const [THREE, rbg, glbx, mod] = await Promise.all([
        safeDynamicImport(() => import('three')),
        safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        safeDynamicImport(() => import('three/examples/jsm/exporters/GLTFExporter.js')),
        safeDynamicImport(() => import('../components/togo/togoGlbExport.js')),
      ]);
      // A PRIVATE model cache (the second arg): this path disposes what it
      // loads once the file is written, and the session-shared cache belongs
      // to the card snapshots rendering around this one.
      const { cache, modelFor } = await loadTogoModels(scene3d, new Map());
      const { fabricTextures, colors, pbr, normals, extras } = await mod.loadSceneFabrics(
        THREE, scene3d, {}, (code) => swatchProxyUrl(code) || swatchUrl(code),
      );
      const built = mod.buildArGroup({ THREE, RoundedBoxGeometry: rbg.RoundedBoxGeometry }, scene3d, {
        fabricTextures, colors, pbr, normals, extras, modelFor,
      });
      const blob = await mod.exportGlbBlob({ GLTFExporter: glbx.GLTFExporter, THREE }, built.root);
      built.dispose();
      cache.forEach((m) => disposeGroup(m.object || m));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `togo-3d-${(row.name || 'solicitud').trim().replace(/\s+/g, '-')}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch { /* export unavailable on this device */ }
    setGlbBusy(false);
  }, [scene3d, glbBusy, row.name]);

  const planItems = useMemo(
    () => (row.items || []).map((it) => ({ modelId: it.modelId, x: it.x, y: it.y, rot: it.rot })),
    [row.items],
  );

  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/solicitudes/${row.id}`} className="font-display font-semibold text-sm truncate hover:underline">
            {row.name}
          </Link>
          <div className="text-[11px] text-ink-500">{formatDateTime(row.createdAt)}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${row.isDirect ? TONE.neutral : TONE.info}`}>
              <Store size={11} aria-hidden /> {row.dealerLabel}
            </span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${TONE[row.status.tone] || TONE.neutral}`}>
              {row.status.label}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado</div>
          <div className="text-sm font-semibold tabular-nums">{row.estimateLabel || '—'}</div>
          <div className="text-[11px] text-ink-500 tabular-nums">
            {row.items.length} pieza{row.items.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {row.phone && (
          <a href={`https://wa.me/${row.phoneDigits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <MessageCircle size={13} className="text-emerald-600" aria-hidden /> {row.phone}
          </a>
        )}
        {row.email && (
          <a href={`mailto:${row.email}`} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <Mail size={13} className="text-ink-500" aria-hidden /> <span className="truncate max-w-[160px]">{row.email}</span>
          </a>
        )}
      </div>

      {/* What they built: their own snapshot, else the 3D render, else the plan. */}
      <Link to={`/solicitudes/${row.id}`} className="block">
        <CompositionView
          image={row.snapshotImageId
            ? <ImageView id={row.snapshotImageId} alt="" className="absolute inset-0 w-full h-full object-contain" />
            : null}
          models={planModels}
          planItems={planItems}
          placed={row.placed}
          alt={`Composición de ${row.name}`}
          className="rounded-lg border border-ink-200 bg-ink-50/40"
        />
      </Link>

      {row.fabrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.fabrics.map((f) => (
            <span key={f.fabric} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2 py-0.5 text-[11px]">
              {f.code && <img src={swatchUrl(f.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 rounded-sm object-cover" />}
              <span className="truncate max-w-[180px]">{f.fabric}</span>
            </span>
          ))}
        </div>
      )}

      {row.note && <p className="text-[12px] text-ink-600 bg-ink-50 rounded-md px-2.5 py-1.5 whitespace-pre-wrap">{row.note}</p>}

      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5">
        {planItems.length > 0 && (
          <span className="mr-auto flex items-center gap-1">
            {/* The TWO exports: 2D = the CAD plan, 3D = one textured GLB that
                opens everywhere. Nothing else. */}
            <button type="button" onClick={downloadDxf} className="btn-ghost text-xs text-ink-600 whitespace-nowrap" title="El plano en CAD (DXF) — AutoCAD y cualquier programa de planos">
              <FileDown size={14} aria-hidden /> 2D
            </button>
            <button type="button" onClick={downloadGlb} disabled={glbBusy} className="btn-ghost text-xs text-ink-600 whitespace-nowrap disabled:opacity-40" title="La composición en 3D con sus telas (GLB) — Twinmotion, Blender, SketchUp, visor 3D">
              {glbBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Box size={14} aria-hidden />} 3D
            </button>
          </span>
        )}
        {row.status.key === 'pending' && (
          <button type="button" onClick={() => onStatus('contacted')} className="btn-ghost text-xs whitespace-nowrap">
            <Check size={14} aria-hidden /> Contactado
          </button>
        )}
        {(row.status.key === 'contacted' || row.status.key === 'dismissed') && (
          <button type="button" onClick={() => onStatus('pending')} className="btn-ghost text-xs whitespace-nowrap">
            <RotateCcw size={14} aria-hidden /> Reabrir
          </button>
        )}
        {(row.status.key === 'pending' || row.status.key === 'contacted') && (
          <button type="button" onClick={() => onStatus('dismissed')} className="btn-ghost text-xs text-ink-500 whitespace-nowrap">
            <Trash2 size={14} aria-hidden /> Descartar
          </button>
        )}
        <Link to={`/solicitudes/${row.id}`} className="btn-ghost text-xs whitespace-nowrap">
          <ArrowRight size={14} aria-hidden /> Abrir
        </Link>
        {row.quoteId ? (
          <Link to={`/cotizaciones/${row.quoteId}`} className="btn-secondary text-xs whitespace-nowrap grow sm:grow-0">
            <FileText size={14} aria-hidden /> Ver cotización
          </Link>
        ) : (
          <button
            type="button"
            onClick={onQuote}
            disabled={busy}
            className="btn-primary text-xs whitespace-nowrap grow sm:grow-0 disabled:opacity-50"
            title="Crear la cotización con los precios de hoy y congelarla"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />} Cotizar
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
    </div>
  );
}
