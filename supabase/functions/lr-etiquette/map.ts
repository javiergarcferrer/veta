/**
 * SERVER TWIN of src/lib/lrEtiquette.ts — the Ligne Roset «Étiquette» feed
 * mapper, for the Deno side of the wall.
 *
 * `src/*` and `supabase/functions/*` never import each other, so this rule set
 * exists twice on purpose. The two copies are kept honest by
 * tests/lrEtiquetteParity.test.js, which runs one corpus through both and
 * asserts identical rows and stats.
 *
 * If you change a rule here, change it there too. A red parity test means
 * re-route, never relax.
 */

/**
 * Ligne Roset «Étiquette» dealer feed → catalog rows. PURE (no fetch, no db),
 * so the whole mapping is unit-testable and runs identically on both sides of
 * the Deno↔Vite wall — the server twin is
 * `supabase/functions/lr-etiquette/map.ts`, pinned by tests/lrEtiquetteParity.
 *
 * WHAT THE FEED IS. Ligne Roset ships its dealers the "Logiciel Étiquette" (the
 * label software, once a CD, now hosted) and inside it sits the official US
 * catalog as `;`-delimited CSV: `Article.csv` (one row per article), `Tarif.csv`
 * (one row per article × price column), `Coloris.csv` (one row per fabric ×
 * colour) and `Modele.csv` (one row per model). It is the SAME data the printed
 * price list is set from, which is why it settles questions the dealer's own
 * CSV export and the website scrape only approximate.
 *
 * THE PRICE COLUMN IS THE GRADE. `Tarif.COLONNE` is `'0'` for a flat-priced
 * article (tables, lighting, accessories) and otherwise a letter that IS the
 * upholstery grade. Dropping the rows Roset left blank leaves exactly
 * `0`, A–R, S and U–X — T, Y and Z fall away on their own, which is precisely
 * the ladder `GRADE_GROUPS` already describes ("T, Y, and Z are intentionally
 * absent"). So the feed independently confirms the taxonomy this app derived by
 * hand, and `splitSkuGrade` reads every SKU minted here without a change.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *
 *  1. **A blank MONTANT mints nothing.** 2,395 of the feed's 36,693 price rows
 *     carry no amount — a column Roset prints but does not sell. Coercing that
 *     to 0 would put a free sofa in the quote builder, so a blank price yields
 *     NO SKU at all (lens 6: bad input → null, never a plausible wrong number).
 *
 *  2. **The feed carries no cost.** There is no wholesale/divisor column
 *     anywhere in it — only retail. Margin, commission and the landed-cost
 *     engine all read `products.cost`, which today comes from the dealer's own
 *     price-list export. So `cost` is DELIBERATELY ABSENT from every row this
 *     module builds: a PostgREST upsert only writes the columns present in the
 *     payload, so omitting it preserves whatever cost the row already carries.
 *     Adding `cost: 0` here would silently zero the dealer's margin on 6,000
 *     products. Pinned in tests/lrEtiquette.test.js.
 */
// Inlined across the Deno↔Vite wall. These are the ONLY lines that differ from
// src/lib/lrEtiquette.ts; every rule below is byte-identical, and
// tests/lrEtiquetteParity.test.js runs the same corpus through both to keep it
// that way. Mirrors GRADE_GROUPS in src/lib/subtype.ts (Telas A–R, Microfibra
// S, Pieles U–X — T, Y and Z intentionally absent) and BRAND_LIGNE_ROSET in
// src/lib/constants.ts.
const ALPHA_GRADES: readonly string[] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
  'S',
  'U', 'V', 'W', 'X',
];
const BRAND_LIGNE_ROSET = 'ligne-roset';

const GRADE_SET: ReadonlySet<string> = new Set(ALPHA_GRADES);

/** Collapse whitespace runs; the feed pads some model names. */
const squish = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ parsing */

