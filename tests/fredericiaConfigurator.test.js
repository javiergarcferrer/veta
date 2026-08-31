/**
 * EL CONFIGURADOR DE FREDERICIA — la proyección pura, pinneada.
 *
 * The VM (core/catalog/fredericiaConfigurator) projects the SAME grammar the
 * admin catalog reads (resolveVariantGroups + variantFacets) into a picker.
 * What this file pins is the money-adjacent behaviour:
 *
 *   • the price is only ever a matching row's number — `exact` when every
 *     matching variant agrees, `from` while choices remain, `none` when
 *     nothing matches or nothing is priced. Never an average, never the
 *     nearest neighbour (the Carl Hansen rule, which is the house rule).
 *   • cross-filter availability: an option with no variant alongside the rest
 *     of the selection is offered OFF, not as a dead end three taps later.
 *   • the grade is an axis here even though variantGroups keeps it out of the
 *     layers — it is the price ladder, and the visitor picks it like a wood.
 *   • the registry: /configurador/fredericia resolves to this instrument and
 *     the bare paths stay Togo's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRADE_AXIS_ID,
  resolveFredericiaFamilies,
  resolveFredericiaFamilyRows,
  resolveFredericiaConfigurator,
} from '../src/core/catalog/fredericiaConfigurator.js';
import { configuratorForPathname, configuratorById } from '../src/brands/configurators/index.js';

/** A believable slice of the Anthom import, enriched: one Spanish Chair in two
 *  woods × two leathers (one combination unpublished), plus a second model. */
const ROWS = [
  row('FRE-1731-LG2-OAK-NAT', 'Spanish Chair · Oak Oiled · Natural', 4200, 'LG2'),
  row('FRE-1731-LG2-OAK-BLK', 'Spanish Chair · Oak Oiled · Black', 4200, 'LG2'),
  row('FRE-1731-LG2-WAL-NAT', 'Spanish Chair · Walnut Oiled · Natural', 5100, 'LG2'),
  // Walnut exists ONLY in natural — black walnut is not published.
  row('FRE-1731-LG5-OAK-NAT', 'Spanish Chair · Oak Oiled · Natural', 5400, 'LG5'),
  row('FRE-2226-OAK', 'Wegner Ottoman · Oak Oiled', 900, ''),
];

function row(reference, name, priceUsd, grade) {
  const family = name.split(' · ')[0];
  return {
    reference,
    name,
    family,
    familyCode: reference.split('-')[1],
    subtype: grade ? `Grade ${grade}` : '',
    category: 'Chairs',
    priceUsd,
    imageSrc: `https://cdn.example/${reference}.jpg`,
    dimensions: '82 × 60 × 67 cm',
  };
}

const spanish = () => resolveFredericiaFamilyRows(ROWS, { model: 'Spanish Chair', familyCode: '1731' });

/* ───────────────────────────── families ───────────────────────────── */

test('families: one model per family+code, with desde and cover', () => {
  const fams = resolveFredericiaFamilies(ROWS);
  assert.equal(fams.length, 2);
  const sp = fams.find((f) => f.model === 'Spanish Chair');
  assert.equal(sp.count, 4);
  assert.equal(sp.priceMin, 4200);
  assert.equal(sp.priceMax, 5400);
  assert.ok(sp.imageSrc);
  assert.equal(resolveFredericiaFamilies(ROWS, { query: 'ottoman' }).length, 1);
});

test('family rows: the same fold that formed the front page', () => {
  assert.equal(spanish().length, 4);
  assert.equal(resolveFredericiaFamilyRows(ROWS, { model: 'spanish  chair', familyCode: '1731' }).length, 4, 'case + spacing fold');
  assert.equal(resolveFredericiaFamilyRows(ROWS, { model: 'Spanish Chair', familyCode: '2226' }).length, 0, 'the code walls the family');
});

/* ─────────────────────────────── axes ─────────────────────────────── */

