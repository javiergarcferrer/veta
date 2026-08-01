// THE CONTACT GRAPH — adjacency derived from placed geometry, not from authored
// ports. The pins: a flush dock and a NESTED dock both read as contact (the
// 9 cm nest is a join, not a gap and not an overlap), a corner-kiss does not,
// edge names are resolved in each piece's own frame at 90° steps and refuse to
// name anything off them, and seat-mounted accessories never enter the graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactGraph, localEdgeOf, neighboursOf } from '../src/index.ts';
import type { PlacedPiece, RuleCatalog } from '../src/index.ts';

const catalog: RuleCatalog = {
  modelById: {
    'vira-arm': { collection: 'vira', tags: ['arm'], widthCm: 40, depthCm: 90 },
    'vira-seat': { collection: 'vira', tags: ['seat'], widthCm: 80, depthCm: 90 },
    'vira-cushion': { collection: 'vira', tags: ['cushion'], widthCm: 50, depthCm: 50, mount: 'seat' },
    // Same footprint, two collections: one nests 9 cm when docked, one doesn't.
    'nest-piece': { collection: 'saparella', tags: ['fireside'], widthCm: 78, depthCm: 102 },
    'flat-piece': { collection: 'duna', tags: ['fireside'], widthCm: 78, depthCm: 102 },
    'square': { collection: 'vira', tags: ['seat'], widthCm: 100, depthCm: 100 },
  },
};

const piece = (uid: string, modelId: string, x: number, y: number, rot = 0): PlacedPiece =>
  ({ uid, modelId, x, y, rot });

test('a flush dock is a contact, named in EACH piece local frame', () => {
  const graph = contactGraph(
    [piece('a1', 'vira-arm', 0, 0), piece('s1', 'vira-seat', 40, 0)],
    catalog,
  );
  assert.equal(graph.contacts.length, 1);
  assert.deepEqual(graph.contacts[0], {
    a: 'a1', b: 's1', edgeA: 'right', edgeB: 'left', freeform: false, spanCm: 90, gapCm: 0,
  });
  // Both pieces see the same contact, each from its own side.
  assert.deepEqual(neighboursOf(graph, 's1').map((n) => [n.other, n.edge]), [['a1', 'left']]);
  assert.deepEqual(neighboursOf(graph, 'a1').map((n) => [n.other, n.edge]), [['s1', 'right']]);
});

test('rotation renames the edge: an arm at 180° meets the run on its own RIGHT', () => {
  const graph = contactGraph(
    [piece('s2', 'vira-seat', 120, 0), piece('a2', 'vira-arm', 200, 0, 180)],
    catalog,
  );
  assert.equal(graph.contacts.length, 1);
  assert.deepEqual([graph.contacts[0].edgeA, graph.contacts[0].edgeB], ['right', 'right']);
});

test('localEdgeOf pins the whole world→local table at the 90° steps', () => {
  const [east, west, south, north] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const table: Record<number, string[]> = {
    0: ['right', 'left', 'front', 'back'],
    90: ['back', 'front', 'right', 'left'],
    180: ['left', 'right', 'back', 'front'],
    270: ['front', 'back', 'left', 'right'],
  };
  for (const [rot, expected] of Object.entries(table)) {
    const got = [east, west, south, north].map(([x, y]) => localEdgeOf(x, y, Number(rot)));
    assert.deepEqual(got, expected, `rot ${rot}`);
  }
  // Off the grid nothing is named — that is the honest boundary of the design.
  assert.equal(localEdgeOf(1, 0, 45), null);
  assert.equal(localEdgeOf(1, 0, 0.5), null);
  assert.equal(localEdgeOf(1, 0, -90), 'front', 'normalises like the layout engine');
});

test('a NESTED dock reads as contact — the 9 cm nest is a join, not a gap', () => {
  // Two same-collection pieces docked at the collection's nest depth.
  const nested = contactGraph(
    [piece('n1', 'nest-piece', 0, 0), piece('n2', 'nest-piece', 69, 0)],
    catalog,
  );
  assert.equal(nested.contacts.length, 1, 'the nest must not read as "no contact"');
  assert.deepEqual([nested.contacts[0].edgeA, nested.contacts[0].edgeB], ['right', 'left']);
  assert.equal(nested.contacts[0].gapCm, -9);

  // The SAME geometry in a collection that docks flush is an overlap, not a dock.
  const flat = contactGraph(
    [piece('f1', 'flat-piece', 0, 0), piece('f2', 'flat-piece', 69, 0)],
    catalog,
  );
  assert.deepEqual(flat.contacts, [], 'the nest is per-collection, never global');

  // …and that same flat collection docked FLUSH is a contact.
  const flush = contactGraph(
    [piece('f1', 'flat-piece', 0, 0), piece('f2', 'flat-piece', 78, 0)],
    catalog,
  );
  assert.equal(flush.contacts.length, 1);
});