/**
 * `;`-delimited CSV → rows of cells. Handles a leading BOM and CRLF/LF alike.
 *
 * TOLERANT BY NECESSITY — the feed is not RFC-4180. Roset writes imperial
 * dimensions inside prose with a bare inch mark and does NOT double it:
 *
 *     "…in its lowest position the overall height is 24" and the seat height…"
 *
 * 711 of Article.csv's lines carry one. A strict parser reads that `"` as the
 * end of the field, the following text as garbage, and then swallows every
 * subsequent line into the next quoted field — which silently collapsed 6,176
 * articles into 3,120 and lost the Togo Fireside Chair entirely.
 *
 * The rule that fixes it: inside a quoted field a `"` only CLOSES the field
 * when the next character is a delimiter, a line break, or end of input.
 * Doubled `""` is still an escape; anything else is a literal inch mark. That
 * is unambiguous here because every field in this feed is quoted, so a closing
 * quote is always followed by `;` or a newline.
 *
 * Deliberately separate from `priceListCsv.parseCsv` (comma-delimited, strict):
 * one concept, one name — two different formats from two different sources, and
 * merging them behind a `delimiter` flag would let a fix for one reshape the
 * other. This parser's tolerance is WRONG for that file, where a bare quote
 * really does mean end-of-field.
 */
export function parseEtiquetteCsv(text: string): string[][] {
  const s = String(text ?? '');
  const src = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Start of the current unbroken run of ordinary characters. The loop only
  // touches `field` at a character that MEANS something; everything between two
  // such characters is copied in one slice. Appending per character instead
  // costs ~2.3× on Article.csv, and the catalog phase pays that toll on every
  // invocation — with 2,000 ms of CPU to spend, it is not small change.
  let run = 0;

  const SEMI = 59, QUOTE = 34, CR = 13, LF = 10;

  /** A quote at `i` ends the field only if a delimiter/EOL/EOF follows it. */
  const closesField = (i: number): boolean => {
    const next = src.charCodeAt(i + 1);
    return Number.isNaN(next) || next === SEMI || next === LF || next === CR;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (inQuotes) {
      // Inside quotes only a quote decides anything; every other character —
      // newlines and carriage returns included — belongs to the field verbatim
      // and is picked up by the next slice.
      if (c !== QUOTE) continue;
      field += src.slice(run, i);
      // `""` is an ESCAPED QUOTE — unless a DELIMITER follows the pair, in which
      // case it is a trailing inch mark plus the field's own closing quote.
      // Roset writes `WIDTH 47 1/4" - 51 1/4"";` and 292 of Article.csv's 6,176
      // rows do it. Read as an escape, that swallows the `;` and shifts EVERY
      // remaining column of the line left by one: the finish lands in the
      // dimensions, the volume in the package count.
      //
      // ONLY the delimiter, deliberately. `""` before a NEWLINE is genuinely
      // ambiguous — inch mark then end of record, or escaped quote then an
      // embedded line break inside the field — and the feed settles it by never
      // doing it: of its 88,455 doubled quotes, 88,449 are followed by `;` and
      // the other six by an ordinary letter. Not one is followed by a newline.
      // So the newline reading stays exactly as it was rather than being
      // changed on a case that does not exist.
      if (src.charCodeAt(i + 1) === QUOTE && src.charCodeAt(i + 2) !== SEMI) { field += '"'; i++; run = i + 1; }
      else if (closesField(i)) { inQuotes = false; run = i + 1; }
      else { field += '"'; run = i + 1; } // a bare inch mark inside prose
      continue;
    }
    if (c === QUOTE) { field += src.slice(run, i); inQuotes = true; run = i + 1; continue; }
    if (c === SEMI) { row.push(field + src.slice(run, i)); field = ''; run = i + 1; continue; }
    if (c === CR) { field += src.slice(run, i); run = i + 1; continue; }
    if (c === LF) { row.push(field + src.slice(run, i)); rows.push(row); row = []; field = ''; run = i + 1; continue; }
  }
  const tail = field + src.slice(run);
  if (tail.length > 0 || row.length > 0) { row.push(tail); rows.push(row); }
  return rows;
}

/**
 * Rows → objects keyed by the header line. The feed's trailing `;` yields an
 * empty final column, which is dropped. Header names are upper-cased so a
 * casing change upstream can't silently blank a column.
 */
