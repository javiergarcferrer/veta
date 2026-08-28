import { Search } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import FilterTabs from './FilterTabs.jsx';
import FilterBar from './FilterBar.jsx';
import SortMenu from './SortMenu.jsx';
import ColumnsMenu from './ColumnsMenu.jsx';

/**
 * ListSearchHeader — the one Shopify-admin-inspired search / filter header
 * reused across every list view in the app (Quotes, Customers, Profesionales,
 * Materiales, Contabilidad). It is deliberately VIEW-AGNOSTIC: it holds no
 * domain logic, owns no state, and never filters anything itself. It takes a
 * declarative config + the current query state and emits changes; the PARENT
 * does the actual filtering / sorting on its own data. That contract is what
 * lets the same component dress five different surfaces.
 *
 * Anatomy (top → bottom), each part rendered only if its config is supplied:
 *   1. Search field — debounced, leading search icon, enterKeyHint="search".
 *   2. Sort menu — pick the sort key + explicit asc/desc control.
 *   3. Filter tabs — the primary status dimension as a scrollable segmented
 *      "saved views" strip (Todas / Borrador / …).
 *   4. Filter pills — ONE always-visible pill per secondary filter
 *      (select / date-range / text), each opening its own popover (desktop)
 *      or sheet (mobile). Changes apply INSTANTLY — no Aplicar step — and an
 *      applied pill reads `Label: value ×` (see FilterBar).
 *   5. Result count — quiet "N resultados" line.
 *
 * Layout: search grows to fill the row; Sort sits to its right and wraps
 * below it on a narrow phone (flex-wrap), so nothing is ever clipped. The
 * tab strip and the pills row live beneath, scrollable/wrapping on mobile.
 *
 * PROP API (the public surface — keep this stable for the other views):
 *
 *   searchValue: string
 *   onSearchChange: (value: string) => void
 *   searchPlaceholder?: string
 *   searchDelay?: number                       // debounce ms, default 250
 *
 *   tabs?: Array<{ key: string, label: string, count?: number }>
 *   activeTab?: string
 *   onTabChange?: (key: string) => void
 *
 *   filters?: Array<{
 *     key: string,
 *     label: string,
 *     type: 'select' | 'date-range' | 'text',
 *     options?: Array<{ value: string, label: string }>,   // for 'select'
 *     placeholder?: string,
 *   }>
 *   activeFilters?: { [key: string]: string | { from?: string, to?: string } }
 *   onFiltersChange?: (next: object) => void
 *
 *   sortOptions?: Array<{ key: string, label: string }>
 *   sort?: { key: string, dir: 'asc' | 'desc' }
 *   onSortChange?: ({ key, dir }) => void
 *
 *   columns?: Array<{ key: string, label: string, canHide?: boolean }>
 *   visibleColumns?: { [key: string]: boolean }
 *   onColumnsChange?: (nextVisible: object) => void
 *   onColumnsReset?: () => void
 *
 *   resultCount?: number
 *   resultNoun?: [singular, plural]            // e.g. ['resultado','resultados']
 *   resultDetail?: string
 *     One more fact about the SAME set, printed after the count on the same
 *     quiet line — Cotizaciones puts the money the listed rows are worth
 *     there. It exists so a page stops repeating the count in its header just
 *     to have somewhere to hang the figure: two identical numbers a screen
 *     apart are one piece of information and one thing to reconcile.
 *
 *   dense?: boolean
 *     For a NARROW host — a rail beside a workbench, not a page. The default
 *     layout gives row 1 to `search + sort + columns` sharing the width, which
 *     is right at page width and wrong at ~22rem: the two menus carry their
 *     labels ("Colección · paleta", "Columnas"), take what they need, and the
 *     search collapses to a bare magnifier nobody can type into. Dense gives
 *     the search a row of its own, puts the menus with the filter pills on the
 *     next one, and tightens the rhythm. Page-width callers pass nothing and
 *     render EXACTLY as before.
 *
 *   bar?: boolean
 *     For a WIDE but SHORT host — a list band across the bottom of a workbench
 *     (the Modelos dashboard), where the scarce axis is HEIGHT and every row of
 *     chrome is a row of data lost. Everything the header owns rides ONE
 *     wrapping line: a fixed-width search, the tabs, sort, columnas, the filter
 *     pills, and the count pushed to the far end. It is the mirror of `dense`,
 *     which spends rows to save width; pass one or the other, never both (bar
 *     wins). The pieces are the SAME components in the same order — a caller
 *     switching between the three layouts never gets a different control.
 */
/**
 * The absent-columns default. A bare `= undefined` would have TypeScript infer
 * the parameter AS `undefined` for every consumer (this file is .jsx, so the
 * props type is inferred from the signature) and reject the table that does
 * pass columns. One cast, once.
 * @type {any}
 */
const NO_COLUMNS = undefined;

