// LIBRARY LAYOUTS — pins how a dropped model files itself under
// GROUP / CATEGORY / COLLECTION from its own path. The dealer drops a whole
// ARCHVIZ tree at once, so a drift here doesn't misfile one model: it misfiles
// thousands, silently, and the pieces can never be found again in the studio.
//
// THE STRATEGY THIS PINS: infer the SHAPE from the BATCH, then read POSITIONALLY.
// A drop is a tree — every file hangs off one root — so `resolveShape` measures
// WHERE each level sits once, and `parsePath` reads each path BY INDEX. The
// vocabulary (LR_GROUPS) locates the level and NEVER interprets a name, which is
// the whole point: a real library always contains folder names nobody
// enumerated, and they must file correctly anyway.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as lrArchviz from '../src/library/lrArchviz.ts';
import {
  LIBRARY_ROOTS,
  LR_GROUPS,
  LR_VARIANT_MARKERS,
  lrArchvizLayout,
  parseLibraryPath,
  prettifyLibraryName,
  resolveLibraryShape,
} from '../src/library/lrArchviz.ts';
import type { LibraryLayout, LibraryPathFields } from '../src/library/types.ts';
import { NO_LIBRARY_FIELDS } from '../src/library/types.ts';

/** The three TAXONOMY fields — what the dealer files a piece under. The other
 *  three (modelFolder / variant / fileName) report what the path was read PAST
 *  and are pinned separately below. */
const taxonomy = (o: LibraryPathFields) => ({ group: o.group, category: o.category, collection: o.collection });

// ONE drop: measure the batch once, then read every path against that plan —
// exactly what the batch ingest does with a folder the dealer dropped.
const fileBatch = (paths: string[]) => {
  const shape = resolveLibraryShape(paths);
  return paths.map((p) => taxonomy(parseLibraryPath(p, shape)));
};

const parsed = (path: string, shape?: lrArchviz.LibraryShape) => taxonomy(parseLibraryPath(path, shape));

