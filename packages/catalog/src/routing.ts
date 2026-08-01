/**
 * LEAD ROUTING — which dealer owns a lead, decided as a PURE function.
 *
 * A brand's dealer network is the one place where "the app decided" is not good
 * enough: a lead handed to the wrong showroom is a lost sale nobody can audit
 * afterwards. So routing here is a CASCADE OF NAMED POLICIES over data, it is
 * deterministic, it never throws, and it always reports WHY — a routed lead
 * carries the policy that placed it, an unrouted one carries the reason it fell
 * through. `null` with a reason is a legitimate outcome (a human assigns it);
 * a plausible-looking guess is not.
 *
 * The four policies (the closed vocabulary):
 *   • `territory` — the lead's position falls inside a location's authored
 *     territory (a polygon, or a radius around the location).
 *   • `nearest`   — great-circle distance to the closest location, optionally
 *     capped by `maxDistanceKm`.
 *   • `round-robin` — deterministic spread: `hash(lead key) % eligible`. NEVER a
 *     mutable counter — a counter makes the same lead route differently on a
 *     retry, and two API instances disagree about whose turn it is.
 *   • `manual`    — stop and hand it to a brand admin. An explicit, recorded
 *     non-decision, which is why it is a policy and not the absence of one.
 *
 * Rules carried over from the reference's own hard-won ones:
 *   • JUNK COSTS THE RULE, NEVER THE LEAD — a malformed territory, a NaN
 *     latitude, a garbage config: each is dropped and the cascade carries on.
 *     Routing must not be able to reject a lead.
 *   • OUT OF RANGE FALLS BACK, NEVER SATURATES — a junk `maxDistanceKm` reverts
 *     to "uncapped", it is not clamped to something the author "meant".
 *   • DETERMINISM IS A FEATURE — every tie is broken by a stable key, so the
 *     same inputs route the same way on every instance, forever.
 *
 * Geometry note: distances are haversine, which is antimeridian-safe BY
 * CONSTRUCTION (it reads `sin²(Δλ/2)`, periodic in Δλ), and polygon containment
 * unwraps the ring's longitudes around the probe point, so a territory drawn
 * across the 180th meridian tests correctly instead of inside-out.
 */

/* --------------------------------- shapes --------------------------------- */

/** A position on the globe. Anything non-finite or out of range is not one. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export const ROUTING_POLICIES = ['territory', 'nearest', 'round-robin', 'manual'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

/** A cascade stage, as it appears in a decision: the four policies, plus the
 *  pre-cascade honouring of a dealer the lead itself named. */
export type RoutingStage = RoutingPolicy | 'pinned';

/**
 * Why a stage did or did not decide. `routed` is the only success; every other
 * value names a specific fall-through, so an unrouted lead is explainable
 * without re-running anything.
 */
export type RoutingOutcome =
  | 'routed'
  | 'no-dealers'        // nothing eligible at all (no active dealer)
  | 'no-geo'            // the lead carries no usable position
  | 'no-location'       // eligible dealers, none with usable coordinates
  | 'no-territory'      // no authored territory contains the lead
  | 'out-of-range'      // the nearest location is beyond maxDistanceKm
  | 'no-key'            // round-robin without a stable key to hash
  | 'manual'            // handed to a human, on purpose
  | 'unroutable';       // the cascade itself is empty

/** A dealer as routing reads it. Presentation (pricing, contact) is none of
 *  routing's business and is deliberately absent from the shape. */
export interface RoutableDealer {
  id: string;
  slug?: string | null;
  status?: string | null;
  brandId?: string | null;
}

/** A territory, PARSED: an authored ring, or a circle around the location
 *  itself. (The stored ring may be `[lng,lat]` pairs — `parsePolygon` is what
 *  normalizes those, so nothing downstream ever meets two shapes.) */
export type Territory =
  | { kind: 'polygon'; polygon: readonly GeoPoint[] }
  | { kind: 'radiusKm'; radiusKm: number };

/** One showroom / delivery point. `routingPriority` breaks ties — higher first. */
export interface RoutableLocation {
  id: string;
  dealerId: string;
  name?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  territory?: unknown;
  routingPriority?: number | null;
}

/** The lead, as routing reads it. Everything is optional: a lead with nothing
 *  but a name is still a lead, it just routes to `manual`. */
export interface RoutableLead {
  /** The stable key round-robin hashes. The windowed dedupe key, by design. */
  dedupeKey?: string | null;
  id?: string | null;
  geo?: Partial<GeoPoint> | null;
  postalCode?: string | null;
  /** A dealer the lead itself names (a widget embedded on that dealer's site). */
  dealerSlug?: string | null;
}

