/**
 * LEADS — the board both planes read, and the ONE rule about who may move one.
 *
 * The board is shared: a brand admin sees the org's leads, a dealer sees its
 * own. What differs is not the query (the database decides that — RLS scopes a
 * dealer member to `org_members.dealer_id`) but the TRANSITIONS each plane may
 * make, and that rule lives here so both surfaces obey the same one.
 *
 *   INBOX-SETTABLE (ported verbatim from the reference dealer inbox): a dealer
 *   may set 'pending' or 'contacted'. `converted` and `dismissed` are the
 *   brand's calls — promotion to a quote, and triage — and a dealer marking its
 *   own lead "converted" is a commission claim, not a status change.
 *
 * The verdict FLAG is display, never a filter the dealer can lose a lead
 * behind: a flagged configuration ("this build breaks a rule") is shown next to
 * the lead, and the lead is in the list either way. That is the law the API
 * captures leads under, carried to the screen that reads them.
 */
import type { AdminDealer, AdminLead, LeadStatus } from './types.ts';

export const LEAD_STATUSES: readonly LeadStatus[] = ['pending', 'contacted', 'converted', 'dismissed'];

/** The only statuses a DEALER may set, from its own inbox. */
export const INBOX_SETTABLE_STATUSES: readonly LeadStatus[] = ['pending', 'contacted'];

export type AdminPlane = 'brand' | 'dealer';

export interface LeadsFilter {
  /** A dealer id, or `'unrouted'` for the pile nobody owns yet. */
  dealerId?: string | 'unrouted' | null;
  status?: LeadStatus | 'all' | null;
  search?: string;
  /** Only leads whose stored verdict is not ok. */
  flaggedOnly?: boolean;
}

export interface LeadRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  dealerId: string | null;
  dealerName: string | null;
  status: LeadStatus;
  /** The build broke a rule. A warning on the row, never a reason to hide it. */
  flagged: boolean;
  violations: string[];
  estimateLabel: string | null;
  pieces: number;
  routingReason: string | null;
  createdAt: number;
}

export interface LeadsBoard {
  rows: LeadRow[];
  counts: {
    total: number;
    shown: number;
    byStatus: Record<LeadStatus, number>;
    unrouted: number;
    flagged: number;
  };
}

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A lead's own verdict, read defensively — a missing verdict is NOT a flag. */
export function isFlagged(lead: AdminLead): boolean {
  return lead.verdict ? lead.verdict.ok === false : false;
}

export function violationsOf(lead: AdminLead): string[] {
  const list = lead.verdict?.violations;
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => trim(v?.message) || trim(v?.ruleId))
    .filter((text): text is string => Boolean(text));
}

/** Minor units → a readable amount. No currency table: the ISO code IS the
 *  label, because inventing symbols per currency is how DOP becomes $. */
