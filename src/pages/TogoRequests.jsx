import { useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Inbox, MessageCircle, Mail, ArrowRight, Send, Trash2, Loader2, FileDown, Store } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber, invalidate, saveImage } from '../db/database.js';
import { supabase } from '../db/supabaseClient.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import { downloadText } from '../lib/csv.js';
import { LINE_KIND_ITEM } from '../lib/constants.js';
import { productForGrade } from '../lib/catalog.js';
import { composeSubtype } from '../lib/subtype.js';
import { swatchUrl } from '../lib/swatchImage.js';
import {
  effectiveRates, initialQuoteTerms,
  resolveConfigurator, resolveTogoModels, buildTogoModularSeed,
  resolveTogoDxf, placementsFromPlaced, resolveTogoScene, scenePlacementsFromPlaced,
} from '../core/quote/index.js';
import EmptyState from '../components/EmptyState.jsx';
import { linkOrCreateCustomer } from '../lib/parties.js';
import { useMeshPlans, applyMeshPlans } from '../components/togo/useMeshPlans.js';
import { useTogoSceneSnapshot, renderTogoSceneThumb } from '../components/togo/togoThumbnails.js';
import ImageView from '../components/ImageView.jsx';

// The read-only plan is resolved in CENTIMETRES (scale 1) and fitted to its
// frame in percent by PlanOutline — so the drawing is as big as the card allows
// at any width, instead of a fixed pixel sketch that only fit one of them.
const PLAN_SCALE = 1;

/**
 * The "Solicitudes" tab of the Togo workspace — the inbox of web leads captured
 * by the public configurator widget (`togo_requests`, status `pending`). Each
 * request shows the visitor's contact + a thumbnail of the plan they built and
 * the estimate they saw. The dealer triages here and PROMOTES the ones they want
 * into the regular pipeline ("Pasar a cotización" → a draft quote, replaying the
 * placements through the SAME configurator engine the internal builder uses), or
 * dismisses the rest. Nothing reaches Cotizaciones until the dealer says so.
 */
