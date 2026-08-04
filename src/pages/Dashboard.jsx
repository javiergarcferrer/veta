import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes, Store, Inbox, FileText, Palette, Tags, Layers, ShieldCheck, Sparkles,
  AlertTriangle, ArrowRight, Loader2, Eye, PackageX, CircleSlash,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { formatDate } from '../lib/format.js';
import { resolveAdminDashboard } from '../core/quote/index.js';
import { ALCOVER_MESH_V } from '../components/togo/togoModelLoader.js';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import PanelCard from '../components/dashboard/PanelCard.jsx';
import StatTile from '../components/dashboard/StatTile.jsx';
import CheckRow, { IssueNote } from '../components/dashboard/CheckRow.jsx';
import { fetchQuotes } from './quoting/api.js';

/**
 * EL PANEL — the screen the manufacturer opens the app on.
 *
 * It exists to answer one question before anything else: ¿ESTÁ MI CATÁLOGO EN
 * CONDICIONES DE VENDER? Everything on it is a fact read off a real row — a
 * count of pieces that fail a named check, a dealer's real catalog scope, a
 * lead's stored estimate, a quote's frozen total — and every number is a link to
 * the screen that changes it. Nothing here is invented, estimated or averaged.
 *
 * MVVM: this component fetches, hands the rows to `resolveAdminDashboard` in one
 * `useMemo` and renders the result. It derives nothing — no counting, no
 * grouping, no money, no thresholds. The only mapping it owns is the one thing
 * that is genuinely the View's: a VM `link` token → a route in this app's
 * router (`hrefFor`), the same way TogoRequests/Quotes own their own `to=`.
 *
 * HONESTY RULES IT RENDERS (all decided in the VM):
 *   • money is grouped BY CURRENCY and never added across them — a quote's
 *     total is frozen in the currency it was written in;
 *   • a check whose data has not landed shows a spinner, never a 0;
 *   • «aún no hay X» is a different state from «X = 0», and reads differently.
 */

/* The ONE place a VM link token becomes a route in this app. */
const SECTION_PATH = {
  modelos: '/modelos',
  distribuidores: '/distribuidores',
  solicitudes: '/solicitudes',
  cotizaciones: '/cotizaciones',
  marcas: '/marcas',
};

function hrefFor(link) {
  if (!link?.section) return null;
  const base = SECTION_PATH[link.section];
  if (!base) return null;
  if (link.section === 'solicitudes' && link.id) return `${base}/${link.id}`;
  // The Solicitudes board reads `?dealer=` on mount — the one deep filter the
  // app actually supports.
  if (link.section === 'solicitudes' && link.dealer) return `${base}?dealer=${encodeURIComponent(link.dealer)}`;
  return base;
}

const TONE_TEXT = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-rose-700 dark:text-rose-400',
  info: 'text-ink-600',
  neutral: 'text-ink-500',
};

const PILL = {
  neutral: 'status-pill-draft',
  info: 'status-pill-sent',
  good: 'status-pill-accepted',
  warn: 'status-pill-pending',
  bad: 'status-pill-declined',
};