test('a corner-kiss is not a neighbour, a shared span AT the floor is', () => {
  const kiss = contactGraph([piece('k1', 'square', 0, 0), piece('k2', 'square', 100, 100)], catalog);
  assert.deepEqual(kiss.contacts, []);

  const grazing = contactGraph([piece('k1', 'square', 0, 0), piece('k2', 'square', 100, 90)], catalog);
  assert.equal(grazing.contacts.length, 1, 'exactly minContactCm (10) still docks');
  assert.equal(grazing.contacts[0].spanCm, 10);

  const under = contactGraph([piece('k1', 'square', 0, 0), piece('k2', 'square', 100, 91)], catalog);
  assert.deepEqual(under.contacts, [], '9 cm of shared span is a corner-kiss');

  // …and the ruleset can raise the floor: a strict system asks for 30.
  const strict = contactGraph(
    [piece('k1', 'square', 0, 0), piece('k2', 'square', 100, 90)],
    catalog,
    { minContactCm: 30 },
  );
  assert.deepEqual(strict.contacts, []);
});

test('contactEps is the gap that still counts as touching', () => {
  const within = contactGraph([piece('k1', 'square', 0, 0), piece('k2', 'square', 101, 0)], catalog);
  assert.equal(within.contacts.length, 1);
  assert.equal(within.contacts[0].gapCm, 1);

  const beyond = contactGraph([piece('k1', 'square', 0, 0), piece('k2', 'square', 102, 0)], catalog);
  assert.deepEqual(beyond.contacts, [], 'a 2 cm gap is a gap');

  const widened = contactGraph(
    [piece('k1', 'square', 0, 0), piece('k2', 'square', 102, 0)],
    catalog,
    { contactEps: 3 },
  );
  assert.equal(widened.contacts.length, 1);
});

test('a free-angle contact is classified freeform and names NO edge', () => {
  const graph = contactGraph(
    [piece('s1', 'vira-seat', 0, 0), piece('s3', 'vira-seat', 80, 0, 45)],
    catalog,
  );
  assert.equal(graph.contacts.length, 1);
  assert.deepEqual(graph.contacts[0], {
    a: 's1', b: 's3', edgeA: null, edgeB: null, freeform: true, spanCm: 90, gapCm: 0,
  });
  assert.deepEqual(neighboursOf(graph, 's1').map((n) => n.edge), [null]);
});

test('seat-mounted accessories never enter the graph — and are reported, not lost', () => {
  const graph = contactGraph(
    [piece('s1', 'vira-seat', 0, 0), piece('c1', 'vira-cushion', 10, 10), piece('s2', 'vira-seat', 80, 0)],
    catalog,
  );
  assert.deepEqual(graph.contacts.map((c) => [c.a, c.b]), [['s1', 's2']]);
  assert.deepEqual(graph.excluded, ['c1']);
  assert.deepEqual(Object.keys(graph.byPiece).sort(), ['s1', 's2']);
});

test('the graph is throw-free over junk: unknown models, no uids, duplicate uids', () => {
  const graph = contactGraph(
    [
      piece('s1', 'vira-seat', 0, 0),
      piece('ghost', 'not-in-catalog', 80, 0),
      { uid: '', modelId: 'vira-seat', x: 0, y: 0 },
      piece('s1', 'vira-seat', 500, 0),                 // duplicate uid — first wins
      null as unknown as PlacedPiece,
      { uid: 'nan', modelId: 'vira-seat', x: 'left' as unknown as number, y: NaN },
    ],
    catalog,
  );
  assert.deepEqual(graph.excluded, ['ghost']);
  assert.deepEqual(Object.keys(graph.byPiece).sort(), ['nan', 's1']);
  assert.deepEqual(contactGraph(null, null).contacts, []);
  assert.deepEqual(contactGraph(undefined, { modelById: {} }, { contactEps: 'wide' as unknown as number }).contacts, []);
});
