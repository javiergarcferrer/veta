/**
 * ROUTING CONFIG — the brand's cascade, edited.
 *
 * The engine that ROUTES is `@veta/catalog`'s `routeLead`, and this screen must
 * never own a second opinion about it. So the editor:
 *
 *   • reads and writes the SAME document the API parses (`parseRoutingConfig`),
 *   • previews with the SAME function the API calls (`routeLead`), against the
 *     brand's real dealers and locations — a preview computed any other way is
 *     a demo, not a preview;
 *   • and refuses to save something that would silently do nothing: a cascade
 *     with every stage switched off falls back to the DEFAULT on read, so the
 *     editor appends `manual` instead. "Nothing happens automatically" is a
 *     legitimate policy; it just has to be SAID, not implied by an empty list.
 *
 * The stage order is the whole product here — the list is ordered, and the
 * first stage that decides wins — so moving a row up or down is a first-class
 * operation, not a sort.
 */
import {
  DEFAULT_ROUTING_CASCADE,
  ROUTING_POLICIES,
  parseRoutingConfig,
  routeLead,
} from '@veta/catalog';
import type {
  RoutableLead,
  RoutingConfig,
  RoutingDecision,
  RoutingPolicy,
} from '@veta/catalog';
import type { AdminDealer, AdminLocation } from './types.ts';

export type { RoutingConfig, RoutingDecision, RoutingPolicy };
export { ROUTING_POLICIES };

/** One row of the cascade editor. Order matters; `enabled` is the checkbox. */
export interface RoutingStageDraft {
  policy: RoutingPolicy;
  enabled: boolean;
}

export interface RoutingDraft {
  /** Every policy, in the brand's order — enabled ones first, as configured. */
  stages: RoutingStageDraft[];
  maxDistanceKm: string;
  honorPinnedDealer: boolean;
  /** `"10101 18.47,-69.9"`-style lines: `code lat,lng`. */
  postalCentroids: string;
}

/** What each stage means, in the words the screen shows. */
export const POLICY_LABELS: Record<RoutingPolicy, string> = {
  territory: 'Territory — the lead falls inside a location’s authored area',
  nearest: 'Nearest — the closest showroom to the lead’s position',
  'round-robin': 'Round-robin — spread evenly, deterministically, by lead key',
  manual: 'Manual — stop here; a brand admin assigns the lead',
};

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function routingDraftOf(raw: unknown): RoutingDraft {
  const config = parseRoutingConfig(raw);
  const enabled = config.cascade;
  const rest = ROUTING_POLICIES.filter((p) => !enabled.includes(p));
  return {
    stages: [
      ...enabled.map((policy) => ({ policy, enabled: true })),
      ...rest.map((policy) => ({ policy, enabled: false })),
    ],
    maxDistanceKm: config.maxDistanceKm === null ? '' : String(config.maxDistanceKm),
    honorPinnedDealer: config.honorPinnedDealer,
    postalCentroids: Object.entries(config.postalCentroids)
      .map(([code, point]) => `${code} ${point.lat},${point.lng}`)
      .join('\n'),
  };
}

export function defaultRoutingDraft(): RoutingDraft {
  return routingDraftOf({ cascade: [...DEFAULT_ROUTING_CASCADE] });
}

/* -------------------------------- editing ---------------------------------- */

export function toggleStage(draft: RoutingDraft, policy: RoutingPolicy): RoutingDraft {
  return {
    ...draft,
    stages: draft.stages.map((s) => (s.policy === policy ? { ...s, enabled: !s.enabled } : s)),
  };
}

/**
 * Move a stage one place. Out-of-range is a NO-OP that returns the same draft —
 * a reorder at the top of the list must not silently wrap to the bottom.
 */
export function moveStage(draft: RoutingDraft, policy: RoutingPolicy, delta: number): RoutingDraft {
  const index = draft.stages.findIndex((s) => s.policy === policy);
  const target = index + (delta < 0 ? -1 : 1);
  if (index < 0 || delta === 0 || target < 0 || target >= draft.stages.length) return draft;
  const stages = [...draft.stages];
  const [moved] = stages.splice(index, 1);
  stages.splice(target, 0, moved!);
  return { ...draft, stages };
}

export function setMaxDistance(draft: RoutingDraft, value: string): RoutingDraft {
  return { ...draft, maxDistanceKm: value };
}

export function setHonorPinned(draft: RoutingDraft, value: boolean): RoutingDraft {
  return { ...draft, honorPinnedDealer: value };
}

