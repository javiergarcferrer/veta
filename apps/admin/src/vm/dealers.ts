/**
 * DEALERS — the network editor's decisions, as pure functions.
 *
 * A dealer row is small and its fields are boring; what is NOT boring is that
 * two of them are money levers (`pricing.mode`, `pricing.multiplier`) and one
 * is an identity the widget embeds (`slug`). So:
 *
 *   • THE FORM VALIDATES, THE STORE SANITIZES. A typo'd multiplier is an ERROR
 *     the author sees, and the value that would be written is ALSO passed
 *     through `safeMultiplier` — so no path exists on which a junk lever
 *     reaches a price. Same for the mode (`validPricingMode`). The engine's own
 *     rules are reused, never restated: a second copy of "what is a valid
 *     multiplier" is how the admin and the widget start disagreeing.
 *   • A SLUG IS AN ADDRESS. It is embedded in widget snippets and quoted in
 *     `?dealer=` links, so it is lower-case, hyphenated, unique within the
 *     brand, and — once a dealer exists — CHANGING it is a rename that breaks
 *     live embeds, which the caller is told about rather than prevented from.
 */
import { safeMultiplier, validPricingMode } from '@veta/catalog';
import type {
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminTerritory,
  DealerStatus,
  PricingMode,
} from './types.ts';

/* --------------------------------- drafts ---------------------------------- */

/** The form's state: strings, because that is what an input holds. Converting
 *  once, at validation, is what keeps "0.5" and 0.5 from both being possible. */
export interface DealerDraft {
  id: string;
  name: string;
  slug: string;
  status: DealerStatus;
  locale: string;
  currency: string;
  pricingMode: PricingMode;
  multiplier: string;
  contactEmail: string;
  contactPhone: string;
}

export interface LocationDraft {
  id: string;
  dealerId: string;
  name: string;
  lat: string;
  lng: string;
  territoryKind: 'none' | 'radiusKm' | 'polygon';
  radiusKm: string;
  polygon: string;
  addressLine: string;
  city: string;
  country: string;
  hours: string;
  routingPriority: string;
}

export const DEALER_STATUSES: readonly DealerStatus[] = ['active', 'inactive'];
export const PRICING_MODES: readonly PricingMode[] = ['full', 'from', 'hidden'];

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A slug from a name: lower-case, ASCII-ish, hyphen-joined. Accents fold
 *  (`Peña` → `pena`) because a slug rides in URLs and embed snippets. */