export default function ListSearchHeader({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Buscar…',
  searchDelay = 250,
  // Optional: lets a host (the Modelos rail's «/» shortcut) focus the field.
  searchInputRef = null,
  tabs,
  activeTab,
  onTabChange,
  filters,
  activeFilters = {},
  onFiltersChange,
  sortOptions,
  sort,
  onSortChange,
  // Optional by contract (`hasColumns` below): a host with one column — the
  // Modelos rail — has nothing to show or hide.
  columns = NO_COLUMNS,
  visibleColumns = NO_COLUMNS,
  onColumnsChange = NO_COLUMNS,
  onColumnsReset = NO_COLUMNS,
  resultCount,
  resultNoun = ['resultado', 'resultados'],
  resultDetail = '',
  dense = false,
  bar = false,
}) {
  const hasFilters = Array.isArray(filters) && filters.length > 0;
  const hasSort = Array.isArray(sortOptions) && sortOptions.length > 0;
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  // Columns toggle tunes a wide desktop table; mobile renders cards, so it's
  // wrapped desktop-only at render (below).
  const hasColumns = Array.isArray(columns) && columns.length > 0 && typeof onColumnsChange === 'function';

  // ONE search field for all three layouts — only the box it sits in changes.
  // Written once because the three variants must never drift into three
  // different inputs (debounce, `type=search`, the a11y label).
  const searchField = (wrapCls) => (
    <div className={wrapCls}>
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
        aria-hidden
      />
      <DebouncedInput
        ref={searchInputRef}
        className="input pl-9"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={searchPlaceholder}
        value={searchValue}
        onCommit={onSearchChange}
        delay={searchDelay}
        placeholder={searchPlaceholder}
      />
    </div>
  );

  // ── BAR — a wide, short host: everything on ONE wrapping line. See the prop
  // docs. The search is the only piece with a width of its own (a bare
  // magnifier is not typeable, and a `flex-1` search would swallow the line at
  // 1400px); every other control takes exactly its label and the tab strip
  // keeps its own horizontal scroll for the narrow case.
  if (bar) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {searchField('relative w-full min-w-0 shrink-0 sm:w-56')}
        {hasTabs && (
          <div className="min-w-0 max-w-full">
            <FilterTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
          </div>
        )}
        {hasSort && (
          <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={onSortChange} />
        )}
        {hasColumns && (
          <div className="hidden md:block">
            <ColumnsMenu
              columns={columns}
              visible={visibleColumns}
              onChange={onColumnsChange}
              onReset={onColumnsReset}
            />
          </div>
        )}
        {hasFilters && (
          <FilterBar
            filters={filters}
            activeFilters={activeFilters}
            onFiltersChange={onFiltersChange}
          />
        )}
        {typeof resultCount === 'number' && (
          <p className="ml-auto shrink-0 text-micro leading-none tabular-nums text-ink-500" aria-live="polite">
            <span className="font-semibold text-ink-500">{resultCount}</span>
            {' '}
            {resultCount === 1 ? resultNoun[0] : resultNoun[1]}
            {resultDetail ? <span className="text-ink-500"> · {resultDetail}</span> : null}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={dense ? 'space-y-1.5' : 'mb-5 space-y-2.5'}>
      {/* Row 1 — search, and (page width only) the two menu triggers beside it.
          Dense hands the row to the search alone: see `dense` in the prop docs. */}
      <div className={dense ? 'relative' : 'flex flex-wrap items-center gap-2'}>
        {searchField(dense ? 'relative' : 'relative min-w-0 flex-1')}

        {!dense && hasSort && (
          <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={onSortChange} />
        )}

        {!dense && hasColumns && (
          <div className="hidden md:block">
            <ColumnsMenu
              columns={columns}
              visible={visibleColumns}
              onChange={onColumnsChange}
              onReset={onColumnsReset}
            />
          </div>
        )}
      </div>

      {/* Row 2 — segmented status views. */}
      {hasTabs && (
        <FilterTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
      )}

      {/* Row 3 — the controls that only need as much room as their label:
          dense gathers sort, columns and the filter pills onto ONE wrapping
          line; at page width the two menus already rode row 1 and this is the
          pills alone, exactly as before. */}
      {dense ? (
        (hasSort || hasColumns || hasFilters) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {hasSort && (
              <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={onSortChange} />
            )}
            {hasColumns && (
              <div className="hidden md:block">
                <ColumnsMenu
                  columns={columns}
                  visible={visibleColumns}
                  onChange={onColumnsChange}
                  onReset={onColumnsReset}
                />
              </div>
            )}
            {hasFilters && (
              <FilterBar
                filters={filters}
                activeFilters={activeFilters}
                onFiltersChange={onFiltersChange}
              />
            )}
          </div>
        )
      ) : (
        hasFilters && (
          <FilterBar
            filters={filters}
            activeFilters={activeFilters}
            onFiltersChange={onFiltersChange}
          />
        )
      )}

      {/* Row 4 — quiet result count; tabular-nums keeps the digit from jumping. */}
      {typeof resultCount === 'number' && (
        <p className="text-micro tabular-nums text-ink-500 leading-none" aria-live="polite">
          <span className="font-semibold text-ink-500">{resultCount}</span>
          {' '}
          {resultCount === 1 ? resultNoun[0] : resultNoun[1]}
          {resultDetail ? <span className="text-ink-500"> · {resultDetail}</span> : null}
        </p>
      )}
    </div>
  );
}
