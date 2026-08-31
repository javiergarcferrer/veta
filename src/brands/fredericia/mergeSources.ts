/**
 * JUNTAR LAS DOS FUENTES — el fabricante dice qué existe, el distribuidor
 * cuánto cuesta aquí.
 *
 * Fredericia publishes the product: named axes, real SKUs, swatches, 44
 * photographs, dimensions, the designer. Anthom Design House publishes the
 * shop: one USD price per reference, which is the one thing the manufacturer's
 * page does NOT say in a unit we can quote (it prices in DKK and EUR plus nine
 * internal groups, one labelled `USD` carrying 26,152 — not dollars for a chair
 * Anthom sells at $7,315).
 *
 * Neither source is redundant and neither is preferred wholesale. This module
 * decides, field by field, which one is authoritative — and refuses to join at
 * all when it cannot be sure.
 *
 * ── EL PROBLEMA: ESCRIBEN DISTINTO LO MISMO ─────────────────────────────────
 *
 *   FABRICANTE                       ANTHOM
 *   Oak oil, FSC Mix 70%             Oak Oiled
 *   Oak light oil, FSC Mix 70%       Oak Light Oiled
 *   Smoked oak, olied, FSC Mix 70%   Oak Smoked Oiled      ← «olied», su errata
 *   Leather, natural                 Natural Saddle
 *   Leather, dark brown              Dark Brown Saddle
 *
 * A plain fold matches none of them. So each value is reduced to its CORE
 * TOKENS — the words that actually distinguish it from its siblings — by
 * dropping what both sides say about every option in the axis: the
 * certification (`FSC Mix 70%`), the substance noun (`leather`, `saddle`), and
 * the tense of a treatment (`oiled` → `oil`).
 *
 * What survives is the choice itself: `{oak, oil}` vs `{oak, light, oil}` vs
 * `{smoked, oak, oil}`, `{natural}` vs `{dark, brown}`.
 *
 * ── Y LO QUE HACE CUANDO NO ESTÁ SEGURO ─────────────────────────────────────
 * A candidate wins only if it is the UNIQUE best and shares at least one core
 * token. A tie, a zero-overlap or an empty core is REPORTED, never resolved by
 * taking the first: joining the wrong wood puts a $10,000 walnut price on a
 * $7,315 oak chair, and that is a wrong quote nobody would catch by reading it.
 *
 * Pure: no React, no db, no network.
 */

/**
 * Words that appear on EVERY option of an axis and therefore distinguish
 * nothing. Dropping them is what lets the two spellings meet.
 *
 * `saddle` and `leather` are the substance — Fredericia leads with it
 * ("Leather, natural"), Anthom trails with it ("Natural Saddle"), and neither
 * is telling you which hide. `fsc`/`mix`/`70` is a certification on every
 * Fredericia oak. `olied` is a typo in the manufacturer's own data and is
 * folded to `oil` for the same reason `oiled` is: it is the same treatment.
 */
const NOISE = new Set([
  'fsc', 'mix', 'certified', 'certificate', '70', '100',
  'leather', 'saddle', 'piel', 'cuero', 'fabric', 'tela',
  'wood', 'madera', 'colour', 'color', 'finish', 'acabado',
]);

/** Treatments whose tense differs between the two houses. */
const STEM: Readonly<Record<string, string>> = {
  oiled: 'oil', olied: 'oil', oils: 'oil',
  soaped: 'soap', soaps: 'soap',
  lacquered: 'lacquer', lacquers: 'lacquer',
  painted: 'paint', stained: 'stain',
  smoke: 'smoked',
};

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * A published option value → the tokens that actually name the choice.
 *
 * Returns an empty set when everything in the value was noise, and the caller
 * must treat that as "cannot join" rather than as "matches anything".
 */