export function slugify(raw: string): string {
  return trim(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function emptyDealerDraft(id: string): DealerDraft {
  return {
    id,
    name: '',
    slug: '',
    status: 'active',
    locale: 'es',
    currency: 'USD',
    pricingMode: 'full',
    multiplier: '1',
    contactEmail: '',
    contactPhone: '',
  };
}

export function dealerDraftOf(dealer: AdminDealer): DealerDraft {
  return {
    id: dealer.id,
    name: dealer.name,
    slug: dealer.slug,
    status: dealer.status,
    locale: dealer.locale,
    currency: dealer.currency,
    pricingMode: validPricingMode(dealer.pricing?.mode),
    multiplier: String(dealer.pricing?.multiplier ?? 1),
    contactEmail: dealer.contact?.email ?? '',
    contactPhone: dealer.contact?.phone ?? '',
  };
}

export function emptyLocationDraft(id: string, dealerId: string): LocationDraft {
  return {
    id,
    dealerId,
    name: '',
    lat: '',
    lng: '',
    territoryKind: 'none',
    radiusKm: '',
    polygon: '',
    addressLine: '',
    city: '',
    country: '',
    hours: '',
    routingPriority: '0',
  };
}

export function locationDraftOf(location: AdminLocation): LocationDraft {
  const territory = location.territory;
  return {
    id: location.id,
    dealerId: location.dealerId,
    name: location.name,
    lat: location.lat === null ? '' : String(location.lat),
    lng: location.lng === null ? '' : String(location.lng),
    territoryKind: territory?.kind ?? 'none',
    radiusKm: territory?.kind === 'radiusKm' ? String(territory.radiusKm) : '',
    polygon: territory?.kind === 'polygon'
      ? territory.polygon.map((p) => `${p.lat},${p.lng}`).join('\n')
      : '',
    addressLine: String(location.address?.line1 ?? ''),
    city: String(location.address?.city ?? ''),
    country: String(location.address?.country ?? ''),
    hours: String(location.hours?.text ?? ''),
    routingPriority: String(location.routingPriority ?? 0),
  };
}

/* ------------------------------- validation -------------------------------- */

export interface Validation<T> {
  ok: boolean;
  /** Field → message. Empty when ok. */
  errors: Record<string, string>;
  /** Non-blocking: the author should know, but the save proceeds. */
  warnings: string[];
  value: T | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a dealer draft against the rest of the network. `existing` is every
 * OTHER dealer (the caller passes the full list; the draft's own id is skipped
 * here, so an edit never collides with itself).
 */
export function validateDealer(
  draft: DealerDraft,
  existing: readonly AdminDealer[] = [],
  { now = Date.now() }: { now?: number } = {},
): Validation<AdminDealer> {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  const name = trim(draft.name);
  if (!name) errors.name = 'A dealer needs a name.';

  const slug = trim(draft.slug).toLowerCase();
  if (!slug) errors.slug = 'A dealer needs a slug — it is what a widget embeds.';
  else if (!SLUG_RE.test(slug)) errors.slug = 'Lower-case letters, digits and hyphens only.';
  else if (existing.some((d) => d.id !== draft.id && d.slug === slug)) {
    errors.slug = 'Another dealer already uses that slug.';
  }

  const previous = existing.find((d) => d.id === draft.id);
  if (previous && previous.slug !== slug && !errors.slug) {
    // Not blocked: renaming is legitimate. But every embed and every
    // `?dealer=` link out there names the OLD slug, so it is said out loud.
    warnings.push(`Renaming the slug breaks existing embeds pointing at “${previous.slug}”.`);
  }

  const raw = trim(draft.multiplier);
  const multiplierNum = Number(raw);
  if (!raw) errors.multiplier = 'A multiplier is required (1 = the brand’s own price).';
  else if (!Number.isFinite(multiplierNum) || multiplierNum <= 0) {
    errors.multiplier = 'A multiplier must be a positive number.';
  } else if (multiplierNum > 5) {
    warnings.push(`×${multiplierNum} is a very large markup — check the decimal point.`);
  }

  const currency = trim(draft.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'A three-letter ISO currency (USD, DOP, EUR).';

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, warnings, value: null };

  return {
    ok,
    errors,
    warnings,
    value: {
      id: draft.id,
      slug,
      name,
      status: DEALER_STATUSES.includes(draft.status) ? draft.status : 'active',
      locale: trim(draft.locale) || 'es',
      currency,
      pricing: {
        // Belt AND braces: the form refused a junk value above, and the engine's
        // own rules decide what is written even so.
        mode: validPricingMode(draft.pricingMode),
        multiplier: safeMultiplier(multiplierNum),
      },
      contact: {
        ...(trim(draft.contactEmail) ? { email: trim(draft.contactEmail) } : {}),
        ...(trim(draft.contactPhone) ? { phone: trim(draft.contactPhone) } : {}),
      },
      updatedAt: now,
    },
  };
}

/**
 * `"18.47,-69.9"` per line → a ring. Junk lines are reported BY LINE NUMBER,
 * never guessed at — which is why the split is on a single newline: collapsing
 * blank lines would renumber the author's text and point at the wrong row.
 */
export function parsePolygonText(raw: string): { points: { lat: number; lng: number }[]; bad: number[] } {
  const points: { lat: number; lng: number }[] = [];
  const bad: number[] = [];
  const lines = String(raw ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const [latRaw, lngRaw] = text.split(/[,\s]+/);
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      bad.push(index + 1);
      return;
    }
    points.push({ lat, lng });
  });
  return { points, bad };
}

export function validateLocation(
  draft: LocationDraft,
  { now = Date.now() }: { now?: number } = {},
): Validation<AdminLocation> {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  const name = trim(draft.name);
  if (!name) errors.name = 'A location needs a name (“Showroom Naco”).';

  const latRaw = trim(draft.lat);
  const lngRaw = trim(draft.lng);
  let lat: number | null = null;
  let lng: number | null = null;
  if (latRaw || lngRaw) {
    // Half a coordinate is not a place. Accepting one would put the pin on the
    // equator or the prime meridian — a plausible, wrong answer.
    if (!latRaw || !lngRaw) errors.lat = 'Give both a latitude and a longitude, or neither.';
    else {
      lat = Number(latRaw);
      lng = Number(lngRaw);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) errors.lat = 'Latitude runs −90…90.';
      if (!Number.isFinite(lng) || Math.abs(lng) > 180) errors.lng = 'Longitude runs −180…180.';
    }
  }

  let territory: AdminTerritory | null = null;
  if (draft.territoryKind === 'radiusKm') {
    const km = Number(trim(draft.radiusKm));
    if (!Number.isFinite(km) || km <= 0) errors.radiusKm = 'A radius is a positive number of kilometres.';
    else if (lat === null || lng === null) errors.radiusKm = 'A radius territory needs the location’s coordinates.';
    else territory = { kind: 'radiusKm', radiusKm: km };
  } else if (draft.territoryKind === 'polygon') {
    const { points, bad } = parsePolygonText(draft.polygon);
    if (bad.length) errors.polygon = `Unreadable coordinates on line ${bad.join(', ')} (“lat, lng” per line).`;
    else if (points.length < 3) errors.polygon = 'A territory needs at least three points.';
    else territory = { kind: 'polygon', polygon: points };
  }

  const priority = Number(trim(draft.routingPriority) || '0');
  if (!Number.isInteger(priority)) errors.routingPriority = 'Priority is a whole number (higher wins a tie).';

  if (!territory && lat === null) {
    warnings.push('Without coordinates or a territory this location never wins a routing decision.');
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, warnings, value: null };

  return {
    ok,
    errors,
    warnings,
    value: {
      id: draft.id,
      dealerId: draft.dealerId,
      name,
      lat,
      lng,
      territory,
      address: {
        ...(trim(draft.addressLine) ? { line1: trim(draft.addressLine) } : {}),
        ...(trim(draft.city) ? { city: trim(draft.city) } : {}),
        ...(trim(draft.country) ? { country: trim(draft.country) } : {}),
      },
      hours: trim(draft.hours) ? { text: trim(draft.hours) } : {},
      routingPriority: priority,
      updatedAt: now,
    },
  };
}

