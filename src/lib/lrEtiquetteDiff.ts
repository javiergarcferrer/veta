/**
 * Ligne Roset «Étiquette» — the CHANGE LOG (`DiffArticle.xml`). PURE (no fetch,
 * no db); the server twin is `supabase/functions/lr-etiquette/diff.ts`, pinned
 * by tests/lrEtiquetteParity.
 *
 * WHY THIS FILE EXISTS AT ALL. The catalog import is an upsert and it NEVER
 * deactivates: a row the feed stopped mentioning is left alone, because absence
 * is ambiguous — Roset drops discontinued articles from the current list while
 * dealers still hold them in stock, quote them and invoice them, and flipping
 * `active=false` on a whole season because it aged out of a file would empty
 * pickers that are legitimately in use.
 *
 * `DiffArticle.xml` removes the ambiguity. It is Roset's own log of what they
 * did, going back to 2021, with three record types:
 *
 *   AJOUT         an article was added
 *   SUPPRESSION   an article was WITHDRAWN  ← the signal absence could not give
 *   MODIFICATION  a field changed, with OLDVAL → NEWVAL and a date
 *
 * A stated deletion is not an inference. That is the difference that lets this
 * module retire a product where the catalog import must not.
 *
 * SIZE IS THE DESIGN CONSTRAINT (lens 1). The file is 125 MB and only grows —
 * it is history, so every past entry stays forever. Reading it whole on every
 * run would move 125 MB to re-learn nothing, so:
 *   • entries are read FORWARD from a cursor (the last `DATMAJ` applied), and
 *   • the caller feeds it bytes in whatever slice it can afford, because
 *     `parseDiffEntries` works on any fragment and simply ignores a record cut
 *     in half at either end.
 * That last property is what makes a bounded HTTP Range read safe: a window
 * that lands mid-record loses that record, not the run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It plans; it does not write. Deactivation
 * is proposed as a list of references with the date and reason attached, so the
 * caller can apply it, cap it, or show it to a human first. A module that both
 * decides and writes would make "retire 400 products" an invisible side effect
 * of a refresh.
 */

/** One record from the log, already shaped for a decision. */
export interface DiffEntry {
  /** `AJOUT` | `SUPPRESSION` | `MODIFICATION`, verbatim. */
  type: string;
  /** `DATMAJ` verbatim (`2026-07-20T`) — the cursor is compared as a string. */
  date: string;
  codart: string;
  idart: string;
  /** Price column, when the record carries one. */
  colonne: string;
  /** e.g. `Modification PRIX`. Empty on AJOUT/SUPPRESSION. */
  modType: string;
  oldVal: string;
  newVal: string;
  name: string;
}

/** A price move the log states outright, ready to show or archive. */
export interface PriceMove {
  reference: string;
  codart: string;
  colonne: string;
  from: number | null;
  to: number | null;
  date: string;
  name: string;
}

const TAG = /<([A-Z_]+)(?:\s+NULL="TRUE"\s*\/>|>([^<]*)<\/\1>)/g;

/** Unescape the five XML entities. The feed uses `&amp;` and little else. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Pull every COMPLETE `<DIFFARTICLES_ROW>` out of an XML fragment.
 *
 * Tolerant of truncation at BOTH ends by construction: it matches only on a
 * closing tag it has actually seen, so a record sliced by a byte window is
 * skipped rather than half-read. That is what lets the caller page through 125
 * MB with Range requests without aligning the windows to record boundaries.
 */
export function parseDiffEntries(xml: string): DiffEntry[] {
  const src = String(xml ?? '');
  const out: DiffEntry[] = [];
  const rowRe = /<DIFFARTICLES_ROW\b[^>]*>([\s\S]*?)<\/DIFFARTICLES_ROW>/g;
  let m: RegExpExecArray | null;

  while ((m = rowRe.exec(src)) !== null) {
    const body = m[1];
    const f: Record<string, string> = {};
    TAG.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TAG.exec(body)) !== null) {
      // `<X NULL="TRUE"/>` captures no value — that is an explicit empty.
      f[t[1]] = t[2] === undefined ? '' : unescapeXml(t[2]).trim();
    }
    const codart = (f.CODART || '').trim();
    if (!codart) continue;
    out.push({
      type: (f.TYPE || '').trim().toUpperCase(),
      date: (f.DATMAJ || '').trim(),
      codart,
      idart: (f.IDART || '').trim(),
      colonne: (f.COLONNE || '').trim().toUpperCase(),
      modType: (f.MOD_TYPE || '').trim(),
      oldVal: (f.OLDVAL || '').trim(),
      newVal: (f.NEWVAL || '').trim(),
      name: (f.LIBPRIN || '').trim(),
    });
  }
  return out;
}

