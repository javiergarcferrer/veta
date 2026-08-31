// Mesh part model — per-part fabric/SKU rules for structured collections
// (Prado…): stable part keys off pCon material names, the admin tagger's
// heuristic proposal, billed-unit counts, the price roll-up, the lead payload
// sanitizer, and the seat mount. Pure Model (src/lib/configurator/meshParts.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PART_ROLES, PART_LABELS, MATERIALIZATION_ROLES, UNPRICED_ROLES, COUNT_MAX, partKeyFor, partRoleFor, hasParts,
  PART_KINDS, partKind, rolesOfKind, billsMoney, takesMaterial,
  classifyPartGroups, partCount, partMeshCount, piecePartsTotal, sanitizePartMaterials, mountOf,
  isGroundShadowBox, accessoryRoleFor, partKeysFor, baseKeyOf,
  mergedKeyOf, partLabelOf, finishSpecOf, finishOptionOf, sanitizePartFinishes,
  roleLabelOf, BILLED_ROLES, planPartJoin, planPartSplit,
} from '../src/lib/configurator/meshParts.js';

test('isGroundShadowBox: only a degenerate-flat floor decal matches — real parts never do', () => {
  // The measured Prado settee (object y 0→87 cm): its pCon ground-shadow plane
  // is 0.0 cm thick at y 0.3 — the artifact that inflated the tile to 179 cm
  // when the platform is 160 (making front/back joins impossible).
  assert.ok(isGroundShadowBox(0.3, 0.3, 0, 87));
  // Real parts: platform slab, seat pad, bolster panel, cushions — all kept.
  assert.ok(!isGroundShadowBox(8.8, 41.3, 0, 87), 'platform');
  assert.ok(!isGroundShadowBox(0, 8.8, 0, 87), 'seat pad');
  assert.ok(!isGroundShadowBox(40, 56, 0, 87), 'bolster');
  // A thin ELEVATED slab (glass tabletop) is furniture — never stripped.
  assert.ok(!isGroundShadowBox(72, 72.5, 0, 75));
  // A rug-like model (the whole object IS flat) never matches its own mesh.
  assert.ok(!isGroundShadowBox(0, 1.5, 0, 1.5));
  assert.ok(!isGroundShadowBox(0, 0, 0, 0), 'degenerate object');
});
import {
  PART_ROLES as DENO_PART_ROLES,
  PART_KINDS as DENO_PART_KINDS,
  MATERIALIZATION_ROLES as DENO_MATERIALIZATION_ROLES,
  COUNT_MAX as DENO_COUNT_MAX,
  partCount as denoPartCount,
  sanitizePartMaterials as denoSanitize,
  sanitizePartFinishes as denoSanitizeFinishes,
} from '../supabase/functions/togo-embed/dealer.ts';

// ── Deno↔Vite wall parity — the data rules live at TWO layers on purpose
// (like the quote-pick reducer); these pins go red if they drift. VETA's Deno
// half is the public widget's (togo-embed/dealer.ts); upstream additionally
// pins a quote-worker copy this deploy does not carry.
test('part rules agree across the Deno↔Vite wall (dealer.ts ↔ meshParts.js)', () => {
  assert.deepEqual([...DENO_PART_ROLES], [...PART_ROLES]);
  assert.deepEqual([...DENO_MATERIALIZATION_ROLES], [...MATERIALIZATION_ROLES]);
  // The fixture carries a STRUCTURE with a stray count on purpose: the unpriced
  // guard is what both halves must agree on, and it's a money rule (a widget
  // that charged for the legs the app quotes free is a wrong estimate). And an
  // OVER-CEILING cushion count — the fat-fingered «Se cobra ×» that billed a
  // part SKU 100000 times: the widget's estimate is the number a visitor sees,
  // so this half must fall back exactly like the Model (never 100000, and never
  // a saturated 20 — that would read as a quantity somebody meant to type).
  const parts = {
    mats: { m1: 'cushion', m2: 'cushion', m3: 'bolster', m4: 'structure' },
    counts: { bolster: 2, structure: 4, cushion: 100000 },
  };
  for (const role of PART_ROLES) {
    assert.equal(denoPartCount(parts, role), partCount(parts, role), `count parity for ${role}`);
  }
  assert.equal(DENO_COUNT_MAX, COUNT_MAX, 'the ceiling is duplicated across the wall BY DESIGN — it must not drift');
  assert.equal(denoPartCount(parts, 'cushion'), 1, 'out of range falls back to the ONE set SKU the tagging implies');

  const raw = {
    cushion: { grade: 'C', fabric: 'Divina 3', code: 'DIV3-224', junk: 1 },
    bolster: { grade: '', fabric: '', code: 'X' },
    base: { grade: 'A', fabric: 'nope' },
    structure: { grade: 'C', fabric: 'no lleva tela' },   // metal wears a finish
    invented: { grade: 'Z', fabric: 'Zz' },
  };
  assert.deepEqual(denoSanitize(raw), sanitizePartMaterials(raw));
  assert.equal(denoSanitize({}), null);
  assert.equal(sanitizePartMaterials({}), null);

  // The FINISH picks sanitize identically on both sides of the wall — the
  // widget's payload is trimmed client-side and re-trimmed server-side, and a
  // twin that clamps differently means the two disagree about what the dealer
  // actually picked. Every shape the widget can really post:
  const finishPayloads = [
    { legs: 'acero-negro' },                                  // the ordinary pick
    { ' legs ': ' acero ', arms: 'acero' },                   // untrimmed
    { legs: '', arms: '   ', feet: null },                    // nothing survives
    { legs: 42 },                                             // a numeric option id
    { ['k'.repeat(80)]: 'v'.repeat(60) },                     // over-long → 64 / 32
    {},
    Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`g${i}`, `o${i}`])), // capped at 12
  ];
  for (const p of finishPayloads) {
    assert.deepEqual(denoSanitizeFinishes(p), sanitizePartFinishes(p), `finish parity for ${JSON.stringify(p).slice(0, 40)}`);
  }
  assert.equal(denoSanitizeFinishes(null), null);
  assert.equal(sanitizePartFinishes(null), null);
});

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

test('classifyPartGroups tags a split material as the two parts it really is', () => {
  // End to end: the shared-cloth sofa above, keyed then classified. Before the
  // split this was ONE group spanning both, and it came back as a single role.
  const nodes = [
    { materialName: 'plat', size: [200, 35, 100] },
    { materialName: 'cloth', size: [64, 50, 22] },
    { materialName: 'cloth', size: [180, 18, 18] },
  ];
  const keys = partKeysFor(nodes);
  const groups = [
    { key: keys[0], min: [0, 0, 0], max: [200, 35, 100] },
    { key: keys[1], min: [10, 35, 5], max: [74, 85, 27] },
    { key: keys[2], min: [10, 35, 70], max: [190, 53, 88] },
  ];
  const out = classifyPartGroups(groups);
  assert.equal(out[keys[0]], 'base');
  assert.equal(out[keys[1]], 'cushion');
  assert.equal(out[keys[2]], 'bolster');

  // A split cluster ignores the MATERIAL fingerprint — its cloth is shared with
  // the other part type on this very model, so taking it would hand the bolster
  // the cushion's role and undo the split. Its shape is what it has.
  const refs = [{ role: 'cushion', matKeys: ['cloth'], size: [64, 50, 22] }];
  const withRefs = classifyPartGroups(groups, refs);
  assert.equal(withRefs[keys[1]], 'cushion', 'cluster 0 still takes the exact material match');
  assert.equal(withRefs[keys[2]], 'bolster', 'the split cluster is judged on shape, not the shared cloth');
});

