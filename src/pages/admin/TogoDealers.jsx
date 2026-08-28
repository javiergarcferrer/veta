import { useMemo, useState } from 'react';
import {
  Store, Plus, Check, Shield, Loader2, Boxes, Coins, Inbox, AlertTriangle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useConfirm, useToast } from '../../components/ConfirmProvider.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import useColumns from '../../components/search/useColumns.js';
import useLocalPref from '../../components/primitives/useLocalPref.js';
import { formatDateTime } from '../../lib/format.js';
import { PRODUCT_LIST_COLUMNS } from '../../lib/constants.js';
import {
  resolveTogoModels, resolveDealersList, resolveDealerDraft, resolveDealerDetail,
  dealerSlugify, dealerStoredCollections, DEALER_SORT_OPTIONS,
} from '../../core/quote/index.js';
import DealerForm from '../../components/togo/DealerForm.jsx';
import DealerPanel from '../../components/togo/DealerPanel.jsx';

/**
 * DISTRIBUIDORES — the onboarding + management workspace for the Ligne Roset
 * dealers that embed the SAME public Togo configurator on their own sites.
 *
 * The one deploy serves everybody; a `dealers` row is the set of dials that bend
 * it for one storefront — the slug that keys `?dealer=`, the COLLECTIONS they
 * carry, the two money knobs (FX `usdRate` × markup `priceMultiplier`, presented
 * per `pricingMode`), and the token that gates their private lead inbox. The
 * model catalog itself stays ONE catalog maintained by Alcover: a dealer never
 * gets its own models or credentials.
 *
 * Three surfaces, one VM family (core/quote/views/dealerWorkspace):
 *   • the LIST (resolveDealersList) — search, estado, and the columns that
 *     actually decide something: catálogo, precios, solicitudes abiertas.
 *   • the ALTA (resolveDealerDraft) — the guided create flow, each choice with
 *     one line on what it does to their widget and a LIVE price example off the
 *     real catalog.
 *   • the FICHA (resolveDealerDetail) — estado, catálogo, precios, install kit
 *     and THEIR solicitudes.
 *
 * This page derives nothing; it fetches, holds UI state and renders VMs. Renders
 * no page chrome of its own (TogoWorkspace owns the header + tabs); admin-only.
 */

/** A long opaque inbox token = two hex UUIDs concatenated (64 chars). */
function genToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/** Form model ↔ a Dealer row (numbers kept as strings for controlled inputs).
 *  `collections` reads through the Model's own rule: null ⇒ the whole catalog,
 *  an array ⇒ exactly those. */
function formFromDealer(d) {
  return {
    name: d?.name || '',
    slug: d?.slug || '',
    contactEmail: d?.contactEmail || '',
    locale: d?.locale || 'es',
    currency: d?.currency || 'USD',
    usdRate: d?.usdRate != null ? String(d.usdRate) : '1',
    pricingMode: d?.pricingMode || 'full',
    priceMultiplier: d?.priceMultiplier != null ? String(d.priceMultiplier) : '1',
    logoUrl: d?.logoUrl || '',
    notes: d?.notes || '',
    active: d?.active != null ? d.active : true,
    collections: dealerStoredCollections(d),
  };
}

/**
 * The persisted patch a create/edit writes. `collections` comes from the CATALOG
 * VM's `valueToStore` (null for "todas", canonical labels otherwise) so the
 * stored value can never drift from what the picker showed.
 */
function dealerPatchFromForm(form, catalog) {
  return {
    name: form.name.trim(),
    slug: form.slug.trim() || dealerSlugify(form.name),
    contactEmail: form.contactEmail.trim() || null,
    locale: form.locale,
    currency: (form.currency.trim() || 'USD').toUpperCase(),
    usdRate: Number(form.usdRate) || 1,
    pricingMode: form.pricingMode,
    priceMultiplier: Number(form.priceMultiplier) || 1,
    logoUrl: form.logoUrl.trim() || null,
    notes: form.notes.trim() || null,
    active: !!form.active,
    collections: catalog.valueToStore,
  };
}

/**
 * Desktop table columns. ONE ordered definition drives the render (`cell`) and
 * the Columns menu (`label` / `canHide`); `name` is the fixed identity anchor.
 */
