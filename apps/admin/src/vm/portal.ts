/**
 * THE DEALER PORTAL — the replacement for a login-less bearer inbox.
 *
 * The reference app handed a dealer a URL with a token in it, and that URL
 * returned every lead's name, phone and email to whoever held it. That inbox is
 * DEAD BY DESIGN here: there is no token column to mint one from. A dealer is
 * an authenticated member (`org_members.role='dealer'` + `dealer_id`), and RLS
 * — not this file — is what limits the rows.
 *
 * So why does `resolveMyLeads` filter by dealer at all, if the database already
 * has? Because a UI that renders whatever it was handed will one day be handed
 * the brand admin's list by a caller that forgot to switch stores. The filter
 * here is a SECOND, cheap wall, and the test pins that it holds even when the
 * caller lies.
 *
 * The other half of this screen is the WORK: what the visitor actually built.
 * A dealer needs the piece list, the estimate, and a DXF an architect can open
 * — produced by `@veta/geometry`'s `planToDxf`, the same exporter the
 * configurator uses, so the drawing a dealer downloads is the drawing the
 * customer configured.
 */
import { planToDxf } from '@veta/geometry';
import type { DxfPlacement } from '@veta/geometry';
import { resolveLeadsBoard } from './leads.ts';
import type { LeadsBoard, LeadsFilter } from './leads.ts';
import type { AdminLead, AdminModel } from './types.ts';

/**
 * ONE dealer's inbox. The dealer id is a PARAMETER, not part of the filter, so
 * a filter object can never widen the scope — `dealerId` in the filter is
 * ignored on this path by construction.
 */
export function resolveMyLeads(
  leads: readonly AdminLead[],
  dealerId: string,
  filter: Omit<LeadsFilter, 'dealerId'> = {},
): LeadsBoard {
  const mine = leads.filter((lead) => lead.dealerId === dealerId);
  return resolveLeadsBoard(mine, [], { ...filter, dealerId: null });
}

/* ------------------------------- the build --------------------------------- */

export interface BuildLine {
  modelId: string;
  name: string;
  qty: number;
}

export interface LeadDetail {
  lead: AdminLead;
  lines: BuildLine[];
  pieces: number;
  /** Pieces whose model is not in the catalogue we were handed. Reported, never
   *  dropped: "3 pieces, 2 lines" with no explanation is how a quote goes out
   *  short. */
  unknownModels: string[];
  estimateLabel: string | null;
  flagged: boolean;
  violations: string[];
  /** A DXF is offered only when there is geometry to put in it. */
  canExportDxf: boolean;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function resolveLeadDetail(lead: AdminLead, models: readonly AdminModel[]): LeadDetail {
  const byId = new Map(models.map((m) => [m.id, m]));
  const pieces = Array.isArray(lead.build?.pieces) ? lead.build!.pieces : [];

  const counts = new Map<string, number>();
  const unknown = new Set<string>();
  for (const piece of pieces) {
    const id = String(piece?.modelId ?? '');
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!byId.has(id)) unknown.add(id);
  }

  const lines: BuildLine[] = [...counts.entries()]
    .map(([modelId, qty]) => ({ modelId, qty, name: byId.get(modelId)?.name ?? 'Unknown model' }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

  const board = resolveLeadsBoard([lead]);
  const row = board.rows[0]!;

  return {
    lead,
    lines,
    pieces: pieces.length,
    unknownModels: [...unknown].sort(),
    estimateLabel: row.estimateLabel,
    flagged: row.flagged,
    violations: row.violations,
    canExportDxf: pieces.length > 0,
  };
}

/* --------------------------------- the DXF --------------------------------- */

/**
 * The build → `planToDxf`'s placements. A piece with no authored plan symbol
 * falls back to its footprint rectangle inside the exporter, which is why the
 * model's cm dimensions are always sent even when an SVG exists — a drawing
 * with the right sizes in the right places beats no drawing.
 */
export function dxfPlacements(lead: AdminLead, models: readonly AdminModel[]): DxfPlacement[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const pieces = Array.isArray(lead.build?.pieces) ? lead.build!.pieces : [];
  return pieces.map((piece, index) => {
    const model = byId.get(String(piece?.modelId ?? '')) ?? null;
    return {
      pieceId: piece?.uid ?? index,
      x: num(piece?.x),
      y: num(piece?.y),
      rot: num(piece?.rot),
      widthCm: num(model?.widthCm),
      depthCm: num(model?.depthCm),
      label: model?.name ?? String(piece?.modelId ?? ''),
      ...(model?.planSvg ? { svg: model.planSvg } : {}),
    };
  });
}

/** The lead's plan, as CAD text. Empty build → an empty (valid) drawing rather
 *  than a throw: the button is disabled, and a caller that pressed it anyway
 *  gets a file, not an exception. */
export function leadDxf(
  lead: AdminLead,
  models: readonly AdminModel[],
  opts: { layerPrefix?: string } = {},
): string {
  return planToDxf(dxfPlacements(lead, models), { layerPrefix: opts.layerPrefix ?? 'VETA' });
}

/** A stable, filesystem-safe name — dated, so a dealer's downloads folder
 *  sorts by when the lead came in rather than by a uuid. */
export function dxfFileName(lead: AdminLead, at: Date | number = lead.createdAt): string {
  const when = at instanceof Date ? at : new Date(at);
  const stamp = Number.isNaN(when.getTime()) ? 'undated' : when.toISOString().slice(0, 10);
  const who = (lead.contact?.name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  return `veta-${stamp}-${who || lead.id.slice(0, 8)}.dxf`;
}
