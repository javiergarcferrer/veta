/**
 * The solid-body segmentation, OFF the main thread — `splitSolids` is pure math
 * over two flat buffers, which makes it the textbook Web Worker: the page posts
 * the buffers (transferred, not copied — postMessage moves ownership, zero
 * bytes cloned), the classifier runs here, and only the verdict travels back
 * (triangle lists packed as transferable Uint32Arrays for the same reason).
 *
 * The worker is deliberately DUMB: no queueing, no state, one message in → one
 * message out, matched by `id`. All policy — the singleton, the FIFO, the
 * crash-and-respawn, the inline fallback when Workers don't exist (node tests,
 * ancient WebViews) — lives with the caller in sceneImport.js, so there is
 * exactly one place that decides what happens when this thread dies.
 */
import { splitSolids } from './solidSplit.js';

self.onmessage = (e) => {
  const { id, positions, indices } = e.data || {};
  try {
    const { solids, weldTolerance } = splitSolids({ positions, indices });
    const packed = solids.map((s) => ({ ...s, triangles: Uint32Array.from(s.triangles) }));
    self.postMessage(
      { id, ok: true, solids: packed, weldTolerance },
      packed.map((s) => s.triangles.buffer),
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
