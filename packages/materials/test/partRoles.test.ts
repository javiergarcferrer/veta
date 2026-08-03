/**
 * The PART-ROLE model — per-part fabric/SKU rules for structured collections:
 * stable part keys off pCon material names, the shape split, role inheritance,
 * and the billed-unit count with its ceiling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PART_ROLES, PART_LABELS, MATERIALIZATION_ROLES, UNPRICED_ROLES, BILLED_ROLES, COUNT_MAX,
  DEFAULT_PART_ROLES, DEFAULT_ROLE_SET,
  partKeyFor, partRoleFor, baseKeyOf, hasParts, accessoryRoleFor, partKeysFor, partCount,
} from '../src/index.ts';
import type { PartRoleSet } from '../src/index.ts';

test('part keys ride the export material name; unnamed falls back to node index', () => {
  assert.equal(partKeyFor('0fe0a9f1-c7e0-4077-b711-c3bbbeaf1683', 3), '0fe0a9f1-c7e0-4077-b711-c3bbbeaf1683');
  assert.equal(partKeyFor('  ', 3), '#3');
  assert.equal(partKeyFor(null, 0), '#0');
});

test('partRoleFor: untagged nodes and absent maps read as base (pre-parts behavior)', () => {
  assert.equal(partRoleFor(null, 'mat-a', 0), 'base');
  assert.equal(partRoleFor({}, 'mat-a', 0), 'base');
  const parts = { mats: { 'mat-a': 'cushion', '#2': 'bolster', 'mat-x': 'nonsense' } };
  assert.equal(partRoleFor(parts, 'mat-a', 0), 'cushion');
  assert.equal(partRoleFor(parts, '', 2), 'bolster');       // unnamed → positional key
  assert.equal(partRoleFor(parts, 'mat-x', 0), 'base');     // unknown role → base
  assert.equal(partRoleFor(parts, 'mat-z', 0), 'base');     // untagged → base
  assert.ok(!hasParts({ mats: { a: 'base' } }));
  assert.ok(hasParts(parts));
  for (const r of PART_ROLES) assert.ok(PART_LABELS[r], `label for ${r}`);
});

test('the taxonomy is DATA: the seven roles are the DEFAULT, not the only ones', () => {
  // Phase 1 makes the role LIST per-collection; Phase 0 pins the current seven
  // as the default set so nothing has to pass one, and adding the parameter
  // could not break a caller.
  assert.deepEqual([...DEFAULT_PART_ROLES], [...PART_ROLES]);
  assert.deepEqual(DEFAULT_ROLE_SET.all, PART_ROLES);
  assert.deepEqual(DEFAULT_ROLE_SET.unpriced, UNPRICED_ROLES);
  assert.equal(DEFAULT_ROLE_SET.labels, PART_LABELS);
  // ONE question for "does this bill?": zones and structures answer together,
  // which is what keeps a fourth unpriced role out of the billed slots.
  assert.deepEqual([...UNPRICED_ROLES], [...MATERIALIZATION_ROLES, 'structure']);

  // A collection with its own vocabulary reads through the same functions.
  const shelving: PartRoleSet = {
    all: ['base', 'shelf', 'bracket'],
    unpriced: ['bracket'],
    labels: { base: 'Base', shelf: 'Estante', bracket: 'Soporte' },
  };
  const parts = { mats: { m1: 'shelf', m2: 'bracket', m3: 'cushion' }, counts: { shelf: 3, bracket: 4 } };
  assert.equal(partRoleFor(parts, 'm1', 0, undefined, shelving), 'shelf');
  assert.equal(partRoleFor(parts, 'm3', 0, undefined, shelving), 'base', 'a role outside the set is untagged');
  assert.ok(hasParts(parts, shelving));
  assert.equal(partCount(parts, 'shelf', shelving), 3);
  assert.equal(partCount(parts, 'bracket', shelving), 0, 'its own unpriced list is honoured');
  // …and the default set still answers the default way about the same data.
  assert.equal(partRoleFor(parts, 'm3', 0), 'cushion');
  // Which is exactly why the set has to be a parameter rather than a guess:
  // under the DEFAULT taxonomy nothing marks a bracket price-neutral, so its
  // typed count rides straight through. `unpriced` is the only list partCount
  // reads, and a collection that has one must say so.
  assert.equal(partCount(parts, 'bracket'), 4);
});

test('the label is presentation; `base` is the TOKEN and never moves', () => {
  // «Cuerpo» is the trade word for the upholstered shell. «Base» named the same
  // thing as the metal bases the estructura rows offer, so the two vocabularies
  // collided on screen. What changed is ONLY what a human reads: the role KEY
  // stays `base` — it is the money rule's own name (base SKU + componentes) and
  // the token every stored tagging, price path and payload is keyed on, so
  // renaming it would silently re-file every tagged model as untagged.
  assert.equal(PART_LABELS.base, 'Cuerpo');
  assert.ok(PART_ROLES.includes('base'), 'the token is untouched by the rename');
  assert.equal(partRoleFor({ mats: { m: 'base' } }, 'm', 0), 'base');
});

test('BILLED_ROLES: the billable slots, derived so an unpriced role can never leak in', () => {
  // The slots a model can bind a part SKU to = the roles MINUS `base` (it bills
  // as the model itself) MINUS the price-neutral ones. Derived rather than
  // listed, so adding an unpriced role can't accidentally open a billing slot.
  assert.deepEqual([...BILLED_ROLES], ['cushion', 'bolster', 'armCushion']);
  for (const role of BILLED_ROLES) {
    assert.ok(!UNPRICED_ROLES.includes(role), `${role} must never be a billed slot`);
    assert.equal(partCount({ mats: { m: role } }, role), 1, `${role} can bill`);
  }
  assert.ok(!BILLED_ROLES.includes('base'));
});

test('partKeysFor: a material covering TWO part types splits by shape, first cluster keeps the name', () => {
  // The reported fault: on a Medium Sofa 120 Depth / Large Sofa the back
  // cushions and the bolster come out of pCon in ONE cloth, so they shared a
  // part key. Merged, their boxes averaged a slab and a roll into a shape that
  // is neither — nothing downstream could tell them apart, tag them apart or
  // price them apart. Cushions are near-identical boxes; a bolster is not.
  const nodes = [
    { materialName: 'platform', size: [200, 35, 100] },
    { materialName: 'cloth', size: [64, 50, 22] },   // back cushion
    { materialName: 'cloth', size: [66, 51, 23] },   // back cushion (within ±20%)
    { materialName: 'cloth', size: [64, 50, 22] },   // back cushion
    { materialName: 'cloth', size: [180, 18, 18] },  // bolster — a different shape entirely
  ];
  assert.deepEqual(partKeysFor(nodes), ['platform', 'cloth', 'cloth', 'cloth', 'cloth~2']);

  // A model whose materials already separate its parts is untouched — the split
  // is a no-op wherever pCon did the right thing, which is most of the time.
  const clean = [
    { materialName: 'plat', size: [200, 35, 100] },
    { materialName: 'cush', size: [64, 50, 22] },
    { materialName: 'cush', size: [64, 50, 22] },
    { materialName: 'roll', size: [180, 18, 18] },
  ];
  assert.deepEqual(partKeysFor(clean), ['plat', 'cush', 'cush', 'roll']);

  // Unnamed materials keep the positional fallback, and a sizeless node joins
  // the first cluster rather than inventing one.
  assert.deepEqual(partKeysFor([{ materialName: '', size: [1, 1, 1] }]), ['#0']);
  assert.deepEqual(
    partKeysFor([{ materialName: 'c', size: [10, 10, 10] }, { materialName: 'c' }]),
    ['c', 'c'],
  );
  assert.deepEqual(partKeysFor(null), []);

  // Orientation-free, like every other size comparison here: the same cushion
  // turned 90° on the floor is the same cushion, not a second cluster.
  assert.deepEqual(
    partKeysFor([{ materialName: 'c', size: [64, 50, 22] }, { materialName: 'c', size: [22, 50, 64] }]),
    ['c', 'c'],
  );
});

test('a split cluster INHERITS its material tag until the dealer gives it one', () => {
  // Back-compat is the whole reason cluster 0 keeps the bare name: every model
  // tagged before parts could split must render exactly as it did.
  const legacy = { mats: { cloth: 'cushion' } };
  assert.equal(partRoleFor(legacy, 'cloth', 1, 'cloth'), 'cushion');
  assert.equal(partRoleFor(legacy, 'cloth', 4, 'cloth~2'), 'cushion', 'inherits until re-tagged');

  // Once the dealer says the second cluster is the bolster, only that one moves.
  const tagged = { mats: { cloth: 'cushion', 'cloth~2': 'bolster' } };
  assert.equal(partRoleFor(tagged, 'cloth', 1, 'cloth'), 'cushion');
  assert.equal(partRoleFor(tagged, 'cloth', 4, 'cloth~2'), 'bolster');

  // No tag anywhere is still base, and a material genuinely containing a tilde
  // is not mistaken for a split key.
  assert.equal(partRoleFor({ mats: {} }, 'cloth', 4, 'cloth~2'), 'base');
  assert.equal(partRoleFor({ mats: { 'a~b': 'cushion' } }, 'a~b', 0, 'a~b'), 'cushion');
  assert.equal(baseKeyOf('cloth~2'), 'cloth');
  assert.equal(baseKeyOf('a~b'), 'a~b');
  assert.equal(baseKeyOf('cloth'), 'cloth');
});

test('accessoryRoleFor: the loose uploads name their role, both languages', () => {
  assert.equal(accessoryRoleFor('Back Cushion'), 'cushion');
  assert.equal(accessoryRoleFor('Cojín respaldo'), 'cushion');
  assert.equal(accessoryRoleFor('Bolster'), 'bolster');
  assert.equal(accessoryRoleFor('Rulo Prado'), 'bolster');
  assert.equal(accessoryRoleFor('Arm Cushion'), 'armCushion');
  assert.equal(accessoryRoleFor('Cojín de brazo'), 'armCushion');
  assert.equal(accessoryRoleFor('Medium Sofa 100 Depth'), null);
  assert.equal(accessoryRoleFor('High Table'), null);
  assert.equal(accessoryRoleFor(null), null);
});

test('materialization zones and structures NEVER bill — the base SKU is the complete materialization', () => {
  const parts = { mats: { body: 'exterior', plinth: 'interior', legs: 'structure' } };
  for (const role of UNPRICED_ROLES) {
    assert.equal(partCount(parts, role), 0, `${role} bills 0 by default`);
    // Bind-proof: even a stray count or SKU root can't make one charge.
    assert.equal(partCount({ ...parts, counts: { [role]: 3 }, roots: { [role]: '11370011' } }, role), 0);
  }
  // They still EXIST for editing — a structure is a real choice the client
  // makes (acero vs acero lacado negro), it is simply never money.
  assert.ok(hasParts(parts));
  assert.equal(PART_LABELS.structure, 'Estructura');
});

test('partCount bills the bound SKU ONCE by default (sets cover the module); explicit counts override', () => {
  // The catalog sells cushions as singles or SETS (juego de 2/3): the dealer
  // binds the set matching the module, so TWO tagged cushions still bill ONE
  // set SKU.
  const parts = { mats: { m1: 'cushion', m2: 'cushion', m3: 'bolster' } };
  assert.equal(partCount(parts, 'cushion'), 1, 'two physical cushions → one set SKU');
  assert.equal(partCount(parts, 'bolster'), 1);
  assert.equal(partCount(parts, 'armCushion'), 0, 'untagged role never bills');
  assert.equal(partCount({ ...parts, counts: { cushion: 2 } }, 'cushion'), 2, 'explicit override (2 × single SKU)');
  assert.equal(partCount({ ...parts, counts: { cushion: 0 } }, 'cushion'), 0, 'explicit 0 disables billing');
  assert.equal(partCount(null, 'cushion'), 0);
});

// ── THE COUNT CEILING. `counts` is the only dealer-TYPED number that reaches a
// quote as a quantity, and nothing between the keyboard and the total used to
// question it: counts.cushion = 100000 on an ordinary bicolor build priced out
// at $30,004,800, and the auto-quote path would have sent that to the client.
test('partCount CLAMPS a typed count — an out-of-range one falls back, it never rides through', () => {
  const parts = { mats: { m1: 'cushion', m2: 'cushion', m3: 'bolster' } };

  // The ceiling itself is a legal count: it is far above any real module (the
  // catalog's juegos run to 3) and must not become an off-by-one refusal.
  assert.equal(COUNT_MAX, 20);
  assert.equal(partCount({ ...parts, counts: { cushion: COUNT_MAX } }, 'cushion'), COUNT_MAX);
  assert.equal(partCount({ ...parts, counts: { cushion: COUNT_MAX - 1 } }, 'cushion'), 19);

  // THE FAT FINGER: over the ceiling falls back to the mesh-derived default —
  // one set SKU for a tagged role — rather than saturating at 20. A quote that
  // silently reads "20 × cojín" is a wrong number someone signs; "1 × cojín" is
  // the tagging's own answer.
  assert.equal(partCount({ ...parts, counts: { cushion: 100000 } }, 'cushion'), 1);
  assert.equal(partCount({ ...parts, counts: { cushion: COUNT_MAX + 1 } }, 'cushion'), 1);
  // Rounding happens BEFORE the range check, so 20.6 is 21 and out.
  assert.equal(partCount({ ...parts, counts: { cushion: 20.6 } }, 'cushion'), 1);
  assert.equal(partCount({ ...parts, counts: { cushion: 20.4 } }, 'cushion'), 20);
  // An out-of-range count on an UNTAGGED role falls back to that role's own
  // default, which is 0 — never to some ceiling it was nowhere near.
  assert.equal(partCount({ ...parts, counts: { armCushion: 100000 } }, 'armCushion'), 0);

  // The ESTABLISHED behaviour for the other end of the range, unchanged: a
  // negative has always fallen back to the default too (never clamped to 0),
  // and Infinity/NaN/garbage are not finite so they fall back as well. The
  // ceiling joined this idiom rather than inventing a second one.
  assert.equal(partCount({ ...parts, counts: { cushion: -5 } }, 'cushion'), 1);
  assert.equal(partCount({ ...parts, counts: { cushion: -0.4 } }, 'cushion'), 1);
  assert.equal(partCount({ ...parts, counts: { armCushion: -5 } }, 'armCushion'), 0);
  assert.equal(partCount({ ...parts, counts: { cushion: Infinity } }, 'cushion'), 1);
  assert.equal(partCount({ ...parts, counts: { cushion: 'muchos' } }, 'cushion'), 1);
  // An explicit 0 is still a real answer (billing off), not an out-of-range one.
  assert.equal(partCount({ ...parts, counts: { cushion: 0 } }, 'cushion'), 0);
});
