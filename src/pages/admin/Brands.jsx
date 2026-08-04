import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Tags, Plus, Check, Shield, Loader2, AlertTriangle, Boxes, Palette, FileText,
  Power, Trash2, UploadCloud,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { uploadSwatchTexture, removeSwatchTexture } from '../../db/swatchUpload.js';
import { useConfirm, useToast } from '../../components/ConfirmProvider.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import useColumns from '../../components/search/useColumns.js';
import useLocalPref from '../../components/primitives/useLocalPref.js';
import useFileIntake from '../../components/primitives/useFileIntake.js';
import { formatDateTime } from '../../lib/format.js';
import {
  BRAND_LOCALES, BRAND_SORT_OPTIONS, brandSlugify, formFromBrand, moduleAdapterOptions,
  moduleSetOptions, moduleSetFor, planMaterialImport, planPriceListImport, readCsvRecords,
  relPathOf, resolveBrandDraft, resolveBrandEnvironment, resolveBrandsList, tallyByBrand,
} from '../../brands/index.js';

/**
 * MARCAS — the brand microenvironments.
 *
 * A brand is not a label on a row: it is an ISOLATED ENVIRONMENT. Its models,
 * materials, telas, distribuidores and solicitudes are its own (the data layer
 * filters every read and stamps every write to the open brand — db/brandScope),
 * and — the part that actually differs between manufacturers — it carries its
 * own IMPORT MODULES: how ITS 3D library is filed, how ITS material archive
 * becomes colours, how ITS SKUs and price list read.
 *
 * Three surfaces, one VM family (src/brands/views/brandsAdmin):
 *   • the LIST (resolveBrandsList) — identity, módulos, and what is actually
 *     inside each environment.
 *   • the EDITOR (resolveBrandDraft) — identity, idioma, moneda, marca visual,
 *     and WHICH MODULE SET reads its files, with each module's capabilities
 *     (what it accepts, what its SKU grammar looks like) beside the choice.
 *   • the FICHA (resolveBrandEnvironment) — what the environment holds, what is
 *     missing, and the two importers those modules make possible: MATERIALES
 *     (a folder of swatches → colours the 3D can wear) and LISTA DE PRECIOS
 *     (a CSV → the brand's own catalog).
 *
 * The page derives nothing; it fetches, holds UI state and renders VMs.
 * Admin-only, like every other admin surface here.
 */

