// kvadrat-collection/parse.ts — THE PURE HALF, pinned by tests/kvadratCollection.test.js.
//
// A Kvadrat product page (e.g. .../products/upholstery/1044-asator) server-
// renders every colourway of the quality as embedded JSON, and each colour
// carries a PUBLIC Azure-blob link to its colormass PBR export:
//
//   …/bynderresources/{GUID}.zip … "id":"1044:::0114:" … "color":"0114" …
//
// The `"id"` field is `{quality}:::{colour}:` — unambiguous — and the nearest
// preceding `bynderresources/{GUID}.zip` is that colour's export (verified by
// downloading one: it is the PBR zip, not the image pack). So the parse is:
// pair each blob GUID with the id that follows it, and build the trade code
// `{quality}-{colour}` and the blob URL. No DOM, no deps — a regex over the
// (un-escaped) HTML, so it runs identically in Deno and in the Node test.

export interface KvadratColour {
  /** The trade reference a quote is written in — `1044-0114`. */
  code: string;
  colour: string;
  quality: string;
  /** The public colormass PBR export for this colour. */
  url: string;
}

export interface KvadratCollectionPage {
  quality: string | null;
  productName: string | null;
  colours: KvadratColour[];
}

const BLOB_ORIGIN = 'https://kvadratimageresizer.blob.core.windows.net';

/**
 * One product page's HTML → its colourways. The page embeds the JSON with HTML
 * entity-escaped quotes (`&quot;`), so it is un-escaped first. A colour with no
 * blob link is skipped — it has no export to import. Never throws.
 */
export function parseKvadratCollectionPage(html: string): KvadratCollectionPage {
  const text = String(html || '').replace(/&quot;/g, '"');
  const colours: KvadratColour[] = [];
  const seen = new Set<string>();
  let quality: string | null = null;

  // GUID first, then the id that names its quality+colour. Non-greedy up to a
  // bounded gap so a match can never span from one colour's blob to the next
  // colour's id.
  const re = /bynderresources\/([A-Fa-f0-9-]+)\.zip[\s\S]{0,3000}?"id"\s*:\s*"(\d{3,5}):::(\d{2,5}):"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, guid, q, colour] = m;
    quality = quality || q;
    const code = `${q}-${colour}`;
    if (seen.has(code)) continue;
    seen.add(code);
    colours.push({ code, colour, quality: q, url: `${BLOB_ORIGIN}/bynderresources/${guid}.zip` });
  }
  colours.sort((a, b) => a.colour.localeCompare(b.colour));

  const pn = /"styleName"\s*:\s*"([^"]+)"/i.exec(text)
    || /<title>\s*([^<|]+?)\s*[|<]/i.exec(text);
  return { quality, productName: pn ? pn[1].trim() : null, colours };
}

/**
 * The one URL this function is allowed to fetch, or null. Accepts a full
 * kvadrat.dk product URL OR a bare `{quality}-{slug}` (which is expanded), and
 * refuses anything that is not a kvadrat.dk/.com product path — the SSRF wall,
 * the same discipline lr-catalog and swatch-proxy keep.
 */
export function kvadratProductUrl(input: string): string | null {
  const s = String(input || '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://www.kvadrat.dk/en/products/upholstery/${s}`);
  } catch {
    return null;
  }
  if (!/(^|\.)kvadrat\.(dk|com)$/i.test(u.hostname)) return null;
  if (!/\/products\/[a-z-]+\/\d{3,5}-[a-z0-9-]+/i.test(u.pathname)) return null;
  return `https://${u.hostname}${u.pathname}`;
}
