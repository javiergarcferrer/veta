/**
 * THE STORE SEAM — the admin's only door to persistence, and it is INJECTED.
 *
 * Nothing in `vm/*` or `ui/*` knows a table name or which plane a request
 * rides. The shell takes an `AdminStore`; the tests take the in-memory one,
 * which is why every workflow here — issue a key, route a lead, move a status —
 * is testable without a project, a network or a credential.
 *
 * Two implementations ship:
 *   • `createMemoryAdminStore` — real, complete, deterministic (tests + demo);
 *   • `createSupabaseAdminStore` — the MEMBER-plane adapter, typed and mocked.
 *
 * ONE RULE THE SHAPE ENFORCES: the store hands back REDACTED keys
 * (`AdminApiKey`) and nothing else. There is no `listApiKeysWithHashes`, no
 * `getKey`, no `token` on a list row — issuing is the only call that ever
 * yields a token, and it yields it once, in the reply that created it.
 */
import type {
  AdminApiKey,
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminModel,
  IssuedApiKey,
  LeadStatus,
} from '../vm/types.ts';
import type { IssueKeyRequest } from '../vm/keys.ts';
import type { RoutingConfig } from '../vm/routing.ts';

export interface AdminStore {
  /* the network */
  listDealers(): Promise<AdminDealer[]>;
  saveDealer(dealer: AdminDealer): Promise<AdminDealer>;
  deleteDealer(id: string): Promise<void>;
  listLocations(): Promise<AdminLocation[]>;
  saveLocation(location: AdminLocation): Promise<AdminLocation>;
  deleteLocation(id: string): Promise<void>;

  /* the brand's routing cascade */
  loadRoutingConfig(): Promise<unknown>;
  saveRoutingConfig(config: RoutingConfig): Promise<void>;

  /* leads */
  listLeads(): Promise<AdminLead[]>;
  /** Returns the row AS STORED, so the caller adopts the server's answer
   *  instead of assuming its optimistic one was accepted. */
  setLeadStatus(id: string, status: LeadStatus): Promise<AdminLead>;
  /** A brand admin assigning what routing left unrouted. `null` un-assigns. */
  assignLead(id: string, dealerId: string | null): Promise<AdminLead>;

  /* the catalogue sliver the portal needs to draw a build */
  listModels(): Promise<AdminModel[]>;

  /* credentials — redacted on the way out, RPC on the way in */
  listApiKeys(): Promise<AdminApiKey[]>;
  issueApiKey(request: IssueKeyRequest): Promise<IssuedApiKey>;
  revokeApiKey(id: string): Promise<void>;
}
