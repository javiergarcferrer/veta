/**
 * THE TASK QUEUE — the batch discipline, as a pure reducer.
 *
 * Ported from the reference studio's «Optimizar mallas» run (RosetSoft
 * `ModelStudio.jsx` ~1531), which is the only batch in that app that survived
 * contact with a real catalogue. Its rules, restated as data so they can be
 * tested without a network:
 *
 *   • THREE AT A TIME. Each unit is a download, a parse, a weld and an upload;
 *     firing a whole catalogue at once is how the tab dies mid-run.
 *   • A CASUALTY IS PER FILE. One bad model never aborts the batch — it is
 *     collected, named, and the other twenty-nine still finish.
 *   • RESUMABLE. The state carries what is already done, so a run that stopped
 *     halfway picks up exactly where it left off and re-running costs nothing
 *     (the work itself is idempotent by the file's own stamp — see
 *     `vm/optimize.ts`).
 *
 * The ref-counted URL reclaim the reference does after each success is NOT here:
 * storage lifetime is the API's to own in this platform, not the browser's.
 */

export type TaskState = 'pending' | 'running' | 'done' | 'failed';

export interface QueueTask {
  id: string;
  label?: string;
  /** Anything the runner needs; the queue never looks inside. */
  payload?: unknown;
}

export interface QueueItem<R = unknown> {
  id: string;
  label: string;
  payload: unknown;
  state: TaskState;
  error: string | null;
  result: R | null;
  attempts: number;
}

export interface QueueState<R = unknown> {
  items: QueueItem<R>[];
  concurrency: number;
  running: boolean;
}

export const DEFAULT_CONCURRENCY = 3;

export function createQueueState<R = unknown>(
  tasks: readonly QueueTask[] | null | undefined,
  { concurrency = DEFAULT_CONCURRENCY }: { concurrency?: number } = {},
): QueueState<R> {
  return {
    items: (tasks || []).map((t) => ({
      id: String(t.id),
      label: t.label || String(t.id),
      payload: t.payload ?? null,
      state: 'pending' as TaskState,
      error: null,
      result: null as R | null,
      attempts: 0,
    })),
    concurrency: Math.max(1, Math.round(concurrency) || DEFAULT_CONCURRENCY),
    running: false,
  };
}

export type QueueEvent<R = unknown> =
  | { type: 'run-start' }
  | { type: 'task-start'; id: string }
  | { type: 'task-done'; id: string; result: R }
  | { type: 'task-failed'; id: string; error: string }
  | { type: 'run-stop' };

/** The ONE state transition. Immutable, and an event for an unknown id is a
 *  no-op rather than a throw — a late message from a worker that outlived its
 *  run must never take the UI down. */
export function queueReduce<R>(state: QueueState<R>, event: QueueEvent<R>): QueueState<R> {
  switch (event.type) {
    case 'run-start':
      return { ...state, running: true };
    case 'run-stop':
      return { ...state, running: false };
    case 'task-start':
      return patch(state, event.id, (it) => ({ ...it, state: 'running', error: null, attempts: it.attempts + 1 }));
    case 'task-done':
      return patch(state, event.id, (it) => ({ ...it, state: 'done', error: null, result: event.result }));
    case 'task-failed':
      return patch(state, event.id, (it) => ({ ...it, state: 'failed', error: event.error || 'Failed.' }));
    default:
      return state;
  }
}

function patch<R>(state: QueueState<R>, id: string, fn: (it: QueueItem<R>) => QueueItem<R>): QueueState<R> {
  let touched = false;
  const items = state.items.map((it) => {
    if (it.id !== id) return it;
    touched = true;
    return fn(it);
  });
  return touched ? { ...state, items } : state;
}

export interface QueueProgress {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  /** done + failed — what the progress bar fills to. */
  finished: number;
  /** 0..1; an empty queue is 1 (there is nothing left to do). */
  ratio: number;
  /** The labels currently in flight, for the "working on…" line. */
  current: string[];
}

export function queueProgress(state: QueueState<any>): QueueProgress {
  const total = state.items.length;
  const by = (s: TaskState): QueueItem[] => state.items.filter((it) => it.state === s);
  const done = by('done').length;
  const failed = by('failed').length;
  const finished = done + failed;
  return {
    total,
    pending: by('pending').length,
    running: by('running').length,
    done,
    failed,
    finished,
    ratio: total ? finished / total : 1,
    current: by('running').map((it) => it.label),
  };
}

/** What is left to do — the resume point, and what `runQueue` will pick up. */
export function pendingTasks(state: QueueState<any>): QueueItem[] {
  return state.items.filter((it) => it.state === 'pending');
}

/** Every casualty, for the review list a failed batch owes the dealer. */
export function failedTasks(state: QueueState<any>): QueueItem[] {
  return state.items.filter((it) => it.state === 'failed');
}

/** Put the casualties back in line, keeping their attempt count — a retry is a
 *  resume, not a fresh run. */
export function retryFailed<R>(state: QueueState<R>): QueueState<R> {
  return {
    ...state,
    items: state.items.map((it) => (it.state === 'failed' ? { ...it, state: 'pending', error: null } : it)),
  };
}

export interface RunQueueOptions<R> {
  /** Fired after every transition, with the whole state — the React shell just
   *  setStates it. */
  onState?: (state: QueueState<R>) => void;
  /** Stop starting NEW tasks; the ones in flight are awaited (a half-written
   *  upload is worse than a slow stop). */
  isCancelled?: () => boolean;
}

/**
 * Drive the queue with an injected async runner.
 *
 * Only PENDING items are run, which is the whole of "resumable": hand back a
 * state from an interrupted run and it continues. Never throws — a rejected
 * runner marks that one item failed and the run carries on.
 */
export async function runQueue<R>(
  initial: QueueState<R>,
  run: (item: QueueItem<R>) => Promise<R>,
  { onState, isCancelled }: RunQueueOptions<R> = {},
): Promise<QueueState<R>> {
  let state = queueReduce(initial, { type: 'run-start' });
  onState?.(state);

  const queue = pendingTasks(initial).map((it) => it.id);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled?.()) return;
      const id = queue[next++];
      if (id == null) return;
      const item = state.items.find((it) => it.id === id);
      if (!item) continue;
      state = queueReduce(state, { type: 'task-start', id });
      onState?.(state);
      try {
        const result = await run({ ...item, state: 'running' });
        state = queueReduce(state, { type: 'task-done', id, result });
      } catch (e) {
        state = queueReduce(state, { type: 'task-failed', id, error: messageOf(e) });
      }
      onState?.(state);
    }
  };

  const lanes = Math.max(1, Math.min(state.concurrency, queue.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  state = queueReduce(state, { type: 'run-stop' });
  onState?.(state);
  return state;
}

export function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : 'Failed.';
}
