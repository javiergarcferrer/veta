/**
 * THE DEALER PORTAL — one dealer's inbox and the build inside a lead.
 *
 * This is the replacement for the reference's login-less bearer inbox: same
 * job, no token. The dealer is a member, the rows are RLS's decision, and the
 * only status verbs offered are the ones `vm/leads` allows this plane.
 *
 * The DXF download is the one piece of browser plumbing here — a Blob and an
 * anchor click. What goes INTO the file is `vm/portal`'s `leadDxf`, so the
 * drawing is testable without a DOM.
 */
import { useMemo, useState } from 'react';
import { dxfFileName, leadDxf, resolveLeadDetail, resolveMyLeads } from '../vm/index.ts';
import { availableTransitions } from '../vm/index.ts';
import type { AdminLead, AdminModel, LeadStatus } from '../vm/index.ts';

export interface PortalPanelProps {
  leads: AdminLead[];
  models: AdminModel[];
  dealerId: string;
  dealerName: string;
  onStatus(leadId: string, status: LeadStatus): void;
}

function download(name: string, text: string): void {
  // Guarded so the component stays importable outside a browser (the vm layer
  // is what the tests exercise; this is the last inch).
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/dxf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PortalPanel({ leads, models, dealerId, dealerName, onStatus }: PortalPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadStatus | 'all'>('all');

  const board = useMemo(() => resolveMyLeads(leads, dealerId, { status }), [leads, dealerId, status]);
  const selected = useMemo(
    () => leads.find((l) => l.id === selectedId && l.dealerId === dealerId) ?? null,
    [leads, selectedId, dealerId],
  );
  const detail = useMemo(
    () => (selected ? resolveLeadDetail(selected, models) : null),
    [selected, models],
  );

  return (
    <div className="panel split">
      <section className="card">
        <h2>{dealerName} — my leads</h2>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | 'all')}>
            <option value="all">every status</option>
            <option value="pending">pending ({board.counts.byStatus.pending})</option>
            <option value="contacted">contacted ({board.counts.byStatus.contacted})</option>
            <option value="converted">converted ({board.counts.byStatus.converted})</option>
            <option value="dismissed">dismissed ({board.counts.byStatus.dismissed})</option>
          </select>
          <span className="msg muted">{board.counts.shown} of {board.counts.total}</span>
        </div>
        <table>
          <thead><tr><th>Lead</th><th>Build</th><th>Status</th><th>Move</th></tr></thead>
          <tbody>
            {board.rows.map((row) => {
              const lead = leads.find((l) => l.id === row.id)!;
              return (
                <tr key={row.id} data-selected={selectedId === row.id}>
                  <td>
                    <button type="button" className="action" onClick={() => setSelectedId(row.id)}>{row.name}</button>
                    <div className="msg muted">{row.email ?? row.phone ?? '—'}</div>
                  </td>
                  <td>
                    {row.pieces} piece(s)
                    {row.estimateLabel ? <div className="msg muted">{row.estimateLabel}</div> : null}
                    {row.flagged ? <span className="pill flag">flagged</span> : null}
                  </td>
                  <td><span className="pill">{row.status}</span></td>
                  <td className="row">
                    {availableTransitions(lead, 'dealer').map((next) => (
                      <button key={next} type="button" className="action" onClick={() => onStatus(row.id, next)}>
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

      <section className="card">
        {!detail || !selected ? <p className="msg muted">Pick a lead to see what the client built.</p> : (
          <>
            <h2>{selected.contact?.name ?? selected.id}</h2>
            <p className="msg muted">
              {selected.contact?.email ?? '—'} · {selected.contact?.phone ?? '—'}
            </p>
            {selected.note ? <p className="msg">{selected.note}</p> : null}

            <h3>The build</h3>
            <table>
              <thead><tr><th>Piece</th><th>Qty</th></tr></thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.modelId}><td>{line.name}</td><td>{line.qty}</td></tr>
                ))}
              </tbody>
            </table>
            {detail.unknownModels.length ? (
              <p className="msg warn">
                {detail.unknownModels.length} piece(s) reference a model this catalogue no longer has.
              </p>
            ) : null}
            {detail.estimateLabel ? <p className="msg">Estimate: {detail.estimateLabel}</p> : null}
            {detail.flagged ? (
              <div>
                <span className="pill flag">configuración con avisos</span>
                {detail.violations.map((v) => <p key={v} className="msg warn">{v}</p>)}
              </div>
            ) : null}

            <button
              type="button"
              className="action primary"
              disabled={!detail.canExportDxf}
              onClick={() => download(dxfFileName(selected), leadDxf(selected, models))}
            >
              Download DXF
            </button>
          </>
        )}
      </section>
    </div>
  );
}