const DEALER_COLUMNS = [
  {
    key: 'name', label: 'Distribuidor', canHide: false,
    tdClass: 'font-medium text-ink-900',
    cell: ({ r }) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate">{r.name}</span>
          {!r.active && <span className="status-pill status-pill-inactive shrink-0">Inactivo</span>}
        </div>
        <div className="text-micro text-ink-500 font-mono truncate">/{r.slug}</div>
      </div>
    ),
  },
  {
    key: 'catalog', label: 'Catálogo',
    tdClass: 'text-ink-600',
    cell: ({ r }) => (
      <div className="min-w-0">
        <div className="truncate">{r.catalogLabel}</div>
        <div className="text-micro text-ink-500 tabular-nums">
          {r.catalogPieces} {r.catalogPieces === 1 ? 'pieza' : 'piezas'}
          {r.catalogEmpty && <span className="text-amber-600 dark:text-amber-400"> · sin colecciones</span>}
        </div>
      </div>
    ),
  },
  {
    key: 'pricing', label: 'Precios',
    tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ r }) => (
      <div className="min-w-0">
        <div className="truncate">{r.pricingLabel}</div>
        <div className="text-micro text-ink-500 tabular-nums">{r.moneyLabel}</div>
      </div>
    ),
  },
  {
    key: 'open', label: 'Abiertas',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => (r.open > 0
      ? <span className="font-semibold text-brand-600">{r.open}</span>
      : <span className="text-ink-500">0</span>),
  },
  {
    key: 'total', label: 'Solicitudes',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.total,
  },
  {
    key: 'last', label: 'Última solicitud',
    thClass: 'whitespace-nowrap',
    tdClass: 'text-ink-500 text-xs whitespace-nowrap',
    cell: ({ r }) => (r.lastLeadAt ? formatDateTime(r.lastLeadAt) : '—'),
  },
  {
    key: 'locale', label: 'Idioma',
    tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.localeLabel,
  },
];

const DEALER_DEFAULT_COLS = {
  catalog: true, pricing: true, open: true, total: true, last: true, locale: false,
};

