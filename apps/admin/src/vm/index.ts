/**
 * The admin's ViewModels — every decision both surfaces make, as pure
 * functions. Nothing here imports React or a store: the shell renders what a
 * `resolve*` returned and writes what a `plan*`/`validate*` produced.
 */

export type {
  AdminApiKey,
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminModel,
  AdminTerritory,
  ApiKeyKind,
  DealerContact,
  DealerPricing,
  DealerStatus,
  IssuedApiKey,
  LeadBuild,
  LeadContact,
  LeadEstimate,
  LeadPiece,
  LeadRoutingStamp,
  LeadStatus,
  LeadVerdict,
  PricingMode,
} from './types.ts';

// Dealers — the network editor.
export type {
  DealerDraft,
  DealerListFilter,
  DealerRow,
  LocationDraft,
  Validation,
} from './dealers.ts';
export {
  DEALER_STATUSES,
  PRICING_MODES,
  dealerDraftOf,
  emptyDealerDraft,
  emptyLocationDraft,
  locationDraftOf,
  locationsOf,
  parsePolygonText,
  pricingLabel,
  resolveDealerList,
  slugify,
  validateDealer,
  validateLocation,
} from './dealers.ts';

// Routing — the cascade, edited and previewed with the engine itself.
export type {
  RoutingConfig,
  RoutingDecision,
  RoutingDraft,
  RoutingPolicy,
  RoutingPreviewRow,
  RoutingStageDraft,
  RoutingValidation,
} from './routing.ts';
export {
  POLICY_LABELS,
  ROUTING_POLICIES,
  defaultRoutingDraft,
  moveStage,
  parseCentroidText,
  previewRouting,
  routableFrom,
  routingDraftOf,
  setHonorPinned,
  setMaxDistance,
  toggleStage,
  validateRoutingDraft,
} from './routing.ts';

// Leads — the board, and who may move one.
export type { AdminPlane, LeadRow, LeadsBoard, LeadsFilter, TransitionPlan } from './leads.ts';
export {
  INBOX_SETTABLE_STATUSES,
  LEAD_STATUSES,
  applyTransition,
  availableTransitions,
  estimateLabel,
  isFlagged,
  leadRow,
  planStatusTransition,
  resolveLeadsBoard,
  violationsOf,
} from './leads.ts';

// API keys — the view that cannot hold a credential.
export type { IssueKeyDraft, IssueKeyRequest, IssueValidation, KeyListFilter, KeyRow, KeyState } from './keys.ts';
export {
  API_KEY_KINDS,
  DEFAULT_SCOPES,
  SCOPES_BY_KIND,
  emptyIssueDraft,
  normalizeOrigin,
  planIssueKey,
  redactKey,
  resolveKeyList,
  revealOnce,
} from './keys.ts';

// The dealer portal — one inbox, and the work inside a lead.
export type { BuildLine, LeadDetail } from './portal.ts';
export { dxfFileName, dxfPlacements, leadDxf, resolveLeadDetail, resolveMyLeads } from './portal.ts';
