// THE BATCH DISCIPLINE — the three rules the reference's «Optimizar mallas» run
// earned the hard way, pinned as behaviour rather than as a comment:
//
//   • THREE AT A TIME. Never more, whatever the queue's length — the ceiling is
//     what keeps a whole-catalogue run from killing the tab.
//   • A CASUALTY IS PER TASK. One rejection never aborts the batch and never
//     escapes as a throw; it is collected, named, and the rest still finish.
//   • RESUMABLE. A state from an interrupted run picks up exactly where it
//     stopped and re-runs nothing that already succeeded.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQueueState,
  failedTasks,
  pendingTasks,
  queueProgress,
  queueReduce,
  retryFailed,
  runQueue,
} from '../src/vm/queue.ts';

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Task ${i}` }));

test('concurrency never exceeds the ceiling, whatever the queue length', async () => {
  const state = createQueueState<number>(tasks(12), { concurrency: 3 });
  let inFlight = 0;
  let peak = 0;
  const final = await runQueue<number>(state, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return 1;
  });
  assert.equal(peak, 3);
  assert.equal(queueProgress(final).done, 12);
  assert.equal(final.running, false);
});

test('a rejected task is a casualty, not an abort', async () => {
  const state = createQueueState<string>(tasks(5), { concurrency: 3 });
  const final = await runQueue<string>(state, async (item) => {
    if (item.id === 't2') throw new Error('bad file');
    return item.id;
  });
  const progress = queueProgress(final);
  assert.equal(progress.done, 4);
  assert.equal(progress.failed, 1);
  assert.deepEqual(failedTasks(final).map((t) => [t.id, t.error]), [['t2', 'bad file']]);
  // Everything else really ran and really carries its result.
  assert.deepEqual(
    final.items.filter((i) => i.state === 'done').map((i) => i.result),
    ['t0', 't1', 't3', 't4'],
  );
});

test('a run resumes: nothing already done is run twice', async () => {
  const first = createQueueState<number>(tasks(4), { concurrency: 2 });
  const ran: string[] = [];
  const half = await runQueue<number>(first, async (item) => {
    ran.push(item.id);
    if (item.id === 't3') throw new Error('interrupted');
    return 1;
  });
  assert.equal(queueProgress(half).failed, 1);

  ran.length = 0;
  const resumed = await runQueue<number>(retryFailed(half), async (item) => {
    ran.push(item.id);
    return 1;
  });
  assert.deepEqual(ran, ['t3'], 'only the casualty is retried');
  assert.equal(queueProgress(resumed).done, 4);
  assert.equal(queueProgress(resumed).failed, 0);
  // The retry is a RESUME, not a fresh run: the attempt count carries.
  assert.equal(resumed.items.find((i) => i.id === 't3')!.attempts, 2);
});

test('an empty queue is finished, not stuck', async () => {
  const final = await runQueue(createQueueState([]), async () => 1);
  const p = queueProgress(final);
  assert.equal(p.total, 0);
  assert.equal(p.ratio, 1);
  assert.equal(final.running, false);
});

test('progress reports what is in flight, and pendingTasks is the resume point', () => {
  let state = createQueueState<number>(tasks(3), { concurrency: 3 });
  state = queueReduce(state, { type: 'task-start', id: 't0' });
  state = queueReduce(state, { type: 'task-done', id: 't0', result: 7 });
  state = queueReduce(state, { type: 'task-start', id: 't1' });
  const p = queueProgress(state);
  assert.deepEqual([p.done, p.running, p.pending, p.failed], [1, 1, 1, 0]);
  assert.deepEqual(p.current, ['Task 1']);
  assert.deepEqual(pendingTasks(state).map((t) => t.id), ['t2']);
});

test('an event for an unknown id is ignored, never a throw', () => {
  const state = createQueueState<number>(tasks(1));
  const next = queueReduce(state, { type: 'task-done', id: 'ghost', result: 1 });
  assert.equal(next, state, 'the state is returned untouched');
});