export default function TogoRequests() {
  const navigate = useNavigate();
  const { profileId, settings, saveSettings, currentProfile } = useApp();

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
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).cached(300_000).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  // Dealers that route leads here → the source badge (dealerId → name; null =
  // "Directo", Alcover's own embed) and the source filter.
  const dealers = useLiveQuery(
    () => (profileId ? db.dealers.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  const base = useMemo(() => resolveTogoModels(models, products), [models, products]);
  const families = base.families;

  // The triage list = still-open leads: 'pending' (new) + 'contacted' (a dealer
  // already reached out from its own inbox). Converted/dismissed drop out.
  const activeAll = useMemo(
    () => (requests || [])
      .filter((r) => r.status === 'pending' || r.status === 'contacted')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [requests],
  );

  // Same FBX-derived plan the customer built with (the embed), so the dealer's
  // preview, totals and manufacturing DXF match the mesh — not the stale DWG plan.
  // ONLY for the models these leads actually placed (the embed holds the same
  // rule for the pieces on its plan): this used to pull EVERY model's FBX — the
  // whole ~30 MB catalog, 70-odd files fetched at once, each parsed and kept —
  // to draw a thumbnail for one or two requests. On a phone that saturated the
  // connection the composition render needs for its OWN mesh, so the 3D never
  // arrived and every card sat on the flat outline fallback.
  const meshEntries = useMemo(() => {
    const used = new Set(activeAll.flatMap((r) => (r.items || []).map((it) => it.modelId)));
    return models
      .filter((m) => m.meshUrl && used.has(m.id))
      .map((m) => ({ id: m.id, url: m.meshUrl, upAxis: m.meshUpAxis }));
  }, [models, activeAll]);
  const meshPlans = useMeshPlans(meshEntries);
  const { svgById, resolvedById } = useMemo(
    () => applyMeshPlans(meshPlans, base.svgById, base.resolvedById),
    [meshPlans, base],
  );
  const rates = useMemo(() => effectiveRates(settings), [settings]);

  const dealerName = useMemo(() => {
    const m = new Map();
    for (const d of dealers || []) m.set(d.id, d.name);
    return m;
  }, [dealers]);
  // Filter by source: all · Directo (no dealer) · a specific dealer. The
  // Resumen deep-links a source (`?dealer=<id|direct>` — a dealer row, a
  // dealer alert), so the workspace's home can open THIS section pre-filtered.
  const [searchParams] = useSearchParams();
  const [dealerFilter, setDealerFilter] = useState(() => searchParams.get('dealer') || 'all');
  const active = useMemo(() => activeAll.filter((r) => {
    if (dealerFilter === 'all') return true;
    if (dealerFilter === 'direct') return !r.dealerId;
    return r.dealerId === dealerFilter;
  }), [activeAll, dealerFilter]);

  const [busyId, setBusyId] = useState(null);

  // Promote a request into the regular quote pipeline — a draft quote whose only
  // line is the modular Togo configuration, exactly as the internal builder makes.
  const promote = useCallback(async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    try {
      // Replay the placements — carrying the visitor's fabric pick, repriced by
      // grade against the DEALER's catalog (list price; the quote's margin applies
      // on top), exactly as the internal editor would.
      const placed = (req.items || []).map((it) => {
        const base = { uid: newId(), pieceId: it.modelId, x: it.x, y: it.y, rot: it.rot };
        const mat = it.material;
        if (mat && (mat.grade || mat.fabric)) {
          const fam = families.get(resolvedById[it.modelId]?.root);
          const p = fam ? productForGrade(fam, mat.grade) : null;
          base.material = {
            grade: mat.grade || '', fabric: mat.fabric || '', code: mat.code || '', swatchImageId: null,
            subtype: composeSubtype(mat.grade, mat.fabric),
            reference: p?.reference || '',
            unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[it.modelId]?.unitPrice ?? null),
          };
        }
        // The visitor's per-part fabric picks ride verbatim — buildTogoComponents
        // reprices each part by its own grade against the dealer's catalog.
        if (it.partMaterials && typeof it.partMaterials === 'object') base.partMaterials = it.partMaterials;
        // Finish picks too (price-neutral): they suffix the module's subtype
        // and replay in the 3D scene, same as the worker's auto-quote.
        if (it.partFinishes && typeof it.partFinishes === 'object') base.partFinishes = it.partFinishes;
        return base;
      });
      const id = newId();
      const c = req.contact || {};
      // Land the web contact as a real client: link the existing one (matched
      // by phone/email) or create a new one, numbered in the shared party
      // sequence. The quote then carries a real customerId instead of three
      // lines of freeform notes, so it shows up on that client's ficha.
      const customerId = await linkOrCreateCustomer({ contact: c, profileId });
      const notes = [
        'Solicitud web (configurador Togo)',
        req.note ? `Nota: ${req.note}` : '',
      ].filter(Boolean).join('\n');
      const defaults = {
        id, profileId, createdByUserId: currentProfile?.id || null, number: null,
        customerId, professionalId: null, commissionPct: null,
        orderType: 'floor', orderId: null, status: 'draft', currencyCode: 'USD',
        rates: effectiveRates(settings),
        marginPct: settings?.defaultMarginPct || 0, discountPct: settings?.defaultDiscountPct || 0,
        shipping: 0, terms: initialQuoteTerms(settings, 'floor'), notes,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await assignSequenceNumber({
        table: 'quotes', profileId, start: 1001,
        build: (number) => ({ ...defaults, number, updatedAt: Date.now() }),
      });
      const seed = buildTogoModularSeed(placed, resolvedById, newId);
      // The line's cover = the composition RENDER. Prefer the snapshot the
      // visitor's browser captured at submit (their exact view, a shared
      // togosnap- row deleteImage refuses); older requests without one get a
      // fresh offscreen render, fabrics included. Best-effort — a WebGL
      // failure just leaves the cover empty, exactly as before.
      let imageId = req.snapshotImageId || null;
      if (!imageId) {
        try {
          const url = await renderTogoSceneThumb(
            resolveTogoScene(scenePlacementsFromPlaced(placed, resolvedById)),
            { width: 960, height: 600 },
          );
          if (url) {
            const blob = await (await fetch(url)).blob();
            imageId = await saveImage({
              kind: 'quote-line',
              ownerId: id,
              file: new File([blob], 'composicion.png', { type: 'image/png' }),
            });
          }
        } catch {
          imageId = null;
        }
      }
      await db.quoteLines.put({
        id: newId(), quoteId: id, kind: LINE_KIND_ITEM, sortOrder: 0,
        family: seed.family, reference: '', name: seed.name, subtype: '',
        dimensions: '', description: '', productDescription: '', pageRef: '',
        imageId, qty: 1, unitPrice: 0, unitCost: null,
        lineMarginPct: 0, lineDiscountPct: 0, priceMin: null, priceMax: null,
        notes: '', components: seed.components,
        isOptional: false, optionalOffered: false, materialOptions: null,
      });
      await db.togoRequests.update(req.id, { status: 'converted', quoteId: id, updatedAt: Date.now() });
      navigate(`/quotes/${id}`);
    } catch (e) {
      console.error('[togo] could not promote request', e);
      setBusyId(null);
    }
  }, [busyId, profileId, currentProfile, settings, families, resolvedById, navigate]);

  const dismiss = useCallback(async (req) => {
    await db.togoRequests.update(req.id, { status: 'dismissed', updatedAt: Date.now() });
  }, []);

  // One tap = the full loop: quote the request AND WhatsApp the client the
  // share link via the approved quote template (togo-quote-worker {execute} —
  // the same pipeline the auto mode runs; tapping IS the approval). Errors
  // surface on the card, never silently.
  const [autoErr, setAutoErr] = useState({});
  const autoSend = useCallback(async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    setAutoErr((m) => ({ ...m, [req.id]: '' }));
    try {
      const { data, error } = await supabase.functions.invoke('togo-quote-worker', { body: { execute: req.id } });
      if (error) throw new Error(error.message || 'No se pudo procesar la solicitud.');
      if (data && data.ok === false) throw new Error(data.error || 'No se pudo procesar la solicitud.');
      invalidate();
    } catch (e) {
      setAutoErr((m) => ({ ...m, [req.id]: e?.message || 'No se pudo enviar.' }));
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  if (!activeAll.length) {
    return (
      <div className="space-y-3">
        <AutoQuoteToggle settings={settings} saveSettings={saveSettings} />
        <EmptyState
          icon={Inbox}
          title="Sin solicitudes nuevas"
          description="Las solicitudes que los clientes envíen desde el configurador embebido en tu web (o en la de tus distribuidores) aparecerán aquí para que las revises antes de pasarlas a cotización."
        />
      </div>
    );
  }

  const filters = [
    { key: 'all', label: 'Todos' },
    { key: 'direct', label: 'Directo' },
    ...(dealers || []).map((d) => ({ key: d.id, label: d.name })),
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        {active.length} solicitud{active.length === 1 ? '' : 'es'} ·
        revisa cada diseño y pásalo a cotización cuando quieras darle seguimiento.
      </p>

      <AutoQuoteToggle settings={settings} saveSettings={saveSettings} />

      {dealers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setDealerFilter(f.key)}
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                dealerFilter === f.key
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-ink-200 text-ink-500 hover:text-ink-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {active.length === 0 ? (
        <p className="text-xs text-ink-400 py-6 text-center">Sin solicitudes para este filtro.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {active.map((req) => (
            <RequestCard
              key={req.id}
              req={req}
              rates={rates}
              resolvedById={resolvedById}
              svgById={svgById}
              dealerLabel={req.dealerId ? (dealerName.get(req.dealerId) || 'Distribuidor') : 'Directo'}
              isDirect={!req.dealerId}
              busy={busyId === req.id}
              onPromote={() => promote(req)}
              onDismiss={() => dismiss(req)}
              onAutoSend={() => autoSend(req)}
              autoErr={autoErr[req.id] || ''}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The togo-quote-worker kill switch. OFF (default): each new priced web
 * request becomes a send_togo_quote proposal in JARVIS (Acciones propuestas)
 * and a human approves the send. ON: the worker quotes AND WhatsApps the
 * share link end-to-end (approved template only). Persisted on settings
 * (togoAutoQuote); the worker reads it per request, so flipping takes effect
 * on the next lead. Exported: the Resumen's Automatización card renders this
 * SAME control, so the switch can never disagree between surfaces.
 */
export function AutoQuoteToggle({ settings, saveSettings }) {
  const on = !!settings?.togoAutoQuote;
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    setBusy(true);
    try {
      await saveSettings({ togoAutoQuote: !on });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-100 bg-surface px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-ink-800">Auto-cotización por WhatsApp</div>
        <p className="text-[11px] text-ink-500">
          {on
            ? 'Cada solicitud nueva con precio se cotiza y se envía sola con tu plantilla aprobada de cotización.'
            : 'Apagada: cada solicitud nueva llega como propuesta a JARVIS (Acciones propuestas) y tú apruebas el envío con un toque.'}
        </p>
      </div>
      <button
        type="button" role="switch" aria-checked={on} aria-label="Auto-cotización por WhatsApp"
        disabled={busy} onClick={flip}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${on ? 'bg-brand-500' : 'bg-ink-200'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function RequestCard({ req, rates, resolvedById, svgById, dealerLabel, isDirect, busy, onPromote, onDismiss, onAutoSend, autoErr }) {
  const c = req.contact || {};
  const placed = useMemo(
    () => (req.items || []).map((it, i) => ({
      uid: `${req.id}-${i}`, pieceId: it.modelId, x: it.x, y: it.y, rot: it.rot,
      // Fabric picks ride into the card's fallback 3D render so it shows the
      // visitor's colours, not the oatmeal default.
      ...(it.material ? { material: it.material } : {}),
      ...(it.partMaterials ? { partMaterials: it.partMaterials } : {}),
    })),
    [req],
  );
  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: PLAN_SCALE }), [placed, resolvedById]);
  // A real 3D snapshot of the layout — every piece in its chosen fabric colour,
  // framed to fit the whole build — instead of the flat gray outline. Renders
  // in the background (offscreen three.js); the flat plan below covers the gap
  // while it's loading and on failure (e.g. WebGL unavailable).
  const scene3d = useMemo(() => resolveTogoScene(scenePlacementsFromPlaced(placed, resolvedById)), [placed, resolvedById]);
  // Prefer the snapshot the VISITOR's browser captured at submit (their exact
  // view, stored once); only requests without one (older leads) pay for a
  // live offscreen re-render.
  const snapshotUrl = useTogoSceneSnapshot(req.snapshotImageId ? null : scene3d);
  const phoneDigits = (c.phone || '').replace(/\D/g, '');

  // Download the visitor's layout as a CAD plan (DXF) — the inverse of the
  // DWG→SVG model import: the placed pieces handed back OUT as drawing geometry
  // (real cm, layered, the actual Togo outlines) an architect drops into AutoCAD.
  const downloadDxf = useCallback(() => {
    const placements = placementsFromPlaced(placed, resolvedById, svgById);
    const { dxf, filename } = resolveTogoDxf(placements, { name: c.name || 'solicitud' });
    downloadText(filename, dxf);
  }, [placed, resolvedById, svgById, c.name]);
  // Distinct fabrics the visitor chose, with swatches.
  const fabrics = useMemo(() => {
    const seen = new Map();
    for (const it of (req.items || [])) {
      const m = it.material;
      if (m?.fabric && !seen.has(m.fabric)) seen.set(m.fabric, m.code || '');
    }
    return [...seen.entries()].map(([fabric, code]) => ({ fabric, code }));
  }, [req]);

  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display font-semibold text-sm truncate">{c.name || 'Sin nombre'}</div>
          <div className="text-[11px] text-ink-500">{formatDateTime(req.createdAt)}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${isDirect ? 'border-ink-200 text-ink-500' : 'border-brand-200 bg-brand-50 text-brand-700'}`}>
              <Store size={11} /> {dealerLabel}
            </span>
            {req.status === 'contacted' && (
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">Contactado</span>
            )}
            {req.status === 'pending' && (
              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">Nueva</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado</div>
          <div className="text-sm font-semibold tabular-nums">{formatMoney(req.estimateUsd || 0, 'DOP', rates)}</div>
          <div className="text-[11px] text-ink-500 tabular-nums">{vm.count} pieza{vm.count === 1 ? '' : 's'}</div>
          {vm.count > 0 && vm.overallCm.widthCm > 0 && (
            <div className="text-[10px] text-ink-400 tabular-nums">{vm.overallCm.widthCm}×{vm.overallCm.depthCm} cm</div>
          )}
        </div>
      </div>

      {/* Contact chips. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {c.phone && (
          <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <MessageCircle size={13} className="text-emerald-600" /> {c.phone}
          </a>
        )}
        {c.email && (
          <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <Mail size={13} className="text-ink-500" /> <span className="truncate max-w-[160px]">{c.email}</span>
          </a>
        )}
      </div>

      {/* The layout the visitor built, in ONE frame at the snapshot's own 3:2 —
          so the card never reflows as the render lands. Inside it: the colored
          3D composition (every piece in its chosen fabric), or the flat outline
          plan while that renders / if it can't. The plan is FITTED to the frame
          rather than drawn at a fixed 0.3 scale: one 174×101 piece came out a
          52px sketch marooned in a full-width box, which reads as broken art
          rather than as the plan it is. */}
      {vm.count > 0 && (
        <div className="relative w-full aspect-[3/2] rounded-lg border border-ink-200 bg-ink-50/40 overflow-hidden">
          {req.snapshotImageId ? (
            <ImageView id={req.snapshotImageId} alt="" className="absolute inset-0 w-full h-full object-contain" />
          ) : snapshotUrl ? (
            <img src={snapshotUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />
          ) : (
            <PlanOutline vm={vm} svgById={svgById} />
          )}
        </div>
      )}

      {fabrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {fabrics.map((f) => (
            <span key={f.fabric} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2 py-0.5 text-[11px]">
              {f.code && <img src={swatchUrl(f.code)} alt="" loading="lazy" decoding="async" className="w-3 h-3 rounded-sm object-cover" />}
              <span className="truncate max-w-[180px]">{f.fabric}</span>
            </span>
          ))}
        </div>
      )}

      {req.note && <p className="text-[12px] text-ink-600 bg-ink-50 rounded-md px-2.5 py-1.5 whitespace-pre-wrap">{req.note}</p>}

      {/* Four actions never fit one phone-width row: they used to squeeze until
          the labels broke over two lines and the primary pushed out past the
          card's own edge. The row WRAPS instead, each label held on one line,
          and the primary takes the full width when it lands on a line of its
          own — so the loudest action stays the loudest. */}
      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5">
        {vm.count > 0 && (
          <button type="button" onClick={downloadDxf} className="btn-ghost text-xs text-ink-600 mr-auto whitespace-nowrap" title="Descargar el plano en CAD (DXF) — se abre en AutoCAD y cualquier programa de planos">
            <FileDown size={14} /> Plano DXF
          </button>
        )}
        <button type="button" onClick={onDismiss} disabled={busy} className="btn-ghost text-xs text-ink-500 whitespace-nowrap disabled:opacity-40">
          <Trash2 size={14} /> Descartar
        </button>
        <button type="button" onClick={onPromote} disabled={busy} className="btn-ghost text-xs whitespace-nowrap disabled:opacity-40" title="Crear la cotización en borrador y abrirla en el editor para revisarla antes de enviar">
          <ArrowRight size={14} /> Pasar a cotización
        </button>
        <button
          type="button" onClick={onAutoSend} disabled={busy || !phoneDigits}
          className="btn-primary text-xs whitespace-nowrap grow sm:grow-0 disabled:opacity-50"
          title={phoneDigits
            ? 'Crear la cotización y enviarle el enlace por WhatsApp con tu plantilla aprobada, en un solo paso'
            : 'La solicitud no tiene teléfono — usa «Pasar a cotización»'}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Cotizar y enviar
        </button>
      </div>
      {autoErr && <p className="text-[11px] text-rose-600 dark:text-rose-400" role="alert">{autoErr}</p>}
    </div>
  );
}

/**
 * The visitor's plan, FITTED to its frame: every tile is placed in PERCENT of
 * the plan's own box, so the whole drawing scales with the card instead of being
 * pinned at THUMB_SCALE pixels. The box carries the plan's aspect and is capped
 * on whichever side runs out first (the frame is 3:2), which is what keeps each
 * tile's rotation square — percent width and percent height then share one
 * scale factor, so a rotated piece can't shear.
 */
function PlanOutline({ vm, svgById }) {
  const { wPx, hPx } = vm.canvas;
  if (!(wPx > 0) || !(hPx > 0)) return null;
  const pct = (n, of) => `${(n / of) * 100}%`;
  const wide = wPx / hPx >= 3 / 2;
  return (
    <div className="absolute inset-0 grid place-items-center p-2.5">
      <div
        className="relative max-w-full max-h-full"
        style={{ aspectRatio: `${wPx} / ${hPx}`, ...(wide ? { width: '100%' } : { height: '100%' }) }}
      >
        {vm.tiles.map((t) => (
          <div
            key={t.uid}
            className="absolute"
            style={{ left: pct(t.leftPx, wPx), top: pct(t.topPx, hPx), width: pct(t.wPx, wPx), height: pct(t.hPx, hPx) }}
          >
            {/* The svg fills an UNrotated box centred in the tile, then rotates
                — the tile's own box stays the footprint the plan math used. */}
            <div
              className="absolute top-1/2 left-1/2 text-ink-500 [&>svg]:w-full [&>svg]:h-full"
              style={{
                width: pct(t.innerWPx, t.wPx),
                height: pct(t.innerHPx, t.hPx),
                transform: `translate(-50%, -50%) rotate(${t.rot}deg)`,
              }}
              aria-hidden
              dangerouslySetInnerHTML={{ __html: svgById[t.pieceId] || '' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
