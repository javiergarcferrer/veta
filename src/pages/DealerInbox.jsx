import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchDealerInbox, updateDealerLead, dealerQuoteOp } from '../lib/togoEmbed.js';
import { t, resolveTogoLocale, piecesLabel } from '../lib/togo/i18n.js';
import { swatchUrl, swatchProxyUrl } from '../lib/swatchImage.js';
import { planToDxf } from '../lib/togo/planToDxf.js';
import { composePlanPreview, planPlacements } from '../lib/togo/planPreview.js';
import { sanitizeSvg } from '../lib/sanitizeSvg.js'; // SECURITY (L6): scrub untrusted SVG before innerHTML
import { resolveTogoScene, scenePlacementsFromPlaced, quoteShareUrl } from '../core/quote/index.js';
import { useTogoSceneSnapshot } from '../components/togo/togoThumbnails.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import { disposeGroup } from '../components/togo/togoSceneBuilder.js';
import { loadTogoModels } from '../components/togo/togoModelLoader.js';

/**
 * Public, login-less dealer lead inbox (route #/dealer/:token). A Ligne Roset
 * dealer that embeds the shared Togo configurator reads its OWN web leads here:
 * the `inbox_token` in the URL is the only key, checked server-side by the
 * `togo-embed` Edge Function (the dealer has no account, no JWT). Everything is
 * localized to the dealer's own locale and forced light (isPublicRoute) — this is
 * the dealer's paper on their own device, matching the configurator. No WhatsApp,
 * no internal chrome.
 *
 * Look: a monochrome, angular editorial layout (ref: Fredericia mobile menu) —
 * pure white ground, near-black ink, hairline-ruled full-width rows, no cards,
 * no color, no rounded corners. The Ligne Roset wordmark is the hero.
 *
 * Shell: a fixed-height dashboard split into two full-viewport-height columns.
 * The LEFT column owns the wordmark header + REQUESTS bar (pinned) with the
 * master list scrolling beneath them; the RIGHT column is the detail canvas,
 * running the entire browser height from the top edge down. Each column
 * scrolls independently (`.scroll-thin` thumbs, index.css) — the page itself
 * never scrolls.
 */

// Status reads as a quiet uppercase eyebrow: pending is the only one in ink,
// everything already handled recedes to neutral-400. No pills, no color.
const statusInk = (status) => (status === 'pending' ? 'text-neutral-900' : 'text-neutral-400');

// A document's states in the same register: what still needs the dealer's hand
// (draft, sent) carries ink; what is answered recedes.
const quoteStatusInk = (status) => (
  status === 'declined' ? 'text-neutral-400 line-through decoration-1' : 'text-neutral-900'
);

// Shared eyebrow: 11px uppercase, letterspaced, muted.
const EYEBROW = 'text-micro uppercase tracking-[0.15em] text-neutral-500';

/** "2× Sillón · 1× Módulo esquina" from the placed items + the model-name map. */
function summarizeItems(items, modelNames) {
  const counts = new Map();
  for (const it of items || []) counts.set(it.modelId, (counts.get(it.modelId) || 0) + 1);
  return [...counts.entries()]
    .map(([id, n]) => `${n}× ${modelNames?.[id] || '—'}`)
    .join(' · ');
}

