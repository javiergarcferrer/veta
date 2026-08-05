/**
 * The EAIWS client — where a pCon.login token becomes de Sede's catalog.
 *
 * pCon's data path has three tiers and only the last one serves products:
 *
 *   pCon.login   issues the OAuth token, and decides which manufacturer
 *                catalogs the user is subscribed to. No product data.
 *   Gatekeeper   trades that token for an EAIWS session; load-balances.
 *   EAIWS        the OFML engine. Catalog walk, article data, prices,
 *                configuration, geometry export.
 *
 * `EaiwsSession.open(baseUrl, { userToken })` is the whole handshake — wcf
 * passes the token through as `-user-token` and the far side does the rest.
 *
 * ── THIS RUNS IN NODE, NOT IN AN EDGE FUNCTION ──────────────────────────────
 * wcf decodes SOAP with `DOMParser` (`utils/string/StringUtils.js parseXml`),
 * which exists in a browser and in neither Node nor Deno Deploy. Node takes a
 * polyfill — `@xmldom/xmldom`, installed and assigned to `globalThis.DOMParser`
 * before wcf is imported, which `openSession` does for you — but Supabase Edge
 * Functions cannot, so the sweep is a Node script (`npm run pcon:sync`) and not
 * a fourth Edge Function. That is also the right home for it: it is a back
 * office batch job, not a public surface.
 *
 * The import is DYNAMIC for the same reason. wcf must not be pulled into the
 * browser bundle by a static import from a module the studio touches — the
 * configurator a customer loads has no business shipping an OFML client.
 *
 * ── WHAT IS LICENSED, AND WHAT THAT LOOKS LIKE ──────────────────────────────
 * EAIWS gates features individually, and a missing one is SILENT — it returns
 * empty, not an error:
 *
 *   egr.eai.server.ofml.prices   no price on any article (`pdSalesPrice`
 *                                undefined → our row's `priceUsd` is null)
 *   egr.eai.server.export.gltf   `getExportedGeometry` returns '' for GLTF
 *   egr.eai.server.export.image  `getGeneratedImage` returns ''
 *
 * So `exportGeometry` and `renderImage` answer null rather than throwing, and
 * the sync counts the nulls and SAYS SO at the end. An unlicensed server that
 * looks like an empty catalog is the failure mode worth spending code on.
 *
 * ── EVERY URL DIES WITH THE SESSION ─────────────────────────────────────────
 * The spec: an exported geometry URL "remains valid until the session is
 * explicitly closed […] or is automatically closed after a configurable time of
 * inactivity". Same for images and swatch icons. Callers must fetch bytes
 * before `close()`, which is why this module hands back URLs and the sync
 * re-hosts them inside the session's lifetime.
 */

import type { PconArticleData, PconPropertyValue } from './articleMap.js';

/** Everything needed to open a session. */
export interface EaiwsConfig {
  /** The EAIWS/Gatekeeper base URL. EasternGraphics gives you this per
   *  deployment; there is no public default and guessing one is a dead end. */
  baseUrl: string;
  /** A pCon.login access token — see `lib/pcon/oauth.ts`. */
  userToken: string;
  /** The startup file naming which OFML data this session mounts. Per
   *  manufacturer; EGR supplies it with the catalog subscription. */
  startup?: string;
  /** Package groups, when the subscription splits data into several. */
  packageGroups?: string;
  /** e.g. 'de-DE' or 'en-US'. Drives every `text`/`shortText` that comes back,
   *  so it is the language the imported catalog will be written in. */
  locale?: string;
}

/** The narrow slice of wcf's session this module drives. */
interface WcfSession {
  open(baseUrl: string, options: Record<string, unknown>): Promise<boolean>;
  close(): Promise<boolean>;
  catalog: any;
  basket: any;
  session: any;
}

export interface PconSession {
  readonly raw: WcfSession;
  close(): Promise<void>;
}

/**
 * Install the DOMParser wcf needs, once, and only outside a browser.
 *
 * Throws a message naming the missing package rather than letting wcf fail
 * later inside a SOAP decode, where the stack says nothing about xmldom.
 */