/** `5400.` → `5400`. The log writes a trailing dot; blank stays null. */
export function amountOf(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim().replace(/\.$/, '');
  if (!s) return null;
  const n = Number(s.replace(/[,\s$]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Entries strictly newer than `cursor`. A blank cursor takes everything. */
export function entriesAfter(entries: DiffEntry[], cursor: string | null | undefined): DiffEntry[] {
  const c = String(cursor ?? '').trim();
  if (!c) return entries.slice();
  // DATMAJ is `YYYY-MM-DDT`, so lexicographic order IS chronological order —
  // no Date parsing, and no timezone to get wrong.
  return entries.filter((e) => e.date > c);
}

/** The highest date seen, for the next run's cursor. Empty ⇒ keep the old one. */
export function cursorOf(entries: DiffEntry[], previous: string | null | undefined): string {
  let max = String(previous ?? '').trim();
  for (const e of entries) if (e.date > max) max = e.date;
  return max;
}

export interface DiffPlan {
  /** SKU references the log says were WITHDRAWN — safe to deactivate. */
  deactivate: string[];
  /** Price moves stated outright, for the archive and the dealer's eye. */
  priceMoves: PriceMove[];
  /** Codes the log ADDED — a hint that a catalog refresh is due. */
  addedCodarts: string[];
  /** The cursor to store after applying this plan. */
  cursor: string;
  stats: {
    read: number;
    fresh: number;
    suppressions: number;
    additions: number;
    modifications: number;
    /** Withdrawn codes skipped because the SKU grammar can't express them. */
    unresolvable: number;
  };
}

/**
 * Turn raw log entries into a plan.
 *
 * A SUPPRESSION names an ARTICLE (a CODART), but we sell SKUs — one per priced
 * grade. So a withdrawal expands to every reference we actually hold for that
 * code, which the caller supplies in `knownReferences`. Expanding against the
 * grade ladder instead would invent references we never minted; expanding
 * against what we hold retires exactly what exists and nothing more.
 *
 * `knownReferences` is REQUIRED for that reason. Called with an empty set, the
 * plan proposes no deactivations at all — the honest answer when we cannot tell
 * what a withdrawal refers to, and far better than guessing at SKU names.
 *
 * `liveReferences` is what the CURRENT feed still prices. Anything in it is
 * immune: see the guard below for the NOMADE 2 case that makes this mandatory
 * rather than defensive.
 */
export function planFromDiff(input: {
  entries: DiffEntry[];
  cursor?: string | null;
  knownReferences: Iterable<string>;
  liveReferences?: Iterable<string>;
}): DiffPlan {
  const previous = String(input.cursor ?? '').trim();
  const fresh = entriesAfter(input.entries, previous);

  // codart → the references we actually hold for it.
  const byCodart = new Map<string, string[]>();
  for (const ref of input.knownReferences) {
    const r = String(ref ?? '').trim();
    if (!r) continue;
    const code = r.length === 9 ? r.slice(0, 8) : r;
    const list = byCodart.get(code);
    if (list) list.push(r); else byCodart.set(code, [r]);
  }

  const deactivate = new Set<string>();
  const added = new Set<string>();
  const priceMoves: PriceMove[] = [];
  const stats = {
    read: input.entries.length,
    fresh: fresh.length,
    suppressions: 0,
    additions: 0,
    modifications: 0,
    unresolvable: 0,
  };

  for (const e of fresh) {
    if (e.type === 'SUPPRESSION') {
      stats.suppressions++;
      const refs = byCodart.get(e.codart);
      if (!refs || refs.length === 0) { stats.unresolvable++; continue; }
      for (const r of refs) deactivate.add(r);
      continue;
    }
    if (e.type === 'AJOUT') {
      stats.additions++;
      added.add(e.codart);
      continue;
    }
    if (e.type === 'MODIFICATION') {
      stats.modifications++;
      // Only price moves are actionable here; the log also records eco-tax and
      // label edits, which nothing downstream reads.
      if (!/PRIX/i.test(e.modType)) continue;
      const reference = e.colonne && e.colonne !== '0' ? `${e.codart}${e.colonne}` : e.codart;
      priceMoves.push({
        reference,
        codart: e.codart,
        colonne: e.colonne,
        from: amountOf(e.oldVal),
        to: amountOf(e.newVal),
        date: e.date,
        name: e.name,
      });
    }
  }

  // A code that was withdrawn and then re-added is NOT retired: the log is
  // chronological and the later word wins. Without this, a re-issued model
  // would be deactivated by its own history.
  for (const code of added) {
    const refs = byCodart.get(code);
    if (refs) for (const r of refs) deactivate.delete(r);
  }

  // TODAY'S PRICE LIST OUTRANKS THE HISTORY. A reference the current feed still
  // prices is not retired, whatever the log says about it.
  //
  // This is not belt-and-braces; it is load-bearing. CODART 13230050 (NOMADE 2
  // BOLSTER) carries a SUPPRESSION dated 2021-03-15 and is priced in the
  // current edition at $435/$475/$510. Roset withdrew one variant of the code
  // years ago and went on selling the rest, so a withdrawal keyed on the CODART
  // alone would retire ten live articles. Across the sampled history this guard
  // is the difference between deactivating 23 sellable SKUs and deactivating
  // none of them.
  //
  // The asymmetry is deliberate: the log may only ever RETIRE something the
  // current catalog has already stopped offering. It can never overrule a
  // living price.
  for (const ref of input.liveReferences || []) {
    deactivate.delete(String(ref ?? '').trim());
  }

  return {
    deactivate: [...deactivate].sort((a, b) => a.localeCompare(b, 'en')),
    priceMoves,
    addedCodarts: [...added].sort((a, b) => a.localeCompare(b, 'en')),
    cursor: cursorOf(fresh, previous),
    stats,
  };
}
