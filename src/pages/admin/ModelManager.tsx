/**
 * THE LIST OF PIECES — the Modelos dashboard's navigator, in two densities.
 *
 *   • `rail`  — the left column beside the stage: ONE LINE per piece (picture,
 *     name, colección, a dot for estado, a triangle when something is missing),
 *     fifteen on screen. What you use to FIND the piece you are about to work
 *     on, and to walk the catalogue with ↑↓ while the stage follows.
 *   • `tabla` — «Tabla» hands the list the WHOLE dashboard: every column, the
 *     checkboxes, the bulk bar, «Completar con Claude», the import review. What
 *     you use to work the catalogue itself.
 *
 * Same component, same rows, same selection, same writes — only the density
 * changes, and the piece on the stage never moves because you switched. That is
 * the difference from the Gestor|Estudio split this dashboard replaced, which
 * was a second SCREEN with its own idea of what was selected.
 *
 * It is not a screen. It is the RAIL of the workbench: every piece the
 * configurador can place, with the facts that decide whether it is safe to
 * publish (estado, malla, partes, SKU), and CLICKING A ROW IS OPENING IT. The
 * stage and the inspector ABOVE it are already editing whatever is selected
 * here — there is no «abrir», no drill-in, and nothing to come back from. It
 * replaced the studio's plan-tile rail outright: the rail's colección chips are
 * this table's «Colección» filter pill, and its ▲▼ became the drag below — the
 * piece is ordered among the pieces it is ordered against.
 *
 * THE RAIL IS NOT A NARROW TABLE — that distinction is the whole lesson of the
 * three layouts this screen went through. Squeezed into a 17rem column, nine
 * columns turned «Medium Sofa 210» into «Mediu…» and every «Partes» cell into a
 * tower of chips, four pieces to a viewport; moved to a full-width band at the
 * bottom, the table read beautifully and left the 3D stage a 1380×380 letterbox
 * with a chair floating in a void. A table wants width, a viewport wants a
 * square, and a screen has only so much: so the list gives up its columns to be
 * a rail, and gets ALL of them back — plus every bulk tool — the moment you
 * press «Tabla», which is also the only time the stage has to step aside.
 *
 * In `tabla` the chrome above the rows is ONE wrapping toolbar line («Pieza»,
 * «Agregar», the reorder state, `ListSearchHeader bar` with the search, the
 * estado tabs, orden, columnas and the colección pill, then the backlog chips);
 * everything else it shows is a bar that only exists while there is something
 * to say.
 *
 * SELECTION IS CONTROLLED (`selectedId` / `onSelect`) and owned by the section
 * (pages/admin/ConfiguratorCatalog), because the table, the 3D stage and the inspector
 * are three views of ONE selection: two of them holding their own copy is
 * exactly how the old master→detail split got out of step with itself.
 *
 * IT IS A FULL LIST SURFACE, dressed with the app's own list furniture rather
 * than a hand-rolled copy of it: `ListSearchHeader` (debounced search, the
 * estado strip as saved-view TABS with counts, the colección as a filter PILL, a
 * sort menu WITH a direction), `useColumns` + `useColumnWidths` (show/hide +
 * drag-to-resize, both persisted per browser). One ordered `MODEL_COLUMNS` array
 * drives the header, the body and the Columnas menu, so a new column is a
 * one-entry edit and the table can never disagree with its own menu.
 *
 * DRAG REORDERS THE PALETTE. The order a colección shows here IS the order the
 * configurador offers its pieces in, so the dealer arranges it by dragging rows
 * (Alt+↑↓ with the keyboard) — that replaced the inspector's ▲▼, where the piece
 * being ordered was two panes away from the list it was ordering. The math is
 * `planConfiguratorReorder` and it is fed THIS resolver's rows, so what gets renumbered
 * is exactly the sequence on screen. Which is why the affordance is GATED: it
 * only appears while the table is in colección order (ascending) — under «Nombre»
 * or «Actualizado» a drop would mean nothing, and an affordance that lies about
 * what it does is worse than one that isn't there.
 *
 * MASS MANAGEMENT lives here: a checkbox column (shift-click extends over the
 * filtered order), a header check that takes the WHOLE filtered set —
 * «Borradores → cabecera → Activar» is the publish-the-batch flow an upload
 * lands in — and a bulk bar whose estado writes ride ONE `bulkUpdate` and whose
 * delete rides ONE `bulkDelete` (per-row loops fire a write + an invalidate
 * each; the markThreadRead lesson). The VM plans both (`planBulkEstado`,
 * `planModelDelete`); deletes clean the uploads only the deleted rows
 * referenced, refcounted against the survivors, best-effort after the rows.
 *
 * SUGERIR SKUs EN LOTE is the third mass op, and the only one that asks Claude:
 * the whole checked set goes out as ONE question per lote (`collectionCandidates`
 * → `planCollectionChunks` → `mergeCollectionSuggestions`), because fifty
 * independent picks can hand one catalog root to two pieces and leave a third
 * unused — a collision no single-piece call can see. What comes back is a
 * REVIEW that takes this table's slot (`CollectionSkuReview`), and it writes
 * NOTHING until its own button: one `bulkPut` of the accepted rows, merged onto
 * the live snapshot. `bulkUpdate` cannot serve that write — it applies ONE patch
 * to many ids and every piece takes a DIFFERENT root — but the property that
 * matters is kept: one round-trip, one invalidate.
 *
 * MVVM: this file renders, nothing more. It does not even fetch — the section
 * owns the one `togo_models` read so the table and the stage can never be
 * looking at two different snapshots of the same row. Every derivation — the
 * rows, the colección list, the KPI counts, the estado patches and the delete
 * plan — is `resolveModelManager` / `planEstadoToggle` / `planBulkEstado` /
 * `planModelDelete` in `core/quote`. The View holds UI state only (search,
 * filters, sort, checks, page size, the optimistic estado overlay) and calls
 * the VM in a `useMemo`.
 *
 * The estado writes stay ADDITIVE BY CONSTRUCTION: one column, `active`,
 * through the VM's own patch — the same flag `resolveConfiguratorModels` and the
 * `togo-embed` payload already gate the public palette on, so «borrador» needed
 * no migration and cannot change what the configurador serves for any other row.
 * That flag is also the whole review loop: an upload lands as BORRADOR, shows up
 * in the «Borradores» tab with its count in the strip, and ONE click on its
 * pill publishes it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode,
} from 'react';
import { AlertCircle, AlertTriangle, Boxes, GripVertical, Loader2, PanelLeft, Plus, Sparkles, Table2, Trash2 } from 'lucide-react';
import { db } from '../../db/database.js';
import { removeConfiguratorMesh } from '../../db/configuratorMeshUpload.js';
import type { ConfiguratorModel } from '../../types/domain.js';
import {
  collectionCandidates, indexCandidates, mergeCollectionSuggestions, planBulkEstado,
  planCollectionBind, planCollectionChunks, planEstadoToggle, planModelDelete,
  planConfiguratorReorder, resolveCollectionReview, resolveModelManager,
} from '../../core/quote/index.js';
import { suggestCollectionSkus } from '../../lib/configurator/suggestSku.js';
import BacklogChips from '../../components/configurator/BacklogChips.jsx';
import type { BacklogKey } from '../../components/configurator/BacklogChips.jsx';
import { ROW_THUMB, useConfiguratorThumbnails } from '../../components/configurator/thumbnails.js';
import CollectionSkuReview from '../../components/configurator/CollectionSkuReview.jsx';
import { PART_LABELS } from '../../lib/configurator/meshParts.js';
import { formatDateTime } from '../../lib/format.js';
import { sanitizeSvg } from '../../lib/sanitizeSvg.js'; // SECURITY (L6): scrub untrusted SVG before innerHTML
import Modal from '../../components/Modal.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import useLocalPref from '../../components/primitives/useLocalPref.js';

/** The VM owns the row shape; deriving it from the resolver keeps this file
 *  honest if the contract ever grows a field. */
type ManagerRow = ReturnType<typeof resolveModelManager>['rows'][number];
type Estado = ManagerRow['estado'];
type SortKey = 'name' | 'collection' | 'updated';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };

/**
 * The in-flight collection suggestion. `plan` is the deterministic pool + each
 * piece's own offers (what went out); `merged` is the answer folded back across
 * the lotes. Both are kept so the review can be re-derived — the View holds the
 * inputs, never the derived rows.
 */
type ReviewState = {
  stage: 'waiting' | 'thinking' | 'done' | 'error';
  /** The pieces under review, for the shared thumbnail feed. */
  rows: ManagerRow[];
  collection: string;
  progress: { done: number; total: number };
  plan?: ReturnType<typeof collectionCandidates> | null;
  merged?: ReturnType<typeof mergeCollectionSuggestions> | null;
  duplicates: { root: string; modelIds: string[] }[];
  dropped: { modelId: string | null; root: string | null; reason: string }[];
  log: string[];
  degraded: boolean;
  error: string | null;
};

