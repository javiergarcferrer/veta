/**
 * THE SHELL — two surfaces, one store.
 *
 * BRAND ADMIN: dealers + locations, the routing cascade, the leads board, API
 * keys. DEALER PORTAL: one dealer's inbox and the build inside a lead.
 *
 * What is left in this component is React: which plane, which tab, which row is
 * selected, and the async plumbing between a store and a ViewModel. Every
 * decision it renders came from `vm/*`, and the store is injected here and
 * nowhere else — swapping the in-memory one for the member-plane adapter is a
 * one-line change at this boundary.
 *
 * The plane switch is a DEVELOPMENT affordance, not an authorization: which
 * plane a real session gets is decided by `org_members.role`, and what it can
 * read is decided by RLS. Nothing here grants anything.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createMemoryAdminStore } from '../store/memory.ts';
import type { AdminStore } from '../store/types.ts';
import { applyTransition, planStatusTransition, routingDraftOf } from '../vm/index.ts';
import type {
  AdminApiKey,
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminModel,
  AdminPlane,
  LeadStatus,
  RoutingConfig,
  RoutingDraft,
} from '../vm/index.ts';
import { DealersPanel } from './DealersPanel.tsx';
import { KeysPanel } from './KeysPanel.tsx';
import { LeadsPanel } from './LeadsPanel.tsx';
import { PortalPanel } from './PortalPanel.tsx';
import { RoutingPanel } from './RoutingPanel.tsx';

export const BRAND_TABS = ['dealers', 'routing', 'leads', 'keys'] as const;
export type BrandTab = (typeof BRAND_TABS)[number];

const uid = (): string => `id-${Math.random().toString(36).slice(2, 10)}`;

export function App({ store = createMemoryAdminStore() }: { store?: AdminStore }) {
  const [plane, setPlane] = useState<AdminPlane>('brand');
  const [tab, setTab] = useState<BrandTab>('dealers');
  const [dealers, setDealers] = useState<AdminDealer[]>([]);
  const [locations, setLocations] = useState<AdminLocation[]>([]);
  const [leads, setLeads] = useState<AdminLead[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [routing, setRouting] = useState<RoutingDraft>(routingDraftOf({}));
  const [dealerId, setDealerId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [d, l, leadRows, m, k, config] = await Promise.all([
      store.listDealers(),
      store.listLocations(),
      store.listLeads(),
      store.listModels(),
      store.listApiKeys(),
      store.loadRoutingConfig(),
    ]);
    setDealers(d);
    setLocations(l);
    setLeads(leadRows);
    setModels(m);
    setKeys(k);
    setRouting(routingDraftOf(config));
    setDealerId((current) => current || d[0]?.id || '');
  }, [store]);

  useEffect(() => { void reload().catch((err: Error) => setError(err.message)); }, [reload]);

  const guard = useCallback(
    (work: Promise<unknown>) => {
      void work.then(() => reload()).catch((err: Error) => setError(err.message));
    },
    [reload],
  );

  const setStatus = useCallback((leadId: string, status: LeadStatus) => {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;
    // The rule decides, not the button that was clicked: a stale render must not
    // be able to make a move this plane may not make.
    const plan = planStatusTransition(lead, status, plane);
    if (!plan.ok || !plan.status) { setError(plan.reason); return; }
    setLeads((rows) => rows.map((row) => (row.id === leadId ? applyTransition(row, plan) : row)));
    guard(store.setLeadStatus(leadId, plan.status));
  }, [leads, plane, store, guard]);

  const dealer = useMemo(() => dealers.find((d) => d.id === dealerId) ?? null, [dealers, dealerId]);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Veta admin</h1>
        <div className="plane-switch">
          <button type="button" aria-pressed={plane === 'brand'} onClick={() => setPlane('brand')}>
            Brand admin
          </button>
          <button type="button" aria-pressed={plane === 'dealer'} onClick={() => setPlane('dealer')}>
            Dealer portal
          </button>
        </div>
        {plane === 'dealer' ? (
          <select value={dealerId} onChange={(e) => setDealerId(e.target.value)}>
            {dealers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
        <span className="spacer" />
        {error ? <span className="msg error">{error}</span> : null}
      </header>

      {plane === 'brand' ? (
        <>
          <nav className="tabs">
            {BRAND_TABS.map((name) => (
              <button key={name} type="button" aria-selected={tab === name} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </nav>

          {tab === 'dealers' ? (
            <DealersPanel
              dealers={dealers}
              locations={locations}
              leads={leads}
              newId={uid}
              onSaveDealer={(d) => guard(store.saveDealer(d))}
              onDeleteDealer={(id) => guard(store.deleteDealer(id))}
              onSaveLocation={(l) => guard(store.saveLocation(l))}
              onDeleteLocation={(id) => guard(store.deleteLocation(id))}
            />
          ) : null}

          {tab === 'routing' ? (
            <RoutingPanel
              draft={routing}
              dealers={dealers}
              locations={locations}
              onChange={setRouting}
              onSave={(config: RoutingConfig) => guard(store.saveRoutingConfig(config))}
            />
          ) : null}

          {tab === 'leads' ? (
            <LeadsPanel
              leads={leads}
              dealers={dealers}
              plane="brand"
              onStatus={setStatus}
              onAssign={(leadId, to) => guard(store.assignLead(leadId, to))}
            />
          ) : null}

          {tab === 'keys' ? (
            <KeysPanel
              keys={keys}
              onIssue={async (request) => {
                const issued = await store.issueApiKey(request);
                await reload();
                return issued;
              }}
              onRevoke={(id) => guard(store.revokeApiKey(id))}
            />
          ) : null}
        </>
      ) : (
        <PortalPanel
          leads={leads}
          models={models}
          dealerId={dealerId}
          dealerName={dealer?.name ?? 'No dealer selected'}
          onStatus={setStatus}
        />
      )}
    </div>
  );
}
