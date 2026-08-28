/** PostgREST's default page. A read that comes back with exactly this many rows
 *  has NOT told you it is complete — it has told you nothing. */
export const READ_PAGE = 1000;

export interface PageResult<T> { data: T[] | null; error: { message: string } | null }

/**
 * Drain a PostgREST read PAGE BY PAGE — the only way to know a read is whole.
 *
 * A bare `.select()` stops at READ_PAGE rows and reports nothing: no error, no
 * flag, no count. The root-SCOPED sweep is not immune — togo-embed's active
 * models span 87 product roots matching 1,839 rows (measured in prod
 * 2026-08-01), so 839 graded SKUs were silently absent and a family ladder
 * arrived moth-eaten (a settee offering 6 of its 23 grades). Silent, and it
 * misprices.
 *
 * `page(from, to)` runs ONE window: the caller owns the filters AND the explicit
 * `.order(...)` on a unique-ish column that makes a window stable — an unordered
 * `.range()` may skip a row and repeat another across the boundary, which is the
 * same hole with extra steps. Termination is the SHORT page (nothing reports a
 * total). An error THROWS rather than returning what arrived so far: a partial
 * answer that looks complete is precisely the bug this exists to kill.
 *
 * It lives in `_shared/` because sixteen reads across nine functions needed it
 * at once (the bounded-reads sweep, 2026-08-22) and a seventeenth hand-rolled
 * copy is how a rule stops being one rule. `togo-embed/payload.ts`, which wrote
 * it first, re-exports from here so its own pin
 * (`tests/togoDealer.test.js:1089`) keeps guarding the implementation.
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => Promise<PageResult<T>>,
  label = 'la tabla',
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) throw new Error(`No se pudo leer ${label}: ${error.message}`);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < READ_PAGE) return out;
  }
}

/** A query that has been filtered but not yet ordered or windowed. */
type Orderable<T> = { order: (col: string, opts?: unknown) => { range: (from: number, to: number) => PromiseLike<PageResult<T>> } };

/**
 * `readAllPages` for the shape that is almost always wanted: build the filtered
 * query, name the column that makes the window stable, get every row.
 *
 *   const rows = await readAllFrom<Row>(
 *     () => admin.from('customers').select('id, phone').eq('profile_id', TEAM), 'id', 'customers');
 *
 * `build` is called once per page — it must return a FRESH query, because a
 * PostgREST builder is single-use. `orderBy` is required for the same reason it
 * is required above: an unordered window may skip a row and repeat another.
 */
export function readAllFrom<T>(build: () => Orderable<T>, orderBy: string, label: string): Promise<T[]> {
  return readAllPages<T>((from, to) => build().order(orderBy).range(from, to), label);
}