// ── THE HEADLINE. Four rows off the owner's real library, and the first one is
// the defect that killed the old vocabulary-driven parser: `Sofa Bed` (singular)
// wasn't in its LR_CATEGORIES list, so the "sits below a resolved taxonomy
// segment ⇒ packaging" peel ate the CATEGORY level and filed the piece as
// { Upholstery, null, 'Sofa Bed' }. Positionally there is nothing to know: the
// segment at the category index IS the category, whatever it is called.
const OWNER_ROWS: [string, ReturnType<typeof taxonomy>][] = [
  ['Upholstery/Sofa Bed/Multy_Convertible120_NoBackWedge.3ds',
    { group: 'Upholstery', category: 'Sofa Bed', collection: 'Multy' }],
  ['Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds',
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' }],
  ['Cabinet/Oka/gd module laqué.3ds',
    { group: null, category: 'Cabinet', collection: 'Oka' }],
  ['Cabinet/Marechiaro_Straight.3ds',
    { group: null, category: 'Cabinet', collection: 'Marechiaro' }],
];

test("the owner's real library: four rows, dropped as ONE batch", () => {
  const paths = OWNER_ROWS.map(([p]) => p);
  const got = fileBatch(paths);
  OWNER_ROWS.forEach(([path, expected], i) => assert.deepEqual(got[i], expected, path));

  // The exact observed wrong answer, pinned out by name: the category level was
  // eaten and its name handed to the collection.
  const [multy] = got;
  assert.notEqual(multy.category, null, 'the CATEGORY must not vanish for being an unknown word');
  assert.notEqual(multy.collection, 'Sofa Bed', 'a category is never the family');
});

test("the owner's real library: each branch alone reads the same as it does mixed", () => {
  // A real drop mixes branches, and a branch dropped by itself must not change
  // its mind. The Cabinet pair carries NO group token at all — the dealer
  // dropped from inside, so there simply is no group — and the Upholstery pair
  // carries one; each files identically alone and together.
  const cabinet = OWNER_ROWS.slice(2);
  const upholstery = OWNER_ROWS.slice(0, 2);
  for (const rows of [cabinet, upholstery, OWNER_ROWS]) {
    const got = fileBatch(rows.map(([p]) => p));
    rows.forEach(([path, expected], i) => assert.deepEqual(got[i], expected, path));
  }

  // And the shape each branch infers, spelled out.
  assert.deepEqual(resolveLibraryShape(cabinet.map(([p]) => p)), {
    groupDepth: null, categoryDepth: 0, compound: false,
  });
  assert.deepEqual(resolveLibraryShape(upholstery.map(([p]) => p)), {
    groupDepth: 0, categoryDepth: 1, compound: false,
  });
});

test('a CATEGORY nobody enumerated reads correctly — the regression that ended the vocabulary', () => {
  // The bug's real lesson: French categories, singular/plural drift and next
  // season's folder all have to file correctly, and they can only do that if no
  // list is ever consulted. Whatever sits at the category index IS the category.
  for (const category of ['Méridiennes', 'Sofa Bed', 'Sofa Beds', 'Banquettes', 'Repose Pieds', 'Zzyzx']) {
    const [out] = fileBatch([`Upholstery/${category}/Foo_bar.3ds`]);
    assert.deepEqual(out, { group: 'Upholstery', category, collection: 'Foo' }, category);
  }
  // A category that merely STARTS with the file's own leading word survives —
  // this is where the old parser deleted the taxonomy to keep the packaging.
  assert.deepEqual(parsed('Upholstery/Sofa Beds/Sofa_gb.3ds'), {
    group: 'Upholstery', category: 'Sofa Beds', collection: 'Sofa',
  });
  // The name is prettified, never interpreted.
  assert.equal(parseLibraryPath('upholstery/coffee-tables/Kashima_low.3ds').category, 'Coffee Tables');
  assert.equal(parseLibraryPath('UPHOLSTERY-ARMCHAIRS/Ottoman_pouf.3ds').group, 'Upholstery');
  assert.equal(parseLibraryPath('upholstery-armchairs/Ottoman_pouf.3ds').category, 'Armchairs');
});

test('THE VOCABULARY IS GONE: no category list, no CATEGORY→GROUP table', () => {
  // Re-adding either re-opens the whole bug class (every name we forgot to
  // enumerate lands somewhere wrong). The group is read from the path or left
  // blank for the dealer — it is never inferred from what a category means.
  assert.equal('LR_CATEGORIES' in lrArchviz, false);
  assert.equal('LR_CATEGORY_GROUP' in lrArchviz, false);
  // A category with no group segment above it answers `group: null` — a blank
  // the dealer fills in one click, never a guess he has to catch first.
  assert.deepEqual(parsed('Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds'), {
    group: null, category: 'Beds', collection: 'Hypna',
  });
  assert.deepEqual(parsed('Coffee Tables/Kashima_low.3ds'), {
    group: null, category: 'Coffee Tables', collection: 'Kashima',
  });
});

test('SIBLINGS AT THE SAME DEPTH GET THE SAME TREATMENT — the segmentation guarantee', () => {
  // One drop, one shape: what separates two files is their names, never how the
  // parser felt about a word. Four categories at the same index, one of them
  // unknown, one spelled like nothing in particular — same treatment.
  const got = fileBatch([
    'Upholstery/Sofa Bed/Multy_Convertible120.3ds',
    'Upholstery/Beds/Hypna_160_v_G.3ds',
    'Upholstery/Méridiennes/Mistral_Left.3ds',
    'Upholstery/Poufs/Togo_pouf.3ds',
  ]);
  assert.deepEqual(got.map((o) => o.group), ['Upholstery', 'Upholstery', 'Upholstery', 'Upholstery']);
  assert.deepEqual(got.map((o) => o.category), ['Sofa Bed', 'Beds', 'Méridiennes', 'Poufs']);
  assert.deepEqual(got.map((o) => o.collection), ['Multy', 'Hypna', 'Mistral', 'Togo']);

  // The same category read at two file depths (loose file vs model folder vs
  // model + variant folder) stays the same category.
  const depths = fileBatch([
    'Upholstery/Beds/Hypna_160_v_G.3ds',
    'Upholstery/Beds/Hypna/Hypna_160_v_G.3ds',
    'Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds',
    'Upholstery/Beds/Hypna/Hypna 160 VersionLeft/Hypna_160_v_G.3ds',
  ]);
  for (const out of depths) assert.deepEqual(out, { group: 'Upholstery', category: 'Beds', collection: 'Hypna' });
});

test('the SHAPE: where the group sits is a fact about the BATCH, majority wins', () => {
  // Each path votes with the SHALLOWEST index carrying a known group token; the
  // most-voted index wins. A stray folder must not move the level — one family
  // named like a division (`Divers/Storage/`) among a real tree would otherwise
  // push every file in the drop down one level.
  const stray = [
    'Upholstery/Beds/Hypna_160.3ds',
    'Upholstery/Sofa/Togo_gb.3ds',
    'Divers/Storage/Vase_petit.3ds',
  ];
  assert.equal(resolveLibraryShape(stray).groupDepth, 0);
  const got = fileBatch(stray);
  assert.deepEqual(got[0], { group: 'Upholstery', category: 'Beds', collection: 'Hypna' });
  assert.deepEqual(got[1], { group: 'Upholstery', category: 'Sofa', collection: 'Togo' });
  assert.equal(got[2].group, null, 'the stray branch reads at the SAME level as its siblings');

  // A tie keeps the SHALLOWEST index — the top division sits closest to the root.
  assert.equal(resolveLibraryShape(['Upholstery/Beds/A_x.3ds', 'Sub/Dining/B_y.3ds']).groupDepth, 0);

  // The batch can sit under a wrapper folder the roots list doesn't know: the
  // level moves with it, and that wrapper can never become the GROUP.
  const wrapped = ['LR 2026/Upholstery/Beds/Hypna_160.3ds', 'LR 2026/Cabinet/Oka/gd module.3ds'];
  assert.deepEqual(resolveLibraryShape(wrapped), { groupDepth: 1, categoryDepth: 2, compound: false });
  assert.deepEqual(fileBatch(wrapped), [
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
    { group: null, category: 'Cabinet', collection: 'Oka' },
  ]);

  // No group token anywhere ⇒ there is no group level at all: the dealer dropped
  // from inside, and the taxonomy starts at the first folder.
  assert.deepEqual(resolveLibraryShape(['Beds/Hypna_160.3ds', 'Cabinet/Oka/x_y.3ds']), {
    groupDepth: null, categoryDepth: 0, compound: false,
  });

  // The plan is a pure function of the SET of paths, not of their order.
  const paths = OWNER_ROWS.map(([p]) => p);
  assert.deepEqual(resolveLibraryShape(paths), resolveLibraryShape([...paths].reverse()));

  // Junk in the batch is skipped, never fatal: a shape is inferred from ten
  // thousand paths and must not die on the one `.DS_Store`-shaped entry.
  const NO_GROUP = { groupDepth: null, categoryDepth: 0, compound: false };
  for (const bad of [null, undefined, [], 'Upholstery/Beds/x_y.3ds', 42, {}]) {
    assert.deepEqual(resolveLibraryShape(bad as any), NO_GROUP, JSON.stringify(bad) ?? String(bad));
  }
  assert.deepEqual(resolveLibraryShape([null, 42, {}, '', 'Upholstery/Beds/x_y.3ds'] as any), {
    groupDepth: 0, categoryDepth: 1, compound: false,
  });
});

test('the COMPOUND shape: `Upholstery-Sofa` spells both levels in ONE segment', () => {
  assert.deepEqual(resolveLibraryShape(['Upholstery-Sofa/Togo/Togo_gb.3ds']), {
    groupDepth: 0, categoryDepth: 0, compound: true,
  });
  assert.deepEqual(parsed('International-3DS/Upholstery-Sofa/Togo/Togo_gb.3ds'), {
    group: 'Upholstery', category: 'Sofa', collection: 'Togo',
  });
  // Underscore and space separate the same way as the hyphen.
  assert.deepEqual(parsed('International-3DS/Upholstery_Beds/Hypna_Bed_180.3ds'), {
    group: 'Upholstery', category: 'Beds', collection: 'Hypna',
  });
  // Multi-word category: every remaining token stays, in order.
  assert.deepEqual(parsed('International-3DS/Occasional Coffee Tables/Kashima_low.3ds'), {
    group: 'Occasional', category: 'Coffee Tables', collection: 'Kashima',
  });

  // BOTH SHAPES COEXIST IN ONE TREE, so the reader confirms it segment by
  // segment: a compound branch and a split branch file correctly side by side
  // in the same drop, and the compound one does NOT consume two levels.
  assert.deepEqual(fileBatch([
    'Upholstery-Sofa/Togo/Togo_gb.3ds',
    'Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds',
  ]), [
    { group: 'Upholstery', category: 'Sofa', collection: 'Togo' },
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
  ]);
  // Written either way, the same piece files the same.
  assert.deepEqual(
    parsed('International-3DS/Bedroom-Beds/Peter Maly/PeterMaly_bed.3ds'),
    parsed('International-3DS/Bedroom/Beds/Peter Maly/PeterMaly_bed.3ds'),
  );
  // A group folder with nothing under it: a group, and no category invented.
  assert.deepEqual(parsed('International-3DS/Lighting/Ruche_lamp.3ds'), {
    group: 'Lighting', category: null, collection: 'Ruche',
  });
  // A collection spelled like a GROUP never deletes its own group.
  assert.deepEqual(parsed('International-3DS/Storage/Storage_unit.3ds'), {
    group: 'Storage', category: null, collection: 'Storage',
  });
});

test('a VARIANT folder is a rendering — dropped at any depth, never a level', () => {
  // The documented list is the contract: each marker, alone under the category.
  for (const marker of LR_VARIANT_MARKERS) {
    assert.deepEqual(
      parsed(`Upholstery/Beds/${marker}/Hypna_160_v_G.3ds`),
      { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
      marker,
    );
  }
  // The generated forms the list can't enumerate — any count, either side,
  // glued or spaced, English or French, and the file's own `v_G` / `v_D`.
  for (const marker of ['3Versions', '2 Versions', 'Version G', 'v_D', 'VERSIONS-RIGHT', 'Version Droite']) {
    assert.deepEqual(
      parsed(`Upholstery/Beds/${marker}/Hypna_160_v_G.3ds`),
      { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
      marker,
    );
  }
  // The library nests them: model folder, then the variant inside it. The
  // SHALLOWEST surviving folder is the model folder; the deeper ones were its
  // renderings.
  assert.deepEqual(
    parsed('International-3DS/Upholstery/Beds/Hypna/Hypna 160 VersionLeft/Hypna_160_v_G.3ds'),
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
  );
  assert.deepEqual(
    parsed('Upholstery/Beds/Hypna/2Versions/Hypna_160_v_G.3ds'),
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
  );
  // Dropped wherever it sits, not only where it trails.
  assert.deepEqual(
    parsed('Upholstery/Beds/2Versions/Hypna/Hypna_160_v_G.3ds'),
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
  );
  // It never fills the CATEGORY slot either, by being the last thing standing.
  assert.deepEqual(parsed('Upholstery/2Versions/Hypna_160_v_G.3ds'), {
    group: 'Upholstery', category: null, collection: 'Hypna',
  });
  assert.deepEqual(parsed('2Versions/Hypna_160_v_G.3ds'), {
    group: null, category: null, collection: 'Hypna',
  });
});

test('the COLLECTION is the model FOLDER, refined by the filename when they agree', () => {
  // The owner's rule «its first string before the _ is the collection» holds
  // only where LR wrote the family first; under `Cabinet/Oka/` the FILE names
  // the piece and only the FOLDER names the family.
  assert.deepEqual(parsed('Cabinet/Oka/gd module laqué.3ds'), {
    group: null, category: 'Cabinet', collection: 'Oka',
  });
  assert.deepEqual(parsed('Cabinet/Oka/LargeModule_Wood.3ds'), {
    group: null, category: 'Cabinet', collection: 'Oka',
  });
  // The exact wrong answers, pinned out: the piece's name is not the family's.
  const laque = parseLibraryPath('Cabinet/Oka/gd module laqué.3ds');
  assert.notEqual(laque.collection, 'Gd Module Laqué');
  assert.notEqual(laque.category, 'Oka');
  assert.notEqual(parseLibraryPath('Cabinet/Oka/LargeModule_Wood.3ds').collection, 'LargeModule');

  // FOLDER WINS when the filename disagrees — with or without a `_` in it.
  assert.equal(parseLibraryPath('Upholstery/Beds/Oka/gd module laqué.3ds').collection, 'Oka');
  assert.equal(parseLibraryPath('Upholstery/Sofa/Oka/LargeModule_Wood.3ds').collection, 'Oka');
  // TOKEN REFINES when they agree — the shorter, cleaner form of the same word.
  assert.equal(parseLibraryPath('Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds').collection, 'Hypna');
  assert.equal(parseLibraryPath('Upholstery/Sofa/Togo/Togo_gb.3ds').collection, 'Togo');
  assert.equal(parseLibraryPath('Upholstery-Sofa/Prado/Prado_Settee_Left_Arm.3ds').collection, 'Prado');
  // They agree only at a WORD BOUNDARY: `Avalon Deco` is not an `Ava` folder…
  assert.equal(parseLibraryPath('Upholstery/Sofa/Avalon Deco/Ava_chair.3ds').collection, 'Avalon Deco');
  // …while `Ava Deco` is, so the token refines it.
  assert.equal(parseLibraryPath('Upholstery/Sofa/Ava Deco/Ava_chair.3ds').collection, 'Ava');
  // NO model folder ⇒ the filename is all there is.
  assert.equal(parseLibraryPath('Cabinet/Marechiaro_Straight.3ds').collection, 'Marechiaro');
  assert.equal(parseLibraryPath('Upholstery-Sofa/Prado_MediumSofa_120.3ds').collection, 'Prado');
  // Only the FIRST `_` cuts — everything after it is the piece, not the family.
  assert.equal(parseLibraryPath('Upholstery/Sofa/Prado_Settee_Left_Arm.3ds').collection, 'Prado');
  // No `_` at all ⇒ the whole basename (this is a real shape in the library).
  assert.equal(parseLibraryPath('Occasional-Coffee-Tables/Kashima.3ds').collection, 'Kashima');
  // A CATEGORY folder never decides it — only a folder BELOW the category can.
  assert.equal(parseLibraryPath('Upholstery/Sofa/Togo_gb.3ds').collection, 'Togo');
  // The name is prettified like every other field.
  assert.equal(parseLibraryPath('Upholstery-Sofa/pumpkin_lg.3ds').collection, 'Pumpkin');
});

test('the collection does NOT decide the category — same family, different categories', () => {
  // Togo is a sofa AND a pouf; Prado is a sofa AND an ottoman. If the collection
  // leaked into the category, half the library would file under the wrong one.
  const [sofa, pouf] = fileBatch([
    'International-3DS/Upholstery-Sofa/Togo/Togo_gb.3ds',
    'International-3DS/Occasional-Poufs/Togo/Togo_pouf.3ds',
  ]);
  assert.equal(sofa.collection, pouf.collection);
  assert.deepEqual([sofa.group, sofa.category], ['Upholstery', 'Sofa']);
  assert.deepEqual([pouf.group, pouf.category], ['Occasional', 'Poufs']);

  const [settee, ottoman] = fileBatch([
    'Upholstery/Sofa/Prado/Prado_Settee_120.3ds',
    'Upholstery/Ottomans/Prado_Ottoman_S.3ds',
  ]);
  assert.equal(settee.collection, ottoman.collection);
  assert.notEqual(settee.category, ottoman.category);
});

test('library ROOT segments never become a group or a category, and never move a level', () => {
  // Roots alone: nothing to derive, and the collection still lands.
  assert.deepEqual(parsed('LIGNE ROSET DATA/ARCHVIZ/International-3DS/Togo_gb.3ds'), {
    group: null, category: null, collection: 'Togo',
  });
  // Every documented root, where it would otherwise be counted as a level.
  for (const root of LIBRARY_ROOTS) {
    assert.deepEqual(
      parsed(`${root}/Objets/Vase_petit.3ds`),
      { group: null, category: 'Objets', collection: 'Vase' },
      root,
    );
    assert.deepEqual(
      parsed(`${root}/Upholstery/Beds/Hypna_160.3ds`),
      { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
      root,
    );
  }
  // Dropped from ABOVE the wrapper or from INSIDE it: same shape, same pieces —
  // roots are stripped BEFORE any index is counted.
  const mixed = ['International-3DS/Upholstery/Beds/Hypna_160.3ds', 'Upholstery/Beds/Peter-Maly_bed.3ds'];
  assert.equal(resolveLibraryShape(mixed).groupDepth, 0);
  assert.deepEqual(fileBatch(mixed), [
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
    { group: 'Upholstery', category: 'Beds', collection: 'Peter Maly' },
  ]);
  // A Windows drive stub is a disk, not a taxonomy level.
  assert.deepEqual(parsed('C:/LIGNE ROSET DATA/Upholstery_Beds/Hypna_Bed_180.3ds'), {
    group: 'Upholstery', category: 'Beds', collection: 'Hypna',
  });
});

test('a Windows path (backslashes) parses exactly like its POSIX twin', () => {
  // A folder drop on Windows hands us its own separator; the same library must
  // file identically on both machines — shape included.
  assert.deepEqual(
    parsed('LIGNE ROSET DATA\\ARCHVIZ\\International-3DS\\Upholstery-Sofa\\Togo\\Togo_gb.3ds'),
    { group: 'Upholstery', category: 'Sofa', collection: 'Togo' },
  );
  assert.deepEqual(
    parseLibraryPath('C:\\LIGNE ROSET DATA\\Upholstery\\Beds\\Hypna_Bed_180.3ds'),
    parseLibraryPath('LIGNE ROSET DATA/Upholstery/Beds/Hypna_Bed_180.3ds'),
  );
  assert.deepEqual(
    resolveLibraryShape(['C:\\LR\\Upholstery\\Beds\\Hypna_Bed_180.3ds']),
    resolveLibraryShape(['C:/LR/Upholstery/Beds/Hypna_Bed_180.3ds']),
  );
  // Mixed separators (a path pasted through two tools) still normalize.
  assert.deepEqual(
    parsed('International-3DS\\Upholstery-Sofa/Togo_gb.3ds'),
    { group: 'Upholstery', category: 'Sofa', collection: 'Togo' },
  );
});

test('a loose file with no folders at all is a collection and nothing more', () => {
  assert.deepEqual(parsed('Togo_gb.3ds'), { group: null, category: null, collection: 'Togo' });
  assert.deepEqual(parsed('./Kashima.3ds'), { group: null, category: null, collection: 'Kashima' });
  assert.deepEqual(parsed('/Togo_gb.3ds'), { group: null, category: null, collection: 'Togo' });
  // …and it contributes no level to a batch it happens to ride along in.
  assert.deepEqual(fileBatch(['Togo_gb.3ds', 'Upholstery/Beds/Hypna_160.3ds']), [
    { group: null, category: null, collection: 'Togo' },
    { group: 'Upholstery', category: 'Beds', collection: 'Hypna' },
  ]);
});

test('BACK-COMPAT: parsing one path with no shape derives that path\'s own shape', () => {
  // Existing callers (the single-model drop, the taxonomy UI) pass a bare path.
  for (const [path, expected] of OWNER_ROWS) {
    assert.deepEqual(parsed(path), expected, path);
    assert.deepEqual(parsed(path, resolveLibraryShape([path])), expected, path);
  }
  // A junk "shape" degrades to that single-path reading instead of throwing —
  // a bad plan must not take a ten-thousand-file import down with it.
  const p = 'Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds';
  for (const junk of [null, undefined, 42, 'shape', {}, [], NaN, true, { groupDepth: 'x' }, { groupDepth: -1 }]) {
    assert.deepEqual(parseLibraryPath(p, junk as any), parseLibraryPath(p), JSON.stringify(junk) ?? String(junk));
  }
});

test('empty / garbage input answers all-null instead of throwing', () => {
  // A ten-thousand-file drop must not die on the one junk entry.
  for (const bad of ['', '   ', '/', '///', './', null, undefined, 42, {}, [], NaN, true]) {
    assert.deepEqual(parseLibraryPath(bad as any), NO_LIBRARY_FIELDS, JSON.stringify(bad) ?? String(bad));
  }
  // A bare extension names nothing but the file it is.
  assert.deepEqual(parsed('.3ds'), { group: null, category: null, collection: null });
  assert.equal(parseLibraryPath('.3ds').fileName, '.3ds');
  // A non-string is refused outright — coercing `{}` would file a piece under
  // a collection called "[object Object]".
  assert.equal(parseLibraryPath({ path: 'Upholstery-Sofa/Togo_gb.3ds' } as any).collection, null);
});

test('parsing is DETERMINISTIC — the same path always files the same way', () => {
  // Re-dropping the same folder must never create a second taxonomy for the
  // same pieces; the answer is a pure function of (path, shape).
  const paths = [
    'International-3DS/Upholstery-Sofa/Togo/Togo_gb.3ds',
    'International-3DS/Upholstery/Sofa/Prado_Settee_120.3ds',
    'Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds',
    'Cabinet/Oka/gd module laqué.3ds',
    'Kashima.3ds',
    '',
  ];
  const shape = resolveLibraryShape(paths);
  for (const p of paths) {
    const first = parseLibraryPath(p, shape);
    for (let i = 0; i < 3; i++) assert.deepEqual(parseLibraryPath(p, shape), first, p);
  }
  assert.deepEqual(fileBatch(paths), paths.map((q) => taxonomy(parseLibraryPath(q, shape))));
  // The result is a fresh object each call — a caller mutating one answer can't
  // poison the next file's…
  const a = parseLibraryPath('Upholstery-Sofa/Togo_gb.3ds');
  a.group = 'MUTATED';
  assert.equal(parseLibraryPath('Upholstery-Sofa/Togo_gb.3ds').group, 'Upholstery');
  // …the all-null answer included (it is a fresh copy of the frozen constant)…
  const none = parseLibraryPath('');
  none.group = 'MUTATED';
  assert.equal(parseLibraryPath('').group, null);
  assert.ok(Object.isFrozen(NO_LIBRARY_FIELDS));
  // …and the shape is FROZEN, because ONE plan is shared by a whole batch: a
  // caller that could edit it mid-import would re-level the files after it.
  assert.ok(Object.isFrozen(shape));
});

test('every LR_GROUPS token parses back as itself — parser and picker offer the same words', () => {
  // A UI offers LR_GROUPS as the GROUP options; a group the parser emits but the
  // picker doesn't list (or vice versa) is a piece the dealer can't refile. The
  // strings are handed back VERBATIM, never re-cased through the prettifier.
  for (const group of LR_GROUPS) {
    assert.equal(parseLibraryPath(`International-3DS/${group}/Chairs/Ava_chair.3ds`).group, group, group);
    assert.equal(parseLibraryPath(`International-3DS/${group}-Chairs/Ava_chair.3ds`).group, group, group);
    assert.equal(parseLibraryPath(`${group.toUpperCase()}/Chairs/Ava_chair.3ds`).group, group, group);
  }
  assert.equal(new Set(LR_GROUPS.map((g) => g.toUpperCase())).size, LR_GROUPS.length, 'no duplicate groups');
});

test('prettifyLibraryName: separators to spaces, first letters up, acronyms intact', () => {
  assert.equal(prettifyLibraryName('coffee-tables'), 'Coffee Tables');
  assert.equal(prettifyLibraryName('Upholstery__Sofa'), 'Upholstery Sofa');
  assert.equal(prettifyLibraryName('  peter   maly  '), 'Peter Maly');
  assert.equal(prettifyLibraryName('Sofa'), 'Sofa');
  // An already-capitalized acronym survives because the tail is left alone.
  assert.equal(prettifyLibraryName('LED-lighting'), 'LED Lighting');
  assert.equal(prettifyLibraryName('MDF'), 'MDF');
  // Always a string, so callers can chain without a null check.
  assert.equal(prettifyLibraryName(''), '');
  assert.equal(prettifyLibraryName(null), '');
  assert.equal(prettifyLibraryName(undefined), '');
  assert.equal(prettifyLibraryName('---'), '');
  // LOCALE-FREE upper-casing: `toLocaleUpperCase` under a Turkish locale turns
  // "i" into "İ" (U+0130) and the same folder would file twice.
  assert.equal(prettifyLibraryName('international').charCodeAt(0), 73, 'ASCII I, not İ');
  assert.equal(prettifyLibraryName('istanbul'), 'Istanbul');
});

// ── THE ADAPTER SURFACE. Everything above pins LR's reading rules; these pin the
// SHAPE of a layout, which is what a second manufacturer plugs into.

test('the six fields: what the path says, and what it was read PAST', () => {
  // The taxonomy is three fields, but a path also carries the packaging that was
  // stepped over. Reporting it is what keeps the read auditable — a piece filed
  // under `Hypna` can still be traced back to the exact folder and file.
  assert.deepEqual(parseLibraryPath('Upholstery/Beds/Hypna 160 2Versions/Hypna_160_v_G.3ds'), {
    group: 'Upholstery',
    category: 'Beds',
    collection: 'Hypna',
    modelFolder: 'Hypna 160 2Versions',
    variant: null,                       // the trailing folder IS the model folder here
    fileName: 'Hypna_160_v_G.3ds',
  });
  // Nested packaging: a BARE marker below the model folder is a rendering, and
  // it is reported VERBATIM (it is not a name we present).
  assert.deepEqual(parseLibraryPath('Upholstery/Beds/Hypna/2Versions/Hypna_160_v_G.3ds'), {
    group: 'Upholstery',
    category: 'Beds',
    collection: 'Hypna',
    modelFolder: 'Hypna',
    variant: '2Versions',
    fileName: 'Hypna_160_v_G.3ds',
  });
  // A folder that merely CARRIES a marker word beside the family is still the
  // model folder — the SHALLOWEST-surviving rule places it, not the marker list,
  // which is why nothing has to enumerate `Hypna 160 VersionLeft`.
  assert.deepEqual(parseLibraryPath('Upholstery/Beds/Hypna/Hypna 160 VersionLeft/Hypna_160_v_G.3ds'), {
    group: 'Upholstery',
    category: 'Beds',
    collection: 'Hypna',
    modelFolder: 'Hypna',
    variant: null,
    fileName: 'Hypna_160_v_G.3ds',
  });
  // A bare marker sitting ABOVE the model folder is packaging just the same.
  assert.deepEqual(parseLibraryPath('Upholstery/Beds/2Versions/Hypna/Hypna_160_v_G.3ds'), {
    group: 'Upholstery',
    category: 'Beds',
    collection: 'Hypna',
    modelFolder: 'Hypna',
    variant: '2Versions',
    fileName: 'Hypna_160_v_G.3ds',
  });
  // No model folder at all: the file is all there is, and nothing is invented.
  assert.deepEqual(parseLibraryPath('Cabinet/Marechiaro_Straight.3ds'), {
    group: null,
    category: 'Cabinet',
    collection: 'Marechiaro',
    modelFolder: null,
    variant: null,
    fileName: 'Marechiaro_Straight.3ds',
  });
  // The model folder that only the FOLDER names (`Oka`), file name untouched.
  assert.deepEqual(parseLibraryPath('Cabinet/Oka/gd module laqué.3ds'), {
    group: null,
    category: 'Cabinet',
    collection: 'Oka',
    modelFolder: 'Oka',
    variant: null,
    fileName: 'gd module laqué.3ds',
  });
  // EVERY field is string|null — never a guessed value, and never undefined.
  for (const path of [
    'Upholstery/Sofa Bed/Multy_Convertible120_NoBackWedge.3ds',
    'Upholstery/2Versions/Hypna_160_v_G.3ds',
    'Togo_gb.3ds',
    '',
  ]) {
    const out = parseLibraryPath(path);
    assert.deepEqual(Object.keys(out).sort(), ['category', 'collection', 'fileName', 'group', 'modelFolder', 'variant']);
    for (const [k, v] of Object.entries(out)) {
      assert.ok(v === null || typeof v === 'string', `${path} → ${k} is string|null`);
    }
  }
});

test('lrArchvizLayout is a LibraryLayout: measure the drop once, read every path by it', () => {
  const layout: LibraryLayout<lrArchviz.LibraryShape> = lrArchvizLayout;
  assert.equal(layout.id, 'lr-archviz');
  assert.ok(layout.label);

  // The two-call contract, exercised the way the batch ingest calls it.
  const paths = OWNER_ROWS.map(([p]) => p);
  const shape = layout.resolveShape(paths);
  paths.forEach((p, i) => assert.deepEqual(taxonomy(layout.parsePath(p, shape)), OWNER_ROWS[i][1], p));

  // The shape is OPTIONAL (a single-file drop derives its own) and TOTAL (junk
  // in, all-null out, never a throw) — both are interface promises, not LR ones.
  assert.deepEqual(layout.parsePath('Cabinet/Oka/gd module laqué.3ds'), layout.parsePath('Cabinet/Oka/gd module laqué.3ds', shape));
  assert.deepEqual(layout.parsePath(null as any), NO_LIBRARY_FIELDS);
  assert.deepEqual(layout.resolveShape(null as any), { groupDepth: null, categoryDepth: 0, compound: false });

  // GROUP-LESS BRANCHES stay group-less through the adapter too: `Cabinet/` next
  // to `Upholstery/` never borrows its neighbour's division.
  const mixedShape = layout.resolveShape(['Upholstery/Beds/Hypna_160.3ds', 'Cabinet/Oka/gd module.3ds']);
  assert.equal(layout.parsePath('Cabinet/Oka/gd module.3ds', mixedShape).group, null);
  assert.equal(layout.parsePath('Upholstery/Beds/Hypna_160.3ds', mixedShape).group, 'Upholstery');
});