async function ensureDomParser(): Promise<void> {
  if (typeof globalThis.DOMParser === 'function') return;
  try {
    const mod: any = await import('@xmldom/xmldom');
    (globalThis as any).DOMParser = mod.DOMParser;
  } catch (err) {
    throw new Error(
      'pCon: wcf decodes SOAP with DOMParser, which Node does not have. '
      + 'Install @xmldom/xmldom (npm i -D @xmldom/xmldom). Original: '
      + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Open a session, or throw with what was missing. */
export async function openSession(config: EaiwsConfig): Promise<PconSession> {
  const baseUrl = String(config?.baseUrl || '').trim();
  const userToken = String(config?.userToken || '').trim();
  if (!baseUrl) throw new Error('pCon: no EAIWS base URL — EasternGraphics issues one with the licence');
  if (!userToken) throw new Error('pCon: no user token — run the OAuth flow first (lib/pcon/oauth.ts)');

  await ensureDomParser();
  const { EaiwsSession } = await import('@easterngraphics/wcf/modules/eaiws/index.js');
  const raw = new EaiwsSession() as unknown as WcfSession;

  const opened = await raw.open(baseUrl, {
    userToken,
    startup: config.startup,
    packageGroups: config.packageGroups,
    locale: config.locale,
  });
  if (!opened) throw new Error('pCon: EAIWS refused the session (token, startup file or subscription)');

  return {
    raw,
    async close() { try { await raw.close(); } catch { /* a dead session is already closed */ } },
  };
}

/** A catalog node, flattened to what the sweep needs. */
export interface CatalogNode {
  catalogId: string;
  catalogNodeKey: string;
  catalogPackageId: string;
  label: string;
  name: string;
  type: string;
  /** Present only on Article nodes — what `insertOFMLArticle` needs. */
  baseArticleNumber?: string;
  variantCode?: string;
  articlePackageId?: string;
  manufacturerIds?: string[];
}

/**
 * The manufacturers this session can actually see.
 *
 * This is the FIRST call worth making after opening a session, and the honest
 * answer to "does my account have de Sede?": if their manufacturer id is not in
 * this list, no amount of catalog walking will find their sofas, and the
 * problem is a subscription, not a bug.
 */
export async function listManufacturers(session: PconSession): Promise<Array<{ id: string; name: string }>> {
  const packages = await session.raw.catalog.getPackageInfo(null, null, { includeCatalogs: true });
  const byId = new Map<string, string>();
  for (const pkg of packages || []) {
    const id = String(pkg?.manufacturerId || '').trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, String(pkg?.manufacturerName || pkg?.name || id).trim());
  }
  return [...byId].map(([id, name]) => ({ id, name }));
}

/** The children of a catalog path. `[]` is the root. */
export async function listCatalog(
  session: PconSession, path: readonly string[] = [],
): Promise<CatalogNode[]> {
  const items = await session.raw.catalog.listCatalogItems(path, {
    // Articles and the folders that hold them. Asking for everything drags in
    // Information/Graphics nodes the sweep would only filter out again.
    itemTypes: ['Folder', 'Article', 'Container'],
    resourceURLs: true,
  });
  return (items || []).map((it: any) => ({
    catalogId: String(it?.catalogId || ''),
    catalogNodeKey: String(it?.catalogNodeKey || ''),
    catalogPackageId: String(it?.catalogPackageId || ''),
    label: String(it?.label || ''),
    name: String(it?.name || ''),
    type: String(it?.type || ''),
    baseArticleNumber: it?.baseArticleNumber ? String(it.baseArticleNumber) : undefined,
    variantCode: it?.variantCode ? String(it.variantCode) : undefined,
    articlePackageId: it?.articlePackageId ? String(it.articlePackageId) : undefined,
    manufacturerIds: Array.isArray(it?.manufacturerIds) ? it.manufacturerIds.map(String) : undefined,
  }));
}

export interface WalkOptions {
  /** Stop descending past this depth. A whole manufacturer tree is large and an
   *  unbounded walk is how a first run turns into an afternoon. */
  maxDepth?: number;
  /** Hard cap on articles returned; the walk stops when it is reached. */
  limit?: number;
  /** Called with each folder path as it is entered, for progress output. */
  onFolder?: (path: readonly string[], found: number) => void;
}

/**
 * Depth-first walk collecting every Article node under `root`.
 *
 * Bounded by BOTH `maxDepth` and `limit`, and when either bound stops the walk
 * the caller is told — `truncated` is the difference between "de Sede has 180
 * articles" and "we looked at 180 of de Sede's articles", and a sync that
 * confuses the two silently deletes the rest of the catalog on its next run.
 */
export async function walkArticles(
  session: PconSession, root: readonly string[], options: WalkOptions = {},
): Promise<{ articles: CatalogNode[]; truncated: boolean }> {
  const { maxDepth = 8, limit = 5000, onFolder } = options;
  const articles: CatalogNode[] = [];
  let truncated = false;

  const visit = async (path: readonly string[], depth: number): Promise<void> => {
    if (articles.length >= limit) { truncated = true; return; }
    if (depth > maxDepth) { truncated = true; return; }
    const children = await listCatalog(session, path);
    onFolder?.(path, articles.length);
    for (const child of children) {
      if (articles.length >= limit) { truncated = true; return; }
      if (child.type === 'Article') articles.push(child);
      else if (child.type === 'Folder' || child.type === 'Container') {
        await visit([...path, child.catalogNodeKey], depth + 1);
      }
    }
  };

  await visit(root, 0);
  return { articles, truncated };
}

/**
 * Put one catalog article into the basket and read it back configured.
 *
 * An article only HAS data once it is instantiated — properties, prices and
 * geometry all belong to a basket item, not to a catalog node. So every read
 * costs an insert, and `releaseItem` exists because a sweep that inserts
 * thousands of articles into one basket gets slower with every one.
 */
export async function insertArticle(session: PconSession, node: CatalogNode): Promise<string> {
  const itemId = await session.raw.basket.insertOFMLArticle(null, null, {
    baseArticleNumber: node.baseArticleNumber,
    variantCode: node.variantCode,
    catalogId: node.catalogId,
    catalogPackageId: node.catalogPackageId,
    articlePackageId: node.articlePackageId,
  });
  return String(itemId);
}

/** Drop a basket item once its data has been read. */
export async function releaseItem(session: PconSession, itemId: string): Promise<void> {
  try { await session.raw.basket.deleteItems([itemId]); } catch { /* best effort */ }
}

/** `getArticleData` for a basket item, with the catalog image asked for. */
export async function articleData(session: PconSession, itemId: string): Promise<PconArticleData> {
  return await session.raw.basket.getArticleData(itemId, {
    fetchCatalogImage: true,
    fetchCatalogIcon: true,
    separateCurrencies: true,
    fetchPropValueImages: true,
  }) as PconArticleData;
}

/** The choice list behind one property — the grade ladder, the cover roster. */
export async function choiceList(
  session: PconSession, itemId: string, propClass: string, propName: string,
): Promise<PconPropertyValue[]> {
  const list = await session.raw.basket.getChoiceList(itemId, propClass, propName, {
    fetchPropValueImages: true, highResPropValueIcons: true,
  });
  return (list || []) as PconPropertyValue[];
}

/**
 * Set one property and let EAIWS re-evaluate. The returned string is the new
 * variant code; the price must be re-read with `articleData`.
 *
 * This is the call that turns one article into a graded price list: set the
 * grade property to each rung, read the price, repeat.
 */
export async function setProperty(
  session: PconSession, itemId: string, propClass: string, propName: string, value: string,
): Promise<string> {
  return String(await session.raw.basket.setPropertyValue(itemId, propClass, propName, value));
}

/**
 * Export the configured geometry. Returns a URL, or NULL when the format is not
 * licensed or the product data has no geometry — the spec has this return an
 * empty string for both, and neither is an error worth throwing on.
 *
 * GLTF is the default because it is what VETA's model layer already loads
 * (`togo_models.mesh_url`, three.js) — asking for FBX would buy a conversion
 * step and a second licence feature.
 */
export async function exportGeometry(
  session: PconSession, itemId: string,
  options: readonly string[] = ['format=GLTF', 'materials=true', 'textures=true'],
): Promise<string | null> {
  const url = String(await session.raw.basket.getExportedGeometry(itemId, options) || '');
  return url || null;
}

/** A rendering of the configured article, or null when unlicensed. */
export async function renderImage(
  session: PconSession, itemId: string,
  options: readonly string[] = ['width=1200', 'height=1200', 'format=PNG', 'background=transparent'],
): Promise<string | null> {
  const url = String(await session.raw.basket.getGeneratedImage(itemId, options) || '');
  return url || null;
}
