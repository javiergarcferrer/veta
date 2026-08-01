/**
 * BRAND ADMIN — the dealer network: the list, one dealer's form, and its
 * locations. Every decision (is this slug free, is that a multiplier, does this
 * location's radius make sense) is a `validate*` in `vm/dealers`; what is left
 * here is which row is selected and what is in the inputs.
 */
import { useMemo, useState } from 'react';
import {
  DEALER_STATUSES,
  PRICING_MODES,
  dealerDraftOf,
  emptyDealerDraft,
  emptyLocationDraft,
  locationDraftOf,
  locationsOf,
  resolveDealerList,
  slugify,
  validateDealer,
  validateLocation,
} from '../vm/index.ts';
import type {
  AdminDealer,
  AdminLead,
  AdminLocation,
  DealerDraft,
  LocationDraft,
} from '../vm/index.ts';

export interface DealersPanelProps {
  dealers: AdminDealer[];
  locations: AdminLocation[];
  leads: AdminLead[];
  onSaveDealer(dealer: AdminDealer): void;
  onDeleteDealer(id: string): void;
  onSaveLocation(location: AdminLocation): void;
  onDeleteLocation(id: string): void;
  newId(): string;
}

export function DealersPanel({
  dealers,
  locations,
  leads,
  onSaveDealer,
  onDeleteDealer,
  onSaveLocation,
  onDeleteLocation,
  newId,
}: DealersPanelProps) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<DealerDraft | null>(null);
  const [locationDraft, setLocationDraft] = useState<LocationDraft | null>(null);

  const board = useMemo(
    () => resolveDealerList(dealers, locations, leads, { search }),
    [dealers, locations, leads, search],
  );
  const validation = useMemo(
    () => (draft ? validateDealer(draft, dealers) : null),
    [draft, dealers],
  );
  const locationValidation = useMemo(
    () => (locationDraft ? validateLocation(locationDraft) : null),
    [locationDraft],
  );
  const selectedLocations = useMemo(
    () => (draft ? locationsOf(locations, draft.id) : []),
    [locations, draft],
  );

  const edit = (dealer: AdminDealer) => {
    setDraft(dealerDraftOf(dealer));
    setLocationDraft(null);
  };

  return (
    <div className="panel split">
      <section className="card">
        <h2>Dealers</h2>
        <div className="row">
          <input
            placeholder="Search name or slug"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="action"
            onClick={() => { setDraft(emptyDealerDraft(newId())); setLocationDraft(null); }}
          >
            New dealer
          </button>
        </div>
        <p className="msg muted">
          {board.rows.length} of {board.total} · {board.unrouted} unrouted lead(s)
        </p>
        <table>
          <thead>
            <tr><th>Dealer</th><th>Pricing</th><th>Locations</th><th>Leads</th></tr>
          </thead>
          <tbody>
            {board.rows.map((row) => (
              <tr key={row.dealer.id} data-selected={draft?.id === row.dealer.id}>
                <td>
                  <button type="button" className="action" onClick={() => edit(row.dealer)}>
                    {row.dealer.name}
                  </button>
                  <div className="msg muted">{row.dealer.slug}</div>
                  {row.dealer.status === 'inactive' ? <span className="pill">inactive</span> : null}
                </td>
                <td>{row.pricingLabel}</td>
                <td>{row.routable}/{row.locations} routable</td>
                <td>{row.openLeads} open / {row.leads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        {!draft ? <p className="msg muted">Pick a dealer, or create one.</p> : (
          <>
            <h2>{draft.name || 'New dealer'}</h2>
            <div className="grid2">
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({
                    ...draft,
                    name: e.target.value,
                    // The slug follows the name only while it is untouched — a
                    // saved dealer's address must never move under it.
                    slug: draft.slug === slugify(draft.name) ? slugify(e.target.value) : draft.slug,
                  })}
                />
              </label>
              <label>
                Slug
                <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </label>
              <label>
                Status
                <select
                  value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as AdminDealer['status'] })}
                >
                  {DEALER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label>
                Currency
                <input value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
              </label>
              <label>
                Price mode
                <select
                  value={draft.pricingMode}
                  onChange={(e) => setDraft({ ...draft, pricingMode: e.target.value as DealerDraft['pricingMode'] })}
                >
                  {PRICING_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>
                Multiplier
                <input value={draft.multiplier} onChange={(e) => setDraft({ ...draft, multiplier: e.target.value })} />
              </label>
              <label>
                Contact email
                <input value={draft.contactEmail} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
              </label>
              <label>
                Contact phone
                <input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />
              </label>
            </div>

            {Object.entries(validation?.errors ?? {}).map(([field, message]) => (
              <p key={field} className="msg error">{message}</p>
            ))}
            {(validation?.warnings ?? []).map((warning) => (
              <p key={warning} className="msg warn">{warning}</p>
            ))}

            <div className="row">
              <button
                type="button"
                className="action primary"
                disabled={!validation?.ok}
                onClick={() => { if (validation?.value) onSaveDealer(validation.value); }}
              >
                Save dealer
              </button>
              <button type="button" className="action" onClick={() => setDraft(null)}>Close</button>
              {dealers.some((d) => d.id === draft.id) ? (
                <button
                  type="button"
                  className="action"
                  onClick={() => { onDeleteDealer(draft.id); setDraft(null); }}
                >
                  Delete
                </button>
              ) : null}
            </div>

            <h3>Locations</h3>
            <table>
              <thead><tr><th>Name</th><th>Position</th><th>Territory</th><th /></tr></thead>
              <tbody>
                {selectedLocations.map((location) => (
                  <tr key={location.id}>
                    <td>{location.name}</td>
                    <td>{location.lat === null ? '—' : `${location.lat}, ${location.lng}`}</td>
                    <td>
                      {location.territory?.kind === 'radiusKm'
                        ? `${location.territory.radiusKm} km`
                        : location.territory?.kind === 'polygon'
                          ? `${location.territory.polygon.length}-point area`
                          : '—'}
                    </td>
                    <td className="row">
                      <button type="button" className="action" onClick={() => setLocationDraft(locationDraftOf(location))}>
                        Edit
                      </button>
                      <button type="button" className="action" onClick={() => onDeleteLocation(location.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="action"
              onClick={() => setLocationDraft(emptyLocationDraft(newId(), draft.id))}
            >
              Add location
            </button>

            {locationDraft ? (
              <>
                <h3>{locationDraft.name || 'New location'}</h3>
                <div className="grid2">
                  <label>
                    Name
                    <input value={locationDraft.name} onChange={(e) => setLocationDraft({ ...locationDraft, name: e.target.value })} />
                  </label>
                  <label>
                    Routing priority
                    <input value={locationDraft.routingPriority} onChange={(e) => setLocationDraft({ ...locationDraft, routingPriority: e.target.value })} />
                  </label>
                  <label>
                    Latitude
                    <input value={locationDraft.lat} onChange={(e) => setLocationDraft({ ...locationDraft, lat: e.target.value })} />
                  </label>
                  <label>
                    Longitude
                    <input value={locationDraft.lng} onChange={(e) => setLocationDraft({ ...locationDraft, lng: e.target.value })} />
                  </label>
                  <label>
                    Territory
                    <select
                      value={locationDraft.territoryKind}
                      onChange={(e) => setLocationDraft({
                        ...locationDraft,
                        territoryKind: e.target.value as LocationDraft['territoryKind'],
                      })}
                    >
                      <option value="none">none</option>
                      <option value="radiusKm">radius (km)</option>
                      <option value="polygon">area (polygon)</option>
                    </select>
                  </label>
                  {locationDraft.territoryKind === 'radiusKm' ? (
                    <label>
                      Radius km
                      <input value={locationDraft.radiusKm} onChange={(e) => setLocationDraft({ ...locationDraft, radiusKm: e.target.value })} />
                    </label>
                  ) : null}
                  <label>
                    Address
                    <input value={locationDraft.addressLine} onChange={(e) => setLocationDraft({ ...locationDraft, addressLine: e.target.value })} />
                  </label>
                  <label>
                    City
                    <input value={locationDraft.city} onChange={(e) => setLocationDraft({ ...locationDraft, city: e.target.value })} />
                  </label>
                </div>
                {locationDraft.territoryKind === 'polygon' ? (
                  <label>
                    Area — one “lat, lng” per line
                    <textarea
                      value={locationDraft.polygon}
                      onChange={(e) => setLocationDraft({ ...locationDraft, polygon: e.target.value })}
                    />
                  </label>
                ) : null}
                <label>
                  Hours
                  <input value={locationDraft.hours} onChange={(e) => setLocationDraft({ ...locationDraft, hours: e.target.value })} />
                </label>

                {Object.entries(locationValidation?.errors ?? {}).map(([field, message]) => (
                  <p key={field} className="msg error">{message}</p>
                ))}
                {(locationValidation?.warnings ?? []).map((warning) => (
                  <p key={warning} className="msg warn">{warning}</p>
                ))}
                <div className="row">
                  <button
                    type="button"
                    className="action primary"
                    disabled={!locationValidation?.ok}
                    onClick={() => {
                      if (locationValidation?.value) {
                        onSaveLocation(locationValidation.value);
                        setLocationDraft(null);
                      }
                    }}
                  >
                    Save location
                  </button>
                  <button type="button" className="action" onClick={() => setLocationDraft(null)}>Cancel</button>
                </div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
