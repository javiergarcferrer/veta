// RENDER PARAMS — LEGACY-DEFAULT EQUIVALENCE.
//
// The de-hardcoding only counts if a caller that passes NOTHING gets exactly
// what the baked-in constants gave: `SOFT_BLEED`, `STANDARD_TOGO_FINISH` and the
// 72 cm framing height are now data, and this file is what stops "made it
// configurable" from quietly meaning "changed the look". Every legacy number is
// written out literally here rather than read from the module — a test that
// imports the constant it is pinning proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  DEFAULT_FINISH_PROFILE,
  DEFAULT_FRAME_HEIGHT_CM,
  finishProfileOf,
  frameHeight,
  makeFabricMaterial,
  meshSeamBleed,
} from '../src/index.ts';

// ── Seam bleed ───────────────────────────────────────────────────────────────

test('meshSeamBleed with NO params reproduces the legacy SOFT_BLEED table', () => {
  // The old table, verbatim: { togo: 1.04, saparella: 1.0 }, '' → togo,
  // anything unlisted → 0.98 (the "structured" marker).
  const legacy = (collection: string | null | undefined) => {
    const c = (collection == null ? '' : String(collection)).trim().toLowerCase();
    const SOFT: Record<string, number> = { togo: 1.04, saparella: 1.0 };
    if (c === '') return SOFT.togo;
    return SOFT[c] ?? 0.98;
  };
  const cases = ['Togo', 'togo', 'TOGO ', 'Saparella', 'saparella', 'Prado', 'prado', 'Anything Else', '', '   ', null, undefined];
  for (const c of cases) {
    assert.equal(meshSeamBleed(c), legacy(c), `meshSeamBleed(${JSON.stringify(c)})`);
  }
  // And the properties the placement code reads off it.
  assert.equal(meshSeamBleed('Togo'), 1.04);
  assert.equal(meshSeamBleed(null), 1.04, 'legacy rows read as Togo');
  assert.equal(meshSeamBleed('Saparella'), 1.0, 'nesting collections are TRUE size');
  assert.ok(meshSeamBleed('Prado') < 1, 'structured collections never overfill (the inset marker)');
});

test('a collection can now state its own bleed — three levers, table untouched', () => {
  // A flat override for this piece.
  assert.equal(meshSeamBleed('Togo', { seamBleed: 1.1 }), 1.1);
  assert.equal(meshSeamBleed('Whatever', { seamBleed: 1.1 }), 1.1);
  // A replacement table.
  assert.equal(meshSeamBleed('mah-jong', { seamBleedTable: { 'mah-jong': 1.06 } }), 1.06);
  // …and its own structured default for everything unlisted.
  assert.equal(meshSeamBleed('prado', { seamBleedTable: {}, structuredSeamBleed: 1 }), 1);
  // A nonsense override never wins (0 / NaN would collapse every piece).
  assert.equal(meshSeamBleed('Togo', { seamBleed: 0 }), 1.04);
  assert.equal(meshSeamBleed('Togo', { seamBleed: Number.NaN }), 1.04);
  // The default table is a shared constant and must not be mutable through use.
  assert.equal(meshSeamBleed('Togo'), 1.04);
});

// ── Framing height ───────────────────────────────────────────────────────────

test('frameHeight of an EMPTY scene is 72 — and only then', () => {
  assert.equal(DEFAULT_FRAME_HEIGHT_CM, 72);
  // three's own empty Box3 is min=+Infinity / max=-Infinity.
  assert.equal(frameHeight(new THREE.Box3()), 72);
  assert.equal(frameHeight(null), 72);
  assert.equal(frameHeight(undefined), 72);
  // A degenerate (zero-height) scene is still nothing to measure.
  assert.equal(frameHeight(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 100))), 72);
});