/** A labelled figure inside a card body. */
function Figure({ value, label, tone = 'neutral', title }) {
  return (
    <div className="min-w-0" title={title}>
      <div className={`font-display text-lg font-semibold tabular-nums leading-none ${TONE_TEXT[tone] || TONE_TEXT.neutral}`}>
        {value}
      </div>
      <div className="text-[11px] text-ink-500 mt-1 leading-snug">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const { profileId, brand, brandModules } = useApp();

  const q = (fn) => (profileId ? fn() : Promise.resolve([]));

  // Everything below is scoped to the ACTIVE BRAND by the data layer
  // (db/brandScope) — these reads carry no brand plumbing of their own.
  const { data: models, loaded: modelsLoaded } = useLiveQueryStatus(
    () => q(() => db.togoModels.where('profileId').equals(profileId).toArray()),
    [profileId], [],
  );
  const { data: materials, loaded: materialsLoaded } = useLiveQueryStatus(
    () => q(() => db.materials.where('profileId').equals(profileId).cached(300_000).toArray()),
    [profileId], [],
  );
  const { data: dealers, loaded: dealersLoaded } = useLiveQueryStatus(
    () => q(() => db.dealers.where('profileId').equals(profileId).toArray()),
    [profileId], [],
  );
  const { data: requests, loaded: requestsLoaded } = useLiveQueryStatus(
    () => q(() => db.togoRequests.where('profileId').equals(profileId).toArray()),
    [profileId], [],
  );
  // THE PRICE JOIN, and the heaviest read on the screen: a brand's catalog is
  // thousands of SKUs. Only two columns are needed to answer "does this bound
  // root carry a price", so the rest of the row (image arrays, pointer ids)
  // stays server-side, and the result is cached for five minutes. Its `loaded`
  // flag is handed to the VM so the price check says «comprobando» instead of
  // reporting a confident zero while it is still in flight.
  const { data: products, loaded: productsLoaded } = useLiveQueryStatus(
    () => q(() => db.products
      .where('profileId').equals(profileId)
      .columns(['reference', 'priceUsd'])
      .cached(300_000)
      .toArray()),
    [profileId], [],
  );
  // Quotes are FROZEN documents owned by the server — read through the quoting
  // surface's own transport, exactly like pages/quoting/Quotes.jsx does.
  const { data: quoteData, loaded: quotesLoaded, error: quotesError } = useLiveQueryStatus(
    () => fetchQuotes(),
    [], null,
  );

  const vm = useMemo(() => resolveAdminDashboard({
    brand,
    brandModules,
    models,
    materials,
    dealers,
    requests,
    quotes: quoteData?.quotes || [],
    products,
    productsLoaded,
    quotesLoaded,
    quotesError,
    meshVersion: ALCOVER_MESH_V,
  }), [
    brand, brandModules, models, materials, dealers, requests,
    quoteData, products, productsLoaded, quotesLoaded, quotesError,
  ]);

  const coreLoaded = modelsLoaded && dealersLoaded && requestsLoaded && materialsLoaded;

  if (!coreLoaded) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-40 rounded bg-ink-100 animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="stat-card h-[92px] animate-pulse" />)}
        </div>
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Masthead vm={vm} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {vm.kpis.map((k) => (
          <StatTile
            key={k.key}
            icon={{ ready: Boxes, requests: Inbox, quotes: FileText, dealers: Store }[k.key]}
            label={k.label}
            value={k.value}
            hint={k.hint}
            tone={k.tone}
            to={hrefFor(k.link)}
          />
        ))}
      </div>

      <CatalogReadiness catalog={vm.catalog} />

      <div className="grid gap-3 lg:grid-cols-2">
        <RequestsPanel requests={vm.requests} />
        <QuotesPanel quotes={vm.quotes} />
      </div>

      <DealersPanel dealers={vm.dealers} />

      <div className="grid gap-3 lg:grid-cols-2">
        <MaterialsPanel materials={vm.materials} />
        <EnvironmentPanel environment={vm.environment} catalog={vm.catalog} />
      </div>
    </div>
  );
}

/* ------------------------------- masthead -------------------------------- */

function Masthead({ vm }) {
  const { environment: env, catalog } = vm;
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-xl font-semibold text-ink-900 truncate">
          {env.hasBrand ? env.name : 'Panel'}
        </h1>
        <p className="text-xs text-ink-500 mt-1">
          {env.hasBrand
            ? `Entorno de marca · ${env.setLabel || 'sin módulos'}${env.active ? '' : ' · marca inactiva'}`
            : 'Sin marcas configuradas todavía.'}
        </p>
      </div>
      {catalog.total > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-ink-500">
          <span className="tabular-nums">
            {catalog.readyPct}% del catálogo listo
          </span>
          <span className="w-28 h-1.5 rounded-full bg-ink-100 overflow-hidden" aria-hidden>
            <span
              className={`block h-full rounded-full ${catalog.blocked === 0 ? 'bg-emerald-500' : 'bg-brand-500'}`}
              style={{ width: `${catalog.readyPct}%` }}
            />
          </span>
        </div>
      )}
    </header>
  );
}

/* --------------------------- catálogo (la joya) --------------------------- */

