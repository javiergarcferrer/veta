// @veta/admin — the brand-admin console and the dealer portal.
//
// Two surfaces over one store, and every decision either of them makes lives in
// `vm/*` as a pure function: the dealer network editor (with the pricing levers
// routed through `@veta/catalog`'s own validators), the lead-routing cascade
// (edited and PREVIEWED with `routeLead` itself — never a second opinion about
// what the API will do), the leads board and its INBOX-SETTABLE rule, and the
// API-key view that structurally cannot hold a credential.

export * from './vm/index.ts';
export type { AdminStore } from './store/types.ts';
export type { MemoryAdminStore, MemoryAdminStoreOptions } from './store/memory.ts';
export { createMemoryAdminStore } from './store/memory.ts';
export type { SupabaseAdminStoreOptions, SupabaseLike } from './store/supabase.ts';
export {
  createSupabaseAdminStore,
  dealerFromRow,
  dealerToRow,
  leadFromRow,
  locationFromRow,
  locationToRow,
  modelFromRow,
} from './store/supabase.ts';