test('frameHeight MEASURES the scene — a tall piece is no longer framed as a Togo', () => {
  const togo = new THREE.Box3(new THREE.Vector3(-87, 0, -51), new THREE.Vector3(87, 72, 51));
  assert.equal(frameHeight(togo), 72, 'a real Togo measures 72 — the legacy number, now derived');
  const shelving = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 210, 40));
  assert.equal(frameHeight(shelving), 210, 'and a 2.1 m unit frames as 2.1 m');
  // An explicit override skips the measurement entirely.
  assert.equal(frameHeight(shelving, { frameHeightCm: 90 }), 90);
  assert.equal(frameHeight(null, { frameHeightCm: 90 }), 90);
  assert.equal(frameHeight(shelving, { frameHeightCm: 0 }), 210, 'a nonsense override never wins');
});

// ── Finish profile ───────────────────────────────────────────────────────────

test('DEFAULT_FINISH_PROFILE IS the legacy STANDARD_TOGO_FINISH', () => {
  assert.deepEqual({ ...DEFAULT_FINISH_PROFILE }, {
    roughness: 0.85, sheen: 0.7, sheenRoughness: 0.6,
    clearcoat: 0, clearcoatRoughness: 0.4, repeat: 3, normalScale: 0.8,
  });
  // A partial override merges over it rather than replacing it.
  assert.deepEqual(finishProfileOf({ finishProfile: { sheen: 0.2 } }), {
    ...DEFAULT_FINISH_PROFILE, sheen: 0.2,
  });
  assert.deepEqual(finishProfileOf(), { ...DEFAULT_FINISH_PROFILE });
});

test('a fabric material built with DEFAULT_FINISH_PROFILE matches the old constants', () => {
  // The legacy call site spread STANDARD_TOGO_FINISH into `opts`; the profile
  // is now the DEFAULT, so a bare call must land on the same numbers.
  const bare = makeFabricMaterial(THREE, null, { color: 0x884422 });
  const spread = makeFabricMaterial(THREE, null, {
    color: 0x884422,
    roughness: 0.85, sheen: 0.7, sheenRoughness: 0.6,
    clearcoat: 0, clearcoatRoughness: 0.4, repeat: 3, normalScale: 0.8,
  });
  for (const k of ['roughness', 'sheen', 'sheenRoughness', 'clearcoat', 'clearcoatRoughness', 'metalness', 'envMapIntensity'] as const) {
    assert.equal((bare as any)[k], (spread as any)[k], `${k} matches the legacy spread`);
  }
  assert.equal(bare.roughness, 0.85);
  assert.equal(bare.sheen, 0.7);
  assert.equal(bare.sheenRoughness, 0.6);
  assert.equal(bare.clearcoat, 0);
  assert.equal(bare.metalness, 0, 'dielectric — never plastic/metal');
  assert.equal(bare.envMapIntensity, 0.7, 'a coloured (fabricked) piece keeps the full IBL fill');
  assert.equal(bare.color.getHex(), 0x884422);
  bare.dispose(); spread.dispose();
});

test('MATERIALLESS keeps its own form-first numbers — the profile does not flatten it', () => {
  const none = makeFabricMaterial(THREE, null, {});
  assert.equal(none.sheen, 0.35, 'a gentler sheen so the oatmeal body is not glazed over');
  assert.equal(none.envMapIntensity, 0.42, 'a lower IBL fill so the key carves the channels');
  assert.equal(none.roughness, 0.85, 'roughness still comes from the profile');
  assert.equal(none.color.getHex(), 0xa28f71, 'the warm oatmeal default');
  none.dispose();
});

test('the profile is a LEVER: a collection can restyle the velvet without touching the engine', () => {
  const linen = makeFabricMaterial(THREE, null, {
    color: 0x884422,
    finishProfile: { sheen: 0.1, sheenRoughness: 0.9, roughness: 0.95 },
  });
  assert.equal(linen.sheen, 0.1);
  assert.equal(linen.sheenRoughness, 0.9);
  assert.equal(linen.roughness, 0.95);
  assert.equal(linen.clearcoat, 0, 'unstated knobs still fall back to the default profile');
  linen.dispose();
});
