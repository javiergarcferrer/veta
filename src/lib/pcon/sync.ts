/**
 * THE SWEEP — one EAIWS session in, a priced catalog out.
 *
 * This is the runner `catalog.source.fetchRows` is handed (`ctx.sweep`). It
 * owns the loop and nothing else: authentication is `oauth.ts`, the protocol is
 * `eaiws.ts`, the row shape is `articleMap.ts`, and the writing is the caller's.
 * Keeping it a pure producer of rows is what lets `scripts/pconSync.mjs` print
 * them, a test drive them with a fake session, and a future studio button write
 * them, without three copies of the loop.
 *
 * ── HOW A GRADED PRICE LIST IS ACTUALLY BUILT ───────────────────────────────
 * pCon does not hold a price list. It holds a CONFIGURATOR, and a price is the
 * answer to one fully-specified configuration. VETA's catalog is the opposite
 * shape — one root, one priced row per grade — so the sweep manufactures the
 * price list by driving the configurator:
 *
 *   1. insert the catalog article into a basket        → itemId
 *   2. getArticleData                                   → root, texts, price
 *   3. getChoiceList(gradeProperty)                     → the ladder
 *   4. for each rung: setPropertyValue, getArticleData  → one priced row
 *   5. deleteItems                                      → give the basket back
 *
 * Step 4 is why a sweep is slow and why `limit` exists: an article with 12
 * leather qualities costs 13 round trips, and de Sede has hundreds of articles.
 * A first run should be scoped to one series.
 *
 * ── AN UNGRADED ARTICLE IS NOT AN ERROR ─────────────────────────────────────
 * No grade property configured, or an article that does not carry it (a table,
 * a base), yields exactly one row with `grade: ''` — the same value the generic
 * set's `splitSku` returns for a brand that does not grade. Downstream cannot
 * tell the difference, which is correct: it IS the same thing.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * It does not convert currency (see articleMap), does not invent a taxonomy
 * level pCon did not send, and does not fabricate a price when the server is
 * unlicensed — `priceUsd: null` travels as null and is counted in
 * `stats.unpriced`, so a caller can refuse to write a catalog that came back
 * free. Silence about a missing licence is the expensive failure here.
 */

import {
  articleData, choiceList, exportGeometry, insertArticle, releaseItem,
  setProperty, walkArticles, type CatalogNode, type PconSession,
} from './eaiws.js';
import {
  coverChoices, gradeChoices, propertyRef, toProductRow,
  type PconArticleMapping, type PconProductRow, type PconPropertyValue,
} from './articleMap.js';

export interface SweepOptions {
  session: PconSession;
  mapping: PconArticleMapping;
  /** Catalog path to sweep. `[]` is everything the session can see — almost
   *  never what you want on a first run. */
  root?: readonly string[];
  /** Stop after this many ARTICLES (not rows). */
  limit?: number;
  maxDepth?: number;
  /** Export a glTF per article. Costs a licence feature and a lot of time. */
  withGeometry?: boolean;
  /** Read the cover roster once per series, for the materials import. */
  withCovers?: boolean;
  composeSku?: (root: string, grade: string) => string | null;
  onProgress?: (msg: string, done: number, total: number) => void;
  signal?: { aborted: boolean };
}

export interface SweepRow extends PconProductRow {
  /** Session-scoped glTF URL — re-host before the session closes, or lose it. */
  meshUrl: string | null;
  /** The catalog path this article was found at; the caller's taxonomy. */
  path: string[];
}

export interface SweepResult {
  rows: SweepRow[];
  covers: Array<{ code: string; name: string; rgb: null; swatch: { url: string } | null }>;
  stats: {
    articles: number;
    rows: number;
    unpriced: number;
    ungraded: number;
    failed: number;
    truncated: boolean;
    /** True when NOTHING came back priced — reads as an unlicensed server. */
    looksUnlicensed: boolean;
  };
  warnings: string[];
}

const aborted = (signal?: { aborted: boolean }) => Boolean(signal?.aborted);

/**
 * Sweep one article into its rows. Exported so a caller can retry a single
 * failure without re-walking the tree.
 */
