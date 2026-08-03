// SAVING — the three rules, each of them the answer to a real failure.
//
//   • the fan-out runs BOUNDED and in parallel, because waiting for each round
//     trip made a save cost as many trips as the collection has models;
//   • a save hands back TWO handles: the UI releases on `committed`, the next
//     save on the same model queues behind `done` — so a second edit still
//     lands after the first, fan-out included, never woven through it;
//   • a FAILED save stops the clock. The draft is dirty again, so re-arming on
//     it would spin: one commit, one read and one fan-out every 900 ms for as
//     long as the network is down. The next EDIT is the retry.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTOSAVE_MS, armAutosave, createSaveQueue, resolveSaveStatus, runPool } from '../src/vm/save.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the fan-out runs in a BOUNDED pool, in order, and never abandons the rest', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  const { failed, failedIndexes } = await runPool(items, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(n);
    inFlight--;
    if (n === 7 || n === 13) throw new Error('sibling gone');
  }, { concurrency: 6 });

  assert.ok(peak <= 6, `at most six writes in the air, saw ${peak}`);
  assert.ok(peak > 1, 'and genuinely in parallel — single file is the wait this replaces');
  assert.equal(seen.length, 20, 'one dead sibling never abandons the other nineteen');
  assert.equal(failed, 2);
  assert.deepEqual(failedIndexes, [7, 13]);
});

test('an empty fan-out is not a lane, and one item is not six', async () => {
  assert.deepEqual(await runPool([], async () => {}), { failed: 0, failedIndexes: [] });
  let peak = 0; let now = 0;
  await runPool([1], async () => { now++; peak = Math.max(peak, now); await tick(); now--; });
  assert.equal(peak, 1);
});

test('TWO handles: the UI releases at `committed`, the next save queues behind `done`', async () => {
  const order: string[] = [];
  let releaseFanout: (() => void) | null = null;
  const queue = createSaveQueue<string>({
    async commit(id, payload) { order.push(`commit:${payload}`); },
    async fanout(id, payload) {
      order.push(`fanout-start:${payload}`);
      await new Promise<void>((r) => { releaseFanout = r; });
      order.push(`fanout-end:${payload}`);
    },
  });

  const first = queue.save('m1', 'A');
  await first.committed;
  // The dealer is free HERE — the fan-out over rows he isn't looking at is
  // still running.
  assert.deepEqual(order, ['commit:A', 'fanout-start:A']);

  // A second edit on the SAME model queues behind the whole first save.
  const second = queue.save('m1', 'B');
  await tick();
  assert.deepEqual(order, ['commit:A', 'fanout-start:A'], 'B has not started: it waits for A, fan-out included');

  releaseFanout!();
  await second.committed;
  assert.deepEqual(order.slice(0, 4), ['commit:A', 'fanout-start:A', 'fanout-end:A', 'commit:B']);
  releaseFanout!();
  await second.done;
  await tick();
  assert.equal(queue.pending('m1'), false, 'the last chain clears its own slot');
});

test('different models never wait on each other — that was the other half of the wait', async () => {
  const started: string[] = [];
  let release: (() => void) | null = null;
  const queue = createSaveQueue<string>({
    async commit(id) {
      started.push(id);
      if (id === 'slow') await new Promise<void>((r) => { release = r; });
    },
  });
  const slow = queue.save('slow', 'x');
  const fast = queue.save('fast', 'y');
  await fast.committed;
  assert.deepEqual(started, ['slow', 'fast']);
  release!();
  await slow.done;
});

test('a failed commit surfaces, does NOT fan out, and leaves the chain usable', async () => {
  let fanned = 0;
  const queue = createSaveQueue<string>({
    async commit(id, payload) { if (payload === 'bad') throw new Error('row rejected'); },
    async fanout() { fanned++; },
  });
  const bad = queue.save('m1', 'bad');
  await assert.rejects(() => bad.committed, /row rejected/);
  await bad.done.catch(() => {});
  assert.equal(fanned, 0, 'a row that was never written is never fanned out');

  const good = queue.save('m1', 'ok');
  await good.committed;
  await good.done;
  assert.equal(fanned, 1);
});

test('a fan-out failure surfaces on `done` and never on `committed`', async () => {
  const queue = createSaveQueue<string>({
    async commit() {},
    async fanout() { throw new Error('siblings unreachable'); },
  });
  const h = queue.save('m1', 'x');
  await h.committed;                                  // the dealer is released
  await assert.rejects(() => h.done, /siblings unreachable/);
});

test('the clock: dirty arms it, an ERROR stops it, an edit is the retry', () => {
  assert.deepEqual(armAutosave({ dirty: true }), { arm: true, delayMs: AUTOSAVE_MS, reason: 'ready' });
  assert.equal(armAutosave({ dirty: false }).arm, false);
  // THE GATE. Re-arming on a failure means a commit + a read + a fan-out every
  // 900 ms for as long as the network stays down.
  assert.deepEqual(armAutosave({ dirty: true, error: 'offline' }).reason, 'failed');
  assert.equal(armAutosave({ dirty: true, saving: true }).reason, 'saving');
  // …and the next edit clears the error, which IS the retry.
  assert.equal(armAutosave({ dirty: true, error: null }).arm, true);
  assert.equal(AUTOSAVE_MS, 900);
});

test('the status strip says what happened — there is nothing to press', () => {
  assert.deepEqual(resolveSaveStatus({ dirty: false, saving: false }), { show: false, level: 'ok', label: '' });
  assert.equal(resolveSaveStatus({ dirty: true, saving: false }).label, 'Saving…');
  assert.equal(resolveSaveStatus({ dirty: false, saving: true }).label, 'Saving…');
  assert.equal(resolveSaveStatus({ dirty: false, saving: false, fanoutFailed: 3 }).level, 'warn');
  const bad = resolveSaveStatus({ dirty: true, saving: false, error: 'offline' });
  assert.equal(bad.level, 'bad');
  assert.equal(bad.label, 'offline');
});