/**
 * The per-brand policy config (stored jsonb). Absent/junk fields fall back to
 * the defaults — a brand that has never opened the routing screen still routes.
 */
export interface RoutingConfig {
  /** Ordered. First stage that decides, wins. */
  cascade: RoutingPolicy[];
  /** `nearest`'s hard limit; null = uncapped. */
  maxDistanceKm: number | null;
  /** Postal code → centroid, for leads that give a code but no coordinates. */
  postalCentroids: Record<string, GeoPoint>;
  /** Honour `lead.dealerSlug` before the cascade runs. */
  honorPinnedDealer: boolean;
}

/** One stage of the cascade, and what it did. */
export interface RoutingStep {
  stage: RoutingStage;
  outcome: RoutingOutcome;
  dealerId: string | null;
  /** For `nearest`: how far the winner (or the rejected nearest) was. */
  distanceKm?: number | null;
}

/** The answer. `dealerId === null` is a valid answer WITH a reason. */
export interface RoutingDecision {
  dealerId: string | null;
  dealerSlug: string | null;
  locationId: string | null;
  /** The stage that decided; null when nothing did. */
  stage: RoutingStage | null;
  outcome: RoutingOutcome;
  /** `stage:outcome` — one string a human or a filter can read. */
  reason: string;
  distanceKm: number | null;
  /** Every stage tried, in order. The audit trail, small enough to store. */
  trace: RoutingStep[];
}

/**
 * Conservative by design: a lead with no position and no pin is NOT sprayed at
 * a dealer, it waits for a human. Round-robin is opt-in — spreading leads
 * evenly is a policy a brand chooses, never a default the platform assumes.
 */
export const DEFAULT_ROUTING_CASCADE: RoutingPolicy[] = ['territory', 'nearest', 'manual'];

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  cascade: DEFAULT_ROUTING_CASCADE,
  maxDistanceKm: null,
  postalCentroids: {},
  honorPinnedDealer: true,
};

/* -------------------------------- geometry -------------------------------- */

export const EARTH_RADIUS_KM = 6371.0088;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** A usable position, or null. Out-of-range coordinates are junk, not a place. */
export function geoOf(raw: unknown): GeoPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const lat = num(o.lat ?? o.latitude);
  const lng = num(o.lng ?? o.lon ?? o.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Longitude difference folded into (-180, 180] — the antimeridian, handled
 *  once, here, instead of in every caller that subtracts two longitudes. */
export function lngDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Great-circle distance in km. Antimeridian-safe by construction: the Δλ term
 * only ever appears as `sin²(Δλ/2)`, which is unchanged by a 360° wrap — so
 * (0.0, 179.9) → (0.0, -179.9) is ~22 km, not ~40 000.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(lngDelta(a.lng, b.lng));
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * s2 * s2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A ring of at least three points, from either shape a store might hold
 *  (`{lat,lng}` objects or `[lng,lat]` pairs — GeoJSON's order). */
export function parsePolygon(raw: unknown): GeoPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const ring: GeoPoint[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      // GeoJSON positions are [lng, lat] — the reversal that bites everyone.
      const point = geoOf({ lng: entry[0], lat: entry[1] });
      if (point) ring.push(point);
      continue;
    }
    const point = geoOf(entry);
    if (point) ring.push(point);
  }
  return ring.length >= 3 ? ring : null;
}

/** A stored territory, defensively read. Junk is NO territory, never a throw. */
export function parseTerritory(raw: unknown): Territory | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? o.type ?? '').trim();
  if (kind === 'radiusKm' || kind === 'radius') {
    const km = num(o.radiusKm ?? o.radius);
    return Number.isFinite(km) && km > 0 ? { kind: 'radiusKm', radiusKm: km } : null;
  }
  if (kind === 'polygon' || Array.isArray(o.polygon)) {
    const ring = parsePolygon(o.polygon ?? o.coordinates ?? o.points);
    return ring ? { kind: 'polygon', polygon: ring } : null;
  }
  return null;
}

const EDGE_EPS = 1e-12;