function CatalogReadiness({ catalog }) {
  if (catalog.empty) {
    return (
      <PanelCard icon={Boxes} title="Catálogo listo para vender" to={SECTION_PATH.modelos} actionLabel="Ir a Modelos">
        <EmptyState
          icon={Boxes}
          title="Aún no hay modelos en esta marca"
          description="Suelta la biblioteca 3D en Modelos: cada pieza sale con su plano y su malla, y aquí verás exactamente qué le falta para poder venderse."
          action={<Link to={SECTION_PATH.modelos} className="btn-primary text-sm">Abrir Modelos</Link>}
        />
      </PanelCard>
    );
  }

  return (
    <PanelCard
      icon={Boxes}
      title="Catálogo listo para vender"
      subtitle={`${catalog.ready} de ${catalog.total} piezas se pueden configurar y cotizar · ${catalog.collections} ${catalog.collections === 1 ? 'colección' : 'colecciones'}`}
      to={SECTION_PATH.modelos}
      actionLabel="Ir a Modelos"
      bodyClass="p-5 space-y-4"
    >
      {catalog.allReady ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12px] text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          <ShieldCheck size={15} className="shrink-0 mt-px" aria-hidden />
          <span>
            Nada bloquea el catálogo: las {catalog.total} piezas tienen plano, están publicadas,
            llevan SKU y ese SKU tiene precio.
            {catalog.allPolished ? ' Todas con malla optimizada y miniatura horneada.' : ''}
          </span>
        </div>
      ) : catalog.pricePending ? (
        <p className="text-[11px] text-ink-500 inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          Comprobando los precios del catálogo — el conteo de piezas listas es provisional.
        </p>
      ) : null}

      {(catalog.noPriceCatalog || catalog.priceCatalogEmpty) && (
        <IssueNote to={hrefFor(catalog.priceCatalogLink)} actionLabel="Ir a Marcas">
          {catalog.noPriceCatalog
            ? 'Esta marca no tiene catálogo de precios asignado, así que ninguna pieza puede valorizarse.'
            : 'El catálogo de precios de esta marca está vacío: importa la lista y las piezas vinculadas se valorizan solas.'}
        </IssueNote>
      )}

      <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        <div>
          <div className="section-rule mb-1"><span>Impide vender</span></div>
          <ul className="divide-y divide-ink-100">
            {catalog.blockers.map((row) => (
              <CheckRow key={row.key} row={row} to={hrefFor(row.link)} />
            ))}
          </ul>
        </div>
        <div>
          <div className="section-rule mb-1"><span>Se sirve, pero peor</span></div>
          <ul className="divide-y divide-ink-100">
            {catalog.quality.map((row) => (
              <CheckRow key={row.key} row={row} to={hrefFor(row.link)} />
            ))}
          </ul>
        </div>
      </div>

      <p className="text-[10px] text-ink-400 leading-snug">
        Una misma pieza puede aparecer en varias filas: cada una es una comprobación
        independiente sobre la misma fila de datos.
      </p>
    </PanelCard>
  );
}

/* ------------------------------ solicitudes ------------------------------- */

