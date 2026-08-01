/**
 * BRAND ADMIN — the routing cascade.
 *
 * The screen is a list you reorder and tick, plus a preview. The preview is the
 * point: it runs `routeLead` — the function the API calls — over the brand's
 * real dealers and locations, so "what will happen to the next lead" is
 * answered before the config is saved rather than after.
 */
import { useMemo, useState } from 'react';
import {
  POLICY_LABELS,
  moveStage,
  previewRouting,
  setHonorPinned,
  setMaxDistance,
  toggleStage,
  validateRoutingDraft,
} from '../vm/index.ts';
import type { AdminDealer, AdminLocation, RoutingConfig, RoutingDraft } from '../vm/index.ts';

export interface RoutingPanelProps {
  draft: RoutingDraft;
  dealers: AdminDealer[];
  locations: AdminLocation[];
  onChange(draft: RoutingDraft): void;
  onSave(config: RoutingConfig): void;
}

export function RoutingPanel({ draft, dealers, locations, onChange, onSave }: RoutingPanelProps) {
  const [lat, setLat] = useState('18.48');
  const [lng, setLng] = useState('-69.90');
  const [key, setKey] = useState('sample-lead-1');

  const validation = useMemo(() => validateRoutingDraft(draft), [draft]);
  const preview = useMemo(
    () => previewRouting(
      [
        { label: 'This position', lead: { geo: { lat: Number(lat), lng: Number(lng) }, dedupeKey: key } },
        { label: 'No position', lead: { dedupeKey: key } },
      ],
      dealers,
      locations,
      draft,
    ),
    [lat, lng, key, dealers, locations, draft],
  );

  return (
    <div className="panel split">
      <section className="card">
        <h2>Lead routing</h2>
        <p className="msg muted">
          The first stage that names a dealer wins. Order matters.
        </p>
        <div className="stages">
          {draft.stages.map((stage, index) => (
            <div className="stage" key={stage.policy}>
              <input
                type="checkbox"
                checked={stage.enabled}
                onChange={() => onChange(toggleStage(draft, stage.policy))}
                aria-label={stage.policy}
              />
              <span className="label">{POLICY_LABELS[stage.policy]}</span>
              <button
                type="button"
                className="action"
                disabled={index === 0}
                onClick={() => onChange(moveStage(draft, stage.policy, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="action"
                disabled={index === draft.stages.length - 1}
                onClick={() => onChange(moveStage(draft, stage.policy, 1))}
              >
                ↓
              </button>
            </div>
          ))}
        </div>

        <div className="grid2">
          <label>
            Max distance (km) — “nearest” only
            <input
              value={draft.maxDistanceKm}
              onChange={(e) => onChange(setMaxDistance(draft, e.target.value))}
            />
          </label>
          <label>
            Honour a dealer named by the widget
            <select
              value={draft.honorPinnedDealer ? 'yes' : 'no'}
              onChange={(e) => onChange(setHonorPinned(draft, e.target.value === 'yes'))}
            >
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </label>
        </div>
        <label>
          Postal centroids — “code lat,lng” per line
          <textarea
            value={draft.postalCentroids}
            onChange={(e) => onChange({ ...draft, postalCentroids: e.target.value })}
          />
        </label>

        {Object.entries(validation.errors).map(([field, message]) => (
          <p key={field} className="msg error">{message}</p>
        ))}
        {validation.warnings.map((warning) => <p key={warning} className="msg warn">{warning}</p>)}

        <button
          type="button"
          className="action primary"
          disabled={!validation.ok}
          onClick={() => { if (validation.value) onSave(validation.value); }}
        >
          Save routing
        </button>
      </section>

      <section className="card">
        <h2>Preview</h2>
        <p className="msg muted">The engine the API runs, over this network, with these unsaved settings.</p>
        <div className="grid2">
          <label>Latitude<input value={lat} onChange={(e) => setLat(e.target.value)} /></label>
          <label>Longitude<input value={lng} onChange={(e) => setLng(e.target.value)} /></label>
        </div>
        <label>Lead key (round-robin)<input value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <table>
          <thead><tr><th>Sample</th><th>Dealer</th><th>Why</th></tr></thead>
          <tbody>
            {preview.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.dealerName ?? <span className="pill">unrouted</span>}</td>
                <td><code>{row.decision.reason}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.length === 0 ? <p className="msg warn">Fix the settings above to preview.</p> : null}
      </section>
    </div>
  );
}