export default function TogoDealers() {
  const { isAdmin, profileId, settings, brand } = useApp();
  const confirm = useConfirm();
  const toast = useToast();

  const { data: dealers, loaded } = useLiveQueryStatus(
    () => (profileId ? db.dealers.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const requests = useLiveQuery(
    () => (profileId ? db.togoRequests.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  // The SAME two reads the Solicitudes tab makes (identical call shapes, so the
  // query cache serves one copy for both): the models are the collections and
  // the products are what prices the example in the live preview.
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  // PROJECTED (PRODUCT_LIST_COLUMNS) — and the Solicitudes tab projects the
  // SAME list, so the two still share one cached corpus. The egress cut,
  // sibling of the Gmail pin.
  const products = useLiveQuery(
    () => (profileId
      ? db.products.where('profileId').equals(profileId).columns(PRODUCT_LIST_COLUMNS).cached(300_000).toArray()
      : Promise.resolve([])),
    [profileId], [],
  );

  // The ONE catalog resolve every dealer surface reads — the same projection the
  // internal builder and the Solicitudes inbox price from, so a dealer's
  // "18 piezas" is eighteen pieces a visitor can really place.
  const resolvedById = useMemo(
    () => resolveTogoModels(models, products).resolvedById,
    [models, products],
  );
  const marginPct = settings?.defaultMarginPct || 0;

  // List UI state (search / estado / sort / columns), persisted per browser.
  const [search, setSearch] = useState('');
  const [status, setStatus] = useLocalPref('rs.dealers.status.v1', 'all');
  const [sort, setSort] = useLocalPref('rs.dealers.sort.v1', { key: 'open', dir: 'desc' });
  const {
    columns, visible: visibleCols, setVisible: setVisibleCols, reset: resetCols, cols,
  } = useColumns(DEALER_COLUMNS, DEALER_DEFAULT_COLS, 'rs.dealers.cols.v1');

  const list = useMemo(
    () => resolveDealersList({ dealers, requests, resolvedById, search, status, sort }),
    [dealers, requests, resolvedById, search, status, sort],
  );

  // Surfaces: 'alta' (guided create), a dealer id (ficha), 'edit:<id>'.
  const [surface, setSurface] = useState(null);
  const openId = surface && surface !== 'alta' ? surface.replace(/^edit:/, '') : null;
  const editing = !!surface && surface.startsWith('edit:');
  const openDealer = useMemo(
    () => (dealers || []).find((d) => d.id === openId) || null,
    [dealers, openId],
  );
  const detail = useMemo(
    () => resolveDealerDetail({ dealer: openDealer, requests, resolvedById, marginPct }),
    [openDealer, requests, resolvedById, marginPct],
  );

  const [busy, setBusy] = useState(false);

  const toggleActive = async () => {
    if (!openDealer || busy) return;
    setBusy(true);
    try {
      await db.dealers.update(openDealer.id, { active: !(openDealer.active !== false), updatedAt: Date.now() });
      toast(openDealer.active !== false ? 'Distribuidor desactivado' : 'Distribuidor activado');
    } finally { setBusy(false); }
  };

  const regenerateToken = async () => {
    if (!openDealer || busy) return;
    const ok = await confirm({
      title: 'Regenerar token',
      message: `El enlace de bandeja actual de «${openDealer.name}» dejará de funcionar y tendrás que enviarle el nuevo. ¿Continuar?`,
      confirmLabel: 'Regenerar',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await db.dealers.update(openDealer.id, { inboxToken: genToken(), updatedAt: Date.now() });
      toast('Token regenerado — envíale el enlace nuevo');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!openDealer) return;
    const ok = await confirm({
      title: 'Eliminar distribuidor',
      message: `Se elimina «${openDealer.name}». Sus solicitudes se conservan, pero quedan sin distribuidor y su enlace deja de funcionar.`,
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    await db.dealers.delete(openDealer.id);
    setSurface(null);
    toast('Distribuidor eliminado');
  };

  if (!isAdmin) {
    return <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar los distribuidores." />;
  }

  return (
    <div className="space-y-4">
      {/* Masthead: what this section is, and the one way in. */}
      <div className="card card-pad flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="icon-tile tint-brand w-9 h-9 rounded-xl shrink-0"><Store size={17} /></span>
          <div className="min-w-0">
            <h2 className="font-display font-semibold text-sm">Distribuidores</h2>
            <p className="text-micro text-ink-500 leading-snug">
              Cada uno embebe el MISMO configurador con su catálogo, su moneda, su margen y su bandeja de solicitudes.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => setSurface('alta')} className="btn-primary text-sm shrink-0">
          <Plus size={15} /> Nuevo distribuidor
        </button>
      </div>

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={4} /></div>
      ) : list.empty ? (
        <EmptyState
          icon={Store}
          title="Aún no hay distribuidores"
          description="Da de alta un distribuidor para darle su propio enlace del configurador, las colecciones que vende, su moneda y una bandeja privada de solicitudes."
          action={<button type="button" onClick={() => setSurface('alta')} className="btn-primary text-sm"><Plus size={15} /> Nuevo distribuidor</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar por nombre, slug, correo o colección…"
            tabs={list.tabs}
            activeTab={status}
            onTabChange={setStatus}
            sortOptions={DEALER_SORT_OPTIONS}
            sort={sort}
            onSortChange={setSort}
            columns={columns}
            visibleColumns={visibleCols}
            onColumnsChange={setVisibleCols}
            onColumnsReset={resetCols}
            resultCount={list.rows.length}
            resultNoun={['distribuidor', 'distribuidores']}
          />

          {/* Mobile: one card per dealer (same fields the table shows). */}
          <div className="md:hidden space-y-2">
            {list.rows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSurface(r.id)}
                className="card card-pad w-full text-left space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900 truncate">{r.name}</span>
                  <span className={`status-pill ${r.statusCls} shrink-0`}>{r.statusLabel}</span>
                </div>
                <div className="text-micro text-ink-500 font-mono truncate">/{r.slug}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-micro text-ink-500">
                  <span className="inline-flex items-center gap-1"><Boxes size={11} /> {r.catalogLabel}</span>
                  <span className="inline-flex items-center gap-1"><Coins size={11} /> {r.moneyLabel}</span>
                  <span className="inline-flex items-center gap-1 tabular-nums"><Inbox size={11} /> {r.open} abiertas · {r.total} total</span>
                </div>
                {r.catalogEmpty && (
                  <div className="text-micro text-amber-700 dark:text-amber-300 flex items-center gap-1">
                    <AlertTriangle size={11} /> Sin colecciones asignadas.
                  </div>
                )}
              </button>
            ))}
            {list.noMatches && <p className="card card-pad text-center text-sm text-ink-500">Sin resultados.</p>}
          </div>

          <div className="hidden md:block card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>{cols.map((col) => <th key={col.key} className={col.thClass || ''}>{col.label}</th>)}</tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setSurface(r.id)}
                      className="hover:bg-ink-50 transition-colors cursor-pointer"
                    >
                      {cols.map((col) => <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>)}
                    </tr>
                  ))}
                  {list.noMatches && (
                    <tr><td colSpan={cols.length} className="text-center text-sm text-ink-500 py-6">Sin resultados.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ALTA — the guided create flow. Mounted only while open (and keyed on the
          target), so every open seeds its form from the row on screen and a
          cancelled edit can never leave half-typed state behind. */}
      {surface === 'alta' && (
        <DealerEditor
          key="alta"
          title="Alta de distribuidor"
          dealer={null}
          dealers={dealers}
          resolvedById={resolvedById}
          marginPct={marginPct}
          profileId={profileId}
          onClose={() => setSurface(null)}
          onSaved={(id) => { setSurface(id); toast('Distribuidor creado — cópiale el kit de instalación'); }}
        />
      )}

      {/* EDICIÓN — the same four decisions, on a saved dealer. */}
      {editing && openDealer && (
        <DealerEditor
          key={`edit:${openDealer.id}`}
          title={`Editar ${openDealer.name || 'distribuidor'}`}
          dealer={openDealer}
          dealers={dealers}
          resolvedById={resolvedById}
          marginPct={marginPct}
          profileId={profileId}
          onClose={() => setSurface(openId)}
          onSaved={(id) => { setSurface(id); toast('Cambios guardados'); }}
        />
      )}

      {/* FICHA — the per-dealer panel. */}
      <Modal
        open={!!openId && !editing}
        onClose={() => setSurface(null)}
        title="Ficha del distribuidor"
        size="lg"
      >
        {detail ? (
          <DealerPanel
            vm={detail}
            brandName={brand?.name || null}
            busy={busy}
            onEdit={() => setSurface(`edit:${openId}`)}
            onToggleActive={toggleActive}
            onRegenerateToken={regenerateToken}
            onDelete={remove}
          />
        ) : (
          // The gap between writing a new dealer and the live query returning it.
          <div className="py-10 text-center text-sm text-ink-500">
            <Loader2 size={16} className="animate-spin inline-block" />
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * The create/edit modal. Both flows run the SAME `resolveDealerDraft`, so a
 * dealer can never be created through one set of rules and edited through
 * another — and the save is gated on the draft's own `canSave` (a duplicate
 * slug, a dealer with no collections and a junk currency each block here rather
 * than reaching the widget).
 */
function DealerEditor({
  title, dealer, dealers, resolvedById, marginPct, profileId, onClose, onSaved,
}) {
  // The caller mounts this only while open and keys it on the target, so the
  // initializer runs once per open — always off the row on screen.
  const [form, setForm] = useState(() => formFromDealer(dealer));
  const [saving, setSaving] = useState(false);

  const draft = useMemo(
    () => resolveDealerDraft({ form, dealers, resolvedById, marginPct, editingId: dealer?.id || null }),
    [form, dealers, resolvedById, marginPct, dealer],
  );

  const save = async () => {
    if (!draft.canSave || saving) return;
    setSaving(true);
    try {
      const patch = dealerPatchFromForm(form, draft.catalog);
      if (dealer) {
        await db.dealers.update(dealer.id, { ...patch, updatedAt: Date.now() });
        onSaved(dealer.id);
      } else {
        const id = newId();
        await db.dealers.put({
          id,
          profileId,
          ...patch,
          inboxToken: genToken(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        onSaved(id);
      }
    } finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={(
        <div className="flex items-center justify-between gap-3 w-full">
          <p className="text-micro text-ink-500 min-w-0 truncate">
            {draft.issues.length > 0
              ? draft.issues[0].text
              : draft.catalog.summary}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancelar</button>
            <button type="button" onClick={save} disabled={!draft.canSave || saving} className="btn-primary text-sm disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {dealer ? 'Guardar cambios' : 'Crear distribuidor'}
            </button>
          </div>
        </div>
      )}
    >
      {/* The step strip: where you are in the alta, and what each step currently
          means for this dealer's widget. */}
      <ol className="flex flex-wrap gap-1.5 mb-3">
        {draft.steps.map((s) => (
          <li
            key={s.key}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-micro ${
              s.done
                ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
                : 'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200'
            }`}
            title={s.summary}
          >
            {s.done ? <Check size={11} /> : <AlertTriangle size={11} />} {s.label}
          </li>
        ))}
      </ol>

      <DealerForm form={form} setForm={setForm} draft={draft} dealer={dealer} />
    </Modal>
  );
}