export function coreTokens(value: unknown): Set<string> {
  const folded = str(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const out = new Set<string>();
  for (const raw of folded ? folded.split(' ') : []) {
    const word = STEM[raw] || raw;
    if (!word || NOISE.has(word)) continue;
    out.add(word);
  }
  return out;
}

/** How well two cores agree: shared tokens, minus what each side left over. */
function score(a: Set<string>, b: Set<string>): { shared: number; spare: number } {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return { shared, spare: (a.size - shared) + (b.size - shared) };
}

export interface AxisMatch {
  /** The manufacturer's own wording, which is what gets written. */
  value: string;
  shared: number;
  spare: number;
}

/**
 * One distributor value → the manufacturer option it names, or null.
 *
 * THE UNIQUE BEST OR NOTHING. Most shared tokens wins; a tie on shared is
 * broken by the fewest leftovers (so `Oak Oiled` takes `Oak oil, FSC Mix 70%`
 * over `Oak light oil, FSC Mix 70%`); a tie on both is no answer at all.
 */
export function matchAxisValue(
  theirs: unknown,
  options: readonly string[] | null | undefined,
): AxisMatch | null {
  const mine = coreTokens(theirs);
  if (!mine.size) return null;

  let best: AxisMatch | null = null;
  let tied = false;
  for (const option of options || []) {
    const core = coreTokens(option);
    if (!core.size) continue;
    const { shared, spare } = score(mine, core);
    if (!shared) continue;
    if (!best || shared > best.shared || (shared === best.shared && spare < best.spare)) {
      best = { value: str(option), shared, spare };
      tied = false;
    } else if (shared === best.shared && spare === best.spare) {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}

/** The manufacturer's variant, narrowed to what the merge reads. */
export interface MfVariant {
  sku: string;
  properties: Record<string, string>;
  /** This configuration's own packshots — the chair somebody is buying. */
  images?: string[];
}

/** What the manufacturer publishes about one model. */
export interface MfProduct {
  code: string;
  name: string;
  category: string | null;
  designer: string | null;
  collection: string | null;
  shipping: string | null;
  dimensions: Record<string, unknown> | null;
  axes: Array<{ name: string; options: Array<{ label: string }> }>;
  variants: MfVariant[];
  images: Array<{ url: string; kind?: string }>;
}

/** A row the Anthom importer already wrote. */
export interface DistributorRow {
  /** The `products` primary key. REQUIRED, and the reason is money: the write
   *  is an upsert on `id`, so a patch without one would INSERT a new row — a
   *  Spanish Chair with a name, a photo and no price at all. Only rows that
   *  already exist can be enriched, and only their own id proves it. */
  id: string;
  reference: string;
  name?: string;
  familyCode?: string;
  priceUsd?: number | null;
  /** The configuration tokens, as the distributor spelled them. */
  configuration?: string[];
}

export interface MergedRow {
  /** Carried through untouched: this row is a PATCH of an existing product. */
  id: string;
  reference: string;
  /** The MANUFACTURER's wording, because it is what parses into named axes. */
  name: string;
  family: string;
  familyCode: string;
  category: string;
  subtype: string;
  dimensions: string;
  /** The manufacturer's own SKU, for the order that eventually leaves. */
  supplierSku: string;
  imageSrc: string;
  imageSrcs: string[] | null;
}

/** `82,5 × 60 × 67 cm · asiento 33` — the line the catalogue had blank, because
 *  a reseller's storefront does not publish a single dimension. */
export function dimensionLine(d: Record<string, unknown> | null | undefined): string {
  if (!d) return '';
  const n = (v: unknown) => str(v).replace(',', '.');
  const box = [n(d.width), n(d.depth), n(d.height)].filter(Boolean);
  const parts: string[] = [];
  if (box.length === 3) parts.push(`${box.join(' × ')} cm`);
  if (n(d.seatHeight)) parts.push(`asiento ${n(d.seatHeight)} cm`);
  return parts.join(' · ');
}

export interface MergePlan {
  rows: MergedRow[];
  /** Distributor references the manufacturer's page could not claim, each with
   *  the axis that failed. Reported, never guessed. */
  unmatched: Array<{ reference: string; why: string }>;
  summary: { matched: number; unmatched: number; axes: number; variants: number };
}

/**
 * One model's manufacturer page + the distributor rows that belong to it →
 * what the merge would write.
 *
 * READ BEFORE WRITE, like every importer here: nothing is saved, the caller
 * shows the plan and only then presses.
 *
 * PRICE IS NOT IN THE OUTPUT and that is deliberate: this enriches rows the
 * distributor importer already priced. A merge that also carried a price would
 * be a second opinion about money, and the whole reason the sources are split
 * is that only one of them has one.
 */
export function planFredericiaMerge(
  product: MfProduct | null | undefined,
  rows: readonly DistributorRow[] | null | undefined,
): MergePlan {
  const out: MergedRow[] = [];
  const unmatched: Array<{ reference: string; why: string }> = [];
  if (!product?.code) {
    return { rows: [], unmatched: [], summary: { matched: 0, unmatched: 0, axes: 0, variants: 0 } };
  }

  const axes = product.axes || [];
  const gallery = (product.images || []).map((i) => i.url).filter(Boolean);
  const dims = dimensionLine(product.dimensions);
  const subtype = [product.designer, product.collection, product.shipping].filter(Boolean).join(' · ');

  for (const row of rows || []) {
    const reference = str(row?.reference);
    const id = str(row?.id);
    // No id, no patch — see DistributorRow. A row we cannot address is one we
    // would CREATE, and creating a priceless product is the failure this whole
    // two-source split exists to avoid.
    if (!reference || !id) continue;
    const theirs = (row.configuration || []).map(str).filter(Boolean);
    if (!theirs.length) { unmatched.push({ reference, why: 'la fila no trae configuración' }); continue; }

    // Each distributor token claims at most ONE axis, and each axis is claimed
    // at most once: two tokens landing on the same axis means the pairing is
    // not understood, and half a configuration is worse than none.
    const chosen: Record<string, string> = {};
    let failed = '';
    for (const token of theirs) {
      let bestAxis = '';
      let bestHit: AxisMatch | null = null;
      for (const axis of axes) {
        if (chosen[axis.name]) continue;
        const hit = matchAxisValue(token, axis.options.map((o) => o.label));
        if (!hit) continue;
        if (!bestHit || hit.shared > bestHit.shared || (hit.shared === bestHit.shared && hit.spare < bestHit.spare)) {
          bestHit = hit; bestAxis = axis.name;
        }
      }
      if (!bestHit) { failed = token; break; }
      chosen[bestAxis] = bestHit.value;
    }
    if (failed) { unmatched.push({ reference, why: `«${failed}» no coincide con ninguna opción` }); continue; }
    if (Object.keys(chosen).length !== axes.length) {
      unmatched.push({ reference, why: `sólo ${Object.keys(chosen).length} de ${axes.length} ejes` });
      continue;
    }

    // The manufacturer's variant for exactly that configuration.
    const variant = (product.variants || []).find(
      (v) => axes.every((a) => str(v.properties?.[a.name]) === chosen[a.name]),
    );
    // Deduped: a variant packshot can also appear in the model gallery, and one
    // photograph twice in a lightbox is a bug the dealer sees.
    const photos = [...new Set([...(variant?.images || []).filter(Boolean), ...gallery])];

    out.push({
      id,
      reference,
      name: `${product.name} · ${axes.map((a) => chosen[a.name]).join(' · ')}`,
      family: product.name,
      familyCode: product.code,
      category: str(product.category),
      subtype,
      dimensions: dims,
      supplierSku: str(variant?.sku),
      // EVERY PHOTOGRAPH, AND THIS CONFIGURATION'S FIRST.
      //
      // The manufacturer shoots each variant separately — 4 to 8 packshots
      // named for exactly this wood and this hide
      // (`bm_2226_smokedoak_black_v1`) — and those are what a catalogue row
      // should lead with: the chair somebody is actually buying, not the
      // model's default photograph. The model's own gallery follows (packshots
      // already ahead of the room shots, sorted at the source), so a row still
      // has 44 pictures when the manufacturer publishes no variant of its own.
      imageSrc: photos[0] || '',
      imageSrcs: photos.length ? photos : null,
    });
  }

  return {
    rows: out,
    unmatched,
    summary: {
      matched: out.length,
      unmatched: unmatched.length,
      axes: axes.length,
      variants: (product.variants || []).length,
    },
  };
}

/**
 * The model code a distributor row belongs to, or ''.
 *
 * `FRE-2226-NLT-OO` → 2226. It is `familyCode` on the row when the importer
 * decoded one, and the SKU's own second segment when it did not — the two
 * agree, and reading both means an older row still joins.
 */
export function modelCodeOf(row: DistributorRow | null | undefined): string {
  const stamped = str(row?.familyCode);
  if (/^\d{3,6}$/.test(stamped)) return stamped;
  const m = /^FRE-(\d{3,6})-/i.exec(str(row?.reference));
  return m ? m[1] : '';
}

/** Distributor rows, bucketed by the model code they belong to. */
export function rowsByModelCode(
  rows: readonly DistributorRow[] | null | undefined,
): Map<string, DistributorRow[]> {
  const out = new Map<string, DistributorRow[]>();
  for (const row of rows || []) {
    const code = modelCodeOf(row);
    if (!code) continue;
    if (!out.has(code)) out.set(code, []);
    out.get(code)!.push(row);
  }
  return out;
}