export default function DealerInbox() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', dealer: null });
  const [requests, setRequests] = useState([]);
  const [modelNames, setModelNames] = useState({});
  const [models, setModels] = useState({}); // { <id>: { name, widthCm, depthCm, svg } }
  const [openId, setOpenId] = useState(null); // inline-expanded lead (UI only)
  // The dealer's OWN documents (dealerQuoteOp 'list' — the server scopes them
  // to this token's dealer). `tab` splits the left column between the two
  // registers; a quote failure degrades to an empty list rather than blanking
  // the inbox — leads are the older, load-bearing half.
  const [quotes, setQuotes] = useState([]);
  const [tab, setTab] = useState('leads'); // 'leads' | 'quotes'
  const [openQuoteId, setOpenQuoteId] = useState(null);
  const [quoteBusyId, setQuoteBusyId] = useState(null); // requestId being frozen
  const [opError, setOpError] = useState('');

  // Before the dealer (and its locale) is known, fall back to the browser's.
  const bootLocale = useMemo(
    () => resolveTogoLocale({
      dealerLocale: typeof navigator !== 'undefined' ? String(navigator.language || '').slice(0, 2) : undefined,
    }),
    [],
  );

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', dealer: null });
    fetchDealerInbox(token)
      .then((data) => {
        if (!active) return;
        setState({ status: 'ready', dealer: data.dealer });
        setRequests(
          [...(data.requests || [])].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          ),
        );
        setModelNames(data.modelNames || {});
        setModels(data.models || {});
      })
      .catch(() => { if (active) setState({ status: 'error', dealer: null }); });
    dealerQuoteOp(token, 'list')
      .then((data) => { if (active) setQuotes(data.quotes || []); })
      .catch(() => { /* the leads half still renders; the tab just reads empty */ });
    return () => { active = false; };
  }, [token]);

  const locale = state.dealer ? resolveTogoLocale({ dealerLocale: state.dealer.locale }) : bootLocale;

  // Title the tab like the other public links; restore on unmount so the app's
  // title isn't left overwritten.
  useEffect(() => {
    if (!state.dealer) return undefined;
    const prev = document.title;
    document.title = `${t(locale, 'inbox.title')} — ${state.dealer.name}`;
    return () => { document.title = prev; };
  }, [state.dealer, locale]);

  // Flip a lead's status (pending ⇄ contacted), optimistically; revert on failure.
  const setLeadStatus = async (id, next) => {
    const prev = requests.find((r) => r.id === id)?.status;
    setRequests((rs) => rs.map((r) => (r.id === id ? { ...r, status: next } : r)));
    try {
      await updateDealerLead(token, id, next);
    } catch {
      setRequests((rs) => rs.map((r) => (r.id === id ? { ...r, status: prev } : r)));
    }
  };

  // A lead's LIVE document (any status but declined) — what decides whether the
  // detail offers «Cotizar» or «Ver cotización». Same liveness rule the server
  // enforces on the unique index, restated for the UI.
  const liveQuoteByRequest = useMemo(() => {
    const map = new Map();
    for (const q of quotes) {
      if (q.requestId && q.status !== 'declined' && !map.has(q.requestId)) map.set(q.requestId, q);
    }
    return map;
  }, [quotes]);

  // FREEZE a lead into a document. The server is idempotent (a lead with a live
  // quote returns it), so a double-tap can never mint two numbers.
  const createQuote = async (requestId) => {
    if (quoteBusyId) return;
    setQuoteBusyId(requestId);
    setOpError('');
    try {
      const { quote } = await dealerQuoteOp(token, 'create', { requestId });
      setQuotes((qs) => [quote, ...qs.filter((q) => q.id !== quote.id)]);
      setRequests((rs) => rs.map((r) => (r.id === requestId ? { ...r, status: 'converted' } : r)));
      setTab('quotes');
      setOpenQuoteId(quote.id);
    } catch (e) {
      setOpError(e?.message || t(locale, 'quotes.error'));
    }
    setQuoteBusyId(null);
  };

  // Advance a document's state. The server answers with the row as stored, so
  // the list re-reads truth instead of trusting the tap.
  const setQuoteStatusOp = async (id, status) => {
    setOpError('');
    try {
      const { quote } = await dealerQuoteOp(token, 'setStatus', { id, status });
      setQuotes((qs) => qs.map((q) => (q.id === id ? quote : q)));
    } catch (e) {
      setOpError(e?.message || t(locale, 'quotes.error'));
    }
  };

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex items-center justify-center bg-white">
        <span className={EYEBROW}>{t(bootLocale, 'inbox.loading')}</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="h-full flex items-center justify-center bg-white px-6">
        <p className={`${EYEBROW} max-w-xs text-center leading-relaxed`}>{t(bootLocale, 'inbox.error')}</p>
      </div>
    );
  }

  const { dealer } = state;
  const dateFmt = new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const moneyFmt = new Intl.NumberFormat(locale, {
    style: 'currency', currency: dealer.currency || 'USD', maximumFractionDigits: 0,
  });

  // date · pieces · estimate — the quiet meta line under a name (list + detail).
  const metaFor = (req) => {
    const items = req.items || [];
    const parts = [];
    if (req.createdAt) parts.push(dateFmt.format(new Date(req.createdAt)));
    parts.push(piecesLabel(locale, items.length));
    if (req.estimateUsd != null) parts.push(`${t(locale, 'inbox.estimate')} ${moneyFmt.format(req.estimateUsd)}`);
    return parts.join(' · ');
  };
  const selected = tab === 'leads' ? (requests.find((r) => r.id === openId) || null) : null;
  const selectedQuote = tab === 'quotes' ? (quotes.find((q) => q.id === openQuoteId) || null) : null;
  const detailOpen = !!(selected || selectedQuote);
  const accepted = quotes.filter((q) => q.status === 'accepted');
  const acceptedTotal = accepted.reduce((acc, q) => acc + (q.total || 0), 0);

  return (
    <div className="h-full overflow-hidden bg-white text-neutral-900">
      {/* Two columns split the FULL viewport height (minmax(0,1fr) row pins the
          grid row to it): the left column owns the brand header + the request
          list, the right column is the detail canvas running from the very top
          edge of the browser to the bottom. Each scrolls on its own. On mobile
          the columns swap (list until a lead is picked, then the detail with a
          "← back"). */}
      <div className="h-full max-w-6xl mx-auto lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        {/* LEFT column — brand + master list. */}
        <div className={`h-full min-h-0 flex-col px-6 sm:px-8 lg:pr-8 lg:border-r lg:border-neutral-200 ${detailOpen ? 'hidden lg:flex' : 'flex'}`}>
          {/* The official Ligne Roset "depuis 1860" logo is the hero; the
              dealer's own name is the eyebrow above it. White-ground asset on a
              white page — seamless. Pinned chrome: it never scrolls away. */}
          <header className="shrink-0 pt-8 sm:pt-10 pb-6 border-b border-neutral-200">
            <div className={EYEBROW}>{dealer.name}</div>
            {/* THE BRAND'S OWN mark, per silo: a dealer carrying its own logo
                shows it; the Ligne Roset wordmark is the HOUSE fallback only —
                a second brand's dealer must never wear another maker's mark. */}
            <img
              src={dealer.logoUrl || '/ligne-roset-depuis-1860.png'}
              alt={dealer.logoUrl ? dealer.name : 'Ligne Roset — depuis 1860'}
              className="mt-4 w-48 sm:w-56 max-h-20 object-contain object-left h-auto select-none"
              draggable={false}
            />
          </header>

          {/* The dashboard's two registers — leads and documents — as quiet
              uppercase tabs in the same eyebrow voice the meta line had. */}
          <div className="shrink-0 flex items-baseline gap-6 py-5" role="tablist">
            {[
              ['leads', t(locale, 'inbox.title'), requests.length],
              ['quotes', t(locale, 'quotes.tab'), quotes.length],
            ].map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => { setTab(key); }}
                className={`text-micro uppercase tracking-[0.15em] transition-colors ${
                  tab === key
                    ? 'text-neutral-900 underline underline-offset-8 decoration-1'
                    : 'text-neutral-400 hover:text-neutral-700'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1.5 tabular-nums">{count}</span>}
              </button>
            ))}
            {tab === 'quotes' && accepted.length > 0 && (
              <span className="ml-auto text-micro tracking-[0.05em] text-neutral-500 tabular-nums normal-case">
                {t(locale, 'quotes.acceptedSummary', {
                  count: accepted.length,
                  total: moneyFmt.format(acceptedTotal),
                })}
              </span>
            )}
          </div>

          {tab === 'quotes' ? (
            quotes.length === 0 ? (
              <div className={`${EYEBROW} flex-1 flex items-center justify-center text-center normal-case tracking-normal leading-relaxed max-w-[16rem] mx-auto`}>
                {t(locale, 'quotes.empty')}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto scroll-thin overscroll-contain border-t border-neutral-200 pb-[max(3rem,env(safe-area-inset-bottom))]">
                {quotes.map((q) => {
                  const on = openQuoteId === q.id;
                  const qMoney = new Intl.NumberFormat(locale, {
                    style: 'currency', currency: q.currency || dealer.currency || 'USD', maximumFractionDigits: 0,
                  });
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setOpenQuoteId(q.id)}
                      aria-current={on}
                      className={`w-full text-left py-5 px-3 -mx-3 border-b border-neutral-200 flex items-start justify-between gap-3 transition-colors ${on ? 'bg-neutral-50' : 'hover:bg-neutral-50/60'}`}
                    >
                      <div className="min-w-0">
                        <div className={`text-micro uppercase tracking-[0.15em] ${quoteStatusInk(q.status)}`}>
                          {t(locale, `quotes.status.${q.status}`)}
                        </div>
                        <div className="mt-1.5 text-lg font-light tracking-tight leading-snug text-neutral-900 break-words">
                          {t(locale, 'quotes.doc', { n: q.number })}
                        </div>
                        <div className={`${EYEBROW} mt-1.5 normal-case tracking-normal text-neutral-500 leading-relaxed`}>
                          {[q.customerName || EMDASH, q.total != null ? qMoney.format(q.total) : null]
                            .filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <span aria-hidden className={`shrink-0 text-lg font-light leading-none pt-1 ${on ? 'text-neutral-900' : 'text-neutral-300'}`}>→</span>
                    </button>
                  );
                })}
              </div>
            )
          ) : requests.length === 0 ? (
            <div className={`${EYEBROW} flex-1 flex items-center justify-center text-center`}>{t(locale, 'inbox.empty')}</div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin overscroll-contain border-t border-neutral-200 pb-[max(3rem,env(safe-area-inset-bottom))]">
              {requests.map((req) => {
                const c = req.contact || {};
                const on = openId === req.id;
                return (
                  <button
                    key={req.id}
                    type="button"
                    onClick={() => setOpenId(req.id)}
                    aria-current={on}
                    className={`w-full text-left py-5 px-3 -mx-3 border-b border-neutral-200 flex items-start justify-between gap-3 transition-colors ${on ? 'bg-neutral-50' : 'hover:bg-neutral-50/60'}`}
                  >
                    <div className="min-w-0">
                      <div className={`text-micro uppercase tracking-[0.15em] ${statusInk(req.status)}`}>
                        {t(locale, `inbox.status.${req.status}`)}
                      </div>
                      <div className="mt-1.5 text-lg font-light tracking-tight leading-snug text-neutral-900 break-words">
                        {c.name || '—'}
                      </div>
                      <div className={`${EYEBROW} mt-1.5 normal-case tracking-normal text-neutral-500 leading-relaxed`}>
                        {metaFor(req)}
                      </div>
                    </div>
                    <span aria-hidden className={`shrink-0 text-lg font-light leading-none pt-1 ${on ? 'text-neutral-900' : 'text-neutral-300'}`}>→</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* RIGHT column — the detail canvas, the FULL browser height, its own
            scroller. Keyed by the selected lead so switching leads remounts the
            scroller and lands at the top. */}
        <div
          key={selected ? selected.id : (selectedQuote ? selectedQuote.id : 'empty')}
          className={`h-full min-h-0 overflow-y-auto scroll-thin overscroll-contain px-6 sm:px-8 lg:pl-10 pb-[max(3rem,env(safe-area-inset-bottom))] ${detailOpen ? 'block' : 'hidden lg:block'}`}
        >
          {selected ? (
            <div className="pt-6 lg:pt-10">
              {/* Mobile-only "back to list". */}
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="eyebrow lg:hidden mb-5 text-neutral-500 hover:text-neutral-900"
              >
                ← {t(locale, 'inbox.back')}
              </button>
              {/* Detail hero: status · name · meta. */}
              <div className={`text-micro uppercase tracking-[0.15em] ${statusInk(selected.status)}`}>
                {t(locale, `inbox.status.${selected.status}`)}
              </div>
              <div className="mt-2 text-2xl sm:text-3xl font-light tracking-tight leading-tight text-neutral-900">
                {(selected.contact || {}).name || '—'}
              </div>
              <div className={`${EYEBROW} mt-2 normal-case tracking-normal text-neutral-500`}>
                {metaFor(selected)}
              </div>
              <LeadDetail
                key={selected.id}
                req={selected}
                models={models}
                modelNames={modelNames}
                locale={locale}
                moneyFmt={moneyFmt}
                onSetStatus={setLeadStatus}
                liveQuote={liveQuoteByRequest.get(selected.id) || null}
                onQuote={() => createQuote(selected.id)}
                onOpenQuote={(id) => { setTab('quotes'); setOpenQuoteId(id); }}
                quoteBusy={quoteBusyId === selected.id}
                opError={opError}
              />
            </div>
          ) : selectedQuote ? (
            <div className="pt-6 lg:pt-10">
              <button
                type="button"
                onClick={() => setOpenQuoteId(null)}
                className="eyebrow lg:hidden mb-5 text-neutral-500 hover:text-neutral-900"
              >
                ← {t(locale, 'inbox.back')}
              </button>
              <QuoteDetailCard
                quote={selectedQuote}
                locale={locale}
                dealer={dealer}
                dateFmt={dateFmt}
                onSetStatus={setQuoteStatusOp}
                opError={opError}
                token={token}
              />
            </div>
          ) : (
            (tab === 'quotes' ? quotes.length : requests.length) > 0 && (
              <div className={`${EYEBROW} hidden lg:flex h-full items-center justify-center text-center`}>
                {t(locale, 'inbox.selectPrompt')}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// The no-value glyph — a single em-dash in the same quiet register as the eyebrows.
const EMDASH = '—';

/** A small square LR fabric swatch (hotlinked from the color code), degrading to a
 *  neutral tile when there's no code or the CDN 404s. Square, no rounding. */
function Swatch({ code, className = '' }) {
  const url = swatchUrl(code);
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <div aria-hidden className={`${className} bg-neutral-100`} />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={`${className} object-cover bg-neutral-100`}
    />
  );
}

/** The small swatch tile with a hover card: on hover (or keyboard focus) it lifts
 *  an enlarged swatch + the fabric name/code, so the dealer can read the exact
 *  finish a visitor picked without leaving the lead. Same monochrome register as
 *  the rest of the page; purely presentational (never captures the row click). */
function SwatchHover({ code, fabric, className = '' }) {
  const url = swatchUrl(code);
  return (
    <div className={`group relative ${className}`} tabIndex={0}>
      <Swatch code={code} className="w-10 h-10" />
      {(url || fabric) && (
        <div className="pointer-events-none absolute z-20 left-0 bottom-full mb-2 opacity-0 translate-y-1 transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100 group-hover:translate-y-0 group-focus:opacity-100 group-focus:translate-y-0">
          <div className="w-44 border border-neutral-200 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.12)] p-3">
            {url && <img src={url} alt="" draggable={false} className="w-full aspect-square object-cover bg-neutral-100" />}
            {fabric && <div className="mt-2 text-sm leading-snug text-neutral-900">{fabric}</div>}
            {code && <div className={`${EYEBROW} mt-0.5`}>{code}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Push a Blob to the browser as a file download, then release the object URL.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * The expanded lead detail: an itemized list (swatch · model + dims/fabric ·
 * price), a total, a monochrome top-down plan preview with PNG + DXF downloads,
 * then the contact links, note and status actions (unchanged from before).
 *
 * Everything past the itemized list is GUARDED on the newer payload carrying a
 * `models` map: without it (older prod payload) the detail falls back to the plain
 * text summary — no plan, no per-item prices — so the page never crashes.
 */
function LeadDetail({ req, models, modelNames, locale, moneyFmt, onSetStatus, liveQuote = null, onQuote, onOpenQuote, quoteBusy = false, opError = '' }) {
  const c = req.contact || {};
  const items = req.items || [];
  const phoneDigits = (c.phone || '').replace(/[^\d+]/g, '');
  const hasModels = !!models && Object.keys(models).length > 0;
  const idPrefix = String(req.id || 'lead').slice(0, 8);

  const plan = useMemo(
    () => (hasModels ? composePlanPreview(models, items) : null),
    [hasModels, models, items],
  );

  // A colored 3D snapshot of the layout — every piece in its chosen fabric,
  // framed to fit the whole build — matching the internal Solicitudes tab. The
  // placed pieces are an ARRAY of { pieceId, x, y, rot, material } (same shape
  // scenePlacementsFromPlaced expects); dims/mesh come from the `models` map
  // keyed by modelId. Renders offscreen; the flat plan below covers the gap
  // while it loads / on failure (e.g. WebGL unavailable).
  const placed = useMemo(
    () => items.map((it, i) => ({
      uid: `${req.id}-${i}`, pieceId: it.modelId, x: it.x, y: it.y, rot: it.rot, material: it.material,
      partMaterials: it.partMaterials || null,
    })),
    [items, req.id],
  );
  const scene3d = useMemo(
    () => resolveTogoScene(scenePlacementsFromPlaced(placed, models || {})),
    [placed, models],
  );
  const snapshotUrl = useTogoSceneSnapshot(scene3d);

  // No currency conversion — the figure IS the price-list value; the dealer's
  // currency only labels it.
  const money = (usd) => (usd == null ? EMDASH : moneyFmt.format(usd));
  const totalUsd = req.totalUsd != null ? req.totalUsd : req.estimateUsd;

  // 2D — the plan handed back as an open CAD file (DXF) every drawing tool reads.
  const downloadDxf = () => {
    const dxf = planToDxf(planPlacements(models, items), { label: 'Togo' });
    downloadBlob(new Blob([dxf], { type: 'application/dxf' }), `togo-plan-${idPrefix}.dxf`);
  };
  // 3D — the assembled layout as ONE textured GLB: the same fabric-baked scene
  // the configurator's AR/download builds (real meshes, the visitor's chosen
  // fabrics embedded, metres), dequantized to core glTF so it opens in
  // Twinmotion / Blender / SketchUp / the OS 3D viewers. The geometry-only cm
  // OBJ this replaced imported into Twinmotion as an empty scene (2026-08).
  // three + the exporter load on demand — only when a dealer actually
  // downloads — so the inbox pays nothing for it until then.
  const [glbBusy, setGlbBusy] = useState(false);
  const downloadGlb = async () => {
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
      // to the card snapshots rendering behind this dialog.
      const { cache, modelFor } = await loadTogoModels(scene3d, new Map());
      const { fabricTextures, colors, pbr, normals, extras } = await mod.loadSceneFabrics(
        THREE, scene3d, {}, (c) => swatchProxyUrl(c) || swatchUrl(c),
      );
      const built = mod.buildArGroup({ THREE, RoundedBoxGeometry: rbg.RoundedBoxGeometry }, scene3d, {
        fabricTextures, colors, pbr, normals, extras, modelFor,
      });
      const blob = await mod.exportGlbBlob({ GLTFExporter: glbx.GLTFExporter, THREE }, built.root);
      built.dispose();
      cache.forEach((m) => disposeGroup(m.object || m));   // free the source meshes
      downloadBlob(blob, `togo-${idPrefix}.glb`);
    } catch { /* export unavailable on this device */ }
    setGlbBusy(false);
  };

  return (
    <div className="pb-8 space-y-5">
      {/* ATOP — the primary action (mark contacted / reopen) as a clear button,
          then the contact links. First thing the dealer sees, so triaging a lead
          is one obvious tap — not a hidden underline at the bottom. */}
      {/* THE DOCUMENT ACTION leads: a lead's endpoint is a quote, so «Cotizar»
          (or the document it already became) stands first among the actions. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 pt-1">
        {liveQuote ? (
          <button
            type="button"
            onClick={() => onOpenQuote?.(liveQuote.id)}
            className="eyebrow inline-flex items-center border border-neutral-900 bg-neutral-900 text-white px-4 py-2 transition-colors hover:bg-white hover:text-neutral-900"
          >
            {t(locale, 'quotes.viewQuote')} · {t(locale, 'quotes.doc', { n: liveQuote.number })}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onQuote?.()}
            disabled={quoteBusy}
            className="eyebrow inline-flex items-center border border-neutral-900 bg-neutral-900 text-white px-4 py-2 transition-colors hover:bg-white hover:text-neutral-900 disabled:opacity-40"
          >
            {quoteBusy ? t(locale, 'quotes.quoteBusy') : t(locale, 'quotes.quoteCta')}
          </button>
        )}
      </div>
      {opError && (
        <p role="alert" className="text-micro tracking-wide text-neutral-900 border-l-2 border-neutral-900 pl-3">
          {opError}
        </p>
      )}

      {(req.status === 'pending' || req.status === 'contacted' || c.phone || c.email) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3 pt-1">
          {req.status === 'pending' && (
            <button
              type="button"
              onClick={() => onSetStatus(req.id, 'contacted')}
              className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-700 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              {t(locale, 'inbox.markContacted')}
            </button>
          )}
          {req.status === 'contacted' && (
            <button
              type="button"
              onClick={() => onSetStatus(req.id, 'pending')}
              className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-700 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              {t(locale, 'inbox.reopen')}
            </button>
          )}
          {c.phone && (
            <a
              href={`tel:${phoneDigits}`}
              className="inline-flex items-center border border-neutral-200 px-4 py-2 text-sm text-neutral-900 transition-colors hover:border-neutral-900"
            >
              {c.phone}
            </a>
          )}
          {c.email && (
            <a
              href={`mailto:${c.email}`}
              className="inline-flex items-center border border-neutral-200 px-4 py-2 text-sm break-all text-neutral-900 transition-colors hover:border-neutral-900"
            >
              {c.email}
            </a>
          )}
        </div>
      )}

      {hasModels ? (
        <>
          {/* 1 — Itemized list: one hairline row per placed piece. */}
          {items.length > 0 && (
            <div className="border-t border-neutral-200">
              {items.map((it, i) => {
                const m = models[it.modelId] || {};
                const name = m.name || modelNames?.[it.modelId] || EMDASH;
                const dims = m.widthCm && m.depthCm ? `${m.widthCm} × ${m.depthCm} cm` : null;
                const mat = it.material;
                const fabric = mat && (mat.fabric || mat.grade)
                  ? [mat.fabric, mat.grade].filter(Boolean).join(' · ')
                  : null;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-4 py-3 min-h-[44px] border-b border-neutral-200"
                  >
                    <SwatchHover code={mat?.code} fabric={fabric || name} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-neutral-900 truncate">{name}</div>
                      {(dims || fabric) && (
                        <div className="mt-0.5 text-micro tracking-wide text-neutral-500 truncate">
                          {dims}{dims && fabric ? ' · ' : ''}{fabric}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-sm tabular-nums text-neutral-900">{money(it.priceUsd)}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 2 — Total. */}
          <div className="flex items-baseline justify-between border-t border-neutral-200 pt-4">
            <span className={EYEBROW}>{t(locale, 'inbox.total')}</span>
            <span className="text-2xl font-light tracking-tight tabular-nums text-neutral-900">
              {money(totalUsd)}
            </span>
          </div>

          {/* 3 + 4 — Plan preview (colored 3D snapshot while loading, flat plan fallback) + downloads. */}
          {plan && (
            <div>
              <div className={`${EYEBROW} mb-2`}>{t(locale, 'inbox.plan')}</div>
              {/* Colored 3D snapshot (every piece in its chosen fabric) renders in the
                  background; the flat plan underneath while it's loading / if it fails. */}
              {snapshotUrl ? (
                <div className="border border-neutral-200 bg-white overflow-hidden flex items-center justify-center">
                  <img src={snapshotUrl} alt="" className="w-full h-auto max-h-[34vh] object-contain block" />
                </div>
              ) : (
                <div
                  role="img"
                  aria-label={t(locale, 'inbox.plan')}
                  className="border border-neutral-200 bg-white p-4 [&>svg]:block [&>svg]:mx-auto [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-h-[34vh] [&>svg]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: sanitizeSvg(plan.svg) }}
                />
              )}
              <div className="mt-3 flex items-center gap-6">
                <button
                  type="button"
                  onClick={downloadDxf}
                  className="eyebrow text-neutral-900 underline underline-offset-4 decoration-1 hover:decoration-2"
                >
                  {t(locale, 'inbox.download2d')}
                </button>
                <button
                  type="button"
                  onClick={downloadGlb}
                  disabled={glbBusy}
                  className="eyebrow text-neutral-900 underline underline-offset-4 decoration-1 hover:decoration-2 disabled:opacity-40 disabled:no-underline"
                >
                  {t(locale, 'inbox.download3d')}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        // Older payload (no models): the original plain-text summary — no plan,
        // no prices — so the current prod payload still renders.
        summarizeItems(items, modelNames) && (
          <p className="text-sm leading-relaxed text-neutral-700">{summarizeItems(items, modelNames)}</p>
        )
      )}

      {req.note && (
        <div>
          <div className={`${EYEBROW} mb-2`}>{t(locale, 'inbox.note')}</div>
          <p className="text-sm leading-relaxed text-neutral-600 whitespace-pre-wrap">{req.note}</p>
        </div>
      )}
    </div>
  );
}

/**
 * ONE document, in the dealer's own register: status · number · customer, the
 * frozen lines, the total AS FROZEN (the server already factored markup × FX
 * into the document's own currency — nothing here converts), the customer link
 * to copy or open, and the state controls. The state machine mirrors the
 * server's (draft → sent → accepted/declined; declined frees the lead to be
 * re-quoted at today's prices), and every transition round-trips — the row the
 * server answers with is what renders, never the tap.
 */
function QuoteDetailCard({ quote, locale, dealer, dateFmt, onSetStatus, opError, token }) {
  const [copied, setCopied] = useState(false);
  // The full frozen document (lines + composition render): the list shape the
  // left column holds has neither, so the card reads its own detail. A failed
  // read degrades to the list shape — number, total and link still work.
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    let active = true;
    setDetail(null);
    dealerQuoteOp(token, 'get', { id: quote.id })
      .then((data) => { if (active) setDetail(data); })
      .catch(() => { /* degrade to the list shape */ });
    return () => { active = false; };
  }, [token, quote.id]);
  const doc = detail?.quote || quote;
  const money = useMemo(
    () => new Intl.NumberFormat(locale, {
      style: 'currency', currency: quote.currency || dealer.currency || 'USD', maximumFractionDigits: 0,
    }),
    [locale, quote.currency, dealer.currency],
  );
  const shareUrl = doc.shareToken && doc.shared !== false ? quoteShareUrl(doc.shareToken) : '';
  const lines = Array.isArray(doc.lines) ? doc.lines : [];

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — the Open link beside it still works */ }
  };

  return (
    <div className="pb-8 space-y-5">
      <div className={`text-micro uppercase tracking-[0.15em] ${quoteStatusInk(quote.status)}`}>
        {t(locale, `quotes.status.${quote.status}`)}
      </div>
      <div className="!mt-2 text-2xl sm:text-3xl font-light tracking-tight leading-tight text-neutral-900">
        {t(locale, 'quotes.doc', { n: quote.number })}
      </div>
      <div className={`${EYEBROW} !mt-2 normal-case tracking-normal text-neutral-500`}>
        {[quote.customerName || EMDASH, quote.createdAt ? dateFmt.format(new Date(quote.createdAt)) : null]
          .filter(Boolean).join(' · ')}
      </div>

      {/* The customer link + state controls — the two things a dealer comes
          here to do. Copy confirms inline; the states that need a hand carry
          the filled register. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 pt-1">
        {shareUrl && (
          <>
            <button
              type="button"
              onClick={copyLink}
              className="eyebrow inline-flex items-center border border-neutral-900 bg-neutral-900 text-white px-4 py-2 transition-colors hover:bg-white hover:text-neutral-900"
            >
              {copied ? t(locale, 'quotes.linkCopied') : t(locale, 'quotes.copyLink')}
            </button>
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-700 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              {t(locale, 'quotes.openLink')}
            </a>
          </>
        )}
        {quote.status === 'draft' && (
          <button
            type="button"
            onClick={() => onSetStatus(quote.id, 'sent')}
            className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-700 transition-colors hover:border-neutral-900 hover:text-neutral-900"
          >
            {t(locale, 'quotes.markSent')}
          </button>
        )}
        {quote.status === 'sent' && (
          <>
            <button
              type="button"
              onClick={() => onSetStatus(quote.id, 'accepted')}
              className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-700 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              {t(locale, 'quotes.markAccepted')}
            </button>
            <button
              type="button"
              onClick={() => onSetStatus(quote.id, 'declined')}
              className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-500 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              {t(locale, 'quotes.markDeclined')}
            </button>
          </>
        )}
        {(quote.status === 'accepted' || quote.status === 'declined') && (
          <button
            type="button"
            onClick={() => onSetStatus(quote.id, 'draft')}
            className="eyebrow inline-flex items-center border border-neutral-300 px-4 py-2 text-neutral-500 transition-colors hover:border-neutral-900 hover:text-neutral-900"
          >
            {t(locale, 'quotes.backToDraft')}
          </button>
        )}
      </div>
      {opError && (
        <p role="alert" className="text-micro tracking-wide text-neutral-900 border-l-2 border-neutral-900 pl-3">
          {opError}
        </p>
      )}

      {/* The composition the customer built, as frozen with the document. */}
      {doc.snapshotUrl && (
        <div className="border border-neutral-200 bg-white overflow-hidden flex items-center justify-center">
          <img src={doc.snapshotUrl} alt="" className="w-full h-auto max-h-[34vh] object-contain block" />
        </div>
      )}

      {/* The frozen lines, hairline-ruled like the lead's items. */}
      {lines.length > 0 && (
        <div className="border-t border-neutral-200">
          {lines.map((ln, i) => (
            <div key={ln.id || i} className="flex items-center gap-4 py-3 min-h-[44px] border-b border-neutral-200">
              <div className="min-w-0 flex-1">
                <div className="text-base text-neutral-900 truncate">{ln.name || EMDASH}</div>
                {(ln.material?.fabric || ln.material?.grade) && (
                  <div className="mt-0.5 text-micro tracking-wide text-neutral-500 truncate">
                    {[ln.material.fabric, ln.material.grade].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-sm tabular-nums text-neutral-900">
                {ln.total != null ? money.format(ln.total) : EMDASH}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The frozen total. */}
      <div className="flex items-baseline justify-between border-t border-neutral-200 pt-4">
        <span className={EYEBROW}>{t(locale, 'inbox.total')}</span>
        <span className="text-2xl font-light tracking-tight tabular-nums text-neutral-900">
          {doc.total != null ? money.format(doc.total) : EMDASH}
        </span>
      </div>

      {/* The open receipt: has the customer looked. */}
      <div className={`${EYEBROW} normal-case tracking-normal text-neutral-500`}>
        {doc.viewCount > 0
          ? t(locale, 'quotes.views', { count: doc.viewCount })
          : t(locale, 'quotes.notViewed')}
      </div>
    </div>
  );
}
