/**
 * THE IN-MEMORY ADMIN STORE — a real implementation, not a stub.
 *
 * It is what the tests run against and what the shell boots with when no
 * adapter is configured, so it behaves like the real thing wherever the
 * workflow can tell the difference: a save returns the STORED row (the caller
 * adopts it), every read hands out COPIES, an unknown id is an error rather
 * than a silent no-op, and — the one that matters — ISSUING A KEY IS THE ONLY
 * CALL THAT EVER RETURNS A TOKEN. What the store keeps afterwards is the
 * redacted row; the secret is generated, handed back once and forgotten, which
 * is exactly what the security-definer RPC does server-side.
 *
 * Clock and id generator are injected so a test's expectations are exact.
 */
import { redactKey } from '../vm/keys.ts';
import type { IssueKeyRequest } from '../vm/keys.ts';
import type {
  AdminApiKey,
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminModel,
  IssuedApiKey,
  LeadStatus,
} from '../vm/types.ts';
import type { RoutingConfig } from '../vm/routing.ts';
import type { AdminStore } from './types.ts';

export interface MemoryAdminStoreOptions {
  dealers?: readonly AdminDealer[];
  locations?: readonly AdminLocation[];
  leads?: readonly AdminLead[];
  models?: readonly AdminModel[];
  keys?: readonly AdminApiKey[];
  routing?: unknown;
  now?: () => number;
  uid?: () => string;
}

export interface MemoryAdminStore extends AdminStore {
  /** Everything held, for assertions. Copies, like every other read. */
  snapshot(): {
    dealers: AdminDealer[];
    locations: AdminLocation[];
    leads: AdminLead[];
    keys: AdminApiKey[];
    routing: unknown;
  };
}

const clone = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T));

export function createMemoryAdminStore({
  dealers = [],
  locations = [],
  leads = [],
  models = [],
  keys = [],
  routing = {},
  now = () => Date.now(),
  uid = () => Math.random().toString(36).slice(2, 10),
}: MemoryAdminStoreOptions = {}): MemoryAdminStore {
  const dealerRows = new Map(dealers.map((d) => [d.id, clone(d)]));
  const locationRows = new Map(locations.map((l) => [l.id, clone(l)]));
  const leadRows = new Map(leads.map((l) => [l.id, clone(l)]));
  const modelRows = new Map(models.map((m) => [m.id, clone(m)]));
  const keyRows = new Map(keys.map((k) => [k.id, clone(k)]));
  let routingConfig: unknown = clone(routing);

  const lead = (id: string): AdminLead => {
    const row = leadRows.get(id);
    // The same failure a 404 is: the caller shows it, nothing is half-written.
    if (!row) throw new Error(`No lead ${id}`);
    return row;
  };

  return {
    async listDealers() {
      return [...dealerRows.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name));
    },
    async saveDealer(dealer) {
      const stored: AdminDealer = { ...clone(dealer), updatedAt: now() };
      dealerRows.set(stored.id, stored);
      return clone(stored);
    },
    async deleteDealer(id) {
      dealerRows.delete(id);
      // A dealer's locations go with it — the FK cascades server-side, and a
      // store that left them would report a phantom network.
      for (const [key, row] of locationRows) if (row.dealerId === id) locationRows.delete(key);
      // Its leads do NOT: a lead outlives the dealer it was routed to, it just
      // becomes unrouted (`on delete set null`).
      for (const [key, row] of leadRows) if (row.dealerId === id) leadRows.set(key, { ...row, dealerId: null });
    },

    async listLocations() {
      return [...locationRows.values()].map(clone);
    },
    async saveLocation(location) {
      const stored: AdminLocation = { ...clone(location), updatedAt: now() };
      locationRows.set(stored.id, stored);
      return clone(stored);
    },
    async deleteLocation(id) {
      locationRows.delete(id);
    },

    async loadRoutingConfig() {
      return clone(routingConfig);
    },
    async saveRoutingConfig(config: RoutingConfig) {
      routingConfig = clone(config);
    },

    async listLeads() {
      return [...leadRows.values()].map(clone).sort((a, b) => b.createdAt - a.createdAt);
    },
    async setLeadStatus(id, status: LeadStatus) {
      const stored = { ...lead(id), status };
      leadRows.set(id, stored);
      return clone(stored);
    },
    async assignLead(id, dealerId) {
      const stored = { ...lead(id), dealerId };
      leadRows.set(id, stored);
      return clone(stored);
    },

    async listModels() {
      return [...modelRows.values()].map(clone);
    },

    async listApiKeys() {
      return [...keyRows.values()].map(clone);
    },
    async issueApiKey(request: IssueKeyRequest): Promise<IssuedApiKey> {
      const id = `key-${uid()}`;
      const token = `${request.kind === 'secret' ? 'sk' : 'pk'}_live_${uid()}${uid()}`;
      // The redaction happens HERE, at the boundary, exactly as it does in the
      // database view: what is kept is a prefix, never the key.
      const key = redactKey({
        id,
        kind: request.kind,
        prefix: `${token.slice(0, 12)}…`,
        scopes: request.scopes,
        allowedOrigins: request.allowedOrigins,
        createdAt: now(),
        lastUsedAt: null,
        revokedAt: null,
      })!;
      keyRows.set(id, key);
      return { key: clone(key), token };
    },
    async revokeApiKey(id) {
      const row = keyRows.get(id);
      if (!row) throw new Error(`No api key ${id}`);
      // Revoked, never deleted: "which key was that, and when did we kill it"
      // is the question an incident asks.
      keyRows.set(id, { ...row, revokedAt: now() });
    },

    snapshot() {
      return {
        dealers: [...dealerRows.values()].map(clone),
        locations: [...locationRows.values()].map(clone),
        leads: [...leadRows.values()].map(clone),
        keys: [...keyRows.values()].map(clone),
        routing: clone(routingConfig),
      };
    },
  };
}
