/**
 * THE LEADS BOARD — rendered by both planes.
 *
 * The plane is a PROP, and every verb the screen offers comes from
 * `availableTransitions(lead, plane)`. That is the whole reason a dealer's
 * portal cannot show a "Convert" button: not because this component hides it,
 * but because the rule says there is none to show.
 */
import { useMemo, useState } from 'react';
import { LEAD_STATUSES, availableTransitions, planStatusTransition, resolveLeadsBoard } from '../vm/index.ts';
import type { AdminDealer, AdminLead, AdminPlane, LeadStatus } from '../vm/index.ts';

export interface LeadsPanelProps {
  leads: AdminLead[];
  dealers: AdminDealer[];
  plane: AdminPlane;
  /** Brand-only: assign what routing left unrouted. */
  onAssign?: (leadId: string, dealerId: string | null) => void;
  onStatus(leadId: string, status: LeadStatus): void;
  onOpen?: (leadId: string) => void;
}

export function LeadsPanel({ leads, dealers, plane, onAssign, onStatus, onOpen }: LeadsPanelProps) {
  const [status, setStatus] = useState<LeadStatus | 'all'>('all');
  const [dealerId, setDealerId] = useState<string | 'unrouted' | ''>('');
  const [search, setSearch] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const board = useMemo(
    () => resolveLeadsBoard(leads, dealers, {
      status,
      dealerId: dealerId || null,
      search,
      flaggedOnly,
    }),
    [leads, dealers, status, dealerId, search, flaggedOnly],
  );
  const byId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);

  return (
    <div className="panel">
      <section className="card">
        <h2>Leads</h2>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | 'all')}>
            <option value="all">every status</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>{s} ({board.counts.byStatus[s]})</option>
            ))}
          </select>
          {plane === 'brand' ? (
            <select value={dealerId} onChange={(e) => setDealerId(e.target.value as typeof dealerId)}>
              <option value="">every dealer</option>
              <option value="unrouted">unrouted ({board.counts.unrouted})</option>
              {dealers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          ) : null}
          <input placeholder="Search name, email, note" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="row">
            <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
            flagged only ({board.counts.flagged})
          </label>
        </div>
        <p className="msg muted">{board.counts.shown} of {board.counts.total}</p>

        <table>
          <thead>
            <tr>
              <th>Lead</th>
              {plane === 'brand' ? <th>Dealer</th> : null}
              <th>Build</th>
              <th>Status</th>
              <th>Move</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((row) => {
              const lead = byId.get(row.id)!;
              return (
                <tr key={row.id}>
                  <td>
                    {onOpen
                      ? <button type="button" className="action" onClick={() => onOpen(row.id)}>{row.name}</button>
                      : row.name}
                    <div className="msg muted">{row.email ?? row.phone ?? '—'}</div>
                    {row.routingReason ? <span className="pill">{row.routingReason}</span> : null}
                  </td>
                  {plane === 'brand' ? (
                    <td>
                      <select
                        value={row.dealerId ?? ''}
                        onChange={(e) => onAssign?.(row.id, e.target.value || null)}
                      >
                        <option value="">unrouted</option>
                        {dealers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </td>
                  ) : null}
                  <td>
                    {row.pieces} piece(s)
                    {row.estimateLabel ? <div className="msg muted">{row.estimateLabel}</div> : null}
                    {row.flagged ? (
                      <div>
                        <span className="pill flag">flagged</span>
                        {row.violations.map((v) => <div key={v} className="msg warn">{v}</div>)}
                      </div>
                    ) : null}
                  </td>
                  <td><span className="pill">{row.status}</span></td>
                  <td className="row">
                    {availableTransitions(lead, plane).map((next) => (
                      <button
                        key={next}
                        type="button"
                        className="action"
                        title={planStatusTransition(lead, next, plane).reason}
                        onClick={() => onStatus(row.id, next)}
                      >
                        {next}
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