function RequestsPanel({ requests }) {
  return (
    <PanelCard
      icon={Inbox}
      title="Solicitudes"
      subtitle={requests.empty ? null : `${requests.open} abiertas de ${requests.total}`}
      to={SECTION_PATH.solicitudes}
      actionLabel="Ver todas"
      bodyClass="p-5 space-y-4"
    >
      {requests.empty ? (
        <EmptyState
          icon={Inbox}
          title="Aún no hay solicitudes"
          description="Cuando alguien arme una composición en el configurador — el tuyo o el de un distribuidor — su solicitud aparece aquí."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {requests.byStatus.map((s) => (
              <Link
                key={s.key}
                to={SECTION_PATH.solicitudes}
                className={`status-pill ${PILL[s.tone] || PILL.neutral} hover:opacity-80 transition-opacity`}
              >
                {s.label} <span className="tabular-nums opacity-70">{s.count}</span>
              </Link>
            ))}
          </div>

          {requests.oldestOpenDays != null && requests.oldestOpenDays >= 2 && (
            <IssueNote to={SECTION_PATH.solicitudes} actionLabel="Atender">
              La solicitud nueva más antigua lleva {requests.oldestOpenDays}{' '}
              {requests.oldestOpenDays === 1 ? 'día' : 'días'} sin atender.
            </IssueNote>
          )}

          <ul className="divide-y divide-ink-100 -my-1">
            {requests.recent.map((r) => (
              <li key={r.id}>
                <Link to={hrefFor(r.link)} className="flex items-center gap-3 py-2 group">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink-900 truncate group-hover:underline">{r.name}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {[
                        r.dealerLabel,
                        `${r.pieces} ${r.pieces === 1 ? 'pieza' : 'piezas'}`,
                        formatDate(r.createdAt),
                      ].join(' · ')}
                    </div>
                  </div>
                  {r.estimateLabel && (
                    <span className="text-[12px] tabular-nums text-ink-600 shrink-0" title={`Estimado que vio el visitante, en ${r.currency}`}>
                      {r.estimateLabel}
                    </span>
                  )}
                  <span className={`status-pill shrink-0 ${PILL[r.status.tone] || PILL.neutral}`}>
                    {r.status.label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-ink-400">
            El estimado es el que vio el visitante, en la moneda de su distribuidor. No se convierte ni se suma.
          </p>
        </>
      )}
    </PanelCard>
  );
}

/* ------------------------------ cotizaciones ------------------------------ */

function QuotesPanel({ quotes }) {
  return (
    <PanelCard
      icon={FileText}
      title="Cotizaciones"
      subtitle={quotes.empty ? null : `${quotes.total} ${quotes.total === 1 ? 'documento' : 'documentos'}`}
      to={SECTION_PATH.cotizaciones}
      actionLabel="Ver todas"
      bodyClass="p-5 space-y-4"
    >
      {!quotes.loaded ? (
        <p className="text-[12px] text-ink-500 inline-flex items-center gap-2 py-6">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Cargando cotizaciones…
        </p>
      ) : quotes.failed && quotes.empty ? (
        <p className="text-[12px] text-ink-500 py-6 text-center">
          No se pudieron cargar las cotizaciones. Se reintenta solo.
        </p>
      ) : quotes.empty ? (
        <EmptyState
          icon={FileText}
          title="Aún no hay cotizaciones"
          description="Abre una solicitud y pásala a cotización: se congela aquí con sus precios y su enlace para el cliente."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {quotes.byStatus.map((s) => (
              <Link
                key={s.key}
                to={SECTION_PATH.cotizaciones}
                className={`status-pill ${PILL[s.tone] || PILL.neutral} hover:opacity-80 transition-opacity`}
              >
                {s.label} <span className="tabular-nums opacity-70">{s.count}</span>
              </Link>
            ))}
          </div>

          <div className="space-y-2">
            {quotes.pipeline.map((p) => (
              <div key={p.currency} className="surface-subtle px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="eyebrow-xs">{p.currency}</span>
                  <span className="text-[10px] text-ink-400 tabular-nums">
                    {p.quotedCount} {p.quotedCount === 1 ? 'cotización viva' : 'cotizaciones vivas'}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-3">
                  <Figure value={p.quotedLabel} label="Cotizado" />
                  <Figure value={p.sentLabel} label={`Enviado (${p.sentCount})`} tone="info" />
                  <Figure value={p.acceptedLabel} label={`Aceptado (${p.acceptedCount})`} tone="good" />
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-ink-400 leading-snug">
            {quotes.multiCurrency
              ? 'Cada moneda va por separado: el total de una cotización está congelado en la moneda en que se escribió, y sumarlas sería inventar una cifra. No hay total general.'
              : 'El total de cada cotización está congelado en la moneda en que se escribió; aquí solo se agrupa y se muestra.'}
            {quotes.withoutTotal > 0 && ` ${quotes.withoutTotal} sin total congelado (cuentan como documento, no suman dinero).`}
          </p>

          {quotes.unpricedLines > 0 && (
            <IssueNote to={SECTION_PATH.cotizaciones} actionLabel="Revisar">
              {quotes.unpricedLines}{' '}
              {quotes.unpricedLines === 1 ? 'cotización lleva' : 'cotizaciones llevan'} piezas
              que el servidor no pudo valorizar.
            </IssueNote>
          )}

          {quotes.seen > 0 && (
            <p className="text-[11px] text-ink-500 inline-flex items-center gap-1.5">
              <Eye size={12} aria-hidden /> {quotes.seen}{' '}
              {quotes.seen === 1 ? 'abierta por su cliente' : 'abiertas por sus clientes'}.
            </p>
          )}
        </>
      )}
    </PanelCard>
  );
}

/* ----------------------------- distribuidores ----------------------------- */

function DealersPanel({ dealers }) {
  return (
    <PanelCard
      icon={Store}
      title="Distribuidores"
      subtitle={dealers.empty
        ? null
        : `${dealers.active} ${dealers.active === 1 ? 'activo' : 'activos'} · sirven de ${dealers.catalogPieces} ${dealers.catalogPieces === 1 ? 'pieza publicada' : 'piezas publicadas'}`}
      to={SECTION_PATH.distribuidores}
      actionLabel="Gestionar"
      bodyClass="p-5 space-y-3"
    >
      {dealers.empty ? (
        <EmptyState
          icon={Store}
          title="Aún no hay distribuidores"
          description="Da de alta un distribuidor y su configurador queda servido desde este mismo catálogo, con su idioma, su moneda y su margen."
          action={<Link to={SECTION_PATH.distribuidores} className="btn-primary text-sm">Dar de alta</Link>}
        />
      ) : (
        <>
          {dealers.misconfigured > 0 && (
            <IssueNote to={SECTION_PATH.distribuidores}>
              {dealers.misconfigured}{' '}
              {dealers.misconfigured === 1
                ? 'distribuidor tiene un catálogo que no resuelve ninguna pieza: su configurador sale vacío.'
                : 'distribuidores tienen un catálogo que no resuelve ninguna pieza: su configurador sale vacío.'}
            </IssueNote>
          )}

          <ul className="divide-y divide-ink-100 -mt-1">
            {dealers.rows.map((d) => (
              <li key={d.id} className="py-2.5 flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] text-ink-900 truncate">{d.name}</span>
                    {!d.active && <span className="status-pill status-pill-inactive">Inactivo</span>}
                    {d.misconfigured && (
                      <span className="status-pill status-pill-declined inline-flex items-center gap-1">
                        <CircleSlash size={10} aria-hidden /> Catálogo vacío
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-500 truncate" title={d.scopeLabel}>
                    {d.scopeLabel}
                    <span className="text-ink-400"> · {d.servedPieces} {d.servedPieces === 1 ? 'pieza' : 'piezas'}</span>
                  </div>
                  {d.issue && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 inline-flex items-start gap-1">
                      <AlertTriangle size={11} className="shrink-0 mt-px" aria-hidden /> {d.issue}
                    </p>
                  )}
                </div>

                <div className="text-[11px] text-ink-500 shrink-0 text-right">
                  <div>{d.pricingLabel}</div>
                  <div className="text-ink-400 tabular-nums">
                    {d.priceIdentity
                      ? `${d.currency} · sin margen`
                      : `${d.currency} · ×${d.priceMultiplier}${d.usdRate === 1 ? '' : ` · 1 USD = ${d.usdRate}`}`}
                  </div>
                </div>

                <Link
                  to={hrefFor(d.link)}
                  className={`chip-action shrink-0 self-center whitespace-nowrap ${d.openRequests === 0 ? 'opacity-60' : ''}`}
                  title="Ver sus solicitudes"
                >
                  <Inbox size={11} aria-hidden /> {d.openRequests} abiertas
                </Link>
              </li>
            ))}
          </ul>

          {dealers.directOpen > 0 && (
            <p className="text-[11px] text-ink-500">
              Además, {dealers.directOpen}{' '}
              {dealers.directOpen === 1 ? 'solicitud abierta llega' : 'solicitudes abiertas llegan'} de tu
              propio configurador (Directo).
            </p>
          )}
          {!dealers.catalogKnown && (
            <p className="text-[11px] text-ink-400">
              Sin piezas publicadas no se puede juzgar el catálogo de ningún distribuidor.
            </p>
          )}
        </>
      )}
    </PanelCard>
  );
}

/* -------------------------------- materiales ------------------------------ */

function MaterialsPanel({ materials }) {
  return (
    <PanelCard
      icon={Palette}
      title="Materiales"
      subtitle={materials.empty ? null : `${materials.total} ${materials.total === 1 ? 'material' : 'materiales'} · ${materials.colors} colores`}
      to={SECTION_PATH.marcas}
      actionLabel="Importar"
      bodyClass="p-5 space-y-4"
    >
      {materials.empty ? (
        <EmptyState
          icon={Palette}
          title="Aún no hay materiales"
          description="Importa las muestras desde la ficha de la marca: cada archivo se convierte en un color con su tono exacto y su textura."
          action={<Link to={SECTION_PATH.marcas} className="btn-primary text-sm">Ir a Marcas</Link>}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Figure value={materials.total} label="Materiales" />
            <Figure value={materials.colors} label="Colores" />
            <Figure
              value={materials.scanned}
              label="Con textura escaneada"
              tone={materials.scanned > 0 ? 'good' : 'neutral'}
            />
            <Figure
              value={materials.unscanned}
              label="Sin escaneo"
              tone={materials.unscanned > 0 ? 'warn' : 'good'}
              title="Sin textura, el 3D solo puede teñir la pieza con un tono plano"
            />
          </div>

          {materials.unscanned > 0 && (
            <p className="text-[11px] text-ink-500 leading-snug">
              {materials.tinted > 0 && `${materials.tinted} ${materials.tinted === 1 ? 'color se tiñe' : 'colores se tiñen'} con su tono medio (sin trama). `}
              {materials.blank > 0 && `${materials.blank} ${materials.blank === 1 ? 'no tiene' : 'no tienen'} ni tono ni textura: el 3D no puede vestirlos.`}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {materials.discontinued > 0 && (
              <span className="status-pill status-pill-archived inline-flex items-center gap-1">
                <PackageX size={11} aria-hidden /> {materials.discontinued} descontinuados
              </span>
            )}
            {materials.notInPriceList > 0 && (
              <span className="status-pill status-pill-pending inline-flex items-center gap-1">
                <Tags size={11} aria-hidden /> {materials.notInPriceList} fuera de la lista de precios
              </span>
            )}
            {materials.withoutColors > 0 && (
              <span className="status-pill status-pill-draft">
                {materials.withoutColors} sin colores
              </span>
            )}
            {materials.ungraded > 0 && (
              <span className="status-pill status-pill-draft">
                {materials.ungraded} sin grado
              </span>
            )}
            {materials.discontinued === 0 && materials.notInPriceList === 0
              && materials.withoutColors === 0 && materials.ungraded === 0 && (
              <span className="text-[11px] text-ink-500 inline-flex items-center gap-1.5">
                <ShieldCheck size={12} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
                Todos vigentes y en la lista de precios.
              </span>
            )}
          </div>
        </>
      )}
    </PanelCard>
  );
}

/* ---------------------------- entorno de la marca ------------------------- */

function EnvironmentPanel({ environment: env, catalog }) {
  if (!env.hasBrand) {
    return (
      <PanelCard icon={Tags} title="El entorno de la marca" to={SECTION_PATH.marcas} actionLabel="Ir a Marcas">
        <EmptyState
          icon={Tags}
          title="Sin marcas configuradas"
          description="Una marca define cómo se leen sus archivos: qué formatos 3D acepta, cómo se convierten sus muestras y qué gramática tienen sus SKU."
          action={<Link to={SECTION_PATH.marcas} className="btn-primary text-sm">Crear una marca</Link>}
        />
      </PanelCard>
    );
  }

  return (
    <PanelCard
      icon={Layers}
      title="El entorno de la marca"
      subtitle={`Módulos de importación: ${env.setLabel}`}
      to={SECTION_PATH.marcas}
      actionLabel="Configurar"
      bodyClass="p-5 space-y-3"
    >
      {env.fellBack && (
        <IssueNote to={SECTION_PATH.marcas} actionLabel="Revisar">
          El juego de módulos guardado no existe en esta versión; se está usando el de Ligne Roset.
        </IssueNote>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
        <span className="badge">{env.slug}</span>
        <span className="badge">{env.currency}</span>
        <span className="badge">{String(env.locale).toUpperCase()}</span>
        {env.mixed && <span className="badge">módulos mixtos</span>}
        {!env.active && <span className="status-pill status-pill-inactive">Marca inactiva</span>}
        <span className={`badge ${catalog.noPriceCatalog ? 'text-amber-700 dark:text-amber-400' : ''}`}>
          {catalog.noPriceCatalog ? 'sin catálogo de precios' : `catálogo: ${env.catalogBrand}`}
        </span>
      </div>

      {env.setSummary && (
        <p className="text-[11px] text-ink-500 leading-snug inline-flex items-start gap-1.5">
          <Sparkles size={12} className="shrink-0 mt-px text-ink-400" aria-hidden />
          {env.setSummary}
        </p>
      )}

      <div className="space-y-2">
        {env.cards.map((c) => (
          <div key={c.slot} className="surface-subtle px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="eyebrow-xs">{c.title}</span>
              <span className="text-[11px] text-ink-600 truncate" title={c.label}>{c.label}</span>
            </div>
            <dl className="mt-1.5 space-y-0.5">
              {c.facts.map((f) => (
                <div key={f.label} className="flex gap-2 text-[11px]">
                  <dt className="text-ink-400 shrink-0 w-32">{f.label}</dt>
                  <dd className="text-ink-600 min-w-0 break-words font-mono text-[10px] pt-px">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <Link to={SECTION_PATH.marcas} className="text-[11px] text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
        Cambiar cómo se leen los archivos de esta marca <ArrowRight size={11} aria-hidden />
      </Link>
    </PanelCard>
  );
}