export function toRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toUpperCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    // A blank trailing line (the file ends in a newline) parses as one empty
    // cell — not a record.
    if (r.length === 1 && r[0].trim() === '') continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      rec[header[c]] = (r[c] ?? '').trim();
    }
    out.push(rec);
  }
  return out;
}

/** Parse a feed CSV straight to records. */
export const readEtiquetteCsv = (text: string): Record<string, string>[] =>
  toRecords(parseEtiquetteCsv(text));

/* ------------------------------------------------------------- field shaping */

/**
 * `MONTANT` → a positive number, or `null` when Roset left the cell blank.
 * `null` is the whole point: see rule 1 in the module header.
 */
export function priceOf(montant: string | null | undefined): number | null {
  const raw = String(montant ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A positive decimal measure (VOLUME), or `null`. Roset writes an unknown
 * volume as an empty cell or a literal `0`; neither means "this article takes
 * no space", so both read as null rather than as a number a container plan
 * would silently trust.
 */
export function measureOf(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A positive whole count (NBCOLIS), or `null` on a blank/zero cell. */
export function countOf(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The six LIBDIM/VALDIM pairs → one readable string, e.g. `DIAM. 17¾ · H 21¾`.
 *
 * The feed writes unused slots as an empty label with the literal value `"0"`,
 * so a pair counts only when BOTH sides say something. Order is the feed's own
 * (Roset lists the dimension a buyer reads first, first) — re-sorting them
 * would put "H" before "W" on some models and after it on others.
 */
export function buildDimensions(rec: Record<string, string>): string {
  const parts: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const label = squish(rec[`LIBDIM${i}`] || '');
    const value = squish(rec[`VALDIM${i}`] || '');
    if (!label || !value || value === '0') continue;
    parts.push(`${label} ${value}`);
  }
  return parts.join(' · ');
}

/** The article's display name — LIBPRIN, with LIBSEC/LIBTER as the finish. */
export function buildSubtype(rec: Record<string, string>): string {
  return [squish(rec.LIBSEC || ''), squish(rec.LIBTER || '')]
    .filter(Boolean)
    .join(' · ');
}

/* --------------------------------------------------- CODART ↔ IDART ownership */

export interface OwnershipConflict {
  codart: string;
  /** The IDART that won the SKU. */
  winner: string;
  /** The IDARTs that lost it, and are therefore not minted. */
  losers: string[];
}

/**
 * Decide which IDART owns a CODART.
 *
 * WHY THIS EXISTS: 517 of the feed's 5,422 CODARTs carry more than one IDART.
 * `15420000` is IDART 25401 "TOGO FIRESIDE CHAIR", priced A–X — and ALSO 32947
 * "TOGO TABLU / VERSION PANTHERE" and 32447 "VERSION ZEBRE", both entirely
 * blank-priced. Since a SKU here is `CODART + grade` under a UNIQUE
 * `(profile_id, reference)`, minting per-IDART would collide three rows onto
 * `15420000A` and the last writer would win at random.
 *
 * THE RULE: the IDART with the most PRICED rows owns the CODART; ties break to
 * the one whose prices are higher (compared on shared columns), then to the
 * lowest IDART so the outcome is deterministic on any input order. That is the
 * same shape as `dedupePriceList`'s rule — prefer the better-attested figure,
 * and when genuinely tied never adopt the CHEAPER one, because quoting a stale
 * low price costs real money while quoting a high one gets corrected in review.
 *
 * In practice the blank-priced siblings score 0 and lose outright; the tie-break
 * is there so a future reissue with two live variants still resolves the same
 * way twice.
 */
export function resolveOwnership(
  prices: Record<string, string>[],
): { owner: Map<string, string>; conflicts: OwnershipConflict[] } {
  // codart → idart → { count, total }
  const byCodart = new Map<string, Map<string, { count: number; total: number }>>();
  for (const p of prices) {
    const codart = String(p.CODART || '').trim();
    const idart = String(p.IDART || '').trim();
    if (!codart || !idart) continue;
    let inner = byCodart.get(codart);
    if (!inner) { inner = new Map(); byCodart.set(codart, inner); }
    let acc = inner.get(idart);
    if (!acc) { acc = { count: 0, total: 0 }; inner.set(idart, acc); }
    const amount = priceOf(p.MONTANT);
    if (amount != null) { acc.count++; acc.total += amount; }
  }

  const owner = new Map<string, string>();
  const conflicts: OwnershipConflict[] = [];
  for (const [codart, inner] of byCodart) {
    const ranked = [...inner.entries()].sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      if (b[1].total !== a[1].total) return b[1].total - a[1].total;
      return a[0].localeCompare(b[0], 'en');
    });
    const winner = ranked[0][0];
    owner.set(codart, winner);
    if (ranked.length > 1) {
      conflicts.push({ codart, winner, losers: ranked.slice(1).map((r) => r[0]) });
    }
  }
  return { owner, conflicts };
}

/* ------------------------------------------------------------ catalog planning */

/** A `products` row this module is willing to write. `cost` is absent BY DESIGN. */
export interface LrEtiquetteProduct {
  id: string;
  profileId: string;
  brand: string;
  reference: string;
  name: string;
  subtype: string;
  dimensions: string;
  family: string;
  familyCode: string;
  category: string;
  priceUsd: number;
  active: true;
  /** Roset's own English copy. NOT the dealer's `quote_lines.description`. */
  catalogDescription: string;
  /** The designer credited on the model, denormalised onto every SKU of it. */
  designer: string;
  /** Shipping volume in m³ — container fill maths. `null` when Roset omits it. */
  volumeM3: number | null;
  /** Package count (NBCOLIS). `null` when Roset omits it. */
  packages: number | null;
  /** PAYSORI verbatim — a Roset internal code, NOT a country. */
  originCode: string;
}

export interface CatalogPlanStats {
  /** Articles read from Article.csv. */
  articles: number;
  /** Distinct CODARTs the feed prices. */
  codarts: number;
  /** SKUs minted. */
  rows: number;
  /** Price rows skipped because Roset left the amount blank. */
  blankPrices: number;
  /** Price rows skipped because the column was not a known grade. */
  unknownGrades: number;
  /** Price rows whose CODART has no Article.csv row. */
  orphanPrices: number;
  /** CODARTs where more than one IDART competed for the SKU. */
  conflicts: number;
  /** Graded price rows skipped because the CODART is not 8 DIGITS (see below). */
  ungradableRoots: number;
}

export interface CatalogPlan {
  rows: LrEtiquetteProduct[];
  stats: CatalogPlanStats;
  conflicts: OwnershipConflict[];
  /**
   * CODARTs that price by grade but cannot carry a grade in this app's SKU
   * grammar — reported so the gap stays VISIBLE instead of silently missing.
   */
  ungradable: string[];
}

/**
 * Build every `products` row the feed supports.
 *
 * A flat-priced article (`COLONNE '0'`) mints ONE SKU under its bare 8-digit
 * CODART; a graded one mints one SKU per priced column, `CODART + letter`.
 * Both shapes are exactly what `splitSkuGrade` already reads, so nothing
 * downstream — family grouping, the fabric picker, `search_root` — needs to
 * learn a new grammar.
 *
 * Bounded by construction: the work is proportional to the price rows handed
 * in, and the caller chunks the write (lens 1).
 */
export function planCatalog(input: {
  articles: Record<string, string>[];
  prices: Record<string, string>[];
  models?: Record<string, string>[];
  profileId: string;
}): CatalogPlan {
  const { articles, prices, profileId } = input;
  const models = input.models || [];

  // IDMOD → programme label, the closest thing the feed has to our `category`.
  const programByModel = new Map<string, string>();
  const designerByModel = new Map<string, string>();
  const copyByModel = new Map<string, string>();
  for (const m of models) {
    const idmod = String(m.IDMOD || '').trim();
    if (!idmod) continue;
    if (!programByModel.has(idmod)) programByModel.set(idmod, squish(m.LIBPROG || ''));
    // 522 of 606 models name one; the rest are genuinely uncredited.
    if (!designerByModel.has(idmod)) designerByModel.set(idmod, squish(m.CREATEUR || ''));
    // Roset writes its copy at whichever level the thing is described AT, and
    // for upholstery that is the RANGE: 69% of flat-priced articles carry their
    // own REMARQUE, but only 9% of graded ones do — the Togo sofa's description
    // ("FRAME: 3 densities of polyether foam…") sits on the model, not on each
    // of its 23 grade SKUs. Read only from the model file; see the fallback.
    if (!copyByModel.has(idmod)) copyByModel.set(idmod, squish(m.REMARQUE || ''));
  }

  // (CODART|IDART) → article record.
  const articleByKey = new Map<string, Record<string, string>>();
  for (const a of articles) {
    const codart = String(a.CODART || '').trim();
    const idart = String(a.IDART || '').trim();
    if (codart && idart) articleByKey.set(`${codart}|${idart}`, a);
  }

  const { owner, conflicts } = resolveOwnership(prices);

  const stats: CatalogPlanStats = {
    articles: articles.length,
    codarts: owner.size,
    rows: 0,
    blankPrices: 0,
    unknownGrades: 0,
    orphanPrices: 0,
    conflicts: conflicts.length,
    ungradableRoots: 0,
  };
  const ungradable = new Set<string>();

  // reference → row. A CODART can repeat a column across IDARTs; only the
  // owning IDART writes, so the map never needs a conflict rule of its own.
  const byReference = new Map<string, LrEtiquetteProduct>();

  for (const p of prices) {
    const codart = String(p.CODART || '').trim();
    const idart = String(p.IDART || '').trim();
    if (!codart || !idart) continue;
    if (owner.get(codart) !== idart) continue;

    const amount = priceOf(p.MONTANT);
    if (amount == null) { stats.blankPrices++; continue; }

    const colonne = String(p.COLONNE || '').trim().toUpperCase();
    let reference: string;
    if (colonne === '0') {
      // Flat-priced. An 8-char CODART is the SKU as-is — including the
      // alphanumeric ones (`00003REM`), which `splitSkuGrade` already files as
      // their own single-member family. Nothing to decide.
      reference = codart;
    } else if (GRADE_SET.has(colonne)) {
      // Graded. The SKU is CODART+letter, and it must stay READABLE:
      // `splitSkuGrade` (and the `search_root` generated column that mirrors
      // it) only recognise a grade after EIGHT DIGITS. 27 CODARTs are
      // alphanumeric yet price by grade (`1000X01A` → `1000X01AA`), which both
      // sides would read as an ungraded standalone SKU. Minting them would put
      // 23 identically-named products at 23 different prices in the picker with
      // no working grade ladder — a plausible wrong answer, which is worse than
      // a visible gap. So: skip, count, and report the roots (lens 6/7).
      if (!/^\d{8}$/.test(codart)) {
        stats.ungradableRoots++;
        ungradable.add(codart);
        continue;
      }
      reference = `${codart}${colonne}`;
    } else {
      stats.unknownGrades++;
      continue;
    }

    const art = articleByKey.get(`${codart}|${idart}`);
    if (!art) { stats.orphanPrices++; continue; }

    const idmod = String(art.IDMOD || '').trim();
    byReference.set(reference, {
      id: reference,
      profileId,
      brand: BRAND_LIGNE_ROSET,
      reference,
      name: squish(art.LIBPRIN || ''),
      subtype: buildSubtype(art),
      dimensions: buildDimensions(art),
      family: squish(art.LIBMOD || ''),
      familyCode: idmod,
      category: programByModel.get(idmod) || '',
      priceUsd: amount,
      active: true,
      // The article's own words when it has them, the range's when it does not.
      // A FALLBACK, never an override: the article is the more specific claim,
      // and it wins wherever Roset bothered to make it. Together they take the
      // description from 15% of SKUs to 100%.
      catalogDescription: squish(art.REMARQUE || '') || copyByModel.get(idmod) || '',
      designer: designerByModel.get(idmod) || '',
      volumeM3: measureOf(art.VOLUME),
      packages: countOf(art.NBCOLIS),
      originCode: String(art.PAYSORI || '').trim(),
    });
  }

  // Sorted so a diff between two runs reads as changed prices, not reordering.
  const rows = [...byReference.values()].sort((a, b) => a.reference.localeCompare(b.reference, 'en'));
  stats.rows = rows.length;
  return {
    rows,
    stats,
    conflicts,
    ungradable: [...ungradable].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

/* ------------------------------------------------------------ fabric planning */

export interface LrEtiquetteFabric {
  /** Normalized fabric name — the key `materials.name` is matched on. */
  name: string;
  /** Roset's pattern code (CODPAT). */
  code: string;
  /** The grade letter this fabric prices at (Coloris.COLONNE). */
  grade: string;
  composition: string;
  notes: string;
  colors: Array<{ name: string; code: string }>;
}

/**
 * `Coloris.csv` → one entry per fabric, colours folded in.
 *
 * This is the half of the feed that answers a question the website scrape
 * answers badly: which GRADE a fabric prices at. The scrape infers it from the
 * product page it happened to be read on; here Roset states it outright, and it
 * lines up with the same letters `Tarif.COLONNE` uses — so a fabric's grade and
 * a model's price column are guaranteed to speak about the same thing.
 *
 * NOT a model↔fabric restriction. `Coloris` is catalog-wide: it says a fabric
 * exists in grade D, not that any given frame can be upholstered in it. That
 * restriction lives in `model_fabrics` and still comes from the product page —
 * the feed does not carry it, and pretending otherwise would widen every
 * model's picker to its whole grade.
 */
export function planFabrics(coloris: Record<string, string>[]): LrEtiquetteFabric[] {
  const byKey = new Map<string, LrEtiquetteFabric>();
  const seenColor = new Map<string, Set<string>>();

  for (const c of coloris) {
    const name = squish(c.LIBPAT || '');
    if (!name) continue;
    const grade = String(c.COLONNE || '').trim().toUpperCase();
    const key = `${name}|${grade}`;

    let fab = byKey.get(key);
    if (!fab) {
      fab = {
        name,
        code: String(c.CODPAT || '').trim(),
        grade,
        composition: squish(c.COMPOSITION || ''),
        notes: squish(c.REMARQUE || ''),
        colors: [],
      };
      byKey.set(key, fab);
      seenColor.set(key, new Set());
    }
    const colorName = squish(c.LIBCLR || '');
    const colorCode = String(c.CODCLR || '').trim();
    if (!colorName && !colorCode) continue;
    const dedupe = seenColor.get(key)!;
    const ck = colorKey(colorCode, colorName);
    if (!ck || dedupe.has(ck)) continue;
    dedupe.add(ck);
    fab.colors.push({ name: colorName, code: colorCode });
  }

  return [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en') || a.grade.localeCompare(b.grade, 'en'));
}

/**
 * The material CATEGORY a fabric's grade implies.
 *
 * Coloris.csv never says "fabric" or "leather" — but the grade ladder does, and
 * it is the same ladder `GRADE_GROUPS` publishes: Telas A–R, Microfibra S,
 * Pieles U–X. A pelle prices in the U–X band and nowhere else, so the grade is
 * a sound reading of the category rather than a guess. Anything outside the
 * known bands returns null — the caller then leaves the existing category
 * alone rather than reclassifying a material on a letter we do not recognise.
 */
export function fabricCategoryFor(grade: string | null | undefined): 'fabric' | 'leather' | null {
  const g = String(grade ?? '').trim().toUpperCase();
  if (!g) return null;
  if (g >= 'A' && g <= 'R') return 'fabric';
  if (g === 'S') return 'fabric';           // microfibra is still a cloth
  if (g === 'U' || g === 'V' || g === 'W' || g === 'X') return 'leather';
  return null;
}

/** The key a feed fabric is matched to an existing material by. */
export const materialKey = (name: string | null | undefined): string =>
  squish(String(name ?? '')).toUpperCase();

/**
 * The key ONE COLOUR is matched by — inside a fabric, and across a re-import.
 *
 * WHY IT IS NOT THE RAW CODE. Roset zero-pads 19 of the feed's 882 `CODCLR`
 * values (`ERPI` ARGILE is `0973`), and the book this dealer already held wrote
 * the same colour as `973`. Keyed on the literal string those are two colours,
 * so the first merge appended a second ARGILE beside the first and the material
 * grew a mirror-image twin of itself — six rows for three cloths. Normalising
 * the code costs nothing: across the whole file 770 distinct raw codes stay 770
 * distinct normalised ones, so no two of Roset's own colours collide under it.
 *
 * The colour NAME is the fallback, not part of the key. A colour with a code is
 * identified BY that code — Roset renames («BLEU» → «BLEU NUIT») without
 * reissuing it, and a rename must edit the row, never mint a second one.
 */
export const colorKey = (code: string | null | undefined, name?: string | null): string => {
  const c = String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    // Leading zeros only ever pad — but never eat the code down to nothing.
    .replace(/^0+(?=.)/, '');
  if (c) return c;
  return squish(String(name ?? '')).toUpperCase();
};

export interface MaterialRowPatch {
  id: string;
  profileId: string;
  brand: string;
  category: string;
  name: string;
  grade: string;
  composition?: string;
  notes?: string;
  colors: Array<{ name: string; code: string; imageId?: string | null }>;
}

export interface FabricMergeStats {
  /** Fabrics in the feed. */
  incoming: number;
  /** Rows written: new materials. */
  created: number;
  /** Rows written: existing materials gaining a field or a colour. */
  updated: number;
  /** Existing rows the feed matched but had nothing to add to. */
  unchanged: number;
  /** Colours added across all updated rows. */
  colorsAdded: number;
  /** Duplicate colours COLLAPSED across all updated rows — the same cloth
   *  stored twice under two spellings of one code. Reported, never silent. */
  colorsDeduped: number;
}

/**
 * Merge the feed's fabric roster into the materials the dealer already holds.
 *
 * STRICTLY ADDITIVE, and that is the whole design. `materials` is shared: the
 * ligne-roset.com sweep writes here, the dealer edits here, swatch images hang
 * off colours here, and Kvadrat/Carl Hansen/COM materials live here too. So
 * this merge:
 *   • touches only rows whose `brand` is the Ligne Roset book,
 *   • fills a field only when the existing one is EMPTY — a dealer's correction
 *     outranks the feed, because they were looking at the swatch and we weren't,
 *   • adds colours it has never seen and NEVER removes one (a colour carries a
 *     `swatchImageId`; dropping it would orphan an uploaded swatch), and
 *   • never flags anything discontinued. Coloris is a complete read of the
 *     book, but it is not the only writer here, so absence still is not proof.
 *
 * Ids are deterministic (`lrf-<CODPAT>`, Roset's own pattern code) so re-running
 * the merge updates the same rows instead of minting duplicates.
 */
export function planFabricMerge(input: {
  fabrics: LrEtiquetteFabric[];
  existing: Array<Record<string, unknown>>;
  profileId: string;
}): { upserts: MaterialRowPatch[]; stats: FabricMergeStats } {
  const { fabrics, existing, profileId } = input;
  const byKey = new Map<string, Record<string, unknown>>();
  for (const m of existing) {
    const brand = String(m.brand ?? '');
    if (brand && brand !== BRAND_LIGNE_ROSET) continue; // another house's book
    const k = materialKey(m.name as string);
    if (k && !byKey.has(k)) byKey.set(k, m);
  }

  const upserts: MaterialRowPatch[] = [];
  const stats: FabricMergeStats = { incoming: fabrics.length, created: 0, updated: 0, unchanged: 0, colorsAdded: 0, colorsDeduped: 0 };

  for (const f of fabrics) {
    const key = materialKey(f.name);
    if (!key) continue;
    const category = fabricCategoryFor(f.grade);
    const prior = byKey.get(key);

    if (!prior) {
      upserts.push({
        id: `lrf-${f.code || key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        profileId,
        brand: BRAND_LIGNE_ROSET,
        category: category || 'fabric',
        name: f.name,
        grade: f.grade,
        composition: f.composition,
        notes: f.notes,
        colors: f.colors.map((c) => ({ name: c.name, code: c.code })),
      });
      stats.created++;
      continue;
    }

    // Union the colours, keyed by NORMALISED code (see colorKey), keeping every
    // existing entry intact — a stored colour may carry a swatchImageId the
    // feed knows nothing about, and dropping it would orphan the upload.
    //
    // The first pass collapses what is already there. An earlier merge keyed on
    // the literal code, so a padded feed colour landed beside its unpadded twin;
    // healing it HERE means the nightly run repairs those rows on its own,
    // instead of the dealer being handed a list of materials to fix by hand.
    const priorColors = Array.isArray(prior.colors) ? (prior.colors as Array<Record<string, unknown>>) : [];
    const merged: Array<{ name: string; code: string; imageId?: string | null }> = [];
    const at = new Map<string, number>();
    let deduped = 0;
    for (const c of priorColors) {
      const entry = c as unknown as { name: string; code: string; imageId?: string | null };
      const k = colorKey(entry.code, entry.name);
      // Nothing to key on — keep it exactly where it is rather than guess.
      if (!k) { merged.push(entry); continue; }
      const idx = at.get(k);
      if (idx === undefined) { at.set(k, merged.length); merged.push(entry); continue; }
      // The same cloth twice. Keep ONE: the entry carrying a swatch wins,
      // because that image is the half of the row we cannot rebuild.
      const kept = merged[idx];
      if (!kept.imageId && entry.imageId) merged[idx] = { ...kept, ...entry };
      else if (!String(kept.name ?? '').trim() && entry.name) merged[idx] = { ...kept, name: entry.name };
      deduped++;
    }

    const seen = new Set(at.keys());
    let added = 0;
    for (const c of f.colors) {
      const k = colorKey(c.code, c.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      merged.push({ name: c.name, code: c.code });
      added++;
    }

    const blank = (v: unknown) => v == null || String(v).trim() === '';
    const patch: MaterialRowPatch = {
      id: String(prior.id),
      profileId,
      brand: BRAND_LIGNE_ROSET,
      category: blank(prior.category) && category ? category : String(prior.category ?? category ?? 'fabric'),
      name: String(prior.name ?? f.name),
      grade: blank(prior.grade) ? f.grade : String(prior.grade),
      composition: blank(prior.composition) ? f.composition : String(prior.composition),
      notes: blank(prior.notes) ? f.notes : String(prior.notes),
      colors: merged,
    };

    const changed = added > 0
      || deduped > 0
      || (blank(prior.grade) && !!f.grade)
      || (blank(prior.composition) && !!f.composition)
      || (blank(prior.notes) && !!f.notes)
      || (blank(prior.category) && !!category);

    if (changed) { upserts.push(patch); stats.updated++; stats.colorsAdded += added; stats.colorsDeduped += deduped; }
    else stats.unchanged++;
  }

  return { upserts, stats };
}

/* ---------------------------------------------------------------- feed layout */

/** Where each file sits under the feed root. Relative, so the token stays out. */
export const FEED_FILES = {
  article: 'Etiquette/XML/Article.csv',
  tarif: 'Etiquette/XML/Tarif.csv',
  coloris: 'Etiquette/XML/Coloris.csv',
  modele: 'Etiquette/XML/Modele.csv',
  /** The change log. 125 MB and append-only — always read by Range, never whole. */
  diff: 'Etiquette/XML/DiffArticle.xml',
} as const;

/**
 * The article image directories, cheapest-useful first. `ILLU_CHEMIN` names a
 * `.gif`; the `Filaires_Png` twin holds the same drawing as `.png`, which is
 * what a browser should be handed.
 */
export const IMAGE_DIRS = {
  png: 'Etiquette/images/Article/Filaires_Png',
  medium: 'Etiquette/images/Article/Filaires_Medium',
  big: 'Etiquette/images/Article/Filaires_Big',
} as const;

/**
 * `ILLU_CHEMIN` ("100ae0.gif") → the PNG path under the feed root. Returns
 * `null` when the article has no drawing, so a caller can't build a URL that
 * 404s (lens 6 again — an image that isn't there degrades to no image, never to
 * a broken one).
 */
export function imagePathFor(illuChemin: string | null | undefined): string | null {
  const raw = String(illuChemin ?? '').trim();
  if (!raw) return null;
  // Reject anything that could climb out of the image directory.
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  const base = raw.replace(/\.(gif|png|jpe?g)$/i, '');
  if (!base) return null;
  return `${IMAGE_DIRS.png}/${base}.png`;
}
