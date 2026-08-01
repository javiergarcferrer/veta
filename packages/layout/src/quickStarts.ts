// Quick-start arrangements — one tap drops a complete, sensible set so a customer
// reaches a quote without building from a blank plan (the slowest part of the
// end-to-end flow).
//
// A spec is DATA: it carries its own role classifier (name regexes, most-specific
// first) and its own slot list, so a new product line ships a new spec instead of
// a new branch in here. Specs resolve against the catalogue actually available: a
// template only appears when EVERY role it needs is present, so it degrades
// gracefully on any dealer's model set.

/** One role in a spec's classifier: a key + the name pattern that claims it. */
export interface QuickStartRole {
  role: string;
  match: RegExp;
}

/** A quick-start template. `slots` may repeat a role → the same model is placed more than once. */
export interface QuickStartSpec {
  id: string;
  label: string;
  /** The roles to place, in visual order. The layout engine lays them out, so order is intent only. */
  slots: string[];
  /** The name classifier, MOST-SPECIFIC FIRST (a "Loveseat" must not fall through to "sofa"). */
  roles: QuickStartRole[];
  /** What an unmatched name reads as; omit for "unmatched models claim no role". */
  fallbackRole?: string;
}

/** A catalogue entry, as far as the matcher cares. */
export interface QuickStartCatalogItem {
  id?: string | number | null;
  name?: string | null;
}

export interface QuickStart {
  id: string;
  label: string;
  pieceIds: (string | number)[];
}

/**
 * The sofa role table — the ES/EN/FR terms a modular seating catalogue uses.
 * Most-specific roles first.
 */
export const SOFA_ROLES: QuickStartRole[] = [
  { role: 'corner', match: /corner|esquina|d['’]?angle|\bangle\b/i },
  { role: 'lounge', match: /lounge|m[eé]ridienne|chaise|div[aá]n|daybed/i },
  { role: 'ottoman', match: /ottoman|puff|pouf|otomana|repose|footstool/i },
  { role: 'loveseat', match: /love\s*seat|loveseat|2\s*(plazas?|seater)|biplaza/i },
  { role: 'fireside', match: /fireside|chauffeuse|sill[oó]n|fauteuil|armchair|1\s*plaza/i },
  { role: 'sofa', match: /sofa|sof[aá]|settee|canap[eé]|3\s*plazas?/i },
];

/** The six seating templates the configurator ships with. */
export const SOFA_QUICK_STARTS: QuickStartSpec[] = [
  { id: 'armchair', label: 'Sillón', slots: ['fireside'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
  { id: 'love', label: 'Loveseat', slots: ['loveseat'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
  { id: 'sofa3', label: 'Sofá 3 plazas', slots: ['fireside', 'sofa', 'fireside'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
  { id: 'lshape', label: 'Sofá en L', slots: ['fireside', 'sofa', 'corner', 'sofa'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
  { id: 'ushape', label: 'Sofá en U', slots: ['corner', 'sofa', 'corner', 'sofa'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
  { id: 'lounge', label: 'Set lounge', slots: ['lounge', 'sofa', 'corner'], roles: SOFA_ROLES, fallbackRole: 'sofa' },
];

/** Classify one catalogue name against a spec's role table. */
export function roleOf(name: unknown, roles: QuickStartRole[], fallbackRole?: string): string | null {
  for (const { role, match } of roles) if (match.test(String(name ?? ''))) return role;
  return fallbackRole ?? null;
}

/**
 * Specs resolvable against `catalog` → `[{ id, label, pieceIds }]`. The first
 * model of each role wins; a spec whose every slot resolves is offered, the rest
 * are hidden.
 */
export function resolveQuickStarts(
  specs: QuickStartSpec[] | null | undefined,
  catalog: QuickStartCatalogItem[] | null | undefined,
): QuickStart[] {
  const items = (catalog || []).filter((m) => m?.id);
  const out: QuickStart[] = [];
  for (const spec of specs || []) {
    if (!spec) continue;
    const byRole = new Map<string, string | number>();
    for (const m of items) {
      const r = roleOf(m.name, spec.roles || [], spec.fallbackRole);
      if (!r) continue;
      if (!byRole.has(r)) byRole.set(r, m.id as string | number);   // first model of each role wins
    }
    const pieceIds = (spec.slots || []).map((r) => byRole.get(r));
    if (pieceIds.length && pieceIds.every((v) => v !== undefined)) {
      out.push({ id: spec.id, label: spec.label, pieceIds: pieceIds as (string | number)[] });
    }
  }
  return out;
}
