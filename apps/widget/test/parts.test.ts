/**
 * THE PARTS PANEL — the two kinds, the whisper, and the tag that agrees with
 * the click.
 *
 * Ported from the reference widget (RosetSoft 17f8fff): «Componentes» over the
 * cloth rows with the estructura LAST, «igual que la pieza» wherever a part
 * rides the piece's own cloth, and the 2D tag gated on exactly what the tap is
 * gated on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { editablePartRoles, partDivergence, resolvePartTag, resolvePartsPanel } from '../src/vm/parts.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';
import type { ResolvedModel } from '../src/vm/catalog.ts';

// A structured module as the studio tags one: an upholstered shell, cushions
// and a bolster that BILL (bound families), an ottoman-style materialization
// zone that binds none by design, and four legs merged into ONE finish group.
const MODEL = {
  id: 'm-settee',
  name: 'Settee',
  parts: {
    mats: { SHELL: 'base', CUSH: 'cushion', ROLL: 'bolster', OUT: 'exterior', LEG1: 'structure', LEG2: 'structure' },
    merges: { LEG2: 'LEG1' },
    labels: { LEG1: 'Patas' },
    finishes: {
      LEG1: {
        label: 'Acabado',
        default: 'negro',
        options: [{ id: 'negro', label: 'Negro mate', rgb: '#181818' }, { id: 'laton', label: 'Latón', rgb: '#b08d57' }],
      },
    },
  },
  partFamilies: {
    cushion: { root: 'C1', name: 'C1', graded: true, grades: ['C'], byGrade: { C: { priceUsd: 90, reference: 'C1C' } } },
    bolster: { root: 'B1', name: 'B1', graded: true, grades: ['C'], byGrade: { C: { priceUsd: 40, reference: 'B1C' } } },
  },
} as unknown as ResolvedModel;

const PIECE: PlacedPiece = {
  uid: 'p1', pieceId: 'm-settee', x: 0, y: 0, rot: 0,
  material: { code: 'B0021', grade: 'C', fabric: 'Bleu Paon' },
} as unknown as PlacedPiece;

const dressed = (over: Record<string, unknown>): PlacedPiece => ({ ...PIECE, ...over } as PlacedPiece);

test('the editable roles are the BILLED families plus the tagged zones — never base or structure', () => {
  // A zone binds no family BY DESIGN (it re-grades the base SKU), so gating on
  // "has a family" hid it while the tap opened it anyway.
  assert.deepEqual(editablePartRoles(MODEL), ['exterior', 'cushion', 'bolster']);
  assert.deepEqual(editablePartRoles(null), []);
});

test('two kinds, two eyebrows — and the ESTRUCTURA is always last', () => {
  const view = resolvePartsPanel(PIECE, MODEL, 'es');
  assert.equal(view.componentsLabel, 'Componentes');
  assert.equal(view.structureLabel, 'Estructura');
  assert.deepEqual(view.components.map((r) => r.role), ['exterior', 'cushion', 'bolster'], 'anatomical order, never jsonb key order');
  assert.equal(view.components.every((r) => r.kind === 'fabric'), true);
  // The four legs are ONE group (merges), wearing the dealer's own label and
  // the collection's default acabado.
  assert.equal(view.structures.length, 1);
  assert.equal(view.structures[0].label, 'Patas');
  assert.equal(view.structures[0].wearing, 'Negro mate');
  assert.equal(view.structures[0].groupKey, 'LEG1');
  assert.equal(view.empty, false);
});

test('THE WHISPER: a part with no pick of its own says it rides the piece\'s cloth', () => {
  const view = resolvePartsPanel(PIECE, MODEL, 'es');
  const cushion = view.components.find((r) => r.role === 'cushion')!;
  assert.equal(cushion.inherited, true);
  assert.equal(cushion.wearing, 'Bleu Paon', 'it IS wearing the piece\'s cloth…');
  assert.equal(cushion.note, 'Igual que la pieza', '…and a fabric name alone would read as a choice nobody made');
  assert.equal(cushion.code, 'B0021', 'the swatch is the piece\'s, shown as the inheritance it is');

  // Its OWN pick silences the whisper and names the divergence.
  const own = resolvePartsPanel(dressed({ partMaterials: { cushion: { code: 'L0100', grade: 'X', fabric: 'Noir' } } }), MODEL, 'es');
  const picked = own.components.find((r) => r.role === 'cushion')!;
  assert.equal(picked.inherited, false);
  assert.equal(picked.wearing, 'Noir');
  assert.equal(picked.note, '');
  // An estructura never whispers: a finish palette always resolves to an option
  // of its own, and the piece has no acabado to inherit from.
  assert.equal(own.structures[0].note, '');
});

test('a pick of the very SAME cloth is not a divergence — the money rule compares CODES', () => {
  const same = dressed({ partMaterials: { cushion: { code: 'B0021', grade: 'C', fabric: 'Bleu Paon' } } });
  assert.equal(partDivergence(same, 'cushion'), null, 'one cloth is one element however it was arrived at');
  assert.equal(resolvePartsPanel(same, MODEL, 'es').components.find((r) => r.role === 'cushion')!.note, 'Igual que la pieza');
  // …and it is self-healing: re-dressing the PIECE makes it a real divergence.
  const rebased = { ...same, material: { code: 'L0100', grade: 'X', fabric: 'Noir' } } as PlacedPiece;
  assert.equal((partDivergence(rebased, 'cushion') as { fabric?: string } | null)?.fabric, 'Bleu Paon');
});

test('the panel answers in the visitor\'s language', () => {
  assert.equal(resolvePartsPanel(PIECE, MODEL, 'de').componentsLabel, 'Komponenten');
  assert.equal(resolvePartsPanel(PIECE, MODEL, 'fr').components.find((r) => r.role === 'cushion')!.note, 'Comme la pièce');
  // The dealer's own label outranks the localized role label.
  assert.equal(resolvePartsPanel(PIECE, MODEL, 'en').structures[0].label, 'Patas');
});

test('THE TAG AND THE CLICK AGREE: structureGroupFor ∪ the editable roles, nothing else', () => {
  // Metal wears an acabado — the tag reads the finish, never an invitation to
  // pick cloth it cannot wear.
  const legs = resolvePartTag(PIECE, MODEL, { role: 'structure', partKey: 'LEG2' }, 'es');
  assert.deepEqual(legs, { name: 'Patas', wearing: 'Negro mate', kind: 'structure', groupKey: 'LEG1' });
  // A ZONE names itself even on a piece with no cloth of its own — the old gate
  // went silent here while the tap opened the picker regardless.
  const bare = { uid: 'p1', pieceId: 'm-settee', x: 0, y: 0, rot: 0 } as PlacedPiece;
  assert.deepEqual(resolvePartTag(bare, MODEL, { role: 'exterior' }, 'es'), {
    name: 'Exterior', wearing: 'Click para cambiar la tela', kind: 'fabric',
  });
  // A part with its own pick names what it wears.
  const picked = dressed({ partMaterials: { bolster: { code: 'L0100', grade: 'X', fabric: 'Noir' } } });
  assert.equal(resolvePartTag(picked, MODEL, { role: 'bolster' }, 'es')?.wearing, 'Noir');
  // And it stays SILENT exactly where the tap opens nothing: the body, a role
  // this model does not carry, no hover at all.
  assert.equal(resolvePartTag(PIECE, MODEL, { role: 'base' }, 'es'), null);
  assert.equal(resolvePartTag(PIECE, MODEL, { role: 'armCushion' }, 'es'), null);
  assert.equal(resolvePartTag(PIECE, MODEL, null, 'es'), null);
  assert.equal(resolvePartTag(PIECE, null, { role: 'cushion' }, 'es'), null, 'a vanished model promises nothing');
});

test('an untagged model has no panel at all — never an empty one pretending otherwise', () => {
  const plain = { id: 'm-plain', name: 'Plain', parts: null, partFamilies: null } as unknown as ResolvedModel;
  const view = resolvePartsPanel(PIECE, plain, 'es');
  assert.deepEqual(view.components, []);
  assert.deepEqual(view.structures, []);
  assert.equal(view.empty, true);
});
