/**
 * How a 125 MB file is MEASURED and read in windows.
 *
 * Two HTTP facts, both of which bit in production, both pulled out of
 * `index.ts` because that module calls `Deno.serve` on import and so cannot be
 * unit-tested. NOT a twin of anything in `src/`: the browser never touches the
 * feed — the access token lives server-side and only the Edge Function fetches.
 *
 * 1. THE SIZE COMES FROM `Content-Range`, NEVER FROM `Content-Length`.
 *    Apache serves `DiffArticle.xml` with `Vary: Accept-Encoding`, and Deno's
 *    fetch strips `Content-Length` from any response it may have decompressed.
 *    A HEAD therefore reports no length at all, and the whole change log reads
 *    as unavailable — «DiffArticle.xml: no content-length» on the Catálogo
 *    card, which is exactly what the dealer saw. A one-byte ranged GET answers
 *    `Content-Range: bytes 0-0/131000417`, and that total is the resource's
 *    real size whatever the transfer encoding did to the body. It costs one
 *    byte instead of a separate request, and it cannot be dropped by
 *    decompression.
 *
 * 2. A 200 TO A RANGED REQUEST IS A REFUSAL, NOT A SUCCESS.
 *    It means the peer ignored `Range` and is handing over the whole file —
 *    125 MB into a 256 MB isolate. The body has to be dropped unread and the
 *    caller told, because otherwise rule 1's honest answer («el servidor no
 *    informa el tamaño») is unreachable: arriving there would mean surviving
 *    the download first. `carl-hansen` refuses the same way on the 3D
 *    archives, for the same reason.
 */

/**
 * The resource's total size out of a `Content-Range` header, or `null` when
 * the peer did not state one.
 *
 * Its own function because `Number('')` is 0, not NaN: an absent total read
 * naively as a finite zero is indistinguishable from a real answer, and zero
 * is the value the caller uses to mean "unknown". `bytes 0-0/*` is a peer that
 * has a range but will not say how big the whole is — that is not a size.
 */
export function sizeFromContentRange(header: string | null | undefined): number | null {
  const total = String(header ?? '').split('/')[1]?.trim();
  if (!total || total === '*') return null;
  const n = Number(total);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Did the peer honour our `Range`? Only `206 Partial Content` says yes.
 *
 * `r.ok` (200–299) covers a 206 too, which is why this needs saying out loud:
 * a ranged read that checks nothing but `ok` treats "here is the entire file"
 * as a successful window.
 */
export function rangeHonored(status: number): boolean {
  return status === 206;
}

/**
 * The body of `r` as text when we asked for it, dropped unread when we did not.
 *
 * A response body that is never read and never cancelled holds its connection
 * open, and one that is read when it should not be pulls the whole resource
 * into the isolate — the two ways rule 2 goes wrong. This makes the choice one
 * expression at the call site so neither can be forgotten separately.
 */
export async function bodyOrDrop(r: Response, wanted: boolean): Promise<string> {
  if (wanted) return await r.text();
  await r.body?.cancel().catch(() => {});
  return '';
}