export async function sweepArticle(
  session: PconSession, node: CatalogNode, options: SweepOptions,
): Promise<{ rows: SweepRow[]; covers: SweepResult['covers'] }> {
  const { mapping, composeSku, withGeometry, withCovers } = options;
  const itemId = await insertArticle(session, node);
  try {
    const base = await articleData(session, itemId);
    const path = [base.manufacturerId, base.seriesId].filter(Boolean);

    // The mesh is per ARTICLE, not per grade: changing the cover grade does not
    // change the shape, and exporting one glTF per rung would multiply the
    // slowest call in the sweep by the length of the ladder for no new bytes.
    const meshUrl = withGeometry ? await exportGeometry(session, itemId).catch(() => null) : null;

    const covers: SweepResult['covers'] = [];
    if (withCovers) {
      const ref = propertyRef(base, mapping.coverProperty);
      if (ref) {
        const list = await choiceList(session, itemId, ref.propClass, ref.propName).catch((): PconPropertyValue[] => []);
        for (const c of coverChoices(list)) {
          covers.push({ code: c.code, name: c.name, rgb: null, swatch: c.swatch ? { url: c.swatch.url } : null });
        }
      }
    }

    const gradeRef = propertyRef(base, mapping.gradeProperty);
    if (!gradeRef) {
      const row = toProductRow(base, mapping, composeSku);
      return { rows: row ? [{ ...row, meshUrl, path }] : [], covers };
    }

    const list = await choiceList(session, itemId, gradeRef.propClass, gradeRef.propName).catch((): PconPropertyValue[] => []);
    const ladder = gradeChoices(list, mapping);
    if (!ladder.length) {
      const row = toProductRow(base, mapping, composeSku);
      return { rows: row ? [{ ...row, meshUrl, path }] : [], covers };
    }

    // The raw values, not the aliased ones — `setPropertyValue` speaks pCon's
    // vocabulary, while our rows speak the brand's. `gradeChoices` folds the
    // aliases in the same order, so index i of each lines up.
    const rawValues = list.filter((v) => v?.selectable !== false).map((v) => String(v?.value || '')).filter(Boolean);

    const rows: SweepRow[] = [];
    for (const raw of rawValues) {
      if (aborted(options.signal)) break;
      try {
        await setProperty(session, itemId, gradeRef.propClass, gradeRef.propName, raw);
        const configured = await articleData(session, itemId);
        const row = toProductRow(configured, mapping, composeSku);
        if (row) rows.push({ ...row, meshUrl, path });
      } catch {
        // One rung the manufacturer's relation logic refuses is normal — a
        // leather grade a given frame cannot be ordered in. Skip it; a phantom
        // SKU in the catalog is worse than a missing one.
      }
    }
    return { rows, covers };
  } finally {
    await releaseItem(session, itemId);
  }
}

/** Walk a catalog subtree and price everything under it. */
export async function sweep(options: SweepOptions): Promise<SweepResult> {
  const {
    session, root = [], limit = 200, maxDepth = 8, onProgress, signal,
  } = options;

  const warnings: string[] = [];
  const { articles, truncated } = await walkArticles(session, root, {
    maxDepth, limit,
    onFolder: (path, found) => onProgress?.(`walk ${path.join('/') || '(root)'}`, found, limit),
  });

  if (truncated) {
    warnings.push(
      `the walk stopped at ${articles.length} articles (limit ${limit}, maxDepth ${maxDepth}) — `
      + 'this is a PARTIAL catalog; do not delete rows it did not mention',
    );
  }

  const rows: SweepRow[] = [];
  const coversByCode = new Map<string, SweepResult['covers'][number]>();
  let failed = 0;

  for (let i = 0; i < articles.length; i += 1) {
    if (aborted(signal)) { warnings.push('sweep aborted by caller — partial result'); break; }
    const node = articles[i];
    onProgress?.(`article ${node.baseArticleNumber || node.label}`, i + 1, articles.length);
    try {
      const out = await sweepArticle(session, node, options);
      rows.push(...out.rows);
      for (const c of out.covers) if (!coversByCode.has(c.code)) coversByCode.set(c.code, c);
    } catch (err) {
      failed += 1;
      // Named, not counted-and-forgotten: an article that fails every run is a
      // data problem somebody has to look at.
      warnings.push(`article ${node.baseArticleNumber || node.catalogNodeKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const unpriced = rows.filter((r) => r.priceUsd == null).length;
  const ungraded = rows.filter((r) => !r.grade).length;
  const looksUnlicensed = rows.length > 0 && unpriced === rows.length;
  if (looksUnlicensed) {
    warnings.push(
      'EVERY row came back without a price. That is what an EAIWS without the '
      + '`egr.eai.server.ofml.prices` licence feature looks like — not an empty catalog.',
    );
  }

  return {
    rows,
    covers: [...coversByCode.values()],
    stats: {
      articles: articles.length,
      rows: rows.length,
      unpriced, ungraded, failed, truncated, looksUnlicensed,
    },
    warnings,
  };
}
