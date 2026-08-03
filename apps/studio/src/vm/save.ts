/**
 * SAVING — automatic, serialized per model, and no longer something to wait for.
 *
 * Three rules, each of them the answer to a real failure:
 *
 * 1. EVERYTHING SAVES ITSELF. The parts draft is written as ONE object, and its
 *    only writers used to be an unmount cleanup and a model swap — so tagging a
 *    part and then reloading the tab lost the edit outright, because a page
 *    unload runs no cleanup. The clock (`AUTOSAVE_MS`) plus a flush on
 *    tab-hide/pagehide is what makes "it saves itself" true rather than
 *    aspirational.
 *
 * 2. A FAILED SAVE STOPS THE CLOCK. A failure marks the draft dirty again, so
 *    re-arming on it would spin: one commit, one full read and one collection
 *    fan-out every 900 ms for as long as the network stays down. The NEXT EDIT
 *    is the retry (`armAutosave` reads a cleared error), and leaving the model
 *    or hiding the tab still flushes regardless.
 *
 * 3. THE FAN-OUT DOES NOT HOLD ANYONE UP. Saving one model wrote its own row and
 *    then walked the collection applying the finish to every sibling, ONE ROUND
 *    TRIP AT A TIME, with the dealer watching — so a save cost as many trips as
 *    the collection has models, and editing ten pieces meant ten of those waits
 *    back to back. It cannot collapse into one bulk patch (each sibling carries
 *    its own payload), so it is a BOUNDED POOL — a wide collection firing every
 *    write at once is how a tab stalls. And the save hands back TWO HANDLES:
 *    `committed` settles when THIS model's row is written (the UI releases
 *    there), `done` covers the fan-out over rows the dealer isn't looking at.
 *    The next save on the same model still queues behind `done`, so a second
 *    edit lands after the first, fan-out included, exactly as before. Nothing is
 *    fire-and-forget: a fan-out failure still surfaces, it just no longer makes
 *    anyone wait.
 */

/**
 * How long the draft sits before it writes itself. Long enough that typing a
 * part's name is one save and not one per keystroke (each carries the collection
 * fan-out behind it), short enough that "everything saves itself" is true.
 */
export const AUTOSAVE_MS = 900;

/**
 * How many fan-out writes may be in the air at once. Bounded on purpose: a wide
 * collection firing every write simultaneously is how the tab stalls.
 */
export const FANOUT_CONCURRENCY = 6;

/**
 * Run `work` over `items` with at most `concurrency` in flight, in the items'
 * own order, NEVER throwing: each rejection is counted and the pool carries on,
 * because one dead sibling must not abandon the other twenty-nine.
 *
 * Returns what failed, by index — a caller reports a count, not a stack.
 */
export async function runPool<T>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<unknown>,
  { concurrency = FANOUT_CONCURRENCY }: { concurrency?: number } = {},
): Promise<{ failed: number; failedIndexes: number[] }> {
  const list = items || [];
  const failedIndexes: number[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try { await work(list[i] as T, i); } catch { failedIndexes.push(i); }
    }
  };
  const lanes = Math.max(1, Math.min(Math.round(concurrency) || FANOUT_CONCURRENCY, list.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  failedIndexes.sort((a, b) => a - b);
  return { failed: failedIndexes.length, failedIndexes };
}

/** The two handles one save hands back. */
export interface SaveHandles {
  /** THIS model's row is written. What the UI waits on. */
  committed: Promise<void>;
  /** …and the collection fan-out behind it. What the next save queues behind. */
  done: Promise<void>;
}

export interface SaveQueueDeps<P> {
  /** Write THIS model's own row. The dealer is released when this settles. */
  commit(id: string, payload: P): Promise<unknown>;
  /** Write the siblings the payload reaches. Rejecting here surfaces on `done`,
   *  never on `committed`. */
  fanout?(id: string, payload: P): Promise<unknown>;
}

export interface SaveQueue<P> {
  /** Queue a save for `id`. A save already in flight for the SAME model is
   *  awaited FIRST — a second edit lands after the first, fan-out included,
   *  never woven through it. Different models never wait on each other. */
  save(id: string, payload: P): SaveHandles;
  /** Whether anything is still in flight for this model (or for anything). */
  pending(id?: string): boolean;
}

/**
 * The per-model write chain.
 *
 * ONE CHAIN PER MODEL, because a save is a read-modify-write of a whole object:
 * two overlapping writes of the same row interleave into a lost edit. Different
 * models are genuinely independent and are never serialized against each other —
 * that was the other half of "editing ten models meant ten waits".
 */
export function createSaveQueue<P>({ commit, fanout }: SaveQueueDeps<P>): SaveQueue<P> {
  const chains = new Map<string, Promise<void>>();

  return {
    save(id, payload) {
      const prev = chains.get(id);
      const committed = (prev ? prev.catch(() => {}) : Promise.resolve())
        .then(() => commit(id, payload))
        .then(() => undefined);
      // The fan-out runs BEHIND the commit and is what the next save queues on.
      // `committed.catch` first, so a failed commit does not leave `done` an
      // unhandled rejection AND does not fan out a row that was never written.
      const done = committed.then(() => (fanout ? fanout(id, payload) : undefined)).then(() => undefined);
      chains.set(id, done);
      // Only the LAST chain clears the slot — an earlier one settling must not
      // unlatch a successor that is still running.
      done.catch(() => {}).then(() => {
        if (chains.get(id) === done) chains.delete(id);
      });
      return { committed, done };
    },
    pending(id) {
      return id == null ? chains.size > 0 : chains.has(id);
    },
  };
}

/**
 * Should the autosave clock be armed?
 *
 * The error is a GATE and not merely a message: see rule 2 above. A save already
 * in flight does not re-arm either — the draft is marked clean the instant a
 * save starts, and re-arming on top of it is how a debounce becomes a spin.
 */
export function armAutosave({ dirty, error = null, saving = false }: {
  dirty: boolean;
  error?: string | null;
  saving?: boolean;
}): { arm: boolean; delayMs: number; reason: 'ready' | 'clean' | 'failed' | 'saving' } {
  if (!dirty) return { arm: false, delayMs: AUTOSAVE_MS, reason: 'clean' };
  if (error) return { arm: false, delayMs: AUTOSAVE_MS, reason: 'failed' };
  if (saving) return { arm: false, delayMs: AUTOSAVE_MS, reason: 'saving' };
  return { arm: true, delayMs: AUTOSAVE_MS, reason: 'ready' };
}

/** What the status strip says. There is nothing to press — «Save» and
 *  «Discard» are gone — so this is the whole of what the dealer is told. */
export function resolveSaveStatus({ dirty, saving, error = null, fanoutFailed = 0 }: {
  dirty: boolean;
  saving: boolean;
  error?: string | null;
  fanoutFailed?: number;
}): { show: boolean; level: 'ok' | 'warn' | 'bad'; label: string } {
  if (error) return { show: true, level: 'bad', label: error };
  if (fanoutFailed > 0) {
    return { show: true, level: 'warn', label: `${fanoutFailed} sibling model(s) could not be updated.` };
  }
  if (saving) return { show: true, level: 'ok', label: 'Saving…' };
  if (dirty) return { show: true, level: 'ok', label: 'Saving…' };
  return { show: false, level: 'ok', label: '' };
}