test('the fused back-cushion slab of the REAL Prado Medium 120 is cushion, not bolster', () => {
  // Measured from the dealer's own Prado_MediumSofa_120.3ds (boxes in cm,
  // y-up after the tagger's remap). The three back cushions export FUSED as
  // one 174-wide slab — elongated enough (174/66 ≥ 2.5) that the old rule
  // filed it as a rulo alongside the real one, which is exactly the reported
  // "Medium Sofa 120 not detecting back cushions and bolster separately".
  const groups = [
    { key: 'COL1', min: [0, 0, 19], max: [151, 8.5, 100] },      // plinth under the platform
    { key: 'COL3', min: [0, 8.5, 0], max: [200, 40.5, 120] },    // platform
    { key: 'COL2', min: [40, 39.7, 75], max: [160, 55.7, 115] }, // the 120 bolster (16 cm tall)
    { key: 'COL4', min: [13, 37.2, 50], max: [187, 87, 116] },   // fused back cushions (50 cm tall)
  ];
  const out = classifyPartGroups(groups);
  assert.equal(out.COL3, 'base');
  assert.equal(out.COL2, 'bolster', 'the real rulo stays a rulo');
  assert.equal(out.COL4, 'cushion', 'the fused cushion slab must NOT file as a second rulo');
});

test('classifyPartGroups: a Prado-shaped settee tags platform/cushions/bolster/arm', () => {
  // Synthetic settee assembled from the measured shapes of the real GLBs:
  // a low full-footprint platform, two back cushions, one long thin bolster,
  // one lateral arm cushion.
  const roles = classifyPartGroups([
    { key: 'platform', min: [0, 0, 0], max: [160, 41, 179] },
    { key: 'cushL', min: [5, 40, 5], max: [75, 80, 40] },
    { key: 'cushR', min: [85, 40, 5], max: [155, 80, 40] },
    { key: 'roll', min: [10, 40, 140], max: [150, 65, 170] },
    { key: 'arm', min: [0, 41, 20], max: [35, 70, 120] },
  ]);
  assert.equal(roles.platform, 'base');
  assert.equal(roles.cushL, 'cushion');
  assert.equal(roles.cushR, 'cushion');
  assert.equal(roles.roll, 'bolster');
  assert.equal(roles.arm, 'armCushion');
});

test('classifyPartGroups: el zócalo es ESTRUCTURA, no un rulo — y por eso no factura', () => {
  // Measured on the dealer's own hand-tagged Prado Large Sofa (86 cm tall):
  // the plinth is a 187×8×54 slab ON THE FLOOR carrying a 240-wide platform.
  // Its footprint is 35% — under the 40% that makes a platform `base`, which
  // is exactly how it used to reach the bolster rule (187/54 = 3.5, elongated
  // and thin on any reading). `structure` was unreachable from the classifier
  // at all, so every plinth in the collection proposed as a BILLABLE part.
  const roles = classifyPartGroups([
    { key: 'plinth', min: [0, 0, 0], max: [187, 8, 54] },
    { key: 'platform', min: [0, 8, 0], max: [240, 26, 120] },
    { key: 'backs', min: [10, 36, 0], max: [235, 86, 47] },
    { key: 'roll', min: [40, 39, 40], max: [160, 55, 80] },
  ]);
  assert.equal(roles.plinth, 'structure');
  assert.equal(roles.platform, 'base');
  assert.equal(roles.backs, 'cushion');
  assert.equal(roles.roll, 'bolster');
  // THE MONEY CONSEQUENCE, pinned at the gate every price path crosses: the
  // misfiled plinth used to bill as a rulo. A structure never bills, whatever
  // is tagged or typed on it.
  assert.equal(partCount({ mats: roles }, 'structure'), 0);
  assert.equal(partCount({ mats: roles, counts: { structure: 3 } }, 'structure'), 0);
  assert.ok(!BILLED_ROLES.includes('structure'));

  // NEGATIVES — each clause of the rule earns its place.
  // A lone accessory model is ONE group that IS the whole piece: it rests on
  // the floor and is "thin" relative to itself, but carries nothing.
  assert.equal(classifyPartGroups([{ key: 'solo', min: [0, 0, 0], max: [54, 17, 17] }]).solo, 'base');
  // A seat pad sitting ABOVE the plinth is not itself a plinth.
  const stacked = classifyPartGroups([
    { key: 'plinth', min: [0, 0, 0], max: [180, 8, 54] },
    { key: 'platform', min: [0, 8, 0], max: [240, 26, 120] },
    { key: 'pad', min: [10, 26, 10], max: [230, 34, 110] },
  ]);
  assert.equal(stacked.plinth, 'structure');
  assert.equal(stacked.pad, 'cushion', 'a pad off the floor is never the plinth');
  // A group on the floor that carries nothing WIDER stays whatever it looked
  // like — the rule needs a body above it, not just a low position.
  const noBody = classifyPartGroups([
    { key: 'wide', min: [0, 0, 0], max: [240, 26, 120] },
    { key: 'rail', min: [0, 0, 130], max: [200, 6, 145] },
  ]);
  assert.equal(noBody.wide, 'base');
  assert.notEqual(noBody.rail, 'structure');
});

test('classifyPartGroups: the largest footprint anchors as base even when nothing sits low', () => {
  const roles = classifyPartGroups([
    { key: 'a', min: [0, 50, 0], max: [100, 80, 100] },
    { key: 'b', min: [0, 55, 0], max: [40, 75, 30] },
  ]);
  assert.equal(roles.a, 'base');
  assert.equal(Object.keys(roles).length, 2);
  assert.deepEqual(classifyPartGroups([]), {});
});