const BRAND_COLUMNS = [
  {
    key: 'name',
    label: 'Marca',
    canHide: false,
    tdClass: 'font-medium text-ink-900',
    cell: ({ r }) => (
      <span className="inline-flex items-center gap-2 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-inset ring-black/10"
          style={{ background: r.primaryColor || 'rgb(var(--ink-200))' }}
          aria-hidden
        />
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  {
    key: 'slug',
    label: 'Identificador',
    tdClass: 'text-ink-400 font-mono text-xs whitespace-nowrap',
    cell: ({ r }) => r.slug,
  },
  {
    key: 'modules',
    label: 'Módulos',
    tdClass: 'text-ink-600 text-xs',
    cell: ({ r }) => (
      <span className="inline-flex items-center gap-1.5">
        {r.moduleLabel}
        {r.mixed && <span className="rounded-full bg-ink-100 px-1.5 py-px text-[10px] text-ink-500">mixto</span>}
        {r.moduleFellBack && (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" title="El juego guardado no existe; se usa el de Ligne Roset">
            <AlertTriangle size={11} /> revisar
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Estado',
    thClass: 'whitespace-nowrap',
    cell: ({ r }) => <span className={`status-pill ${r.statusCls}`}>{r.statusLabel}</span>,
  },
  {
    key: 'models',
    label: 'Modelos',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => (r.models ? r.models : <span className="text-ink-400">0</span>),
  },
  {
    key: 'materials',
    label: 'Materiales',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.materials,
  },
  {
    key: 'dealers',
    label: 'Distribuidores',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.dealers,
  },
  {
    key: 'money',
    label: 'Idioma · moneda',
    tdClass: 'text-ink-500 text-xs whitespace-nowrap',
    cell: ({ r }) => `${r.localeLabel} · ${r.currency}`,
  },
  {
    key: 'updated',
    label: 'Actualizada',
    tdClass: 'text-ink-500 text-xs whitespace-nowrap',
    cell: ({ r }) => (r.updatedAt ? formatDateTime(r.updatedAt) : '—'),
  },
];

const BRAND_DEFAULT_COLS = {
  slug: true, modules: true, status: true, models: true,
  materials: true, dealers: false, money: false, updated: false,
};

export default function Brands() {
  const { isAdmin, profileId, brands, brandsAvailable, brand: activeBrand, refreshBrands, selectBrand } = useApp();
  const confirm = useConfirm();
  const toast = useToast();

  const brandIds = useMemo(() => (brands || []).map((b) => b.id), [brands]);

  // The per-brand counts. Every read filters `brandId` EXPLICITLY, which is
  // also what opts it out of the automatic brand scope (db/brandScope): this is
  // the one surface that legitimately looks across every environment. Only the
  // id + the brand come back — a tally never needs the rows.
  const { data: modelCounts, loaded: countsLoaded } = useLiveQueryStatus(
    () => (brandIds.length
      ? db.togoModels.where('brandId').anyOf(brandIds).columns(['id', 'brandId']).toArray()
      : Promise.resolve([])),
    [brandIds], [],
  );
  const materialCounts = useLiveQuery(
    () => (brandIds.length
      ? db.materials.where('brandId').anyOf(brandIds).columns(['id', 'brandId']).toArray()
      : Promise.resolve([])),
    [brandIds], [],
  );
  const fabricCounts = useLiveQuery(
    () => (brandIds.length
      ? db.modelFabrics.where('brandId').anyOf(brandIds).columns(['id', 'brandId']).toArray()
      : Promise.resolve([])),
    [brandIds], [],
  );
  const dealerCounts = useLiveQuery(
    () => (brandIds.length
      ? db.dealers.where('brandId').anyOf(brandIds).columns(['id', 'brandId']).toArray()
      : Promise.resolve([])),
    [brandIds], [],
  );
  const requestCounts = useLiveQuery(
    () => (brandIds.length
      ? db.togoRequests.where('brandId').anyOf(brandIds).columns(['id', 'brandId']).toArray()
      : Promise.resolve([])),
    [brandIds], [],
  );

  const counts = useMemo(() => ({
    models: tallyByBrand(modelCounts).by,
    materials: tallyByBrand(materialCounts).by,
    fabrics: tallyByBrand(fabricCounts).by,
    dealers: tallyByBrand(dealerCounts).by,
    requests: tallyByBrand(requestCounts).by,
  }), [modelCounts, materialCounts, fabricCounts, dealerCounts, requestCounts]);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useLocalPref('veta.brands.status.v1', 'all');
  const [sort, setSort] = useLocalPref('veta.brands.sort.v1', { key: 'name', dir: 'asc' });
  const {
    columns, visible: visibleCols, setVisible: setVisibleCols, reset: resetCols, cols,
  } = useColumns(BRAND_COLUMNS, BRAND_DEFAULT_COLS, 'veta.brands.cols.v1');

  const list = useMemo(
    () => resolveBrandsList({ brands, counts, search, status, sort }),
    [brands, counts, search, status, sort],
  );

  // Surfaces: 'alta' (create), a brand id (ficha), 'edit:<id>'.
  const [surface, setSurface] = useState(null);
  const openId = surface && surface !== 'alta' ? surface.replace(/^edit:/, '') : null;
  const editing = !!surface && surface.startsWith('edit:');
  const openBrand = useMemo(() => (brands || []).find((b) => b.id === openId) || null, [brands, openId]);

  // The open brand's own catalog size — one exact head count, only once a brand
  // is open (the catalog is tens of thousands of rows; never fetched to count).
  const openCatalogBrand = openBrand?.settings?.catalogBrand || '';
  const productCount = useLiveQuery(
    () => (openCatalogBrand
      ? db.products.where('brand').equals(openCatalogBrand).count()
      : Promise.resolve(null)),
    [openCatalogBrand], null,
  );

  const environment = useMemo(() => resolveBrandEnvironment({
    brand: openBrand,
    counts: {
      models: counts.models.get(openId) || 0,
      materials: counts.materials.get(openId) || 0,
      fabrics: counts.fabrics.get(openId) || 0,
      dealers: counts.dealers.get(openId) || 0,
      requests: counts.requests.get(openId) || 0,
    },
    productCount,
  }), [openBrand, counts, openId, productCount]);

  const [busy, setBusy] = useState(false);

  const toggleActive = async () => {
    if (!openBrand || busy) return;
    setBusy(true);
    try {
      const next = openBrand.active === false;
      await db.brands.update(openBrand.id, { active: next, updatedAt: Date.now() });
      await refreshBrands();
      toast(next ? 'Marca activada' : 'Marca desactivada');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!openBrand) return;
    const inside = (counts.models.get(openBrand.id) || 0) + (counts.materials.get(openBrand.id) || 0)
      + (counts.dealers.get(openBrand.id) || 0) + (counts.requests.get(openBrand.id) || 0);
    if (inside > 0) {
      // The rows point at this brand by foreign key; deleting it would either be
      // refused by Postgres or orphan a whole environment. Desactivar is the
      // honest answer, and it is one click away.
      toast('Esta marca tiene datos dentro: desactívala en vez de eliminarla.');
      return;
    }
    const ok = await confirm({
      title: 'Eliminar marca',
      message: `Se elimina «${openBrand.name}». No tiene modelos, materiales, distribuidores ni solicitudes.`,
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    await db.brands.delete(openBrand.id);
    await refreshBrands();
    setSurface(null);
    toast('Marca eliminada');
  };

  if (!isAdmin) {
    return <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar las marcas." />;
  }

  // The `brands` table isn't there yet (a deploy that reached Vercel before the
  // migration reached Supabase). Say so plainly — the rest of the app keeps
  // working unscoped, which is exactly what it did before brands existed.
  if (!brandsAvailable) {
    return (
      <EmptyState
        icon={Tags}
        title="Las marcas aún no están disponibles"
        description="La base de datos todavía no tiene la tabla de marcas. En cuanto la migración se aplique, esta pantalla se llena sola y el resto de la aplicación sigue funcionando igual mientras tanto."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="card card-pad flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="icon-tile tint-brand w-9 h-9 rounded-xl shrink-0"><Tags size={17} /></span>
          <div className="min-w-0">
            <h2 className="font-display font-semibold text-sm">Marcas</h2>
            <p className="text-[11px] text-ink-500 leading-snug">
              Cada marca es un entorno aparte — sus modelos, materiales, distribuidores y solicitudes — con sus propios
              módulos de importación: cómo se lee SU biblioteca 3D, SUS muestras y SU lista de precios.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => setSurface('alta')} className="btn-primary text-sm shrink-0">
          <Plus size={15} /> Nueva marca
        </button>
      </div>

      {!countsLoaded && list.empty ? (
        <div className="card overflow-hidden"><ListLoading rows={3} /></div>
      ) : list.empty ? (
        <EmptyState
          icon={Tags}
          title="Aún no hay marcas"
          description="Crea la primera marca para darle su propio catálogo de modelos, sus materiales y el módulo de importación que lee sus archivos."
          action={<button type="button" onClick={() => setSurface('alta')} className="btn-primary text-sm"><Plus size={15} /> Nueva marca</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar por nombre, identificador o módulo…"
            tabs={list.tabs}
            activeTab={status}
            onTabChange={setStatus}
            sortOptions={BRAND_SORT_OPTIONS}
            sort={sort}
            onSortChange={setSort}
            columns={columns}
            visibleColumns={visibleCols}
            onColumnsChange={setVisibleCols}
            onColumnsReset={resetCols}
            resultCount={list.rows.length}
            resultNoun={['marca', 'marcas']}
          />

          <div className="md:hidden space-y-2">
            {list.rows.map((r) => (
              <button key={r.id} type="button" onClick={() => setSurface(r.id)} className="card card-pad w-full text-left space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900 truncate">{r.name}</span>
                  <span className={`status-pill ${r.statusCls} shrink-0`}>{r.statusLabel}</span>
                </div>
                <div className="text-[11px] text-ink-400 font-mono truncate">{r.slug}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                  <span className="inline-flex items-center gap-1"><Boxes size={11} /> {r.models} modelos</span>
                  <span className="inline-flex items-center gap-1"><Palette size={11} /> {r.materials} materiales</span>
                  <span className="truncate">· {r.moduleLabel}</span>
                </div>
              </button>
            ))}
            {list.noMatches && <p className="card card-pad text-center text-sm text-ink-400">Sin resultados.</p>}
          </div>

          <div className="hidden md:block card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>{cols.map((col) => <th key={col.key} className={col.thClass || ''}>{col.label}</th>)}</tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} onClick={() => setSurface(r.id)} className="hover:bg-ink-50 transition-colors cursor-pointer">
                      {cols.map((col) => <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>)}
                    </tr>
                  ))}
                  {list.noMatches && (
                    <tr><td colSpan={cols.length} className="text-center text-sm text-ink-400 py-6">Sin resultados.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ALTA / EDICIÓN — mounted only while open and keyed on the target, so
          every open seeds its form from the row on screen. */}
      {(surface === 'alta' || editing) && (
        <BrandEditor
          key={surface}
          title={editing ? `Editar ${openBrand?.name || 'marca'}` : 'Nueva marca'}
          brand={editing ? openBrand : null}
          brands={brands}
          onClose={() => setSurface(editing ? openId : null)}
          onSaved={async (id) => {
            await refreshBrands();
            setSurface(id);
            toast(editing ? 'Cambios guardados' : 'Marca creada');
          }}
        />
      )}

      {/* FICHA — the environment: what is inside, what its modules can read, and
          the two importers those modules make possible. */}
      <Modal open={!!openId && !editing} onClose={() => setSurface(null)} title="Entorno de la marca" size="lg">
        {environment ? (
          <BrandEnvironmentPanel
            vm={environment}
            brand={openBrand}
            profileId={profileId}
            busy={busy}
            isActiveBrand={activeBrand?.id === openBrand?.id}
            onOpenBrand={() => { selectBrand(openBrand.id); toast(`Trabajando en ${openBrand.name}`); }}
            onEdit={() => setSurface(`edit:${openId}`)}
            onToggleActive={toggleActive}
            onDelete={remove}
            onToast={toast}
          />
        ) : (
          <div className="py-10 text-center text-sm text-ink-400"><Loader2 size={16} className="animate-spin inline-block" /></div>
        )}
      </Modal>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  THE EDITOR                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Create/edit run the SAME `resolveBrandDraft`, so a brand can never be created
 * through one set of rules and edited through another — and the save is gated on
 * the draft's own `canSave` (a duplicate identifier, a junk currency and a
 * missing module set each block here rather than reaching the studio).
 */
function BrandEditor({ title, brand, brands, onClose, onSaved }) {
  const [form, setForm] = useState(() => formFromBrand(brand));
  const [saving, setSaving] = useState(false);
  // The identifier follows the name until the dealer types one himself — after
  // that it is his, because it is the brand's public handle and the key its
  // price list lives under.
  const slugTouched = useRef(!!brand);

  const draft = useMemo(
    () => resolveBrandDraft({ form, brands, editingId: brand?.id || null }),
    [form, brands, brand],
  );

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!draft.canSave || saving) return;
    setSaving(true);
    try {
      if (brand) {
        await db.brands.update(brand.id, { ...draft.patch, updatedAt: Date.now() });
        onSaved(brand.id);
      } else {
        const id = newId();
        await db.brands.put({ id, ...draft.patch, createdAt: Date.now(), updatedAt: Date.now() });
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
          <p className="text-[11px] text-ink-400 min-w-0 truncate">
            {draft.issues.length > 0 ? draft.issues[0].text : draft.capabilities.summary}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancelar</button>
            <button type="button" onClick={save} disabled={!draft.canSave || saving} className="btn-primary text-sm disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {brand ? 'Guardar cambios' : 'Crear marca'}
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="brand-name">Nombre</label>
            <input
              id="brand-name"
              className="input"
              value={form.name}
              onChange={(e) => set({
                name: e.target.value,
                ...(slugTouched.current ? null : { slug: brandSlugify(e.target.value) }),
              })}
              placeholder="p. ej. Ligne Roset"
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="brand-slug">Identificador</label>
            <input
              id="brand-slug"
              className="input font-mono text-xs"
              value={form.slug}
              onChange={(e) => { slugTouched.current = true; set({ slug: e.target.value }); }}
              onBlur={(e) => set({ slug: brandSlugify(e.target.value) })}
              placeholder="ligne-roset"
            />
            <p className="mt-1 text-[11px] text-ink-400">Se usa en enlaces y como catálogo de precios por defecto.</p>
          </div>
          <div>
            <label className="label" htmlFor="brand-locale">Idioma</label>
            <select
              id="brand-locale"
              className="input"
              value={form.locale}
              onChange={(e) => set({ locale: e.target.value })}
            >
              {BRAND_LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="brand-currency">Moneda</label>
            <input
              id="brand-currency"
              className="input uppercase"
              value={form.currency}
              onChange={(e) => set({ currency: e.target.value.toUpperCase().slice(0, 3) })}
              placeholder="USD"
              maxLength={3}
            />
          </div>
          <div>
            <label className="label" htmlFor="brand-logo">Logo (URL)</label>
            <input
              id="brand-logo"
              className="input"
              value={form.logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder="https://…"
            />
          </div>
          <div>
            <label className="label" htmlFor="brand-color">Color</label>
            <div className="flex items-center gap-2">
              <input
                id="brand-color"
                type="color"
                className="h-9 w-12 rounded-md border border-ink-200 bg-surface p-1"
                value={/^#[0-9a-f]{6}$/i.test(form.primaryColor) ? form.primaryColor : '#3600ff'}
                onChange={(e) => set({ primaryColor: e.target.value })}
                aria-label="Color de la marca"
              />
              <input
                className="input font-mono text-xs flex-1"
                value={form.primaryColor}
                onChange={(e) => set({ primaryColor: e.target.value })}
                placeholder="#3600ff"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="brand-catalog">Catálogo de precios</label>
          <input
            id="brand-catalog"
            className="input font-mono text-xs"
            value={form.catalogBrand}
            onChange={(e) => set({ catalogBrand: e.target.value })}
            placeholder={form.slug || 'ligne-roset'}
          />
          <p className="mt-1 text-[11px] text-ink-400">
            Qué catálogo de productos ve esta marca. Vacío = usa su propio identificador, que empieza sin SKU — nunca los
            precios de otra marca.
          </p>
        </div>

        {/* ── THE IMPORT MODULES. The decision that actually differentiates one
            manufacturer from another, so it is shown as a choice with its
            consequences, never as a bare dropdown. */}
        <div className="rounded-xl border border-ink-100 p-3 space-y-3">
          <div>
            <span className="label">Módulos de importación</span>
            <p className="text-[11px] text-ink-500 -mt-1">
              Cómo se leen los archivos de esta marca: su biblioteca 3D, sus muestras de material y su lista de precios.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {moduleSetOptions().map((s) => {
              const active = form.moduleSet === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => set({ moduleSet: s.id, geometry: null, materials: null, catalog: null })}
                  aria-pressed={active}
                  className={`rounded-lg border p-2.5 text-left transition ${
                    active ? 'border-brand-400 ring-2 ring-brand-400 bg-brand-50/40' : 'border-ink-200 hover:border-brand-300'
                  }`}
                >
                  <span className="block text-[13px] font-semibold text-ink-800">{s.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-500">{s.summary}</span>
                </button>
              );
            })}
          </div>

          <ModuleCapabilityCards capabilities={draft.capabilities} form={form} onChange={set} />
        </div>
      </div>
    </Modal>
  );
}

/** The three capability cards — what each module ACCEPTS and what it
 *  UNDERSTANDS — each with its own per-slot override, which is what makes the
 *  modules genuinely pluggable rather than three fixed bundles. */
function ModuleCapabilityCards({ capabilities, form, onChange }) {
  return (
    <div className="space-y-2">
      {capabilities.fellBack && (
        <p className="rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:border-amber-900/40 dark:text-amber-200">
          El juego de módulos guardado no existe en esta versión; se está usando el de Ligne Roset.
        </p>
      )}
      {capabilities.cards.map((c) => (
        <div key={c.slot} className="rounded-lg border border-ink-100 bg-surface p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">{c.title}</span>
            <select
              className="input h-7 py-0 text-[11px] max-w-[14rem]"
              value={c.id}
              onChange={(e) => onChange({ [c.slot]: e.target.value })}
              aria-label={`Módulo de ${c.title}`}
            >
              {moduleAdapterOptions(c.slot).map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink-500">{c.summary}</p>
          <dl className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
            {c.facts.map((f) => (
              <div key={f.label} className="flex items-baseline gap-1.5 min-w-0">
                <dt className="text-[10px] uppercase tracking-wide text-ink-400 shrink-0">{f.label}</dt>
                <dd className="text-[11px] text-ink-700 font-mono truncate" title={f.value}>{f.value}</dd>
              </div>
            ))}
          </dl>
          {form[c.slot] && form[c.slot] !== c.id && (
            <p className="mt-1 text-[11px] text-amber-700">Ese módulo no existe; se usa {c.label}.</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  THE FICHA — the environment + its importers                                */
/* ─────────────────────────────────────────────────────────────────────────── */

function BrandEnvironmentPanel({
  vm, brand, profileId, busy, isActiveBrand, onOpenBrand, onEdit, onToggleActive, onDelete, onToast,
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-display font-semibold text-sm truncate">{vm.name}</h3>
            <span className={`status-pill ${vm.active ? 'status-pill-active' : 'status-pill-inactive'}`}>
              {vm.active ? 'Activa' : 'Inactiva'}
            </span>
          </div>
          <p className="text-[11px] text-ink-400 font-mono">{vm.slug}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isActiveBrand && vm.active && (
            <button type="button" onClick={onOpenBrand} className="btn-secondary text-xs">Trabajar en esta marca</button>
          )}
          <button type="button" onClick={onEdit} className="btn-secondary text-xs">Editar</button>
          <button type="button" onClick={onToggleActive} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
            <Power size={13} /> {vm.active ? 'Desactivar' : 'Activar'}
          </button>
          <button type="button" onClick={onDelete} className="btn-ghost text-xs text-red-600">
            <Trash2 size={13} /> Eliminar
          </button>
        </div>
      </div>

      {/* WHAT IS INSIDE. Honest counts of real rows — a brand with nothing shows
          zeros and what to do about them, never invented content. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {vm.counts.map((c) => (
          <div key={c.key} className="rounded-lg border border-ink-100 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wide text-ink-400">{c.label}</div>
            <div className="text-lg font-semibold tabular-nums text-ink-900">{c.value}</div>
          </div>
        ))}
      </div>
      {vm.catalogBrand && (
        <p className="text-[11px] text-ink-500">
          Catálogo <b className="font-mono text-ink-700">{vm.catalogBrand}</b>
          {vm.productCount == null ? ' — contando…' : ` — ${vm.productCount.toLocaleString('es-DO')} SKU`}
        </p>
      )}
      {vm.gaps.length > 0 && (
        <ul className="space-y-1">
          {vm.gaps.map((g, i) => (
            <li key={`${g.key}-${i}`} className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-200">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {g.text}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-ink-100 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500 mb-2">
          Módulos de importación — {vm.modules.label}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {vm.modules.cards.map((c) => (
            <div key={c.slot} className="rounded-lg bg-ink-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-ink-400">{c.title}</div>
              <div className="text-[12px] font-medium text-ink-800">{c.label}</div>
              {c.facts.map((f) => (
                <div key={f.label} className="mt-0.5 text-[10px] text-ink-500 truncate" title={`${f.label}: ${f.value}`}>
                  {f.label}: <span className="font-mono text-ink-600">{f.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <MaterialImportPanel brand={brand} profileId={profileId} onToast={onToast} />
      <PriceListImportPanel brand={brand} profileId={profileId} onToast={onToast} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  IMPORTERS — the module set, actually running                               */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * MATERIALES — a folder of swatches → this brand's colours.
 *
 * Every file goes through the BRAND's own materials module: it decides what it
 * can read, pulls the code and the name out of the filename, averages the exact
 * tone off the scan and hands back the texture to store. The rows are planned
 * purely (`planMaterialImport`) and written in ONE `bulkPut`, so re-importing
 * the same folder converges instead of duplicating.
 *
 * Files are read STRICTLY SEQUENTIALLY: decoding is heavy, and a folder of four
 * hundred scans in parallel is how the tab dies with the dealer's afternoon in
 * it. A file that can't be read costs that file and nothing else.
 */
function MaterialImportPanel({ brand, profileId, onToast }) {
  const modules = useMemo(() => moduleSetFor(brand), [brand]);
  const adapter = modules.materials;
  const [state, setState] = useState({ stage: 'idle', done: 0, total: 0, current: '' });
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = useCallback(async (files) => {
    const list = Array.from(files || []).filter((f) => adapter.accepts(f));
    if (!list.length) {
      setError(`Ningún archivo reconocible. Este módulo lee ${adapter.extensions.join(', ')}.`);
      return;
    }
    setError(null); setResult(null);
    setState({ stage: 'reading', done: 0, total: list.length, current: list[0].name });

    const upload = (blob, name) => uploadSwatchTexture(blob, { folder: brand.slug || brand.id, name });
    const colors = [];
    const uploaded = [];
    let skipped = 0;
    for (const file of list) {
      setState((s) => ({ ...s, current: relPathOf(file) || file.name }));
      try {
        const color = await adapter.parse(file, { upload });
        if (color) {
          colors.push(color);
          if (color.textureUrl) uploaded.push(color.textureUrl);
        } else skipped += 1;
      } catch {
        skipped += 1;   // one unreadable swatch never costs the drop
      }
      setState((s) => ({ ...s, done: s.done + 1 }));
    }

    if (!colors.length) {
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
      setError('No se pudo leer ninguna muestra. Revisa que los nombres lleven el código (p. ej. 4479_ANIS.jpg).');
      return;
    }

    setState((s) => ({ ...s, stage: 'writing' }));
    try {
      // The brand's OWN materials, read with an explicit brandId (which is also
      // what opts this read out of the active-brand scope — the ficha can be
      // open on a brand that isn't the one being worked in).
      const existing = await db.materials.where('brandId').equals(brand.id).toArray();
      const plan = planMaterialImport({
        colors, existing, profileId, brandId: brand.id, newId,
        fallbackName: `${brand.name} · muestras`,
      });
      if (plan.rows.length) await db.materials.bulkPut(plan.rows);
      setResult({ ...plan.summary, skipped });
      onToast?.(`${plan.summary.colors} colores importados`);
    } catch (e) {
      // The textures are already paid for and would otherwise sit in the bucket
      // forever with nothing pointing at them.
      await Promise.all(uploaded.map((u) => removeSwatchTexture(u)));
      setError(e?.message || 'No se pudieron guardar los materiales.');
    } finally {
      setState({ stage: 'idle', done: 0, total: 0, current: '' });
    }
  }, [adapter, brand, profileId, onToast]);

  const busy = state.stage !== 'idle';
  const intake = useFileIntake({
    accept: adapter.accept,
    multiple: true,
    directories: true,
    disabled: busy,
    onFiles: run,
    onReject: () => setError(`Este módulo lee ${adapter.extensions.join(', ')}.`),
  });

  return (
    <div className="rounded-xl border border-ink-100 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Palette size={14} className="text-ink-400" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">Importar materiales</span>
      </div>
      <p className="text-[11px] text-ink-500">{adapter.summary}</p>
      <div
        {...intake.rootProps}
        onClick={intake.open}
        className={`rounded-lg border-2 border-dashed px-3 py-5 text-center cursor-pointer transition-colors ${
          intake.dragging ? 'border-brand-400 bg-brand-50/40' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50/40'
        }`}
      >
        <input {...intake.inputProps} />
        {busy ? (
          <span className="inline-flex items-center gap-2 text-xs text-ink-500">
            <Loader2 size={14} className="animate-spin" />
            {state.stage === 'writing'
              ? 'Guardando materiales…'
              : `Leyendo ${state.done + 1}/${state.total} · ${state.current}`}
          </span>
        ) : (
          <span className="block text-xs text-ink-500">
            <UploadCloud size={16} className="inline-block mr-1 -mt-0.5" aria-hidden />
            Suelta las muestras o una carpeta ({adapter.extensions.join(', ')})
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 px-3 py-2 text-[11px] text-red-800 dark:text-red-200">
          {error}
        </div>
      )}
      {result && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-[11px] text-emerald-800">
          {result.materials} material{result.materials === 1 ? '' : 'es'} · {result.newColors} colores nuevos
          {result.updatedColors > 0 && <> · {result.updatedColors} actualizados</>}
          {result.skipped > 0 && <> · {result.skipped} archivo{result.skipped === 1 ? '' : 's'} sin código, omitido{result.skipped === 1 ? '' : 's'}</>}
        </div>
      )}
    </div>
  );
}

/**
 * LISTA DE PRECIOS — a CSV → this brand's own catalog.
 *
 * The decode is the BRAND's catalog module (`parsePriceRow`), so Ligne Roset's
 * `reference,description,price` and a generic `sku,grade,price` both land
 * correctly without the page knowing either grammar. Rows are matched against
 * the brand's EXISTING SKUs — fetched by reference, never by downloading the
 * catalog — so a re-import updates instead of duplicating.
 */
function PriceListImportPanel({ brand, profileId, onToast }) {
  const modules = useMemo(() => moduleSetFor(brand), [brand]);
  const adapter = modules.catalog;
  const catalogBrand = brand?.settings?.catalogBrand || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = useCallback(async (files) => {
    const file = Array.from(files || [])[0];
    if (!file) return;
    if (!catalogBrand) {
      setError('Esta marca no tiene catálogo asignado. Ponle uno en «Editar» antes de importar precios.');
      return;
    }
    setError(null); setResult(null); setBusy(true);
    try {
      const { records } = readCsvRecords(await file.text());
      if (!records.length) { setError('El archivo no trae filas.'); return; }

      // First pass: what does this list even reference? (No existing rows yet,
      // so every row reads as "new" — we only want its decoded references.)
      const dry = planPriceListImport({ records, brand, profileId, existing: [], newId });
      const refs = [...new Set(dry.rows.map((r) => String(r.reference)))];
      if (!refs.length) {
        setError(`Ninguna fila se pudo leer. Este módulo espera las columnas ${adapter.priceColumns.join(', ')}.`);
        return;
      }
      // Then fetch ONLY those SKUs (chunked under the API cap) — a catalog of
      // 27k rows is never downloaded to import 300 prices.
      const existing = [];
      const CHUNK = 200;
      for (let i = 0; i < refs.length; i += CHUNK) {
        existing.push(...await db.products
          .where('brand').equals(catalogBrand)
          .where('reference').anyOf(refs.slice(i, i + CHUNK))
          .toArray());
      }
      const plan = planPriceListImport({ records, brand, profileId, existing, newId });
      if (plan.rows.length) await db.products.bulkPut(plan.rows);
      setResult(plan.summary);
      onToast?.(`${plan.summary.total} SKU importados`);
    } catch (e) {
      setError(e?.message || 'No se pudo leer la lista de precios.');
    } finally {
      setBusy(false);
    }
  }, [brand, catalogBrand, profileId, adapter, onToast]);

  const intake = useFileIntake({
    accept: '.csv,.txt,.tsv',
    multiple: false,
    disabled: busy,
    onFiles: run,
    onReject: () => setError('Sube un CSV.'),
  });

  return (
    <div className="rounded-xl border border-ink-100 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-ink-400" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">Importar lista de precios</span>
      </div>
      <p className="text-[11px] text-ink-500">
        {adapter.summary} Columnas: <span className="font-mono text-ink-600">{adapter.priceColumns.join(',')}</span>.
      </p>
      <div
        {...intake.rootProps}
        onClick={intake.open}
        className={`rounded-lg border-2 border-dashed px-3 py-5 text-center cursor-pointer transition-colors ${
          intake.dragging ? 'border-brand-400 bg-brand-50/40' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50/40'
        }`}
      >
        <input {...intake.inputProps} />
        {busy ? (
          <span className="inline-flex items-center gap-2 text-xs text-ink-500"><Loader2 size={14} className="animate-spin" /> Importando…</span>
        ) : (
          <span className="block text-xs text-ink-500">
            <UploadCloud size={16} className="inline-block mr-1 -mt-0.5" aria-hidden />
            Suelta el CSV de precios
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 px-3 py-2 text-[11px] text-red-800 dark:text-red-200">
          {error}
        </div>
      )}
      {result && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-[11px] text-emerald-800">
          {result.created} SKU nuevos · {result.updated} actualizados
          {result.skipped > 0 && <> · {result.skipped} fila{result.skipped === 1 ? '' : 's'} sin precio, omitida{result.skipped === 1 ? '' : 's'}</>}
        </div>
      )}
    </div>
  );
}