/**
 * Point-in-polygon, ray-cast, with two deliberate properties:
 *
 *   • ON THE BOUNDARY IS INSIDE. A dealer whose territory edge runs down a
 *     street must own the addresses on it; "inside" flipping with floating-point
 *     noise is the worst possible answer. Vertices and edges test true.
 *   • ANTIMERIDIAN-SAFE. The RING is unwrapped along itself (each vertex within
 *     ±180° of the previous one) into a continuous longitude space, and the
 *     probe is then placed in that same space next to the ring's centre. A
 *     territory drawn across ±180 therefore stays a 4°-wide box instead of
 *     inverting into a 356°-wide band around the rest of the world — which is
 *     exactly what unwrapping around the PROBE would produce.
 */
export function pointInPolygon(point: GeoPoint, ring: ReadonlyArray<GeoPoint>): boolean {
  if (!ring || ring.length < 3) return false;
  const ys = ring.map((p) => p.lat);
  const xs: number[] = [ring[0]!.lng];
  for (let i = 1; i < ring.length; i++) {
    xs.push(xs[i - 1]! + lngDelta(ring[i - 1]!.lng, ring[i]!.lng));
  }
  const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
  const px = centre + lngDelta(centre, point.lng);
  const py = point.lat;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = xs[i]!;
    const yi = ys[i]!;
    const xj = xs[j]!;
    const yj = ys[j]!;

    // On the segment? Then the answer is yes, before any crossing arithmetic.
    const cross = (xj - xi) * (py - yi) - (yj - yi) * (px - xi);
    if (Math.abs(cross) <= EDGE_EPS
      && px >= Math.min(xi, xj) - EDGE_EPS && px <= Math.max(xi, xj) + EDGE_EPS
      && py >= Math.min(yi, yj) - EDGE_EPS && py <= Math.max(yi, yj) + EDGE_EPS) {
      return true;
    }

    // Half-open rule on the y span: a ray through a vertex crosses ONCE.
    if ((yi > py) !== (yj > py)) {
      const x = xi + ((py - yi) * (xj - xi)) / (yj - yi);
      if (x > px) inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------- the config ------------------------------- */

const POLICY_SET = new Set<string>(ROUTING_POLICIES);

/**
 * Read a stored routing config. Every field is optional and every junk value
 * falls back — a brand's config row is authored in an admin screen, and a typo
 * there must not stop leads from routing.
 */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const cascade: RoutingPolicy[] = [];
  const rawCascade = Array.isArray(o.cascade) ? o.cascade : Array.isArray(o.policies) ? o.policies : null;
  if (rawCascade) {
    for (const entry of rawCascade) {
      const name = String(entry ?? '').trim();
      // A repeated stage would be evaluated twice with the same inputs and the
      // same answer — noise in the trace, never a different decision.
      if (POLICY_SET.has(name) && !cascade.includes(name as RoutingPolicy)) cascade.push(name as RoutingPolicy);
    }
  }

  const maxRaw = num(o.maxDistanceKm ?? o.max_distance_km);
  const maxDistanceKm = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;

  const postalCentroids: Record<string, GeoPoint> = {};
  const centroids = o.postalCentroids ?? o.postal_centroids;
  if (centroids && typeof centroids === 'object' && !Array.isArray(centroids)) {
    for (const [code, value] of Object.entries(centroids as Record<string, unknown>)) {
      const key = postalKey(code);
      const point = geoOf(value);
      if (key && point) postalCentroids[key] = point;
    }
  }

  return {
    cascade: cascade.length ? cascade : [...DEFAULT_ROUTING_CASCADE],
    maxDistanceKm,
    postalCentroids,
    honorPinnedDealer: o.honorPinnedDealer === undefined ? true : o.honorPinnedDealer !== false,
  };
}

/** Postal codes are compared case- and separator-insensitively ("A1B 2C3"). */
export function postalKey(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

/* ------------------------------ the hash ---------------------------------- */

/**
 * FNV-1a, 32-bit. Chosen because it is tiny, stable across runtimes, and
 * specified — a `hashCode` improvised per language is how "the same lead" ends
 * up at two different dealers on two different servers.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------ the cascade ------------------------------- */

interface Candidate {
  dealer: RoutableDealer;
  location: RoutableLocation;
  geo: GeoPoint | null;
  priority: number;
}

const isActive = (d: RoutableDealer): boolean => {
  const status = String(d.status ?? 'active').trim().toLowerCase();
  return status === '' || status === 'active';
};

/** Deterministic ordering for everything the cascade iterates. */
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function eligibleDealers(
  dealers: readonly RoutableDealer[] | null | undefined,
  brandId?: string | null,
): RoutableDealer[] {
  const rows = (dealers ?? []).filter((d) => d && typeof d.id === 'string' && d.id && isActive(d));
  const scoped = brandId ? rows.filter((d) => !d.brandId || d.brandId === brandId) : rows;
  return [...scoped].sort(byId);
}

function candidatesFor(
  dealers: readonly RoutableDealer[],
  locations: readonly RoutableLocation[] | null | undefined,
): Candidate[] {
  const byDealer = new Map(dealers.map((d) => [d.id, d]));
  const out: Candidate[] = [];
  for (const loc of locations ?? []) {
    if (!loc || typeof loc.id !== 'string' || !loc.id) continue;
    const dealer = byDealer.get(loc.dealerId);
    if (!dealer) continue;
    const priority = Number(loc.routingPriority);
    out.push({
      dealer,
      location: loc,
      geo: geoOf({ lat: loc.lat, lng: loc.lng }),
      priority: Number.isFinite(priority) ? priority : 0,
    });
  }
  // Priority first (higher wins), then id — so a tie is broken the same way on
  // every instance and in every policy below.
  return out.sort((a, b) => b.priority - a.priority || byId(a.location, b.location));
}

/** The lead's position: its own coordinates, else its postal code's centroid. */
export function leadGeo(lead: RoutableLead | null | undefined, config: RoutingConfig): GeoPoint | null {
  const own = geoOf(lead?.geo);
  if (own) return own;
  const key = postalKey(lead?.postalCode);
  return key ? config.postalCentroids[key] ?? null : null;
}

/** The stable key round-robin hashes. No key ⇒ no deterministic spread. */
export function routingKeyOf(lead: RoutableLead | null | undefined): string | null {
  const key = String(lead?.dedupeKey ?? lead?.id ?? '').trim();
  return key || null;
}

function decisionOf(
  trace: RoutingStep[],
  hit: { stage: RoutingStage; candidate?: Candidate; dealer?: RoutableDealer; distanceKm?: number | null } | null,
): RoutingDecision {
  if (hit) {
    const dealer = hit.candidate?.dealer ?? hit.dealer!;
    return {
      dealerId: dealer.id,
      dealerSlug: dealer.slug ?? null,
      locationId: hit.candidate?.location.id ?? null,
      stage: hit.stage,
      outcome: 'routed',
      reason: `${hit.stage}:routed`,
      distanceKm: hit.distanceKm ?? null,
      trace,
    };
  }
  const last = trace[trace.length - 1];
  const stage = last?.stage ?? null;
  const outcome = last?.outcome ?? 'unroutable';
  return {
    dealerId: null,
    dealerSlug: null,
    locationId: null,
    stage: null,
    outcome,
    reason: stage ? `${stage}:${outcome}` : 'unroutable',
    distanceKm: last?.distanceKm ?? null,
    trace,
  };
}

/**
 * ROUTE ONE LEAD. Pure, total, deterministic.
 *
 * The cascade runs in the brand's configured order; the first stage that names
 * a dealer wins and the rest are not evaluated. `manual` always terminates —
 * it is the brand saying "past here, a human decides", so a stage after it
 * would be dead config, and silently running it would override that intent.
 */
export function routeLead(
  lead: RoutableLead | null | undefined,
  dealers: readonly RoutableDealer[] | null | undefined,
  locations: readonly RoutableLocation[] | null | undefined,
  policy?: RoutingConfig | unknown,
): RoutingDecision {
  const config = parseRoutingConfig(policy);
  const trace: RoutingStep[] = [];
  const active = eligibleDealers(dealers);
  const candidates = candidatesFor(active, locations);
  const geo = leadGeo(lead, config);

  // ── pre-cascade: a dealer the lead itself named ──────────────────────────
  // Not a guess — the visitor was on that dealer's site. An unresolvable pin
  // (typo, retired dealer) falls THROUGH to the cascade rather than dropping
  // the lead, and the trace says which happened.
  const pinned = String(lead?.dealerSlug ?? '').trim();
  if (config.honorPinnedDealer && pinned) {
    const dealer = active.find((d) => (d.slug ?? '') === pinned) ?? null;
    trace.push({ stage: 'pinned', outcome: dealer ? 'routed' : 'no-dealers', dealerId: dealer?.id ?? null });
    if (dealer) {
      const home = candidates.find((c) => c.dealer.id === dealer.id) ?? null;
      return decisionOf(trace, {
        stage: 'pinned',
        dealer,
        candidate: home ?? undefined,
        distanceKm: home?.geo && geo ? haversineKm(geo, home.geo) : null,
      });
    }
  }

  for (const stage of config.cascade) {
    if (stage === 'manual') {
      trace.push({ stage, outcome: 'manual', dealerId: null });
      break;   // a human owns it from here
    }

    if (!active.length) {
      trace.push({ stage, outcome: 'no-dealers', dealerId: null });
      continue;
    }

    if (stage === 'round-robin') {
      const key = routingKeyOf(lead);
      if (!key) {
        trace.push({ stage, outcome: 'no-key', dealerId: null });
        continue;
      }
      // Over the SORTED eligible list: the answer must not depend on the order
      // the rows came back from the database.
      const dealer = active[hash32(key) % active.length]!;
      trace.push({ stage, outcome: 'routed', dealerId: dealer.id });
      return decisionOf(trace, { stage, dealer });
    }

    // territory and nearest both need a position.
    if (!geo) {
      trace.push({ stage, outcome: 'no-geo', dealerId: null });
      continue;
    }
    const placed = candidates.filter((c) => c.geo || (stage === 'territory' && parseTerritory(c.location.territory)?.kind === 'polygon'));
    if (!placed.length) {
      trace.push({ stage, outcome: 'no-location', dealerId: null });
      continue;
    }

    if (stage === 'territory') {
      // Every territory that CONTAINS the lead, then one winner: highest
      // routingPriority, and among equals the nearest centre — so overlapping
      // territories resolve to the same dealer every single time.
      const hits: { candidate: Candidate; distanceKm: number | null }[] = [];
      for (const candidate of placed) {
        const territory = parseTerritory(candidate.location.territory);
        if (!territory) continue;
        const distanceKm = candidate.geo ? haversineKm(geo, candidate.geo) : null;
        const contains = territory.kind === 'polygon'
          ? pointInPolygon(geo, territory.polygon)
          : distanceKm !== null && distanceKm <= territory.radiusKm;
        if (contains) hits.push({ candidate, distanceKm });
      }
      // `placed` is already priority-desc/id-asc, so a stable sort on distance
      // within equal priority preserves that as the final tie-break.
      hits.sort((a, b) => {
        if (a.candidate.priority !== b.candidate.priority) return b.candidate.priority - a.candidate.priority;
        if (a.distanceKm === null || b.distanceKm === null) return 0;
        return a.distanceKm - b.distanceKm;
      });
      const best = hits[0] ?? null;
      if (best) {
        trace.push({ stage, outcome: 'routed', dealerId: best.candidate.dealer.id, distanceKm: best.distanceKm });
        return decisionOf(trace, { stage, candidate: best.candidate, distanceKm: best.distanceKm });
      }
      trace.push({ stage, outcome: 'no-territory', dealerId: null });
      continue;
    }

    // nearest
    let best: { candidate: Candidate; distanceKm: number } | null = null;
    for (const candidate of placed) {
      if (!candidate.geo) continue;
      const distanceKm = haversineKm(geo, candidate.geo);
      // Strict `<`: the sort already put the higher priority (then lower id)
      // first, so an exact tie keeps the earlier one.
      if (!best || distanceKm < best.distanceKm) best = { candidate, distanceKm };
    }
    if (!best) {
      trace.push({ stage, outcome: 'no-location', dealerId: null });
      continue;
    }
    if (config.maxDistanceKm !== null && best.distanceKm > config.maxDistanceKm) {
      // Reported, not silently accepted: "the closest dealer is 800 km away" is
      // information a brand admin needs, and assigning it anyway is the guess.
      trace.push({ stage, outcome: 'out-of-range', dealerId: null, distanceKm: best.distanceKm });
      continue;
    }
    trace.push({ stage, outcome: 'routed', dealerId: best.candidate.dealer.id, distanceKm: best.distanceKm });
    return decisionOf(trace, { stage, candidate: best.candidate, distanceKm: best.distanceKm });
  }

  return decisionOf(trace, null);
}

/**
 * The compact stamp stored on the lead (`leads.source.routing`). Small on
 * purpose — the trace is the audit, the stamp is what a list view reads.
 */
export interface RoutingStamp {
  policy: RoutingStage | null;
  outcome: RoutingOutcome;
  reason: string;
  distanceKm: number | null;
  at: string;
}

export function routingStamp(decision: RoutingDecision, at: Date | number = Date.now()): RoutingStamp {
  const when = at instanceof Date ? at : new Date(at);
  return {
    policy: decision.stage,
    outcome: decision.outcome,
    reason: decision.reason,
    distanceKm: decision.distanceKm === null ? null : Math.round(decision.distanceKm * 100) / 100,
    at: Number.isNaN(when.getTime()) ? new Date(0).toISOString() : when.toISOString(),
  };
}