export function estimateLabel(lead: AdminLead): string | null {
  const estimate = lead.estimate;
  if (!estimate || !Number.isFinite(Number(estimate.amountMinor))) return null;
  const currency = trim(estimate.currency).toUpperCase() || 'USD';
  const major = Number(estimate.amountMinor) / 100;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function leadRow(lead: AdminLead, dealerName: string | null): LeadRow {
  return {
    id: lead.id,
    name: trim(lead.contact?.name) || trim(lead.contact?.email) || 'Sin nombre',
    email: trim(lead.contact?.email) || null,
    phone: trim(lead.contact?.phone) || null,
    dealerId: lead.dealerId,
    dealerName,
    status: lead.status,
    flagged: isFlagged(lead),
    violations: violationsOf(lead),
    estimateLabel: estimateLabel(lead),
    pieces: Array.isArray(lead.build?.pieces) ? lead.build!.pieces.length : 0,
    routingReason: trim(lead.source?.routing?.reason) || null,
    createdAt: lead.createdAt,
  };
}

/**
 * The board. Counts are computed over the WHOLE set (so the tab badges do not
 * change as you filter), while `rows` is the filtered, newest-first list.
 */
export function resolveLeadsBoard(
  leads: readonly AdminLead[],
  dealers: readonly AdminDealer[] = [],
  filter: LeadsFilter = {},
): LeadsBoard {
  const nameById = new Map(dealers.map((d) => [d.id, d.name]));
  const search = trim(filter.search).toLowerCase();
  const status = filter.status && filter.status !== 'all' ? filter.status : null;

  const byStatus: Record<LeadStatus, number> = { pending: 0, contacted: 0, converted: 0, dismissed: 0 };
  let unrouted = 0;
  let flagged = 0;
  for (const lead of leads) {
    if (byStatus[lead.status] !== undefined) byStatus[lead.status] += 1;
    if (!lead.dealerId) unrouted += 1;
    if (isFlagged(lead)) flagged += 1;
  }

  const rows = leads
    .filter((lead) => {
      if (filter.dealerId === 'unrouted') return lead.dealerId === null;
      if (filter.dealerId) return lead.dealerId === filter.dealerId;
      return true;
    })
    .filter((lead) => (status ? lead.status === status : true))
    .filter((lead) => (filter.flaggedOnly ? isFlagged(lead) : true))
    .filter((lead) => {
      if (!search) return true;
      const hay = [lead.contact?.name, lead.contact?.email, lead.contact?.phone, lead.note]
        .map((v) => trim(v).toLowerCase())
        .join(' ');
      return hay.includes(search);
    })
    .map((lead) => leadRow(lead, lead.dealerId ? nameById.get(lead.dealerId) ?? null : null))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

  return {
    rows,
    counts: { total: leads.length, shown: rows.length, byStatus, unrouted, flagged },
  };
}

/* ------------------------------- transitions ------------------------------- */

export interface TransitionPlan {
  ok: boolean;
  /** The status to write. Null when the move is refused or is a no-op. */
  status: LeadStatus | null;
  reason: string;
}

/**
 * May this plane move this lead to `next`? The refusals are explicit because
 * every one of them is a rule someone will otherwise "fix" by widening it:
 *
 *   • an unknown status is never written;
 *   • a dealer may only ever set INBOX-SETTABLE statuses…
 *   • …and only on a lead that is still in the inbox: once the brand has
 *     converted or dismissed it, the dealer's inbox is no longer the authority.
 */
export function planStatusTransition(
  lead: AdminLead,
  next: string,
  plane: AdminPlane,
): TransitionPlan {
  const target = LEAD_STATUSES.find((s) => s === next) ?? null;
  if (!target) return { ok: false, status: null, reason: `“${next}” is not a lead status.` };
  if (lead.status === target) return { ok: false, status: null, reason: 'Already in that status.' };

  if (plane === 'dealer') {
    if (!INBOX_SETTABLE_STATUSES.includes(target)) {
      return { ok: false, status: null, reason: 'Only the brand can convert or dismiss a lead.' };
    }
    if (!INBOX_SETTABLE_STATUSES.includes(lead.status)) {
      return { ok: false, status: null, reason: 'This lead has already been closed by the brand.' };
    }
  }

  return { ok: true, status: target, reason: `${lead.status} → ${target}` };
}

/** Apply a planned transition to the row. Returns the SAME lead when refused —
 *  the caller can render either without branching, and nothing is half-moved. */
export function applyTransition(lead: AdminLead, plan: TransitionPlan): AdminLead {
  if (!plan.ok || !plan.status) return lead;
  return { ...lead, status: plan.status };
}

/** Which buttons a plane may show for a row. Pure, so the two surfaces cannot
 *  drift into offering different verbs for the same rule. */
export function availableTransitions(lead: AdminLead, plane: AdminPlane): LeadStatus[] {
  return LEAD_STATUSES.filter((status) => planStatusTransition(lead, status, plane).ok);
}