test('classifyPartGroups: a Prado OTTOMAN (body over a recessed plinth, nothing above) proposes exterior/interior zones', () => {
  // The measured Small Square Ottoman GLB: quilted body 100×100, 8..41 cm,
  // recessed plinth 52×62, 0..8 cm — its ONE graded SKU is the complete
  // materialization (monocolor/bicolor), so the pair tags as ZONES, never as
  // base+cojín (that mislabel is exactly what the owner reported).
  const roles = classifyPartGroups([
    { key: 'body', min: [2.5, 8, 11.5], max: [102.5, 41, 111.5] },
    { key: 'plinth', min: [26.5, 0, 30.5], max: [78.5, 8, 92.5] },
  ]);
  assert.deepEqual(roles, { body: 'exterior', plinth: 'interior' });
  // The ROUND ottoman exports ONE fabric group — stays base (monocolor only).
  assert.deepEqual(
    classifyPartGroups([{ key: 'solo', min: [0, 0, 0], max: [85, 41, 85] }]),
    { solo: 'base' },
  );
  // A sofa never matches: its cushions sit ABOVE the platform, so the
  // settee keeps base + cushions even though it ALSO has a low plinth.
  const settee = classifyPartGroups([
    { key: 'platform', min: [0, 9, 0], max: [160, 41, 160] },
    { key: 'plinth', min: [35, 0, 15], max: [125, 9, 145] },
    { key: 'cush', min: [40, 37, 5], max: [87, 87, 75] },
  ]);
  assert.equal(settee.platform, 'base');
  assert.equal(settee.plinth, 'base');
  assert.equal(settee.cush, 'cushion');
});

test('materialization zones NEVER bill — the base SKU is the complete materialization', () => {
  const parts = { mats: { body: 'exterior', plinth: 'interior' } };
  for (const role of MATERIALIZATION_ROLES) {
    assert.equal(partCount(parts, role), 0, `${role} bills 0 by default`);
    // Bind-proof: even a stray count or SKU root can't make a zone charge.
    assert.equal(partCount({ ...parts, counts: { [role]: 3 }, roots: { [role]: '11370011' } }, role), 0);
    assert.equal(denoPartCount({ ...parts, counts: { [role]: 3 } }, role), 0, `Deno parity for ${role}`);
  }
  // The zones still EXIST for editing (hasParts) and display (partMeshCount).
  assert.ok(hasParts(parts));
  assert.equal(partMeshCount(parts, 'exterior'), 1);
  // piecePartsTotal ignores zone prices even if a caller passes them.
  assert.equal(piecePartsTotal(3145, parts, { exterior: 999, interior: 999 }), 3145);
});

test('ESTRUCTURA: a real choice the client makes, and never money', () => {
  // The owner's ask (2026-07): «añadir la opción de pieza estructura … cosas
  // que van en lacado negro, acero … que se eligen pero no cambian el precio».
  // So a structure is a FIRST-CLASS tag — it has to survive a read, show its
  // palette and reach the lead — while being invisible to every price path.
  const parts = {
    mats: { COL3: 'base', legs: 'structure', frame: 'structure', cush: 'cushion' },
    // A stray root AND a typed count, the two ways a structure could sneak into
    // billing if the guard lived anywhere but partCount.
    roots: { cushion: '22222222', structure: '99999999' },
    counts: { structure: 4 },
    labels: { legs: 'Patas' },
    finishes: {
      legs: {
        label: 'Acabado',
        default: 'acero',
        options: [
          { id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1, rough: 0.3 },
          { id: 'acero-negro', label: 'Acero lacado negro', rgb: '#17181c', metal: 1, rough: 0.5 },
        ],
      },
    },
  };
  assert.ok(PART_ROLES.includes('structure'));
  assert.equal(PART_LABELS.structure, 'Estructura');

  // ── It cannot bill. Not once, not four times, not with a root bound.
  assert.equal(partCount(parts, 'structure'), 0);
  assert.equal(partMeshCount(parts, 'structure'), 2, 'but it EXISTS — two tagged groups');
  // The roll-up is deaf to it even when a caller hands it a price…
  assert.equal(piecePartsTotal(1000, parts, { cushion: 120, structure: 999 }), 1120);
  // …and tagging one changes NOTHING: the same piece without it prices the same.
  const without = { ...parts, mats: { COL3: 'base', cush: 'cushion' } };
  assert.equal(
    piecePartsTotal(1000, parts, { cushion: 120 }),
    piecePartsTotal(1000, without, { cushion: 120 }),
  );

  // ── ONE question for "does this bill?": zones and structures answer together,
  // which is what keeps a fourth unpriced role out of the billed slots.
  assert.deepEqual([...UNPRICED_ROLES], [...MATERIALIZATION_ROLES, 'structure']);
  for (const role of UNPRICED_ROLES) {
    assert.equal(partCount({ mats: { k: role }, counts: { [role]: 3 }, roots: { [role]: '111' } }, role), 0, role);
  }

  // ── It wears a FINISH, not cloth: a fabric pick aimed at one is dropped at
  // the door, while a bicolor ZONE pick (which re-grades the base SKU) survives.
  assert.deepEqual(
    sanitizePartMaterials({
      structure: { grade: 'C', fabric: 'Divina', code: 'D1' },
      interior: { grade: 'F', fabric: 'Alcantara', code: 'AL1' },
    }),
    { interior: { grade: 'F', fabric: 'Alcantara', code: 'AL1' } },
  );
  assert.deepEqual(sanitizePartFinishes({ legs: 'acero-negro' }), { legs: 'acero-negro' });

  // ── The dealer's word about what a group IS survives a read (and a split
  // cluster still inherits it, like every other role).
  assert.equal(partRoleFor(parts, 'legs', 0, 'legs'), 'structure');
  assert.equal(partRoleFor(parts, 'legs', 4, 'legs~2'), 'structure');
  assert.ok(hasParts(parts), 'a structure-tagged model has parts to edit');
  // The palette reads exactly as authored — it is the same finish machinery.
  const spec = finishSpecOf(parts, 'legs');
  assert.deepEqual(spec.options.map((o) => o.id), ['acero', 'acero-negro']);
  assert.equal(finishOptionOf(spec, undefined).label, 'Acero', 'unpicked → the dealer default');
  assert.equal(partLabelOf(parts, 'legs', PART_LABELS.structure), 'Patas');

  // ── The detector still PROPOSES nothing: no geometry says "this is metal",
  // so the dealer tags it. A settee classifies exactly as it always did.
  const roles = classifyPartGroups([
    { key: 'platform', min: [0, 0, 0], max: [160, 41, 179] },
    { key: 'cush', min: [5, 40, 5], max: [75, 80, 40] },
    { key: 'roll', min: [10, 40, 140], max: [150, 65, 170] },
  ]);
  assert.deepEqual(roles, { platform: 'base', cush: 'cushion', roll: 'bolster' });
  assert.ok(!Object.values(roles).includes('structure'));
});