test('axes: the grade rides first as its own axis; facets follow', () => {
  const vm = resolveFredericiaConfigurator(spanish());
  assert.ok(vm);
  assert.equal(vm.axes[0].id, GRADE_AXIS_ID);
  assert.deepEqual(vm.axes[0].options.map((o) => o.key), ['LG2', 'LG5']);
  assert.ok(vm.axes.length > 1, 'the facet layers follow');
  // Nothing picked → nothing selected, everything available.
  for (const axis of vm.axes) {
    assert.equal(axis.options.some((o) => o.selected), false);
    assert.ok(axis.options.every((o) => o.available));
  }
});

test('axes: cross-filter — an option with no companion variant goes off', () => {
  const vm = resolveFredericiaConfigurator(spanish(), { selection: pickOf(spanish(), 'Walnut') });
  // With walnut chosen, "Black" (whatever facet it landed in) must be
  // unavailable — the walnut chair is only published in natural.
  const options = vm.axes.flatMap((a) => a.options);
  const black = options.find((o) => /black/i.test(o.label));
  assert.ok(black, 'the black option exists');
  assert.equal(black.available, false);
  // And LG5 dies too: only the oak natural climbs to LG5.
  const lg5 = vm.axes[0].options.find((o) => o.key === 'LG5');
  assert.equal(lg5.available, false);
});

/* ─────────────────────────────── price ────────────────────────────── */

test('price: a range while choices remain, exact when the rows agree', () => {
  const open = resolveFredericiaConfigurator(spanish());
  assert.equal(open.price.state, 'from');
  assert.equal(open.price.minUsd, 4200);
  assert.equal(open.price.maxUsd, 5400);
  assert.ok(open.pending.length > 0, 'the panel can say what is missing');

  // Oak in LG2: two leathers, ONE price — exact without full narrowing.
  const oakLg2 = resolveFredericiaConfigurator(spanish(), {
    selection: { [GRADE_AXIS_ID]: 'LG2', ...pickOf(spanish(), 'Oak Oiled') },
  });
  assert.equal(oakLg2.price.state, 'exact');
  assert.equal(oakLg2.price.usd, 4200);
});

test('price: an impossible combination says none — never a neighbour', () => {
  const vm = resolveFredericiaConfigurator(spanish(), {
    selection: { [GRADE_AXIS_ID]: 'LG5', ...pickOf(spanish(), 'Walnut') },
  });
  assert.equal(vm.matching, 0);
  assert.equal(vm.price.state, 'none');
  assert.equal(vm.price.usd, null);
});

test('variant: resolved only when the selection truly determines it, with its ficha', () => {
  const rows = spanish();
  const vm = resolveFredericiaConfigurator(rows, {
    selection: { [GRADE_AXIS_ID]: 'LG2', ...pickOf(rows, 'Walnut') },
  });
  assert.equal(vm.matching, 1);
  assert.equal(vm.selectedVariant.reference, 'FRE-1731-LG2-WAL-NAT');
  assert.equal(vm.selectedVariant.dimensions, '82 × 60 × 67 cm', 'la ficha viene de la fila fuente');
  const ambiguous = resolveFredericiaConfigurator(rows, { selection: { [GRADE_AXIS_ID]: 'LG2' } });
  assert.equal(ambiguous.selectedVariant, null);
});

test('empty rows resolve to null, never a phantom model', () => {
  assert.equal(resolveFredericiaConfigurator([]), null);
  assert.equal(resolveFredericiaConfigurator(null), null);
});

/* ───────────────────────────── registry ───────────────────────────── */

test('registry: /configurador/fredericia is this instrument; the bare path stays Togo', () => {
  assert.equal(configuratorForPathname('/configurador/fredericia')?.id, 'fredericia');
  assert.equal(configuratorForPathname('/configurator/fredericia')?.id, 'fredericia');
  assert.equal(configuratorForPathname('/configurador')?.id, 'togo');
  assert.equal(configuratorById('fredericia')?.brandSlug, 'fredericia');
});

/** The folded key of the option whose label matches, wherever the facet
 *  classifier filed it — the test cares about behaviour, not the filing. */
function pickOf(rows, labelPart) {
  const vm = resolveFredericiaConfigurator(rows);
  for (const axis of vm.axes) {
    const hit = axis.options.find((o) => o.label.toLowerCase().includes(labelPart.toLowerCase()));
    if (hit) return { [axis.id]: hit.key };
  }
  throw new Error(`no option labelled like "${labelPart}"`);
}
