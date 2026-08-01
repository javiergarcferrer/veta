export type { AdminStore } from './types.ts';
export type { MemoryAdminStore, MemoryAdminStoreOptions } from './memory.ts';
export { createMemoryAdminStore } from './memory.ts';
export type {
  QueryLike,
  SupabaseAdminStoreOptions,
  SupabaseLike,
  TableLike,
} from './supabase.ts';
export {
  createSupabaseAdminStore,
  dealerFromRow,
  dealerToRow,
  leadFromRow,
  locationFromRow,
  locationToRow,
  modelFromRow,
} from './supabase.ts';
