// The shipment-tracking Model + ViewModels.
//
//   • Model      — the pure logic in lib/containerTracking (ISO 6346 validation,
//                  DCSA event summarisation, route + voyage geometry), surfaced
//                  here.
//   • ViewModel  — resolveTrackableContainers (which containers to show),
//                  resolveVoyageHud (the voyage summary fields the map HUD and
//                  the summary band share), and the useContainerTracking hook
//                  (one container's live HL state).
//   • View       — ContainerTracking / ShipmentTracking render these; every
//                  surface (quote list, editor, client link, order) derives from
//                  the same place.
export {
  normalizeContainerNo, isValidContainerNo, validateContainerNo, detectCarrier,
  summarizeTracking, buildTrackingRoute, summarizeVoyage,
  MODE_LABELS, CLASSIFIER_LABELS,
} from '../../lib/containerTracking.js';
export { resolveTrackableContainers } from './containers.js';
export { resolveVoyageHud } from './voyage.js';
export { resolveOrderNotices, isNotifiableStage, resolveDeliveryTemplate, buildLifecycleTemplatePlan } from './orderNotices.js';
// The hook VMs (useContainerTracking / useContainerEtas) are the documented
// EFFECTFUL exception — they import db/supabaseClient at module scope. They are
// deliberately NOT re-exported here: this barrel feeds pure consumers
// (core/quote's lists → the PUBLIC configurator embed), and re-exporting the
// hooks dragged the whole Supabase client (−53KB gz + a logged-out auth
// instance) onto the embed's boot path. Import them from
// './useContainerTracking.js' directly — the hook file IS their entry point.
