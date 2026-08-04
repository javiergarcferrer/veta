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

// ---- per-quote money rollups (the single "sum a quote" helpers for the
//      list/detail surfaces — dashboard, quotes/orders lists, customer/pro)
export { linesByQuoteId, quoteTotals, quoteGrandTotal, quoteMargin, commissionBasesByBrand } from './totals.js';
// Inventory order vs catalog order — one or the other, never both (gates the
// pickers, the Especial tier and the anticipo).
export {
  resolveQuoteKind, lineKind, canAddCatalogLine, canAddInventoryLine,
  canUseSpecialOrder, effectiveOrderType,
  QUOTE_KIND_CATALOG, QUOTE_KIND_INVENTORY, QUOTE_KIND_MIXED, QUOTE_KIND_EMPTY,
} from '../../lib/quoteKind.js';

// ---- predicates (what counts toward the total)
export { isPricedLine, isPricedComponent } from '../../lib/constants.js';

// ---- group attributes
export { isGroupOptional, selectAlternativePatches } from '../../lib/quoteGroups.js';

// ---- exchange-rate state (live-until-accept lock; the single source of truth)
export {
  quoteRateState, displayRatesFor, effectiveRates, effectiveDopRate, readExchangeRate,
} from '../../lib/exchangeRate.js';

// ---- PIB delivery signals (a line's Ligne Roset lead-time / stock / discontinued
//      status + the whole-quote delivery estimate, off the weekly PIB briefing)
export { lineDeliveryEstimate, quoteDeliverySummary, pibPromoExcluded } from '../../lib/pib.js';

// ---- the one mutation reducer (optimistic client + authoritative server share it)
//      reanchorMaterial is the grade-switch re-anchor rule (subtype/swatch/options
//      re-base) the editor preview reuses to mirror the link's `materials` pick.
export { applyAction, applyClientPick, reanchorMaterial } from './actions.js';

// ---- terms presets (the dealer's named-terms library + the editor's one-tap
//      picker that writes a preset body into quote.terms; termsPatchForOrderType
//      auto-swaps terms when the Piso/Especial toggle flips)
export {
  DEFAULT_QUOTE_TERMS_PRESETS, resolveTermsPresets, resolveTermsPresetPicker,
  initialQuoteTerms, termsPatchForOrderType,
} from '../../lib/quoteTerms.js';

// ---- ViewModels (per-view projections off the Model)
export { resolveQuoteView, linePriced, componentPriced } from './views/quoteView.js';
export { resolveQuoteLinePreview } from './views/linePreview.js';
export { resolveLineList } from './views/editor.js';
export { resolveLineItem } from './views/lineItem.js';
export { resolveQuoteHeader, sellerName } from './views/header.js';
export { resolveRateBadge } from './views/rateBadge.js';
export { resolveDashboard } from './views/dashboard.js';
export { resolveQuotesList, resolveOrdersList, resolveProfessionalsList, resolveCustomersList } from './views/lists.js';
export { resolveCrmAnalytics } from './views/crmAnalytics.js';
export { resolveOrderDetail, resolveCustomerDetail, resolveProfessionalDetail } from './views/detail.js';
export { resolveOrderRegistration } from './views/registration.js';
// Payment plan + contract VM (the amortized schedule decorated with paid/overdue
// + DOP figures + signed state); the schedule math is lib/paymentPlan.
export { resolvePaymentPlanView, buildPlanSchedule, resolvePaymentPlanFollowUp, defaultContractBody } from './views/paymentPlan.js';
export { amortize, addMonths, buildCustomSchedule, SPLIT_PRESETS } from '../../lib/paymentPlan.js';
export { resolveWarehouseOrder } from './views/warehouseOrder.js';
// Togo plan configurator VM (drag-and-drop top-down → a modular quote line),
// plus the DXF export (a placed plan → a downloadable CAD file).
export {
  resolveConfigurator, resolveTogoModels, resolveTogoModelCards, planTogoReorder, togoPickerFamilies,
  snapPlacement, snapPlacementInfo, footprintOf, resolvePlacement, compactPlaced,
  buildTogoComponents, buildTogoModularSeed,
  createHistory, historyPush, historyUndo, historyRedo, canUndo, canRedo, TOGO_HISTORY_LIMIT,
  firstWithoutFabric, duplicatePlacement, cyclePieceUid,
  resolveTogoDxf, placementsFromPlaced, placementsFromComponents, lineHasTogoPlan,
  resolveTogoScene, scenePlacementsFromPlaced, scenePlacementsFromComponents,
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
} from '../../lib/togo/modelMatch.js';
// Togo workspace home VM (the Resumen: cross-section KPIs, alerts, funnel,
// activity + per-dealer board — the one projection that fuses the tabs).
export {
  resolveTogoOverview,
  TOGO_OVERVIEW_WINDOW_DAYS, TOGO_STALE_PENDING_DAYS, TOGO_OVERVIEW_RECENT_MAX, TOGO_OVERVIEW_ALERTS_MAX,
} from './views/togoOverview.js';
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