/* ------------------------------- validation -------------------------------- */

export interface RoutingValidation {
  ok: boolean;
  errors: Record<string, string>;
  warnings: string[];
  value: RoutingConfig | null;
}

/** `code lat,lng` per line → the centroid table. Junk lines are named. */
export function parseCentroidText(raw: string): {
  centroids: Record<string, { lat: number; lng: number }>;
  bad: number[];
} {
  const centroids: Record<string, { lat: number; lng: number }> = {};
  const bad: number[] = [];
  // A single newline, never `\n+`: collapsing blanks renumbers the author's
  // text and makes "line 3 is unreadable" point at the wrong line.
  String(raw ?? '').split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const match = /^(\S+)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/.exec(text);
    const lat = Number(match?.[2]);
    const lng = Number(match?.[3]);
    if (!match || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      bad.push(index + 1);
      return;
    }
    centroids[match[1]!.toUpperCase().replace(/[\s-]+/g, '')] = { lat, lng };
  });
  return { centroids, bad };
}

export function validateRoutingDraft(draft: RoutingDraft): RoutingValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  const cascade = draft.stages.filter((s) => s.enabled).map((s) => s.policy);

  const maxRaw = trim(draft.maxDistanceKm);
  let maxDistanceKm: number | null = null;
  if (maxRaw) {
    const km = Number(maxRaw);
    if (!Number.isFinite(km) || km <= 0) errors.maxDistanceKm = 'A cap is a positive number of kilometres.';
    else maxDistanceKm = km;
  }

  const { centroids, bad } = parseCentroidText(draft.postalCentroids);
  if (bad.length) errors.postalCentroids = `Unreadable on line ${bad.join(', ')} (“code lat,lng”).`;

  if (!cascade.length) {
    // An empty cascade READS as the default (junk falls back), so saving one
    // would quietly re-enable territory+nearest. Say what you mean instead.
    warnings.push('No stage is enabled — routing will be saved as “manual only”.');
  }
  if (maxDistanceKm !== null && !cascade.includes('nearest')) {
    warnings.push('The distance cap only applies to the “nearest” stage, which is off.');
  }
  if (cascade.includes('round-robin') && cascade.indexOf('round-robin') < cascade.length - 1) {
    warnings.push('Round-robin always decides, so every stage after it is unreachable.');
  }
  const manualAt = cascade.indexOf('manual');
  if (manualAt >= 0 && manualAt < cascade.length - 1) {
    warnings.push('“Manual” ends the cascade — the stages after it never run.');
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, warnings, value: null };

  return {
    ok,
    errors,
    warnings,
    value: {
      cascade: cascade.length ? cascade : ['manual'],
      maxDistanceKm,
      postalCentroids: centroids,
      honorPinnedDealer: draft.honorPinnedDealer,
    },
  };
}

/* --------------------------------- preview --------------------------------- */

/** A dealer/location, as the routing engine reads them. The admin's rows and
 *  the API's rows describe the same network; only the spellings differ. */
export function routableFrom(dealers: readonly AdminDealer[], locations: readonly AdminLocation[]) {
  return {
    dealers: dealers.map((d) => ({ id: d.id, slug: d.slug, status: d.status })),
    locations: locations.map((l) => ({
      id: l.id,
      dealerId: l.dealerId,
      name: l.name,
      lat: l.lat,
      lng: l.lng,
      territory: l.territory,
      routingPriority: l.routingPriority,
    })),
  };
}

export interface RoutingPreviewRow {
  lead: RoutableLead;
  label: string;
  decision: RoutingDecision;
  dealerName: string | null;
}

/**
 * Run sample leads through the DRAFT config against the real network. The
 * preview is the same call the API makes — that is the point of it. An invalid
 * draft previews against nothing rather than against a half-parsed config.
 */
export function previewRouting(
  samples: ReadonlyArray<{ label: string; lead: RoutableLead }>,
  dealers: readonly AdminDealer[],
  locations: readonly AdminLocation[],
  draft: RoutingDraft,
): RoutingPreviewRow[] {
  const validation = validateRoutingDraft(draft);
  if (!validation.value) return [];
  const network = routableFrom(dealers, locations);
  const nameById = new Map(dealers.map((d) => [d.id, d.name]));
  return samples.map(({ label, lead }) => {
    const decision = routeLead(lead, network.dealers, network.locations, validation.value!);
    return {
      label,
      lead,
      decision,
      dealerName: decision.dealerId ? nameById.get(decision.dealerId) ?? null : null,
    };
  });
}