test('partCount bills the bound SKU ONCE by default (sets cover the module); explicit counts override', () => {
  // The catalog sells cushions as singles or SETS (juego de 2/3): the dealer
  // binds the set matching the module, so TWO tagged cushions still bill ONE
  // set SKU. partMeshCount keeps the physical story for the admin/display.
  const parts = { mats: { m1: 'cushion', m2: 'cushion', m3: 'bolster' } };
  assert.equal(partCount(parts, 'cushion'), 1, 'two physical cushions → one set SKU');
  assert.equal(partCount(parts, 'bolster'), 1);
  assert.equal(partCount(parts, 'armCushion'), 0, 'untagged role never bills');
  assert.equal(partCount({ ...parts, counts: { cushion: 2 } }, 'cushion'), 2, 'explicit override (2 × single SKU)');
  assert.equal(partCount({ ...parts, counts: { cushion: 0 } }, 'cushion'), 0, 'explicit 0 disables billing');
  assert.equal(partCount(null, 'cushion'), 0);
  assert.equal(partMeshCount(parts, 'cushion'), 2, 'physical count stays 2');
  assert.equal(partMeshCount(parts, 'bolster'), 1);
  assert.equal(partMeshCount(null, 'cushion'), 0);
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

test('piecePartsTotal cannot be inflated past the ceiling by a hand-crafted counts bag', () => {
  // Every role poisoned at once, priced at $1000 a unit — the shape of the
  // reproduction, aimed at the roll-up rather than at one count.
  const parts = {
    mats: { m1: 'cushion', m2: 'bolster', m3: 'armCushion', m4: 'structure', m5: 'exterior' },
    counts: { cushion: 100000, bolster: 100000, armCushion: 1e9, structure: 100000, exterior: 100000 },
  };
  const prices = { cushion: 1000, bolster: 1000, armCushion: 1000, structure: 1000, exterior: 1000 };
  const unit = 1000;
  const billable = PART_ROLES.filter((r) => r !== 'base' && !UNPRICED_ROLES.includes(r)).length;

  const total = piecePartsTotal(3145, parts, prices);
  // The bag rides ALL the way back to the default: 3145 + 3 × 1×1000.
  assert.equal(total, 3145 + billable * unit);
  // The invariant, stated as the ceiling rather than as this fixture's answer —
  // a future default that legitimately bills more still can't exceed it.
  assert.ok(total <= 3145 + billable * COUNT_MAX * unit, 'never past ceiling × unit');
  // For scale: unclamped this read $30,004,800 on the real build.
  assert.ok(total < 100000, 'the fat finger never reaches the total');
});

test('piecePartsTotal: base + billed SKU units × per-part grade price; unpriced base stays null', () => {
  const parts = { mats: { m1: 'cushion', m2: 'cushion', m3: 'bolster' } };
  // base 1000 + 1×120 (the cushion SET) + 1×80 (bolster) = 1200
  assert.equal(piecePartsTotal(1000, parts, { cushion: 120, bolster: 80 }), 1200);
  // Explicit counts (no set exists → 2 × single SKU): 1000 + 240 + 80.
  assert.equal(piecePartsTotal(1000, { ...parts, counts: { cushion: 2 } }, { cushion: 120, bolster: 80 }), 1320);
  // Unpicked/unbound part (null) simply doesn't bill.
  assert.equal(piecePartsTotal(1000, parts, { cushion: null }), 1000);
  assert.equal(piecePartsTotal(1000, parts, null), 1000);
  // No parts map → just the base (whole-piece pricing unchanged).
  assert.equal(piecePartsTotal(850.5, null, { cushion: 120 }), 850.5);
  // The single-price contract survives: no base price → null.
  assert.equal(piecePartsTotal(null, parts, { cushion: 120 }), null);
});

test('sanitizePartMaterials keeps only known non-base roles, trimmed', () => {
  const clean = sanitizePartMaterials({
    cushion: { grade: 'C', fabric: 'Divina 3', code: 'DIV3-224', extra: 'drop-me' },
    bolster: { grade: '', fabric: '', code: 'X' },          // no grade/fabric → dropped
    base: { grade: 'A', fabric: 'nope' },                    // base rides `material`, never here
    armCushion: 'not-an-object',
    invented: { grade: 'Z', fabric: 'Zz' },
  });
  assert.deepEqual(clean, { cushion: { grade: 'C', fabric: 'Divina 3', code: 'DIV3-224' } });
  assert.equal(sanitizePartMaterials({}), null);
  assert.equal(sanitizePartMaterials(null), null);
  const long = sanitizePartMaterials({ cushion: { grade: 'ABCDEFGHIJK', fabric: 'F' } });
  assert.equal(long.cushion.grade.length, 8);
});

test('mergedKeyOf: a folded child reads as its target, and a hand-edited LOOP stops at the last safe key', () => {
  // No map at all is the pre-studio world: every key is its own group.
  assert.equal(mergedKeyOf(null, 'cloth'), 'cloth');
  assert.equal(mergedKeyOf({}, 'cloth'), 'cloth');
  assert.equal(mergedKeyOf({ merges: {} }, 'cloth'), 'cloth');
  assert.equal(mergedKeyOf({ merges: { cloth: '   ' } }, 'cloth'), 'cloth', 'blank target folds nowhere');

  // The reason merges exist: pCon gave the split cluster its own key and the
  // dealer wants it back with its material (the inverse of partKeysFor).
  assert.equal(mergedKeyOf({ merges: { 'cloth~2': 'cloth' } }, 'cloth~2'), 'cloth');
  // Chains follow to the end — folding B into A after C was folded into B.
  assert.equal(mergedKeyOf({ merges: { c: 'b', b: 'a' } }, 'c'), 'a');

  // The jsonb is hand-editable, so a cycle is reachable: a naive walk would
  // hang the render thread on a model the dealer can no longer open to fix.
  assert.equal(mergedKeyOf({ merges: { a: 'b', b: 'a' } }, 'a'), 'b');
  assert.equal(mergedKeyOf({ merges: { a: 'b', b: 'a' } }, 'b'), 'a');
  assert.equal(mergedKeyOf({ merges: { a: 'b', b: 'c', c: 'a' } }, 'a'), 'c');
  assert.equal(mergedKeyOf({ merges: { a: 'a' } }, 'a'), 'a', 'self-merge is a no-op');
  assert.equal(mergedKeyOf({ merges: { a: 'b' } }, ''), '');
  assert.equal(mergedKeyOf({ merges: { a: 42 } }, 'a'), 'a', 'a non-string target folds nowhere');
});

test('partLabelOf: the dealer name wins, then the role label, then the key itself', () => {
  const parts = { mats: { COL1: 'base' }, labels: { COL1: '  Patas  ', COL2: '   ' } };
  assert.equal(partLabelOf(parts, 'COL1', PART_LABELS.base), 'Patas', 'trimmed dealer label');
  assert.equal(partLabelOf(parts, 'COL2', PART_LABELS.cushion), 'Cojín', 'blank label → the role label');
  assert.equal(partLabelOf(parts, 'COL3', PART_LABELS.bolster), 'Rulo', 'untitled group → the role label');
  assert.equal(partLabelOf(parts, 'COL3'), 'COL3', 'no fallback → the export key');
  assert.equal(partLabelOf(null, 'COL3'), 'COL3');
  // A folded child never shows a name of its own — the group has ONE name.
  const folded = { labels: { cloth: 'Respaldo' }, merges: { 'cloth~2': 'cloth' } };
  assert.equal(partLabelOf(folded, 'cloth~2', PART_LABELS.cushion), 'Respaldo');
});

test('finishSpecOf: only complete, hex-real options survive; an empty palette is null', () => {
  const parts = {
    finishes: {
      legs: {
        label: '  Acabado  ',
        default: 'acero',
        options: [
          { id: ' acero ', label: ' Acero ', rgb: '#8A8F98', metal: 1, rough: 0.35 },
          { id: 'nohex', label: 'Sin color', rgb: 'acero' },        // not a hex → dropped
          { id: 'short', label: 'Corto', rgb: '#abc' },             // 3-digit → dropped
          { id: 'nolabel', label: '  ', rgb: '#111111' },           // half-typed → dropped
          { id: '', label: 'Sin id', rgb: '#111111' },              // unaddressable → dropped
          { id: 'acero', label: 'Duplicado', rgb: '#ffffff' },      // first row wins
          'not-an-object',
        ],
      },
      empty: { label: 'Nada', options: [{ id: 'x', label: 'X', rgb: 'nope' }] },
      shapeless: { label: 'Nada' },
      bad: 'not-an-object',
    },
  };
  const spec = finishSpecOf(parts, 'legs');
  assert.equal(spec.label, 'Acabado');
  assert.equal(spec.default, 'acero');
  assert.deepEqual(spec.options, [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1, rough: 0.35 }]);
  // Nothing valid left is the same thing as "no finishes" — one falsy check.
  assert.equal(finishSpecOf(parts, 'empty'), null);
  assert.equal(finishSpecOf(parts, 'shapeless'), null);
  assert.equal(finishSpecOf(parts, 'bad'), null);
  assert.equal(finishSpecOf(parts, 'untagged'), null);
  assert.equal(finishSpecOf(null, 'legs'), null);
  assert.equal(finishSpecOf({}, 'legs'), null);

  // A default naming an option that didn't survive is dropped — finishOptionOf
  // must never resolve to a swatch the picker isn't showing.
  const orphan = finishSpecOf({
    finishes: { legs: { default: 'nohex', options: [{ id: 'a', label: 'A', rgb: '#000000' }] } },
  }, 'legs');
  assert.equal(orphan.default, null);
  assert.equal(orphan.label, null, 'an unnamed palette carries no label');

  // The PBR knobs are optional and only present when really given: Number(null)
  // is 0, and a coerced blank would hand the scene a hard metal:0.
  const knobs = finishSpecOf({
    finishes: {
      k: {
        options: [
          { id: 'a', label: 'A', rgb: '#000000' },
          { id: 'b', label: 'B', rgb: '#000000', metal: null, rough: '' },
          { id: 'c', label: 'C', rgb: '#000000', metal: 4, rough: '0.5' },
        ],
      },
    },
  }, 'k');
  assert.deepEqual(knobs.options[0], { id: 'a', label: 'A', rgb: '#000000' });
  assert.deepEqual(knobs.options[1], { id: 'b', label: 'B', rgb: '#000000' });
  assert.deepEqual(knobs.options[2], { id: 'c', label: 'C', rgb: '#000000', metal: 1, rough: 0.5 }, 'clamped to 0–1');

  // A folded child inherits the target's palette (one group, one finish).
  const folded = {
    merges: { 'cloth~2': 'cloth' },
    finishes: { cloth: { options: [{ id: 'a', label: 'A', rgb: '#000000' }] } },
  };
  assert.equal(finishSpecOf(folded, 'cloth~2').options.length, 1);
});

test('finishOptionOf: the pick, else the palette default, else the first option', () => {
  const spec = finishSpecOf({
    finishes: {
      legs: {
        default: 'negro',
        options: [
          { id: 'acero', label: 'Acero', rgb: '#8a8f98' },
          { id: 'negro', label: 'Negro', rgb: '#17181c' },
        ],
      },
    },
  }, 'legs');
  assert.equal(finishOptionOf(spec, 'acero').id, 'acero');
  assert.equal(finishOptionOf(spec, '  acero  ').id, 'acero', 'the pick is trimmed like the ids');
  assert.equal(finishOptionOf(spec, null).id, 'negro', 'no pick → the dealer default');
  assert.equal(finishOptionOf(spec, 'retirado').id, 'negro', 'a pick that no longer exists → default');
  // No default → the first option: a leg always renders SOMETHING.
  const noDefault = finishSpecOf({ finishes: { l: { options: [{ id: 'a', label: 'A', rgb: '#000000' }] } } }, 'l');
  assert.equal(finishOptionOf(noDefault, 'gone').id, 'a');
  assert.equal(finishOptionOf(null, 'a'), null);
  assert.equal(finishOptionOf({ options: [] }, 'a'), null);
});

test('sanitizePartFinishes: trimmed, clamped, capped at 12, null when nothing survives', () => {
  assert.deepEqual(
    sanitizePartFinishes({ ' legs ': ' acero-negro ', arms: 'acero', blank: '  ', nope: { id: 'x' }, none: null }),
    { legs: 'acero-negro', arms: 'acero' },
  );
  assert.equal(sanitizePartFinishes({}), null);
  assert.equal(sanitizePartFinishes(null), null);
  assert.equal(sanitizePartFinishes('legs'), null);
  assert.equal(sanitizePartFinishes(['acero']), null);
  assert.equal(sanitizePartFinishes({ '  ': 'acero' }), null, 'a keyless pick survives nothing');

  const long = sanitizePartFinishes({ ['k'.repeat(80)]: 'v'.repeat(60) });
  const [key, id] = Object.entries(long)[0];
  assert.equal(key.length, 64);
  assert.equal(id.length, 32);

  // A hand-crafted POST can't write a novel into the lead: the first twelve
  // groups survive, by insertion order, deterministically.
  const many = {};
  for (let i = 0; i < 30; i++) many[`g${i}`] = `o${i}`;
  const capped = sanitizePartFinishes(many);
  assert.equal(Object.keys(capped).length, 12);
  assert.deepEqual(Object.keys(capped)[0], 'g0');
  assert.deepEqual(Object.keys(capped)[11], 'g11');
  assert.equal(capped.g12, undefined);
  assert.deepEqual(sanitizePartFinishes(many), capped, 'same payload, same object');
});

test('the Prado legs palette end to end: two acabados on one PRICE-NEUTRAL group', () => {
  // The real ask: the Prado platform's legs ship in Acero or Acero lacado
  // negro — same piece, same graded SKU, same price. So the group carries a
  // finish PALETTE instead of a fabric, and nothing about it can move a quote.
  const parts = {
    mats: { COL3: 'base', legs: 'base' },
    labels: { legs: 'Patas' },
    finishes: {
      legs: {
        label: 'Acabado',
        default: 'acero',
        options: [
          { id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1, rough: 0.3 },
          { id: 'acero-negro', label: 'Acero lacado negro', rgb: '#17181c', metal: 1, rough: 0.5 },
        ],
      },
    },
  };
  assert.equal(mergedKeyOf(parts, 'legs'), 'legs', 'the legs group folds into nothing');
  assert.equal(partLabelOf(parts, 'legs', PART_LABELS.base), 'Patas');
  assert.equal(partLabelOf(parts, 'COL3', PART_LABELS.base), 'Cuerpo', 'the untitled platform keeps its role label');

  const spec = finishSpecOf(parts, 'legs');
  assert.equal(spec.label, 'Acabado');
  assert.deepEqual(spec.options.map((o) => o.id), ['acero', 'acero-negro']);
  assert.equal(finishOptionOf(spec, undefined).label, 'Acero', 'unpicked → Acero');
  assert.deepEqual(
    finishOptionOf(spec, 'acero-negro'),
    { id: 'acero-negro', label: 'Acero lacado negro', rgb: '#17181c', metal: 1, rough: 0.5 },
  );
  assert.equal(finishSpecOf(parts, 'COL3'), null, 'the platform itself has no palette');

  // PRICE-NEUTRAL BY CONSTRUCTION, like the exterior/interior zones: a finish
  // binds no SKU root, so it can never reach the roll-up.
  assert.equal(partCount(parts, 'cushion'), 0);
  assert.equal(piecePartsTotal(3145, parts, { cushion: 120 }), 3145);
  // The lead carries only the pick — the palette itself lives on the model.
  assert.deepEqual(sanitizePartFinishes({ legs: 'acero-negro' }), { legs: 'acero-negro' });
});

test('mountOf: floor by default; seat rows ride at their height (fallback 40 cm)', () => {
  assert.deepEqual(mountOf({}), { seat: false, heightCm: 0 });
  assert.deepEqual(mountOf({ mount: 'floor' }), { seat: false, heightCm: 0 });
  assert.deepEqual(mountOf({ mount: 'seat', mountHeightCm: 38 }), { seat: true, heightCm: 38 });
  assert.deepEqual(mountOf({ mount: 'seat' }), { seat: true, heightCm: 40 });
  assert.deepEqual(mountOf(null), { seat: false, heightCm: 0 });
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

test('classifyPartGroups: accessory fingerprints outrank the shape heuristic', () => {
  // The real settee layout again, but now the dealer has uploaded the loose
  // parts: the sofa's cushion sub-mesh shares the loose cushion's pCon
  // MATERIAL id (identity), and an oddly-shaped group that the heuristic
  // would call a cushion matches the loose bolster's SIZE instead.
  const groups = [
    { key: 'platform', min: [0, 0, 0], max: [160, 41, 160] },
    { key: '0fe0a9f1-shared', min: [5, 40, 5], max: [75, 80, 40] },       // material match
    { key: 'odd-roll', min: [10, 40, 100], max: [64, 57, 117] },          // 54×17×17 → size match
  ];
  const refs = [
    { role: 'cushion', matKeys: ['0fe0a9f1-shared'], size: [68, 40, 47] },
    { role: 'bolster', matKeys: ['bolster-mat'], size: [54, 17, 17] },
  ];
  const roles = classifyPartGroups(groups, refs);
  assert.equal(roles.platform, 'base', 'the platform can never be an accessory');
  assert.equal(roles['0fe0a9f1-shared'], 'cushion', 'shared material id = identity');
  assert.equal(roles['odd-roll'], 'bolster', 'size fingerprint (±20%, rotation-free) decides');
  // Without refs the same odd roll reads as a cushion (aspect 54/17 ≥ 2.5 →
  // actually bolster by heuristic too; use a shape the heuristic mislabels):
  const noRefs = classifyPartGroups([
    { key: 'platform', min: [0, 0, 0], max: [160, 41, 160] },
    { key: 'sq', min: [50, 45, 50], max: [104, 62, 104] },   // 54×54 square, 17 tall
  ]);
  assert.equal(noRefs.sq, 'cushion', 'heuristic alone calls a square pad a cushion');
  const withRef = classifyPartGroups([
    { key: 'platform', min: [0, 0, 0], max: [160, 41, 160] },
    { key: 'sq', min: [50, 45, 50], max: [104, 62, 104] },
  ], [{ role: 'armCushion', matKeys: [], size: [54, 17, 54] }]);
  assert.equal(withRef.sq, 'armCushion', 'the loose arm cushion re-labels it');
});

test('roleLabelOf: the DEALER\'s word for a role, else the localized fallback', () => {
  // The widget's chips speak in roles ("Cojín"), which is the app's taxonomy —
  // not the dealer's catalogue. The Estudio's per-group label is what the
  // customer should read, and it is keyed by GROUP KEY, so the role has to be
  // walked back to the groups wearing it.
  const parts = {
    mats: { cojin_a: 'cushion', cojin_b: 'cushion', brazo: 'armCushion' },
    labels: { cojin_b: 'Almohadón grande' },
  };
  assert.equal(roleLabelOf(parts, 'cushion', 'Cojín'), 'Almohadón grande', 'the labelled group wins over the role');
  assert.equal(roleLabelOf(parts, 'armCushion', 'Cojín de brazo'), 'Cojín de brazo', 'unlabelled → the caller\'s localized label');
  assert.equal(roleLabelOf(parts, 'bolster', 'Rulo'), 'Rulo', 'a role the model does not carry still answers');
  // Two labelled groups on ONE role: sorted, so the chip can't say one thing on
  // this render and another on the next.
  const both = { ...parts, labels: { cojin_b: 'Grande', cojin_a: 'Chico' } };
  assert.equal(roleLabelOf(both, 'cushion', 'Cojín'), 'Chico');
  assert.equal(roleLabelOf({ ...both, mats: { cojin_b: 'cushion', cojin_a: 'cushion' } }, 'cushion', 'Cojín'), 'Chico',
    'independent of the order the keys happen to sit in');
  // A merged child wears its TARGET's identity, labels included.
  const merged = { mats: { 'cojin~2': 'cushion' }, merges: { 'cojin~2': 'cojin' }, labels: { cojin: 'Respaldo' } };
  assert.equal(roleLabelOf(merged, 'cushion', 'Cojín'), 'Respaldo');
  // Junk never crashes and never invents a name.
  assert.equal(roleLabelOf(null, 'cushion', 'Cojín'), 'Cojín');
  assert.equal(roleLabelOf({ mats: { a: 'cushion' }, labels: { a: '   ' } }, 'cushion', 'Cojín'), 'Cojín');
  assert.equal(roleLabelOf({}, 'cushion', ''), 'cushion', 'with no fallback at all it degrades to the role, never blank');
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIR / SEPARAR — the ONE gesture, and the two very different things it is
// underneath. The fixture is the dealer's real row («EXCLUSIF gd canapé
// asymetrique gauche»): pCon gave the frame AND the seat cushions ONE material
// (COL0), `partKeysFor` split it into islands by shape, and the cushion islands
// were tagged out of it. `merges` is absent — the join never had a route.
const EXCLUSIF = () => ({
  mats: {
    COL0: 'base', COL1: 'armCushion', COL2: 'base',
    'COL0~2': 'cushion', 'COL0~3': 'cushion',
  },
});

test('planPartJoin UN-SPLITS an island back into its own material — the case that had no route', () => {
  const before = EXCLUSIF();
  const next = planPartJoin(before, 'COL0', ['COL0~2']);

  // The gesture is not a no-op on the data the way `merges` alone was: the
  // island now GROUPS with COL0 *and* RESOLVES as COL0.
  assert.equal(mergedKeyOf(next, 'COL0~2'), 'COL0', 'it groups with the frame');
  assert.equal(partRoleFor(next, null, -1, 'COL0~2'), 'base', 'and it PLAYS the frame — the half `merges` never moved');
  // Minimal by construction: a split island inheriting its material's tag is
  // exactly the state it had before anyone split anything, so it carries no tag
  // of its own. An untagged mesh is NOT the same as one tagged `base` — the
  // scene builder renders a factory-textured mesh as-is only while nothing
  // claims it — so stamping every key touched would repaint parts.
  assert.equal('COL0~2' in next.mats, false, 'no tag of its own: it inherits, as it did before the split');
  // Nothing else moved.
  assert.equal(next.mats.COL0, 'base');
  assert.equal(next.mats.COL1, 'armCushion');
  assert.equal(partRoleFor(next, null, -1, 'COL0~3'), 'cushion', 'the OTHER island keeps its own tag');
  // The input is never mutated — the studio holds it as a draft.
  assert.deepEqual(before, EXCLUSIF());
});

test('planPartJoin MERGES two different materials — same gesture, the other case', () => {
  // Two pCon materials, one of them a structure. Here the member cannot inherit
  // anything (its base key is itself), so the role must be written explicitly or
  // it silently falls back to `base` — a different fabric, and for a billed role
  // a different price.
  const parts = { mats: { metal_01: 'structure', metal_02: 'base' } };
  const next = planPartJoin(parts, 'metal_01', ['metal_02']);
  assert.equal(next.merges.metal_02, 'metal_01');
  assert.equal(next.mats.metal_02, 'structure', 'written, because nothing would have inherited it');
  assert.equal(partRoleFor(next, null, -1, 'metal_02'), 'structure');
  // A target is never itself a child (that is what keeps mergedKeyOf loop-free),
  // and joining a key to itself is a no-op.
  assert.equal('metal_01' in (next.merges || {}), false);
  assert.deepEqual(planPartJoin(parts, 'metal_01', ['metal_01']), parts);
});

test('planPartJoin gives back the billed slot it emptied — a phantom cushion never bills', () => {
  // Both cushion islands joined into the frame ⇒ the model no longer HAS a
  // cushion, so the cushion SKU and its typed quantity must go with it. Left
  // behind, `partCount` reads the explicit count first and bills a part SKU on a
  // tagging that has no such part.
  const parts = {
    ...EXCLUSIF(),
    roots: { cushion: 'PRADO-COJ', armCushion: 'PRADO-BRZ' },
    counts: { cushion: 3, armCushion: 2 },
  };
  const next = planPartJoin(parts, 'COL0', ['COL0~2', 'COL0~3']);
  assert.equal(partCount(next, 'cushion'), 0, 'nothing left to bill');
  assert.equal(next.roots.cushion, undefined);
  assert.equal(next.counts.cushion, undefined);
  // A role somebody still holds is untouched — the release is surgical.
  assert.equal(next.roots.armCushion, 'PRADO-BRZ');
  assert.equal(partCount(next, 'armCushion'), 2);
  assert.ok(BILLED_ROLES.includes('cushion') && !BILLED_ROLES.includes('structure'));
});

test('joining does not ORPHAN a palette — it moves, or it yields to the target', () => {
  const palette = { options: [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 }], default: 'acero' };
  const otra = { options: [{ id: 'laca', label: 'Laca', rgb: '#17181c' }] };

  // The target has none ⇒ it ADOPTS the member's. A palette left on a key
  // nothing renders is worse than dead: `collectionFinishes` reads `finishes` as
  // evidence the model has that group and keeps fanning it out forever.
  const a = planPartJoin(
    { mats: { patas: 'structure', 'patas~2': 'structure' }, finishes: { 'patas~2': palette }, labels: { 'patas~2': 'Patas traseras' } },
    'patas', ['patas~2'],
  );
  assert.equal('patas~2' in a.finishes, false, 'no palette left on a key that is no longer a group');
  assert.deepEqual(a.finishes.patas, palette, 'it moved to the group that now renders it');
  assert.equal(a.labels.patas, 'Patas traseras', 'and so did the name — the target had none');
  assert.ok(finishSpecOf(a, 'patas~2'), 'the folded key still resolves a palette, through its target');

  // The target already has one ⇒ the target's identity wins, and the member's is
  // REMOVED rather than kept as a second, unreachable copy.
  const b = planPartJoin(
    { mats: { patas: 'structure', marco: 'structure' }, finishes: { patas: palette, marco: otra }, labels: { patas: 'Patas', marco: 'Marco' } },
    'patas', ['marco'],
  );
  assert.deepEqual(b.finishes, { patas: palette });
  assert.deepEqual(b.labels, { patas: 'Patas' });
});

test('planPartSplit is the same gesture in reverse — natively grouped or dealer-joined, it does not care', () => {
  // (1) UNDO a join: the island comes back out as its own group, still a
  // cushion, with no leftover merge entry.
  const joined = planPartJoin(EXCLUSIF(), 'COL0', ['COL0~2']);
  const undone = planPartSplit(joined, 'COL0', ['COL0~2']);
  assert.equal(mergedKeyOf(undone, 'COL0~2'), 'COL0~2', 'its own group again');
  assert.equal(partRoleFor(undone, null, -1, 'COL0~2'), 'base',
    'it keeps the role it was WEARING inside the group — separating never re-files a part');

  // (2) UNGROUP what came grouped from the FILE. `COL1` was never joined by
  // anybody; it is one pCon material split into islands, and the dealer must be
  // able to take one out without knowing that. The island carries no tag and no
  // merge entry — only inheritance — and it still separates.
  const native = { mats: { COL1: 'structure' } };
  const apart = planPartSplit(native, 'COL1', ['COL1~2']);
  assert.equal(mergedKeyOf(apart, 'COL1~2'), 'COL1~2');
  assert.equal(partRoleFor(apart, null, -1, 'COL1~2'), 'structure',
    'the role it inherited is the role it leaves with — never a silent drop to base');
  assert.equal(apart.mats.COL1, 'structure', 'and the material it left is untouched');

  // (3) A cross-material member leaves with an EXPLICIT tag, because there is
  // nothing for it to inherit from.
  const two = planPartJoin({ mats: { metal_01: 'structure', metal_02: 'base' } }, 'metal_01', ['metal_02']);
  const back = planPartSplit(two, 'metal_01', ['metal_02']);
  assert.equal(back.mats.metal_02, 'structure');
  assert.equal(back.merges.metal_02, undefined);

  // You cannot separate a group from itself, and an empty ask changes nothing.
  const same = planPartSplit(joined, 'COL0', ['COL0']);
  assert.deepEqual(same, joined);
  assert.deepEqual(planPartSplit(joined, 'COL0', []), joined);
});

test('a join/separate round trip loses neither a tagged role nor a palette', () => {
  const palette = { options: [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 }], default: 'acero' };
  const start = {
    mats: { COL0: 'base', 'COL0~2': 'cushion', patas: 'structure' },
    finishes: { patas: palette },
    labels: { patas: 'Patas' },
    roots: { cushion: 'PRADO-COJ' },
    counts: { cushion: 2 },
  };
  const joined = planPartJoin(start, 'COL0', ['COL0~2']);
  const back = planPartSplit(joined, 'COL0', ['COL0~2']);

  // The ROLE survives the trip in both directions. It comes back as an explicit
  // `cushion`… no: it comes back wearing what the GROUP wore, which is the
  // honest answer — the dealer said "this is part of the frame", and undoing the
  // grouping does not un-say it. What must never happen is a silent third
  // answer, so this is pinned rather than left to chance.
  assert.equal(partRoleFor(back, null, -1, 'COL0~2'), 'base');
  assert.equal(partRoleFor(back, null, -1, 'COL0'), 'base');
  assert.equal(partRoleFor(back, null, -1, 'patas'), 'structure', 'an untouched group is untouched');
  // The palette of a group nobody joined is exactly where it was.
  assert.deepEqual(back.finishes, { patas: palette });
  assert.deepEqual(back.labels, { patas: 'Patas' });
  // And the billed slot the join emptied stays given back — re-separating the
  // mesh does not resurrect a SKU the tagging no longer implies.
  assert.equal(partCount(back, 'cushion'), 0);
  assert.equal(back.roots.cushion, undefined);
});

test('join/split never throw on a half-typed parts bag', () => {
  // `parts` is dealer-authored jsonb and reaches these two straight off the row.
  for (const junk of [null, undefined, 'nope', 42, [], { mats: 'no' }, { merges: [] }, { mats: null, finishes: 7 }]) {
    assert.doesNotThrow(() => planPartJoin(junk, 'a', ['b']));
    assert.doesNotThrow(() => planPartSplit(junk, 'a', ['b']));
  }
  assert.doesNotThrow(() => planPartJoin({ mats: { a: 'base' } }, '', ['a']));
  assert.doesNotThrow(() => planPartJoin({ mats: { a: 'base' } }, 'a', [null, '', undefined]));
  // A hand-edited merge LOOP resolves to a real group instead of hanging, and
  // the join still lands somewhere legal.
  const loop = { mats: { a: 'cushion', b: 'base' }, merges: { a: 'b', b: 'a' } };
  assert.doesNotThrow(() => planPartJoin(loop, 'a', ['c']));
  assert.doesNotThrow(() => planPartSplit(loop, 'a', ['b']));
});

test('regrouping never strips a tag the dealer already put there', () => {
  // An UNTAGGED mesh and one tagged `base` are different things to the renderer:
  // the scene builder shows a factory-textured mesh (walnut, lacquer) as-is only
  // while nothing claims it, and an explicit `base` is what overrides it with
  // fabric. So a key whose tag ALREADY says what the group says is left exactly
  // as it is — otherwise joining a part and separating it again would silently
  // repaint it, which is a round trip that isn't one.
  const start = { mats: { COL0: 'base', COL2: 'base' } };
  const joined = planPartJoin(start, 'COL0', ['COL2']);
  assert.equal(joined.mats.COL2, 'base', 'the explicit tag survives the join');
  const back = planPartSplit(joined, 'COL0', ['COL2']);
  assert.equal(back.mats.COL2, 'base', 'and the separation');
  assert.deepEqual(back.mats, start.mats, 'mats comes back exactly as it went in');

  // And the mirror: a key with NO tag joined into a `base` group stays untagged,
  // so its factory finish is never claimed by a regrouping it didn't ask for.
  const untagged = planPartJoin({ mats: { COL0: 'base' } }, 'COL0', ['nogal']);
  assert.equal('nogal' in untagged.mats, false);
  assert.equal(partRoleFor(untagged, null, -1, 'nogal'), 'base');
});


/* ---------------------- the slot KINDS (slice 5) -------------------------- */

/**
 * THE IDENTITY PIN. `PART_ROLES`, `MATERIALIZATION_ROLES`, `UNPRICED_ROLES` and
 * `BILLED_ROLES` are now DERIVED from `PART_KINDS` instead of written out. This
 * asserts they came out byte-identical to the literals they replaced — which is
 * what makes naming the classification a rename of a concept and provably not a
 * change to any price. If a kind is edited wrongly, this is what goes red,
 * before any money moves.
 */
test('meshParts: the derived role lists are identical to the retired literals', () => {
  assert.deepEqual([...PART_ROLES],
    ['base', 'structure', 'exterior', 'interior', 'cushion', 'bolster', 'armCushion']);
  assert.deepEqual([...MATERIALIZATION_ROLES], ['exterior', 'interior']);
  assert.deepEqual([...UNPRICED_ROLES], ['exterior', 'interior', 'structure']);
  assert.deepEqual([...BILLED_ROLES], ['cushion', 'bolster', 'armCushion']);
});

test('meshParts: every role has a kind, and every kind is one of the four', () => {
  const KINDS = new Set(['body', 'component', 'zone', 'finish']);
  for (const role of PART_ROLES) {
    assert.ok(KINDS.has(partKind(role)), `${role} must carry one of the four kinds`);
    assert.equal(PART_KINDS[role], partKind(role));
  }
  // EXACTLY ONE body: it carries the base price, and two would make "what does
  // this piece cost" depend on iteration order.
  assert.deepEqual(rolesOfKind('body'), ['base']);
});

test('meshParts: an unknown role has NO kind, and therefore never bills', () => {
  // Null, not a default. Guessing 'component' would make an unrecognised role
  // BILL, and inventing a charge is the one thing this file must never do.
  for (const junk of ['respaldo', '', null, undefined, 'BASE', 'component']) {
    assert.equal(partKind(junk), null, `${JSON.stringify(junk)} is not a known role`);
    assert.equal(billsMoney(junk), false);
    assert.equal(takesMaterial(junk), false);
  }
});

test('meshParts: billsMoney agrees with BILLED_ROLES on every role', () => {
  // The two answers must never disagree — one is the list the studio reads, the
  // other the question the money path asks.
  for (const role of PART_ROLES) {
    assert.equal(billsMoney(role), BILLED_ROLES.includes(role), `${role}`);
    // …and the complement: a zone or a finish never bills, for its own reason.
    if (partKind(role) === 'zone' || partKind(role) === 'finish') {
      assert.equal(billsMoney(role), false);
      assert.equal(partCount({ mats: { m: role } }, role), 0,
        `${role} must count 0 — it is already inside the base SKU, or it is free`);
    }
  }
  // `body` carries the base price but is not an ADDITION to it.
  assert.equal(billsMoney('base'), false);
  assert.ok(!BILLED_ROLES.includes('base'));
});

test('meshParts: the Deno mirror carries the same kinds', () => {
  // The wall forbids the import, so the classification lives at two layers and
  // this is what welds them. A mirror that drifts prices a piece differently in
  // the widget than in the app. (Upstream additionally pins a quote-worker
  // mirror this deploy does not carry.)
  assert.deepEqual({ ...DENO_PART_KINDS }, { ...PART_KINDS },
    "dealer's PART_KINDS must match the app's");
});
