// The quote MODEL — the logic + data core, framework-agnostic (no React, no
// Supabase, no pdf-lib). It's the single place the quote's rules live; the
// per-view ViewModels and the Views derive from here and nothing re-implements
// the logic on its own.
//
// MVVM layering:
//   • Model      — this package: pricing, grouping, predicates, the exchange-
//                  rate state, and `applyAction` (the one mutation reducer).
//   • ViewModel  — `views/*`: pure projections shaped to what each view needs.
//   • View       — the renderers (ClientPreview, the editor, the PDF) that read
//                  a ViewModel and render it; they derive nothing themselves.
//
// (During the migration the pricing/grouping/rate helpers physically still live
// under src/lib and are surfaced here; new code imports them from the Model.)

// ---- derivations: pricing + grouping (totals, ranges, group runs, positions)
export * from '../../lib/pricing.js';
// ---- alternativas: the pick-one container and what it holds (an OPTION is a
//      package — one line, or a whole Conjunto offered together)
export * from '../../lib/alternatives.js';

// ---- predicates (what counts toward the total)
export { isPricedLine, isPricedComponent } from '../../lib/constants.js';

// ---- exchange-rate state (live-until-accept lock; the single source of truth)
export {
  quoteRateState, displayRatesFor, effectiveRates, effectiveDopRate, readExchangeRate,
} from '../../lib/exchangeRate.js';
// Togo plan configurator VM (drag-and-drop top-down → a modular quote line),
// plus the DXF export (a placed plan → a downloadable CAD file).
export {
  resolveConfigurator, resolveConfiguratorModels, resolveConfiguratorModelCards, planConfiguratorReorder, configuratorPickerFamilies,
  snapPlacement, snapPlacementInfo, footprintOf, resolvePlacement, compactPlaced,
  buildConfiguratorComponents, buildConfiguratorModularSeed,
  createHistory, historyPush, historyUndo, historyRedo, canUndo, canRedo, CONFIGURATOR_HISTORY_LIMIT,
  firstWithoutFabric, placementDressed, dressableRoles, duplicatePlacement, cyclePieceUid,
  placementMode, componentRoles, partsModeTotalUsd, planModeSwitch,
  // Los dos modos, segunda vuelta: que telas VISTEN de verdad una pieza segun
  // su modo (`effectivePartMaterials` — un pick dormido en modo pieza no la
  // viste), la vista de un componente abierto, y las piezas que solo se venden
  // por componentes. `isWholePieceRole` desambigua el rol 'base' (pieza entera
  // vs. componente que se llama «base»). `linkOverlap` es el solape que decide
  // si dos piezas se encadenan; `materializedBase` y los dos `unresolved*` son
  // lo que el escenario y el desglose ya usaban a traves de este barril.
  effectivePartMaterials, componentViewOf, sellsByComponentsOnly, isWholePieceRole,
  materializedBase, unresolvedPartRoles, unresolvedWholePiece,
  linkOverlap, LINK_OVERLAP_CM,
  resolveConfiguratorDxf, placementsFromPlaced, placementsFromComponents, lineHasConfiguratorPlan,
  resolveConfiguratorScene, scenePlacementsFromPlaced, scenePlacementsFromComponents,
  resolveLaunchHero, LAUNCH_HERO_FABRIC, resolveCollectionMenu,
  heroFabricOptions, planHeroPin,
  partFamiliesFrom, partPricesFor, placementTotalUsd, placementBreakdown, resolveCompleteSku,
  PX_PER_CM, SNAP_GRID_CM, EDGE_SNAP_CM, RELEASE_DOCK_CM, PLAN_MARGIN_CM,
} from './views/configuratorView.js';
// Model manager VM (the admin board over togo_models: estado activo/borrador,
// binding + mesh fidelity per row). `planEstadoToggle` is the one write it
// plans — `active:false` IS the widget's hide semantics, so no migration.
export { resolveModelManager, planEstadoToggle, planBulkEstado, planModelDelete } from './views/modelManager.js';
// SKU suggestion — the candidate NARROWER behind binding an uploaded model to
// the product that prices it. Deterministic on purpose: it parses LR's inch
// dimensions, refuses the partial-subtype twins outright and never crosses a
// generation, so whatever chooses the final root (a human, or Claude) is only
// ever choosing among rows that could legitimately price the piece.
// The COLLECTION half of the same module lifts it from one piece to a whole
// family: `collectionCandidates` unions each piece's offers into one deduped
// pool (so every guard above still gates it), `planCollectionChunks` declares
// the split, and the merge/review/bind planners fold the answer back into one
// row per model that nothing writes until the reviewer clicks.
export {
  resolveModelMatches, indexCandidates, parseLrDimensions, nameTokens, shapeFacts,
  collectionCandidates, planCollectionChunks, mergeCollectionSuggestions,
  resolveAssignmentDuplicates, resolveCollectionReview, planCollectionBind,
  COLLECTION_PER_MODEL, COLLECTION_MAX_MODELS, COLLECTION_MAX_POOL,
} from '../../lib/configurator/modelMatch.js';
// Dealer workspace VM (Distribuidores: the alta wizard, the list board and the
// per-dealer ficha). `resolveDealerCollections` is the CATÁLOGO dial — which
// collections a dealer carries, read off the real togo_models set, with "todas"
// stored as the ABSENCE of a list; `resolveDealerPricePreview` walks ONE real
// catalog piece through list → margen → multiplicador → tasa so the two money
// knobs (FX vs markup) are legible before a visitor ever sees a price.
export {
  resolveDealerCollections, resolveDealerPricePreview, resolveDealerDraft,
  resolveDealersList, resolveDealerDetail, dealerStoredCollections,
  dealerSlugify, dealerMoneyLabel, dealerLocaleLabel, dealerPricingLabel,
  DEALER_LOCALES, DEALER_PRICING_MODES, DEALER_LIST_TABS, DEALER_SORT_OPTIONS,
} from './views/dealerWorkspace.js';
// The QUOTING surface — a configurator lead becomes a document the manufacturer
// sends. `resolveQuoteDoc` is the SHARED content tree for the internal quote
// detail AND the customer's login-less `#/q/<token>` page (the same
// one-projection-two-surfaces rule `resolveQuoteView` holds for the ERP quote),
// so screen and paper cannot drift. Nothing here PRICES: a quote's money is
// frozen server-side at creation (togo-embed/quotes.ts, migration
// 20261130000000) and these VMs only format and label what is stored.
export {
  resolveQuoteDoc, resolveQuotesBoard, quoteStatusMeta, quoteDocCopy,
  formatQuoteMoney, quoteShareUrl, QUOTE_BOARD_TABS, QUOTE_STATUSES,
} from './views/quoteDoc.js';
// Solicitudes: the triage board + one lead opened (priced by the server's shared
// pricer — the same numbers the widget and the dealer inbox show).
export {
  resolveRequestsBoard, resolveRequestDetail, requestStatusMeta, placedFromItems,
  REQUEST_BOARD_TABS,
} from './views/requestDetail.js';
// EL PANEL — the admin home screen: the catalog readiness ledger (what blocks a
// piece from being configurable or quotable, including the SILENT one — a SKU
// bound to a product row that carries no price), materiales, distribuidores,
// solicitudes + cotizaciones (money grouped BY CURRENCY, never summed across
// them) and the active brand's import environment.
export {
  resolveAdminDashboard, DASHBOARD_EXAMPLES_MAX, DASHBOARD_RECENT_MAX,
} from './views/dashboardView.js';