/* ------------------------------- the list view ----------------------------- */

export interface DealerRow {
  dealer: AdminDealer;
  locations: number;
  /** How many of this dealer's locations can actually win a routing decision. */
  routable: number;
  leads: number;
  openLeads: number;
  pricingLabel: string;
}

export interface DealerListFilter {
  search?: string;
  status?: DealerStatus | 'all';
}

export function pricingLabel(dealer: AdminDealer): string {
  const mode = validPricingMode(dealer.pricing?.mode);
  const multiplier = safeMultiplier(dealer.pricing?.multiplier);
  const markup = multiplier === 1 ? 'list price' : `×${multiplier}`;
  if (mode === 'hidden') return `no prices · ${markup}`;
  if (mode === 'from') return `“from” prices · ${markup}`;
  return `full prices · ${markup}`;
}

/**
 * The dealers board. Counts come from the SAME rows the other panels render,
 * so a dealer's lead count and its lead list can never disagree.
 */
export function resolveDealerList(
  dealers: readonly AdminDealer[],
  locations: readonly AdminLocation[],
  leads: readonly AdminLead[],
  filter: DealerListFilter = {},
): { rows: DealerRow[]; total: number; unrouted: number } {
  const search = trim(filter.search).toLowerCase();
  const wanted = filter.status && filter.status !== 'all' ? filter.status : null;

  const byDealer = new Map<string, { locations: number; routable: number }>();
  for (const location of locations) {
    const bucket = byDealer.get(location.dealerId) ?? { locations: 0, routable: 0 };
    bucket.locations += 1;
    if (location.lat !== null && location.lng !== null) bucket.routable += 1;
    else if (location.territory?.kind === 'polygon') bucket.routable += 1;
    byDealer.set(location.dealerId, bucket);
  }

  const leadCounts = new Map<string, { total: number; open: number }>();
  let unrouted = 0;
  for (const lead of leads) {
    if (!lead.dealerId) { unrouted += 1; continue; }
    const bucket = leadCounts.get(lead.dealerId) ?? { total: 0, open: 0 };
    bucket.total += 1;
    if (lead.status === 'pending') bucket.open += 1;
    leadCounts.set(lead.dealerId, bucket);
  }

  const rows = dealers
    .filter((d) => (wanted ? d.status === wanted : true))
    .filter((d) => (search ? `${d.name} ${d.slug}`.toLowerCase().includes(search) : true))
    .map((dealer) => {
      const counts = byDealer.get(dealer.id) ?? { locations: 0, routable: 0 };
      const leadCount = leadCounts.get(dealer.id) ?? { total: 0, open: 0 };
      return {
        dealer,
        locations: counts.locations,
        routable: counts.routable,
        leads: leadCount.total,
        openLeads: leadCount.open,
        pricingLabel: pricingLabel(dealer),
      };
    })
    .sort((a, b) => a.dealer.name.localeCompare(b.dealer.name));

  return { rows, total: dealers.length, unrouted };
}

/** One dealer's locations, in the order routing itself walks them. */
export function locationsOf(
  locations: readonly AdminLocation[],
  dealerId: string,
): AdminLocation[] {
  return locations
    .filter((l) => l.dealerId === dealerId)
    .sort((a, b) => b.routingPriority - a.routingPriority || a.name.localeCompare(b.name));
}