/**
 * How many rows render (and therefore how many 3D thumbnails are queued) before
 * «Mostrar más». A thumbnail costs a GPU draw plus a synchronous PNG encode per
 * model, and the catalog is ~600 pieces: rendering all of them on tab open would
 * spend a minute of main thread on tiles nobody has scrolled to. The search and
 * the colección filter are the real navigation; this is the floor under them.
 */
const PAGE = 60;

/**
 * `useConfiguratorThumbnails(models, frame = null)` lives in a .js module, so TS reads
 * its `frame` parameter as `null` off the default rather than as the render
 * frame the JSDoc documents. Aliased once, with the real signature, instead of
 * casting at the call site.
 */
const useRowThumbnails = useConfiguratorThumbnails as unknown as (
  models: unknown[],
  frame?: { width: number; height: number } | null,
) => Record<string, string>;

const ESTADO_TABS: { key: 'all' | Estado; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'activo', label: 'Activos' },
  { key: 'borrador', label: 'Borradores' },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  // Ascending colección order is the palette order AND the only order a drag
  // means anything in — hence the note, right where the owner picks it.
  { key: 'collection', label: 'Colección · paleta' },
  { key: 'name', label: 'Nombre' },
  { key: 'updated', label: 'Actualizado' },
];

const MESH_BADGE: Record<string, { label: string; className: string; title: string }> = {
  glb: { label: 'GLB', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300', title: 'Malla servible: el configurador la renderiza' },
  raw: { label: 'Fuente', className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300', title: 'El slot tiene un export fuente (.fbx/.obj…), no un GLB convertido' },
  none: { label: 'Sin malla', className: 'bg-ink-100 text-ink-500', title: 'Sin modelo 3D: se dibuja la forma genérica' },
};

/** The model's OWN binding — one of the four publish-gate facts (with estado,
 *  malla and partes), and the one the table never showed. */
const SKU_BADGE: Record<'yes' | 'no', { label: string; className: string; title: string }> = {
  yes: { label: 'Vinculado', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300', title: 'Tiene producto Ligne Roset vinculado: la pieza puede cotizar' },
  no: { label: 'Sin SKU', className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300', title: 'Sin producto vinculado: la pieza no puede poner precio' },
};

const BADGE_CLS = 'inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide';

/** Everything one row's cells may need. Assembled ONCE per row so each column's
 *  `cell` stays a pure read — no column ever reaches back into the component. */
type CellCtx = {
  r: ManagerRow;
  est: Estado;
  thumb: string | undefined;
  svg: string;
  saving: boolean;
  /** Whether the drag affordance is live (see the gate in the component). */
  canReorder: boolean;
  onToggleEstado: () => void;
};

type ModelColumn = {
  key: string;
  label: string;
  canHide?: boolean;
  thClass?: string;
  tdClass?: string;
  cell: (ctx: CellCtx) => ReactNode;
};

/**
 * ONE ordered definition drives the header, the body and the Columnas menu.
 *
 * TWO ANCHORS (`canHide: false`): the thumbnail and the name. A row's identity
 * here is the picture plus the piece's name — the whole point of the rail is
 * recognising a sofa at a glance — so neither is offered in the menu; everything
 * else the owner turns on and off (persisted per browser).
 *
 * The `hidden md:table-cell` on the optional columns is NOT a second visibility
 * system fighting the menu: it is set at EXACTLY the breakpoint where
 * ListSearchHeader starts showing the Columnas control, so a column can never be
 * toggled on into a viewport that then refuses to render it. Below `md` the table
 * is what it has always been — vista, modelo, estado — and the modelo cell keeps
 * carrying the medidas and the colección in its subline.
 */
const MODEL_COLUMNS: ModelColumn[] = [
  {
    key: 'thumb', label: 'Vista', canHide: false,
    thClass: 'w-[4.25rem]',
    cell: ({ r, thumb, svg, canReorder }) => (
      <div className="flex items-center gap-1">
        {/* The grab affordance. The SLOT is always reserved so toggling the
            sort can't change the column's measured width mid-session. */}
        <span className="w-3 shrink-0 text-ink-400" aria-hidden>
          {canReorder && <GripVertical size={12} className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100" />}
        </span>
        <div className="grid h-9 w-12 place-items-center overflow-hidden rounded bg-ink-50 text-ink-400">
          {thumb
            ? <img src={thumb} alt="" draggable={false} className="h-full w-full select-none object-contain" />
            : svg
              ? <span className="h-full w-full p-px text-ink-500 [&>svg]:h-full [&>svg]:w-full" aria-hidden dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
              : <Boxes size={14} aria-hidden />}
        </div>
      </div>
    ),
  },
  {
    key: 'name', label: 'Modelo', canHide: false,
    tdClass: 'min-w-0',
    cell: ({ r }) => (
      <>
        <span className="block truncate font-medium text-ink-900" title={r.name}>{r.name || 'Sin nombre'}</span>
        {/* `min-h` keeps every row the same height whether or not it carries the
            warning — otherwise a «sin planta» row would stand a line taller than
            its neighbours once the medidas move out to their own column. */}
        <div className="min-h-[15px] text-micro tabular-nums text-ink-500">
          <span className="md:hidden">{Math.round(r.widthCm)}×{Math.round(r.depthCm)} cm · {r.collection}</span>
          {!r.svg && (
            <span className="text-amber-600 dark:text-amber-400">
              <span className="md:hidden"> · </span>sin planta
            </span>
          )}
        </div>
      </>
    ),
  },
  {
    key: 'collection', label: 'Colección',
    thClass: 'hidden md:table-cell', tdClass: 'hidden whitespace-nowrap text-ink-600 md:table-cell',
    cell: ({ r }) => r.collection,
  },
  {
    key: 'category', label: 'Categoría',
    thClass: 'hidden md:table-cell', tdClass: 'hidden text-xs text-ink-500 md:table-cell',
    cell: ({ r }) => r.category || '—',
  },
  {
    key: 'group', label: 'Grupo',
    thClass: 'hidden md:table-cell', tdClass: 'hidden text-xs text-ink-500 md:table-cell',
    cell: ({ r }) => r.productGroup || '—',
  },
  {
    key: 'parts', label: 'Partes',
    thClass: 'hidden md:table-cell', tdClass: 'hidden md:table-cell',
    cell: ({ r }) => (r.partsRoles.length
      ? (
        <span className="flex flex-wrap gap-1">
          {r.partsRoles.map((role) => (
            <span key={role} className="badge py-0 text-micro">{PART_LABELS[role] || role}</span>
          ))}
          {r.partsSkuCount > 0 && (
            <span className="badge-brand py-0 text-micro" title="Partes con SKU propio">{r.partsSkuCount} SKU</span>
          )}
        </span>
      )
      : <span className="text-xs text-ink-400">—</span>),
  },
  {
    key: 'sku', label: 'SKU',
    thClass: 'hidden md:table-cell', tdClass: 'hidden md:table-cell',
    cell: ({ r }) => {
      const b = SKU_BADGE[r.skuBound ? 'yes' : 'no'];
      return <span className={`${BADGE_CLS} ${b.className}`} title={b.title}>{b.label}</span>;
    },
  },
  {
    key: 'mesh', label: 'Malla',
    thClass: 'hidden md:table-cell', tdClass: 'hidden md:table-cell',
    cell: ({ r }) => {
      const b = MESH_BADGE[r.meshKind] || MESH_BADGE.none;
      return <span className={`${BADGE_CLS} ${b.className}`} title={b.title}>{b.label}</span>;
    },
  },
  {
    key: 'dims', label: 'Medidas',
    thClass: 'hidden md:table-cell', tdClass: 'hidden whitespace-nowrap tabular-nums text-ink-500 md:table-cell',
    cell: ({ r }) => `${Math.round(r.widthCm)}×${Math.round(r.depthCm)} cm`,
  },
  {
    key: 'updated', label: 'Actualizado',
    thClass: 'hidden md:table-cell', tdClass: 'hidden whitespace-nowrap tabular-nums text-ink-500 md:table-cell',
    cell: ({ r }) => (r.updatedAt ? formatDateTime(r.updatedAt) : '—'),
  },
  {
    key: 'estado', label: 'Estado',
    thClass: 'text-right', tdClass: 'text-right',
    cell: ({ r, est, saving, onToggleEstado }) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleEstado(); }}
        disabled={saving}
        aria-pressed={est === 'activo'}
        title={est === 'activo' ? 'Publicado en el configurador — toca para pasarlo a borrador' : 'Oculto del configurador — toca para publicarlo'}
        className={`status-pill ${est === 'activo' ? 'status-pill-active' : 'status-pill-draft'} ${saving ? 'opacity-60' : 'hover:brightness-95'}`}
      >
        {est === 'activo' ? 'Activo' : 'Borrador'}
      </button>
    ),
  },
];

/** What the table ships with. The four publish-gate facts (estado · malla ·
 *  partes · SKU) are on, plus the colección and the medidas; the LR library
 *  metadata and the timestamp are one toggle away in the Columnas menu. */
const DEFAULT_VISIBLE_COLS: Record<string, boolean> = {
  collection: true, category: false, group: false,
  parts: true, sku: true, mesh: true, dims: true, updated: false, estado: true,
};
const COLS_STORAGE_KEY = 'rs.configuratorModels.cols.v1';
// v2: the widths stored under v1 were MEASURED inside the old ~22rem left
// column — natural widths for a rail, meaningless across the full-width band,
// and `table-layout: fixed` would have scaled the cramped set up proportionally
// (a 4rem thumbnail column at 8rem) instead of re-measuring. A layout change is
// exactly what a width key version is for.
const WIDTHS_STORAGE_KEY = 'rs.configuratorModels.widths.v2';
const SORT_STORAGE_KEY = 'rs.configuratorModels.sort.v1';

/**
 * `useColumns` / `useColumnWidths` / `useLocalPref` live in .js|.jsx modules, so
 * TS infers them structurally (and `tableStyle.tableLayout` as a bare `string`,
 * which no `<table style>` accepts). Aliased once with their documented
 * signatures — the same treatment `useRowThumbnails` gets below — instead of
 * casting at every call site.
 */
const useModelColumns = useColumns as unknown as (
  all: ModelColumn[], defaults: Record<string, boolean>, storageKey: string,
) => {
  columns: ModelColumn[];
  visible: Record<string, boolean>;
  setVisible: (next: Record<string, boolean>) => void;
  reset: () => void;
  cols: ModelColumn[];
};

const useModelColumnWidths = useColumnWidths as unknown as (
  cols: ModelColumn[], storageKey: string,
) => {
  tableRef: (node: HTMLTableElement | null) => void;
  tableStyle: CSSProperties;
  thProps: (key: string) => { 'data-col-key': string; style: CSSProperties };
  ResizeHandle: (key: string) => ReactNode;
  reset: () => void;
  hasWidths: boolean;
};

const useSortPref = useLocalPref as unknown as (
  key: string, fallback: SortState,
) => [SortState, (next: SortState) => void];

type Props = {
  /** The section's ONE `togo_models` read — the same rows the stage renders. */
  models: ConfiguratorModel[];
  /** The selected piece: what the stage shows and the inspector edits. */
  selectedId: string | null;
  /** Selecting IS opening. One click, no second step. */
  onSelect: (modelId: string | null) => void;
  /** Open the shared add-model flow (the section owns the modal). */
  onAddModel?: () => void;
  /** Seed the demo Togo pieces — the empty state's second door. */
  onImportSeeds?: () => Promise<void> | void;
  /** The section's LAZY LR catalog — null until something asks for it. The
   *  collection suggestion is one of the things that asks. */
  products?: unknown[] | null;
  /** Ask the section to load it (the same door the studio's pickers use). */
  onNeedCatalog?: () => void;
  /** The ids in the order the dealer is LOOKING at — filters, search and sort
   *  applied. Published so «anterior/siguiente» elsewhere can walk this list
   *  instead of the unfiltered catalogue. Must be stable (useCallback). */
  onOrderChange?: (ids: string[]) => void;
  /**
   * WHICH LIST. Two jobs, two densities, ONE component — same state, same
   * selection, same writes:
   *   • `rail`  — the navigator beside the stage: thumbnail, name, colección,
   *     estado. What you use to FIND the piece you are about to work on.
   *   • `tabla` — the full data table over the whole dashboard: every column,
   *     the checkboxes, the bulk bar, «Completar». What you use to WORK THE
   *     CATALOGUE (publish thirty borradores, chase the pieces without SKU).
   * It is a DENSITY, not a mode with a life of its own: nothing is fetched,
   * selected or remembered differently in one than the other, and the piece on
   * the stage never changes because you switched. That is the whole difference
   * from the Gestor|Estudio split this dashboard replaced, which drilled into a
   * second screen with its own idea of what was selected.
   */
  mode?: ListMode;
  onModeChange?: (next: ListMode) => void;
};

export type ListMode = 'rail' | 'tabla';

export default function ModelManager({
  models, selectedId, onSelect, onAddModel, onImportSeeds, products = null, onNeedCatalog,
  onOrderChange, mode = 'rail', onModeChange,
}: Props) {
  // ── Table controls (UI state, nothing derived). `filters` is ListSearchHeader's
  // secondary-filter bag — one key today, `collection`.
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [estado, setEstado] = useState<'all' | Estado>('all');
  // Persisted: coming back to a table that silently no longer accepts a drag is
  // the kind of thing the owner would read as broken.
  const [sort, setSort] = useSortPref(SORT_STORAGE_KEY, { key: 'collection', dir: 'asc' });
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  // The optimistic estado overlay: `id → estado`, held until the refetched row
  // says the same thing (see the effect below), so the pill never flickers back
  // through its old value while the write is in flight.
  const [pendingEstado, setPendingEstado] = useState<Record<string, Estado>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  // ── Mass management: the checked set (ids), the in-flight flag, and the
  // delete confirmation. Selection SURVIVES a filter change on purpose — check
  // the borradores, widen back to Todos, and the bulk bar still says who's
  // checked — but never survives the rows themselves (pruned below).
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shiftAnchor = useRef<string | null>(null);
  // ── Sugerencia de SKUs EN LOTE. A whole collection goes to Claude in one
  // question (see the panel's header for why fifty single calls is the wrong
  // shape), and what comes back is a REVIEW: nothing is written until the
  // review's own button is pressed.
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewRun, setReviewRun] = useState(0);
  const reviewClaimed = useRef(0);
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [binding, setBinding] = useState(false);
  const [bound, setBound] = useState(0);

  // ── The backlog filter: «sin malla» / «sin SKU» / «sin partes», the three
  // publish gates the estado tabs can't express. Not persisted — it is a working
  // set for right now, not a view the dealer would want restored days later on a
  // different piece.
  const [pendiente, setPendiente] = useState<BacklogKey | null>(null);

  // ── Drag-to-reorder: the row being dragged and the row it would land above.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  // The WHOLE catalog: the colección options, the KPI strip (over every row,
  // never the filtered slice, so narrowing can't make the catalog look healthier
  // than it is) and — as `catalog.palette` — the configurador's own numbering
  // order, which is what a drag renumbers.
  const catalog = useMemo(() => resolveModelManager(models || []), [models]);
  const view = useMemo(
    () => resolveModelManager(models || [], {
      q, collection: filters.collection || 'all', estado, sort: sort.key, dir: sort.dir, pendiente,
    }),
    [models, q, filters.collection, estado, sort.key, sort.dir, pendiente],
  );
  // Whether anything is actually narrowing the list — the header's result count
  // is worth a row only then (unfiltered it restates the «Todos» tab).
  const narrowed = !!q.trim() || estado !== 'all' || !!pendiente
    || !!(filters.collection && filters.collection !== 'all');

  // Estado is read through the overlay everywhere, so the pill and the filter
  // agree the moment the owner clicks.
  const estadoOf = useCallback(
    (r: ManagerRow): Estado => pendingEstado[r.id] ?? r.estado,
    [pendingEstado],
  );

  // Drop an override the instant the live row carries the same answer — the
  // write landed and the refetch caught up.
  useEffect(() => {
    setPendingEstado((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const next = { ...prev };
      let changed = false;
      for (const r of catalog.rows) {
        if (next[r.id] !== undefined && next[r.id] === r.estado) { delete next[r.id]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [catalog.rows]);

  // A narrowed table starts at the top: keeping page 5 after a search would show
  // «Mostrar más» over three results.
  useEffect(() => { setLimit(PAGE); }, [q, filters.collection, estado, sort.key, sort.dir, pendiente]);

  // A checked id whose row left the catalog (deleted here or in a parallel
  // session) leaves the set — a bulk op must never aim at ghosts.
  useEffect(() => {
    setCheckedIds((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(catalog.rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [catalog.rows]);

  const visible = useMemo(() => view.rows.slice(0, limit), [view.rows, limit]);

  // Publish the CURRENT order upward. Keyed on the joined ids so a re-render
  // that produces an equal list doesn't re-fire — `view.rows` is a fresh array
  // every time, and handing the parent a new one each render would loop through
  // its state. `limit` is deliberately NOT applied: it is lazy rendering, and
  // stepping past it should reach the next row, not stop at the fold.
  const orderKey = useMemo(() => view.rows.map((r) => r.id).join(','), [view.rows]);
  useEffect(() => {
    onOrderChange?.(orderKey ? orderKey.split(',') : []);
  }, [orderKey, onOrderChange]);
  const rawById = useMemo(() => {
    const m = new Map<string, ConfiguratorModel>();
    for (const row of models || []) if (row?.id) m.set(row.id, row);
    return m;
  }, [models]);

  // The rendered thumbnails, for the rows ACTUALLY ON SCREEN — same engine,
  // cache and cross-visit store the configurador palette uses, at the small
  // frame these 48-px cells display (ROW_THUMB). The review list rides the SAME
  // feed (its rows are usually off the visible page) so a piece is never
  // rendered twice by two hooks.
  const thumbFeed = useMemo(() => {
    const seen = new Set<string>();
    const out: unknown[] = [];
    const push = (r: ManagerRow) => {
      if (!r || seen.has(r.id)) return;
      seen.add(r.id);
      const m = rawById.get(r.id);
      out.push({
        id: r.id,
        name: r.name,
        collection: r.collection,
        widthCm: r.widthCm,
        depthCm: r.depthCm,
        mesh: m?.meshUrl
          ? { url: m.meshUrl, scale: m.meshScale ?? null, upAxis: m.meshUpAxis || 'y', rotateY: m.meshRotateY || 0 }
          : null,
      });
    };
    for (const r of visible) push(r);
    if (review) for (const r of review.rows) push(r);
    return out;
  }, [visible, rawById, review]);
  const thumbs = useRowThumbnails(thumbFeed, ROW_THUMB);

  // ── Check/uncheck. Shift extends from the last toggled row over the FILTERED
  // order (what the eye sees), so «primer borrador, shift, último» is a range.
  const toggleChecked = useCallback((id: string, shift: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      const anchor = shiftAnchor.current;
      if (shift && anchor && anchor !== id) {
        const order = view.rows.map((r) => r.id);
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const on = !prev.has(id);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (on) next.add(order[i]); else next.delete(order[i]);
          }
          shiftAnchor.current = id;
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      shiftAnchor.current = id;
      return next;
    });
  }, [view.rows]);

  // The header checkbox works the FILTERED set, not the visible page — that is
  // what makes «borradores → todo → activar» a two-click mass op instead of a
  // per-page chore.
  const filteredChecked = useMemo(
    () => view.rows.reduce((n, r) => n + (checkedIds.has(r.id) ? 1 : 0), 0),
    [view.rows, checkedIds],
  );
  const allFilteredChecked = view.rows.length > 0 && filteredChecked === view.rows.length;
  const toggleAllFiltered = useCallback(() => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (view.rows.every((r) => prev.has(r.id))) for (const r of view.rows) next.delete(r.id);
      else for (const r of view.rows) next.add(r.id);
      return next;
    });
    shiftAnchor.current = null;
  }, [view.rows]);
  const headerCheckRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = filteredChecked > 0 && !allFilteredChecked;
  }, [filteredChecked, allFilteredChecked]);

  // ── Bulk estado: ONE bulkUpdate over the rows that actually change (the VM
  // plans it), with the same optimistic overlay the single pill uses.
  const bulkEstado = useCallback(async (target: Estado) => {
    if (bulkBusy) return;
    const rows = catalog.rows
      .filter((r) => checkedIds.has(r.id))
      .map((r) => ({ id: r.id, estado: pendingEstado[r.id] ?? r.estado }));
    const plan = planBulkEstado(rows, target);
    if (!plan.ids.length) return;
    setError(null);
    setBulkBusy(true);
    setPendingEstado((p) => {
      const n = { ...p };
      for (const id of plan.ids) n[id] = target;
      return n;
    });
    try {
      await db.configuratorModels.bulkUpdate(plan.ids, plan.patch);
    } catch {
      setPendingEstado((p) => {
        const n = { ...p };
        for (const id of plan.ids) delete n[id];
        return n;
      });
      setError('No se pudo guardar el estado en lote. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, catalog.rows, checkedIds, pendingEstado]);

  // ── Bulk delete: rows first (ONE bulkDelete), then the uploads only they
  // referenced, best-effort (planModelDelete refcounts against the survivors —
  // a shared batch source under a surviving sibling is never touched).
  const deletePlan = useMemo(
    () => planModelDelete((models || []) as unknown[], [...checkedIds]),
    [models, checkedIds],
  );
  const runDelete = useCallback(async () => {
    if (bulkBusy || !deletePlan.ids.length) { setConfirmDelete(false); return; }
    setError(null);
    setBulkBusy(true);
    try {
      await db.configuratorModels.bulkDelete(deletePlan.ids);
      for (const u of deletePlan.removeUrls) removeConfiguratorMesh(u);
      setCheckedIds(new Set());
      // The stage must not keep editing a row that no longer exists — hand it a
      // SURVIVOR, picked here. Clearing to null would leave the choice to the
      // section's "nothing picked" fallback, which reads a `models` that still
      // holds the deleted rows until the refetch lands.
      if (selectedId && deletePlan.ids.includes(selectedId)) {
        const gone = new Set(deletePlan.ids);
        onSelect(catalog.rows.find((r) => !gone.has(r.id))?.id || null);
      }
      setConfirmDelete(false);
    } catch {
      setError('No se pudieron eliminar los modelos. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, deletePlan, selectedId, onSelect, catalog.rows]);

  // ── «Sugerir SKUs con Claude». ONE question for the whole checked set, not
  // one per piece: seen together the pieces are an ASSIGNMENT (two of them can
  // be handed the same root while a third root sits unused), and that collision
  // is invisible to fifty independent calls.
  //
  // The trigger is the CLICK and nothing else — same shape as the studio's
  // single-piece panel: `reviewRun` starts the work, `reviewClaimed` makes sure
  // the catalog landing (or the live query refetching under it) can never spend
  // a second batch on the same question.
  const askCollection = useCallback(() => {
    const rows = catalog.rows.filter((r) => checkedIds.has(r.id));
    if (!rows.length) return;
    setError(null);
    setBound(0);
    setAccepted(new Set());
    setOverrides({});
    setReview({
      stage: 'waiting',
      rows,
      collection: [...new Set(rows.map((r) => r.collection))].length === 1 ? rows[0].collection : '',
      progress: { done: 0, total: 0 },
      plan: null,
      merged: null,
      duplicates: [],
      dropped: [],
      log: [],
      degraded: false,
      error: null,
    });
    onNeedCatalog?.();
    setReviewRun((n) => n + 1);
  }, [catalog.rows, checkedIds, onNeedCatalog]);

  useEffect(() => {
    if (!reviewRun || reviewClaimed.current === reviewRun || !products) return undefined;
    reviewClaimed.current = reviewRun;
    let cancelled = false;

    (async () => {
      const rows = catalog.rows.filter((r) => checkedIds.has(r.id));
      if (!rows.length) return;
      const index = indexCandidates(products);
      // The pool is the UNION of what the deterministic narrower offers each
      // piece — never «the whole family» — so every guard it enforces
      // (frame-and-seat twin, cushion subtypes, generation) still gates it.
      const plan = collectionCandidates(rows.map((r) => ({
        id: r.id,
        name: r.name,
        widthCm: r.widthCm,
        depthCm: r.depthCm,
        collection: r.collection,
        category: r.category || '',
        parts: r.partsRoles.map((role) => PART_LABELS[role] || role),
      })), index);
      const { chunks, log } = planCollectionChunks(plan);
      if (cancelled) return;
      setReview((s) => (s ? { ...s, stage: 'thinking', progress: { done: 0, total: chunks.length } } : s));

      const parts: unknown[] = [];
      let anyOk = false;
      let lastError = '';
      const label = [...new Set(rows.map((r) => r.collection))].length === 1 ? rows[0].collection : '';
      for (const c of chunks) {
        const out = await suggestCollectionSkus({
          collection: label,
          models: c.models,
          candidates: c.pool,
          chunk: { index: c.index, total: c.total },
        });
        if (cancelled) return;
        if (out?.ok) {
          anyOk = true;
          parts.push(out);
        } else {
          // A failed lote costs ITS pieces a suggestion, never the batch. They
          // come back as explicit «sin sugerencia» rows carrying the reason —
          // a piece that silently vanished from the review would read as "the
          // catalog has nothing", which is a different and false claim.
          lastError = out?.error || 'No se pudo obtener la sugerencia.';
          parts.push({
            assignments: [],
            unassigned: c.models.map((m: { id: string }) => ({ modelId: m.id, why: lastError })),
            duplicates: [],
            dropped: [],
            degraded: true,
            log: [`Lote ${c.index} de ${c.total}: ${lastError}`],
          });
        }
        setReview((s) => (s ? { ...s, progress: { done: s.progress.done + 1, total: c.total } } : s));
      }

      if (!anyOk) {
        setReview((s) => (s ? { ...s, stage: 'error', error: lastError } : s));
        return;
      }
      const merged = mergeCollectionSuggestions(parts, { unmatched: plan.unmatched, log });
      const built = resolveCollectionReview(plan, merged);
      if (cancelled) return;
      // ACCEPTED BY DEFAULT: alta and media only. «Poco seguro» starts
      // unchecked — accepting fifty at once is exactly where an unsure binding
      // slips through unread, and the reviewer opting IN is one click.
      setAccepted(new Set(
        built.rows.filter((r) => r.root && (r.confidence === 'alta' || r.confidence === 'media')).map((r) => r.modelId),
      ));
      setOverrides({});
      setReview((s) => (s ? {
        ...s,
        stage: 'done',
        plan,
        merged,
        duplicates: merged.duplicates,
        dropped: merged.dropped,
        log: merged.log,
        degraded: merged.degraded,
        error: null,
      } : s));
    })().catch((e) => {
      if (!cancelled) setReview((s) => (s ? { ...s, stage: 'error', error: e?.message || 'No se pudo obtener la sugerencia.' } : s));
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per click; the catalog may land after it
  }, [reviewRun, products]);

  // The review's own numbers, re-derived from the plan + the merged answer.
  const reviewView = useMemo(
    () => (review?.plan && review?.merged ? resolveCollectionReview(review.plan, review.merged) : null),
    [review],
  );

  /**
   * THE ONE WRITE. Every accepted row lands in a SINGLE round-trip: `bulkUpdate`
   * can't serve here (it applies ONE patch to many ids, and every piece takes a
   * DIFFERENT root), so this is the same merged-row `bulkPut` the inventory
   * repricers use — one request, one `invalidate()`, never a per-row loop that
   * would fire fifty writes and fifty full refetches (the markThreadRead lesson).
   *
   * The rows are merged onto the LIVE `togo_models` snapshot the section already
   * holds, and only `productRoot` + `updatedAt` differ from it.
   */
  const bindAccepted = useCallback(async () => {
    if (binding || !reviewView) return;
    const binds = planCollectionBind(reviewView.rows, { accepted, overrides });
    if (!binds.length) return;
    setError(null);
    setBinding(true);
    const now = Date.now();
    const rows: ConfiguratorModel[] = [];
    for (const b of binds) {
      const row = rawById.get(b.modelId);
      if (row) rows.push({ ...row, productRoot: b.root, updatedAt: now });
    }
    try {
      await db.configuratorModels.bulkPut(rows);
      setBound(binds.length);
      setReview(null);
      setCheckedIds(new Set());
      shiftAnchor.current = null;
    } catch {
      setError('No se pudieron guardar los SKU. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setBinding(false);
    }
  }, [binding, reviewView, accepted, overrides, rawById]);

  const toggleAccepted = useCallback((modelId: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      return next;
    });
  }, []);

  const toggleAllAccepted = useCallback((on: boolean) => {
    setAccepted(on ? new Set((reviewView?.rows || []).filter((r) => r.root).map((r) => r.modelId)) : new Set());
  }, [reviewView]);

  // Changing a row's root ACCEPTS it (choosing a SKU is the acceptance); the
  // empty option is how a row is rejected outright.
  const overrideRoot = useCallback((modelId: string, root: string) => {
    setOverrides((prev) => ({ ...prev, [modelId]: root }));
    setAccepted((prev) => {
      const next = new Set(prev);
      if (root) next.add(modelId); else next.delete(modelId);
      return next;
    });
  }, []);

  const toggleEstado = useCallback(async (r: ManagerRow) => {
    const shown = pendingEstado[r.id] ?? r.estado;
    const plan = planEstadoToggle({ id: r.id, estado: shown });
    if (!plan.id) return;
    setError(null);
    setPendingEstado((p) => ({ ...p, [r.id]: plan.patch.active ? 'activo' : 'borrador' }));
    setSaving((s) => ({ ...s, [r.id]: true }));
    try {
      // The VM's patch, verbatim — `active` and nothing else. Stamping
      // `updatedAt` here would make publishing a piece the "freshest word" on
      // its colección's estructura palette (collectionFinishes.rankedRows), and
      // a visibility flip is not a content edit.
      await db.configuratorModels.update(plan.id, plan.patch);
    } catch {
      setPendingEstado((p) => { const n = { ...p }; delete n[r.id]; return n; });
      setError('No se pudo guardar el estado. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setSaving((s) => { const n = { ...s }; delete n[r.id]; return n; });
    }
  }, [pendingEstado]);

  // ── Reordering the configurador's palette.
  //
  // THE GATE, and it is the honest half of this feature: a drop only means
  // something while the table is in colección order ASCENDING, because that IS
  // the palette order (resolveModelManager sorts a colección by `sortOrder`).
  // Under «Nombre», «Actualizado» or a descending flip the rows on screen are not
  // the sequence being renumbered, so the affordance is withdrawn rather than
  // left to lie about what it would do.
  const canReorder = sort.key === 'collection' && sort.dir === 'asc';

  // Where a piece sits inside ITS colección, read off `catalog.palette` — the
  // VM's projection of the whole catalog in the configurador's numbering order,
  // which is the list the plan renumbers (its per-colección subsequence is the
  // one the table shows). The FULL group, not the filtered slice: dropping a row
  // onto another means "take that piece's place in the palette", which stays
  // exactly defined when a filter hides the pieces in between.
  const palettePosOf = useCallback((id: string | null) => {
    if (!id) return null;
    const row = catalog.palette.find((r) => r.id === id);
    if (!row) return null;
    const group = catalog.palette.filter((r) => r.collection === row.collection);
    const index = group.findIndex((r) => r.id === id);
    return index < 0 ? null : { index, size: group.length, collection: row.collection };
  }, [catalog.palette]);

  // The write. `planConfiguratorReorder` renumbers the WHOLE displayed order gaplessly
  // and hands back ONLY the rows whose position actually changed, so a neighbour
  // swap on a tidy colección is two writes. Per-row `update()` of `sortOrder`
  // (a PATCH) rather than a bulkPut of whole rows: a move can rewrite a dozen
  // rows, and re-putting them would clobber a rename the dealer made seconds
  // earlier from this row's own stale copy.
  const reorderTo = useCallback(async (id: string, toIndex: number) => {
    const writes = planConfiguratorReorder(catalog.palette, { id, toIndex });
    if (!writes.length) return;
    setError(null);
    const now = Date.now();
    try {
      await Promise.all(writes.map(
        (w: { id: string; sortOrder: number }) => db.configuratorModels.update(w.id, { sortOrder: w.sortOrder, updatedAt: now }),
      ));
    } catch {
      setError('No se pudo guardar el orden de la paleta. Revisa la conexión e inténtalo de nuevo.');
    }
  }, [catalog.palette]);

  // Drop `dragId` ABOVE `targetId` (where the indicator line is drawn). Dragging
  // DOWN closes a gap behind itself, so the target's index shifts one up once the
  // piece is lifted out — the same ±1 every insert-before reducer needs.
  const dropOn = useCallback((targetId: string) => {
    const dragged = dragId;
    setDragId(null);
    setDropId(null);
    if (!dragged || dragged === targetId) return;
    const from = palettePosOf(dragged);
    const to = palettePosOf(targetId);
    // A piece never leaves its colección (planConfiguratorReorder refuses to move it out
    // anyway) — so a cross-colección drop is refused here, before it can be read
    // as an index into the wrong group.
    if (!from || !to || from.collection !== to.collection) return;
    reorderTo(dragged, from.index < to.index ? to.index - 1 : to.index);
  }, [dragId, palettePosOf, reorderTo]);

  // ↑↓ walk the visible rows — and because selecting IS opening, the arrows walk
  // the stage too. The scroller owns the handler (one listener for the whole
  // table) and takes focus on a row click so the arrows work straight after
  // picking a model with the mouse.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A <tr> in the table, a <div> in the rail — same job (keep the selection in
  // view), so the ref is typed at the element they share.
  const selRowRef = useRef<HTMLElement | null>(null);
  useEffect(() => { selRowRef.current?.scrollIntoView({ block: 'nearest' }); }, [selectedId]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!visible.length) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;

    // Alt+↑↓ MOVES the selected piece one slot inside its colección — the
    // keyboard half of the drag, and what keeps the reorder reachable without a
    // pointer now that the inspector's ▲▼ are gone. Same planner, same gate: with
    // the table in any other order the key does nothing but walk.
    if (e.altKey && canReorder && selectedId) {
      const pos = palettePosOf(selectedId);
      const to = pos ? pos.index + step : -1;
      if (pos && to >= 0 && to < pos.size) {
        e.preventDefault();
        reorderTo(selectedId, to);
        return;
      }
      // Nothing to move (edge of the colección) — swallow it rather than walk
      // the selection off under a modifier the owner pressed to REORDER.
      if (pos) { e.preventDefault(); return; }
    }

    e.preventDefault();
    const i = visible.findIndex((r) => r.id === selectedId);
    if (i < 0) { onSelect(visible[0].id); return; }
    const next = step === 1
      ? Math.min(visible.length - 1, i + 1)
      : Math.max(0, i - 1);
    onSelect(visible[next].id);
  }, [visible, selectedId, onSelect, canReorder, palettePosOf, reorderTo]);

  const { counts } = catalog;

  // Which columns show (persisted per browser) and how wide each is (likewise).
  // The table renders `cols` — the two anchors plus whatever is toggled on, in
  // MODEL_COLUMNS order; the menu gets the full set so a hidden one can return.
  const {
    visible: visibleCols, setVisible: setVisibleCols, reset: resetCols, cols,
  } = useModelColumns(MODEL_COLUMNS, DEFAULT_VISIBLE_COLS, COLS_STORAGE_KEY);
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths,
  } = useModelColumnWidths(cols, WIDTHS_STORAGE_KEY);

  const tabs = useMemo(() => ESTADO_TABS.map((t) => ({
    ...t,
    count: t.key === 'all' ? counts.total : t.key === 'activo' ? counts.activos : counts.borradores,
  })), [counts]);

  // The colección pill's options come from the VM's already-FOLDED list
  // («Exclusif» and «EXCLUSIF» are one colección, canonicalised in the Model) —
  // never re-derived or re-cased here.
  const collectionFilter = useMemo(() => ({
    key: 'collection',
    label: 'Colección',
    type: 'select' as const,
    placeholder: 'Todas',
    options: catalog.collections.map((c) => ({ value: c, label: c })),
  }), [catalog.collections]);

  // ───────────────────────────────────────────────────────────────────────────
  // THE RAIL — the navigator beside the stage.
  //
  // A table crammed into 17rem is what this screen kept getting wrong: nine
  // columns squeezed until «Medium Sofa 210» read «Mediu…» and every «Partes»
  // cell grew a tower of chips, four pieces to a screen. A rail is not a narrow
  // table, it is a DIFFERENT OBJECT: one line per piece — picture, name,
  // colección — and the four publish-gate facts reduced to two marks you can
  // read without stopping (an amber triangle for «le falta algo», a dot for
  // activo/borrador that is also the switch). Fifteen pieces to a screen, and
  // the columns those chips used to hold are one click away in «Tabla».
  if (mode === 'rail') {
    return (
      <div className="flex min-h-0 flex-col bg-surface/40 lg:row-span-2 lg:h-full lg:border-r lg:border-ink-200">
        {/* ── HEAD. Fixed: the list scrolls under it, never it with the list. */}
        <div className="shrink-0 space-y-2 border-b border-ink-200 px-2.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Piezas</span>
            <span className="text-micro tabular-nums text-ink-500">{counts.total}</span>
            <button
              type="button"
              onClick={() => onModeChange?.('tabla')}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-micro font-medium text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
              title="Ver el catálogo completo: todas las columnas, selección múltiple, publicar en lote y «Completar con Claude». La pieza seleccionada no cambia."
            >
              <Table2 size={13} aria-hidden /> Tabla
            </button>
          </div>

          {/* The same list furniture as the table — búsqueda, estados, orden y
              colección — in the layout `dense` exists for. No «Columnas»: a
              rail has one. */}
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar pieza…"
            tabs={tabs}
            activeTab={estado}
            onTabChange={(k: string) => setEstado(k as 'all' | Estado)}
            filters={[collectionFilter]}
            activeFilters={filters}
            onFiltersChange={setFilters}
            sortOptions={SORT_OPTIONS}
            sort={sort}
            onSortChange={setSort}
            resultCount={narrowed ? view.rows.length : undefined}
            resultNoun={['pieza', 'piezas']}
            dense
          />

          <BacklogChips counts={counts} value={pendiente} onChange={setPendiente} />

        </div>

        {error && (
          <div role="alert" className="shrink-0 border-b border-ink-200 px-2.5 py-2 text-micro text-status-critical-ink">{error}</div>
        )}

        {/* ── THE LIST. Its own scroller and its own focus, so ↑↓ walk the
            pieces (and Alt+↑↓ reorder them) the moment you click one. */}
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          // `flex-1` from `lg` only, where the rail has a height to divide up.
          // Below it the column sizes to its content, and a basis-zero item in
          // a content-sized column resolves to zero — the same trap that had
          // the stage collapsing to a sliver on a phone. Here it is a capped
          // height instead: the list takes what it needs up to 45dvh, then
          // scrolls, and the stage still starts above the fold.
          role="listbox"
          aria-label="Piezas del catálogo"
          aria-activedescendant={selectedId ? `togo-rail-${selectedId}` : undefined}
          className="scroll-thin max-h-[45dvh] min-h-0 overflow-y-auto overscroll-contain p-1.5 focus:outline-none lg:max-h-none lg:flex-1"
        >
          <ul role="presentation" className="space-y-px">
            {visible.map((r) => {
              const on = r.id === selectedId;
              const est = estadoOf(r);
              const thumb = thumbs[r.id];
              const svg = rawById.get(r.id)?.svg || '';
              const dragging = dragId === r.id;
              const isDropTarget = canReorder && dropId === r.id && dragId !== r.id;
              const falta = r.meshKind === 'none' ? 'Sin malla 3D: el configurador dibuja la forma genérica.'
                : !r.skuBound ? 'Sin SKU vinculado: la pieza no puede cotizarse.'
                  : !r.partsRoles.length ? 'Sin partes etiquetadas: no puede facturar sus componentes.'
                    : null;
              return (
                <li key={r.id}>
                  <div
                    ref={on ? (el) => { selRowRef.current = el; } : null}
                    id={`togo-rail-${r.id}`}
                    role="option"
                    aria-selected={on}
                    onClick={() => { onSelect(r.id); scrollRef.current?.focus({ preventScroll: true }); }}
                    draggable={canReorder}
                    onDragStart={(e) => {
                      if (!canReorder) return;
                      setDragId(r.id);
                      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); } catch { /* older Safari */ }
                    }}
                    onDragOver={(e) => {
                      if (!canReorder || !dragId || dragId === r.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropId(r.id);
                    }}
                    onDrop={(e) => { if (!canReorder) return; e.preventDefault(); dropOn(r.id); }}
                    onDragEnd={() => { setDragId(null); setDropId(null); }}
                    title={canReorder
                      ? `${r.name} — arrastra para moverla dentro de su colección (ese ES el orden de la paleta del configurador; Alt + ↑↓ con el teclado)`
                      : r.name}
                    className={`group relative flex items-center gap-2 rounded-lg py-1.5 pl-2 pr-1.5 transition-colors ${
                      canReorder ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                    } ${dragging ? 'opacity-40' : ''} ${
                      isDropTarget ? 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-brand-500' : ''
                    } ${on ? 'bg-brand-500/15' : 'hover:bg-ink-100'}`}
                  >
                    {/* The selection, said with a rule rather than a border box:
                        a rail of outlined cards is noise at fifteen rows. */}
                    {on && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-500" />}

                    {canReorder && (
                      <GripVertical
                        size={12}
                        aria-hidden
                        className="absolute -left-0.5 top-1/2 -translate-y-1/2 text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100"
                      />
                    )}

                    <div className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-100 text-ink-400">
                      {thumb
                        ? <img src={thumb} alt="" draggable={false} className="h-full w-full select-none object-contain" />
                        : svg
                          ? <span className="h-full w-full p-px text-ink-500 [&>svg]:h-full [&>svg]:w-full" aria-hidden dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
                          : <Boxes size={13} aria-hidden />}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-xs leading-tight ${on ? 'font-semibold text-ink-900' : 'font-medium text-ink-800'}`}>
                        {r.name || 'Sin nombre'}
                      </div>
                      <div className="truncate text-micro leading-tight text-ink-500">{r.collection}</div>
                    </div>

                    {/* WHAT IT IS MADE OF — the «Partes» column, as two labels
                        and a count. Only from `md`, where the pane is wide
                        enough that they land in the row's own empty middle
                        instead of squeezing the name. */}
                    {r.partsRoles.length > 0 && (
                      <div className="hidden shrink-0 items-center gap-1 md:flex">
                        {r.partsRoles.slice(0, 2).map((role) => (
                          <span key={role} className="badge py-0 text-micro">{PART_LABELS[role] || role}</span>
                        ))}
                        {r.partsRoles.length > 2 && (
                          <span className="text-micro tabular-nums text-ink-500" title={r.partsRoles.map((x) => PART_LABELS[x] || x).join(' · ')}>
                            +{r.partsRoles.length - 2}
                          </span>
                        )}
                      </div>
                    )}

                    <span className="hidden shrink-0 text-micro tabular-nums text-ink-500 lg:inline">
                      {Math.round(r.widthCm)}×{Math.round(r.depthCm)}
                    </span>

                    {falta && (
                      <span className="shrink-0 text-status-warning-ink" title={falta} role="img" aria-label={falta}>
                        <AlertTriangle size={12} aria-hidden />
                      </span>
                    )}

                    {/* Estado IS the switch, the same one click the table's pill
                        is — a rail you can publish from is a rail you can
                        actually work the borradores in.
                        Which is also why it takes `.btn-icon-sm` rather than a
                        hand-rolled box: it was `h-5 w-5`, 20px, under §1's 24px
                        floor, and `targetSize` never caught it because that pin
                        scans hand-rolled `p-1`. The rail performs exactly ONE
                        write and this is it — a mis-tap on a showroom tablet
                        publishes a piece to customers — so the primitive keeps
                        the 8px dot and gives it a 24/44 target. */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleEstado(r); }}
                      disabled={!!saving[r.id]}
                      aria-pressed={est === 'activo'}
                      title={est === 'activo' ? 'Publicado en el configurador — toca para pasarlo a borrador' : 'Oculto del configurador — toca para publicarlo'}
                      className="btn-icon-sm shrink-0 rounded-full hover:bg-ink-200/60"
                    >
                      <span
                        aria-hidden
                        className={`h-2 w-2 rounded-full ${
                          saving[r.id] ? 'animate-pulse bg-ink-400'
                            : est === 'activo' ? 'bg-status-good' : 'border border-ink-400'
                        }`}
                      />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {!view.rows.length && (
            <div className="space-y-2 px-3 py-10 text-center text-micro text-ink-500">
              <p>{counts.total ? 'Ninguna pieza coincide.' : 'Todavía no hay piezas en el catálogo Togo.'}</p>
              {!counts.total && onImportSeeds && (
                <button type="button" onClick={() => onImportSeeds()} className="btn-secondary text-micro">Importar piezas Togo</button>
              )}
            </div>
          )}

          {view.rows.length > visible.length && (
            <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="btn-ghost mt-1 w-full justify-center text-micro">
              Mostrar más ({view.rows.length - visible.length})
            </button>
          )}
        </div>

        {/* ── FOOT. What you start rather than browse; the mass work lives in
            the table. */}
        <div className="shrink-0 space-y-1.5 border-t border-ink-200 p-2">
          {onAddModel && (
            <button type="button" onClick={onAddModel} className="btn-primary w-full justify-center text-micro" title="Subir uno o varios modelos 3D (.fbx/.glb) — una pieza o una escena completa de pCon">
              <Plus size={13} /> Agregar pieza
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    // THE TABLE takes the whole dashboard (the studio collapses to one column
    // and hides the stage and the ficha while this is up), so it finally has the
    // width a nine-column table wants. It fills its cell from `lg` up and
    // scrolls inside itself, so the page body never scrolls.
    <div className="order-first flex min-h-0 flex-col gap-2 p-2 lg:order-none lg:h-full">
      {/* ── THE TOOLBAR. ONE line, because every line here is a row of the table
          below it: the two controls the shared header has no slot for
          («Agregar», the reorder state), then the header itself in `bar` mode
          (search · estado · orden · columnas · colección), then what is left to
          finish. It wraps rather than scrolls — at a narrow window it becomes
          two lines and nothing is ever out of reach. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* THE WAY BACK, first in the line because that is where the «Tabla»
            button that opened this was. Nothing is lost on the way: the piece
            selected here is the piece on the stage when the rail comes back. */}
        {onModeChange && (
          <button
            type="button"
            onClick={() => onModeChange('rail')}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-micro font-medium text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
            title="Volver a la pieza: el escenario 3D y la ficha, con la lista como carril"
          >
            <PanelLeft size={13} aria-hidden /> Pieza
          </button>
        )}
        {onAddModel && (
          <button type="button" onClick={onAddModel} className="btn-primary text-micro" title="Subir uno o varios modelos 3D (.fbx/.glb) — una pieza o una escena completa de pCon">
            <Plus size={13} /> Agregar
          </button>
        )}
        {/* The reorder state, said out loud. Live: a hint. Not live: the fix,
            one tap away — an affordance that explains itself beats one that
            silently does nothing. */}
        {canReorder ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50/60 px-2 py-1 text-micro font-medium text-brand-700 dark:border-brand-900/50 dark:bg-brand-950/30"
            title="Arrastra una fila para moverla dentro de su colección — ese orden ES el de la paleta del configurador. Con el teclado: Alt + ↑↓ sobre la fila seleccionada."
          >
            <GripVertical size={11} aria-hidden /> Arrastra para ordenar
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setSort({ key: 'collection', dir: 'asc' })}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-300 px-2 py-1 text-micro font-medium text-ink-500 transition-colors hover:border-ink-400 hover:text-ink-600"
            title="Reordenar la paleta solo tiene sentido con la tabla en orden de colección ascendente: ese ES el orden en que el configurador ofrece las piezas. Toca para cambiar el orden."
          >
            <GripVertical size={11} aria-hidden /> Ordena por colección para arrastrar
          </button>
        )}

        {/* WHAT NEEDS DOING, and nothing else. The estado tabs already carry
            total/activos/borradores with their counts, so repeating them here was
            the same three numbers a third time. What the tabs CAN'T say is which
            pieces are unfinished — and a zero is good news that needs no row, so
            each gate appears only when it is a real backlog. They ride the
            toolbar's own line — three chips never deserved a band across the
            dashboard — and they ride it BEFORE the header, with the rest of the
            catalogue's state («Agregar», el orden): after it they would have
            been pushed to the far right of whatever the header's own wrap left
            over, which is nowhere in particular. */}
        <BacklogChips counts={counts} value={pendiente} onChange={setPendiente} className="shrink-0" />

        {/* The shared list header: búsqueda debounced, el estado como pestañas
            con sus conteos, la colección como pill, orden CON dirección y el
            menú de columnas — todo en la MISMA línea (`bar`), que es la forma
            que pide una banda ancha y baja. Se queda con la holgura (`flex-1`),
            así el conteo se va al extremo derecho y la línea tiene dos anclas.
            Sólo desde `lg`: `flex-1` es basis 0, así que en una pantalla
            estrecha no fuerza el salto de línea — se quedaba con los pixeles
            que sobraran (ninguno) y se desbordaba de lado. Debajo de `lg` toma
            una línea entera (`w-full`) y envuelve dentro de ella.
            `resultCount` rides ONLY while something narrows the list: unfiltered
            it restated the «Todos» tab one row below itself — the header printed
            «125 modelos» directly under a tab already reading «Todos 125». */}
        <div className="w-full min-w-0 lg:w-auto lg:flex-1">
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar modelo, colección…"
            tabs={tabs}
            activeTab={estado}
            onTabChange={(k: string) => setEstado(k as 'all' | Estado)}
            filters={[collectionFilter]}
            activeFilters={filters}
            onFiltersChange={setFilters}
            sortOptions={SORT_OPTIONS}
            sort={sort}
            onSortChange={setSort}
            columns={MODEL_COLUMNS}
            visibleColumns={visibleCols}
            onColumnsChange={setVisibleCols}
            onColumnsReset={() => { resetCols(); resetWidths(); }}
            resultCount={narrowed ? view.rows.length : undefined}
            resultNoun={['modelo', 'modelos']}
            bar
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="notice notice-sm notice-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* ── The bulk bar — appears with the first check. Estado in lote and
          the mass delete both run over the CHECKED set, wherever it was
          checked from; «Borradores → cabecera → Activar» publishes a whole
          batch import in two clicks, and → Eliminar purges one. */}
      {checkedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 dark:border-brand-900/50 dark:bg-brand-950/30">
          <span className="mr-1 text-xs font-medium tabular-nums text-ink-800">
            {checkedIds.size} seleccionado{checkedIds.size === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={() => bulkEstado('activo')} disabled={bulkBusy} className="btn-secondary text-micro disabled:opacity-50" title="Publicar los seleccionados en el configurador">
            Activar
          </button>
          <button type="button" onClick={() => bulkEstado('borrador')} disabled={bulkBusy} className="btn-secondary text-micro disabled:opacity-50" title="Ocultar los seleccionados del configurador">
            Pasar a borrador
          </button>
          {/* The collection-level suggestion: ONE question for the whole checked
              set. It opens a review — nothing binds until that panel's own
              button, «proponer siempre». */}
          <button
            type="button"
            onClick={askCollection}
            disabled={bulkBusy || !!review}
            className="btn-secondary text-micro disabled:opacity-50"
            title="Que Claude proponga el SKU de catálogo de todas las piezas seleccionadas de una vez — abre una revisión, no vincula nada"
          >
            <Sparkles size={12} /> Sugerir SKUs con Claude
          </button>
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={bulkBusy} className="btn-secondary text-micro !text-status-critical-ink disabled:opacity-50 dark:!text-status-critical-ink" title="Eliminar los seleccionados del catálogo">
            {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Eliminar…
          </button>
          <button type="button" onClick={() => { setCheckedIds(new Set()); shiftAnchor.current = null; }} disabled={bulkBusy} className="btn-ghost ml-auto text-micro disabled:opacity-50">
            Limpiar selección
          </button>
        </div>
      )}

      {bound > 0 && !review && (
        <p className="notice notice-sm notice-success">
          {bound} SKU{bound === 1 ? '' : 's'} vinculado{bound === 1 ? '' : 's'}.
        </p>
      )}

      {/* THE COLLECTION REVIEW takes the table's slot — same column, same
          dashboard, no modal over a modal. The stage and the inspector to the
          right keep working: clicking a review row selects that piece. */}
      {review ? (
        <CollectionSkuReview
          collection={review.collection}
          stage={review.stage}
          progress={review.progress}
          review={reviewView}
          duplicates={review.duplicates}
          dropped={review.dropped}
          log={review.log}
          degraded={review.degraded}
          error={review.error}
          thumbs={thumbs}
          accepted={accepted}
          overrides={overrides}
          binding={binding}
          onToggle={toggleAccepted}
          onToggleAll={toggleAllAccepted}
          onOverride={overrideRoot}
          onSelect={onSelect}
          onBind={bindAccepted}
          onRetry={askCollection}
          onClose={() => setReview(null)}
        />
      ) : (
      /* The table. Its OWN scroller in both axes: a narrow column at a wide
         viewport still shows every column, and the page body must never scroll
         sideways. */
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-ink-200 bg-surface">
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="scroll-thin max-h-[55dvh] min-h-0 flex-1 overflow-auto overscroll-contain focus:outline-none lg:max-h-none"
        >
          <table ref={tableRef} style={tableStyle} className="table" aria-label="Modelos Configurador">
            {/* `sticky` sits on the CELLS (Safari never honours it on a
                thead/tr), and the background is `!` because `.table th` paints
                a translucent ink-50 at a higher specificity than a utility —
                rows would scroll THROUGH the header. */}
            <thead>
              <tr>
                <th className="sticky top-0 z-10 w-8 !bg-ink-50 !pr-0">
                  <input
                    ref={headerCheckRef}
                    type="checkbox"
                    checked={allFilteredChecked}
                    onChange={toggleAllFiltered}
                    aria-label={allFilteredChecked ? 'Quitar la selección de los filtrados' : `Seleccionar los ${view.rows.length} modelos filtrados`}
                    title="Selecciona todos los modelos del filtro actual"
                  />
                </th>
                {cols.map((col) => {
                  // useColumnWidths hands back an inline `position: relative` for
                  // its resize handle to anchor on — which would OUTRANK the
                  // sticky class and drop the header into the scroll. Merged, not
                  // spread over: `sticky` is itself a positioned ancestor, so the
                  // handle still anchors.
                  const tp = thProps(col.key);
                  return (
                    <th
                      key={col.key}
                      {...tp}
                      style={{ ...tp.style, position: 'sticky', top: 0 }}
                      className={`z-10 !bg-ink-50 ${col.thClass || ''}`}
                    >
                      {col.label}
                      {ResizeHandle(col.key)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const on = r.id === selectedId;
                const est = estadoOf(r);
                const checked = checkedIds.has(r.id);
                const dragging = dragId === r.id;
                const isDropTarget = canReorder && dropId === r.id && dragId !== r.id;
                const ctx: CellCtx = {
                  r,
                  est,
                  thumb: thumbs[r.id],
                  svg: rawById.get(r.id)?.svg || '',
                  saving: !!saving[r.id],
                  canReorder,
                  onToggleEstado: () => toggleEstado(r),
                };
                return (
                  <tr
                    key={r.id}
                    ref={on ? (el) => { selRowRef.current = el; } : null}
                    // ONE click: the stage and the inspector to the right are
                    // already editing this piece by the next paint.
                    onClick={() => { onSelect(r.id); scrollRef.current?.focus({ preventScroll: true }); }}
                    aria-current={on ? 'true' : undefined}
                    // The whole row is the drag handle (and the drop target): the
                    // row IS the piece. Plain HTML5 DnD, the same idiom the quote
                    // line list and the Materiales color list already use.
                    draggable={canReorder}
                    onDragStart={(e) => {
                      if (!canReorder) return;
                      setDragId(r.id);
                      // `setData` is not decoration: Firefox refuses to start a
                      // drag without it. Same line the quote list already writes.
                      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); } catch { /* older Safari */ }
                    }}
                    onDragOver={(e) => {
                      if (!canReorder || !dragId || dragId === r.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropId(r.id);
                    }}
                    onDrop={(e) => { if (!canReorder) return; e.preventDefault(); dropOn(r.id); }}
                    onDragEnd={() => { setDragId(null); setDropId(null); }}
                    title={canReorder
                      ? 'Arrastra para mover la pieza dentro de su colección — ese ES el orden de la paleta del configurador (Alt + ↑↓ con el teclado)'
                      : undefined}
                    // `!` again: `.table tbody tr:hover` outranks a plain
                    // utility, so the selection would vanish under the cursor.
                    // The drop indicator is a top rule on the row's own cells —
                    // an absolute overlay can't span a table row.
                    className={`group ${canReorder ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${dragging ? 'opacity-40' : ''} ${isDropTarget ? '[&>td]:!border-t-2 [&>td]:!border-t-brand-500' : ''} ${on ? '!bg-brand-50/70 dark:!bg-brand-950/40' : checked ? '!bg-brand-50/40 dark:!bg-brand-950/20' : ''}`}
                  >
                    <td className="!pr-0" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        // Click (not change) carries shiftKey reliably across browsers.
                        onClick={(e: ReactMouseEvent<HTMLInputElement>) => toggleChecked(r.id, e.shiftKey)}
                        onChange={() => { /* handled on click */ }}
                        aria-label={`Seleccionar ${r.name || 'modelo'}`}
                      />
                    </td>
                    {cols.map((col) => (
                      <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!view.rows.length && (
            <div className="space-y-3 px-4 py-10 text-center text-xs text-ink-500">
              <p>{counts.total ? 'Ningún modelo coincide con el filtro.' : 'Todavía no hay modelos en el catálogo Togo.'}</p>
              {!counts.total && (onAddModel || onImportSeeds) && (
                <div className="flex items-center justify-center gap-2">
                  {onAddModel && (
                    <button type="button" onClick={onAddModel} className="btn-primary text-xs"><Plus size={14} /> Agregar modelo</button>
                  )}
                  {onImportSeeds && (
                    <button type="button" onClick={() => onImportSeeds()} className="btn-secondary text-xs">Importar piezas Togo</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {view.rows.length > visible.length && (
          <div className="shrink-0 border-t border-ink-200 px-3 py-2 text-center">
            <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="btn-ghost text-xs">
              Mostrar más ({view.rows.length - visible.length} restantes)
            </button>
          </div>
        )}
      </div>
      )}

      {/* The mass-delete confirmation: says exactly WHO goes and what it
          means. Rows delete in ONE bulkDelete; the uploads only they
          referenced are cleaned best-effort after (see planModelDelete). */}
      <Modal
        open={confirmDelete}
        onClose={() => !bulkBusy && setConfirmDelete(false)}
        title={`Eliminar ${deletePlan.ids.length} modelo${deletePlan.ids.length === 1 ? '' : 's'}`}
        footer={(
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={bulkBusy} className="btn-ghost text-sm disabled:opacity-50">Cancelar</button>
            <button type="button" onClick={runDelete} disabled={bulkBusy || !deletePlan.ids.length} className="btn-danger text-sm disabled:opacity-50">
              {bulkBusy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Eliminar {deletePlan.ids.length}
            </button>
          </div>
        )}
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            Se eliminan del catálogo y desaparecen del configurador público.
            {deletePlan.removeUrls.length > 0 && <> También se borran {deletePlan.removeUrls.length} archivo{deletePlan.removeUrls.length === 1 ? '' : 's'} 3D que ya nadie usa.</>}
            {' '}Las solicitudes antiguas que los usaban se conservan, pero ya no podrán recotizarse.
          </p>
          <DeleteNames rows={catalog.rows} checkedIds={checkedIds} />
        </div>
      </Modal>
    </div>
  );
}

/** The first few names going out, so the confirm is never a blind number. */
function DeleteNames({ rows, checkedIds }: { rows: ManagerRow[]; checkedIds: Set<string> }) {
  const names = rows.filter((r) => checkedIds.has(r.id)).map((r) => r.name || 'Sin nombre');
  if (!names.length) return null;
  const shown = names.slice(0, 6);
  return (
    <p className="rounded-md bg-ink-50 px-2.5 py-1.5 text-xs text-ink-500">
      {shown.join(' · ')}{names.length > shown.length && <> · y {names.length - shown.length} más</>}
    </p>
  );
}
