/**
 * EL SEGUNDO CONFIGURADOR — y el primero que no es Togo.
 *
 * Two things are pinned here, and they fail for different reasons:
 *
 *   1. THE SEAM. Which brand a public path names, decided once. The last time
 *      this lived in a regex it lived in THREE of them, and adding a spelling
 *      to two left the third behind. A registry is only better than a regex if
 *      a test says what it must answer.
 *   2. THE CONFIGURATOR ITSELF, against the manufacturer's REAL data — the
 *      CH24 Wishbone master, its VAT0-USD price list and its product page,
 *      captured verbatim. Its pricing grammar was measured, not inferred
 *      (`CH24_01_020101` is Seat-then-Frame while `CH07_<Frame>_<SeatBack>` is
 *      Frame-then-SeatBack), so a synthetic fixture would have invented a tidy
 *      rule and passed while the real one broke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CONFIGURATORS, DEFAULT_CONFIGURATOR, configuratorById,
  configuratorForPathname, configuratorPath,
} from '../src/brands/configurators/index.js';
import { isConfiguratorPathname } from '../src/lib/togoEmbed.js';
import { isPublicRoute } from '../src/lib/theme.js';
import { resolveCarlHansenConfigurator } from '../src/core/catalog/carlHansenConfigurator.js';
import { canonicalLabel } from '../src/brands/carl-hansen/variants.ts';
import {
  safeModelId, safeMarket, sitePathOf, productPagesFromSitemap, parseNextData, slimPage,
  looksLikeProductCode,
  modelUrl, pricesUrl, ALLOWED_HOSTS,
} from '../supabase/functions/carl-hansen/parse.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carlHansen');
const load = (n) => JSON.parse(readFileSync(join(FIX, n), 'utf8'));

const SPEC = load('CH24_en.model.json');
const PRICES = load('CH24_prices_VAT0-USD.json');
const PAGE = load('ch24.pageData.json');

/* ─────────────────────────────────────────────────── el seam ────────────── */

test('las rutas desnudas son de Togo, para siempre', () => {
  // They are printed on things and pasted into dealers' websites. Whatever
  // becomes the "main" brand later, these keep resolving to Togo.
  for (const p of ['/configurador', '/configurator', '/configurador/', '/configurator/']) {
    assert.equal(configuratorForPathname(p)?.id, 'togo', p);
  }
  assert.equal(DEFAULT_CONFIGURATOR.id, 'togo');
  assert.equal(configuratorPath(DEFAULT_CONFIGURATOR), '/configurador');
});

test('cada marca nueva llega por sufijo, en las dos ortografías', () => {
  assert.equal(configuratorForPathname('/configurador/carl-hansen')?.id, 'carl-hansen');
  assert.equal(configuratorForPathname('/configurator/carl-hansen')?.id, 'carl-hansen');
  assert.equal(configuratorPath(configuratorById('carl-hansen')), '/configurador/carl-hansen');
});

test('un sufijo desconocido NO cae a la marca por defecto', () => {
  // `/configurador/carl-hanson` is a typo. Opening a modular-sofa configurator
  // for somebody who asked for a chair is worse than showing them nothing: they
  // would configure the wrong manufacturer's product believing it was right.
  assert.equal(configuratorForPathname('/configurador/carl-hanson'), null);
  assert.equal(configuratorForPathname('/configurador/ligne-roset'), null);
  assert.equal(configuratorForPathname('/configurador/carl-hansen/extra'), null);
  assert.equal(configuratorForPathname('/otra-cosa'), null);
  assert.equal(configuratorForPathname(''), null);
  assert.equal(configuratorForPathname(null), null);
});

test('las tres preguntas sobre una ruta dan la MISMA respuesta', () => {
  // The bug this exists to prevent: the entry that mounts the widget, the
  // widget's own "am I standalone?" check and the forced-light public-route
  // test each carried a copy of the rule, and one of them fell behind.
  for (const p of ['/configurador', '/configurador/carl-hansen', '/configurator/carl-hansen']) {
    assert.equal(isConfiguratorPathname(p), true, p);
    assert.equal(isPublicRoute('', p), true, p);
  }
  for (const p of ['/', '/configurador/carl-hanson', '/admin']) {
    assert.equal(isConfiguratorPathname(p), false, p);
  }
});

test('cada configurador registrado tiene un id, una marca y qué compone', () => {
  const ids = CONFIGURATORS.map((c) => c.id);
  assert.deepEqual([...new Set(ids)], ids, 'los ids se repiten');
  const slugs = CONFIGURATORS.filter((c) => c.slug).map((c) => c.slug);
  assert.deepEqual([...new Set(slugs)], slugs, 'los slugs se repiten');
  // Exactly one owns the bare paths — two would make the resolution arbitrary.
  assert.equal(CONFIGURATORS.filter((c) => !c.slug).length, 1);
  for (const c of CONFIGURATORS) {
    assert.ok(c.brandSlug, `${c.id} sin marca`);
    assert.ok(c.label && c.brandName && c.composes, `${c.id} sin etiquetas`);
  }
});

/* ──────────────────────────────────── el transporte, con sus candados ───── */

test('el modelId se valida antes de entrar en una ruta del blob', () => {
  // This value is interpolated into somebody else's storage path. A lax rule
  // here is a path traversal on their account, not a cosmetic problem.
  assert.equal(safeModelId('CH24'), 'CH24');
  assert.equal(safeModelId('ch24'), 'CH24');
  assert.equal(safeModelId('CH24-H43'), 'CH24-H43');
  assert.equal(safeModelId('BM1106'), 'BM1106');
  for (const bad of ['../../etc', 'CH24/../x', 'CH 24', 'CH24.json', '', null, 'A'.repeat(30)]) {
    assert.equal(safeModelId(bad), null, String(bad));
  }
  assert.equal(safeMarket('VAT0-USD'), 'VAT0-USD');
  assert.equal(safeMarket('../x'), null);
  assert.ok(modelUrl('CH24').startsWith('https://stchsdocsprod.blob.core.windows.net/products/models/CH24/'));
  assert.ok(pricesUrl('CH24', 'VAT0-USD').endsWith('CH24_prices_VAT0-USD.json'));
});

test('el sitemap es dato ajeno: solo tres hosts, y nada que salga de ellos', () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), [
    'admincms.carlhansen.com', 'stchsdocsprod.blob.core.windows.net', 'www.carlhansen.com',
  ]);
  assert.equal(sitePathOf('https://www.carlhansen.com/en/en/collection/chairs/ch24'), '/en/en/collection/chairs/ch24');
  for (const bad of [
    'https://evil.com/x',
    'https://www.carlhansen.com.evil.com/x',
    'https://www.carlhansen.com/../secret',
    'https://www.carlhansen.com//evil.com',
    '//evil.com',
  ]) assert.equal(sitePathOf(bad), null, bad);
});

test('el sitemap → solo productos, y el código sale del último segmento', () => {
  const xml = `<urlset>
    <url><loc>https://www.carlhansen.com/en/en</loc></url>
    <url><loc>https://www.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24</loc></url>
    <url><loc>https://www.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24</loc></url>
    <url><loc>https://www.carlhansen.com/en/en/collection/lounge/bm1106</loc></url>
    <url><loc>https://www.carlhansen.com/en/en/stories/a-home</loc></url>
    <url><loc>https://evil.com/en/collection/x/ch99</loc></url>
  </urlset>`;
  // Editorial and the front page are not products; the other host never
  // qualifies; the duplicate collapses.
  assert.deepEqual(productPagesFromSitemap(xml).map((m) => m.modelId), ['CH24', 'BM1106']);
  assert.deepEqual(productPagesFromSitemap(null), []);
});

test('el sitemap mete categorías y diseñadores entre los productos', () => {
  // Measured against all 370 entries. Seven of every twenty-four the picker
  // offered were dead — `SPARE-PARTS`, `DINING-CHAIRS`, `BORGE-MOGENSEN` —
  // each opening onto "sin ficha".
  for (const id of ['CH24', 'BM1106', 'E015', 'VLA26P', 'RF1905', 'MG501-PAPERCORD', 'BM0703-TEAK', 'OS111-BEGONYA'])
    assert.equal(looksLikeProductCode(id), true, id);
  for (const id of ['SPARE-PARTS', 'BAR-STOOLS', 'DINING-CHAIRS', 'BORGE-MOGENSEN', 'CHRISTMAS-BAUBLE', 'TRIVETS', 'EOOS', 'AH-601', 'CUSHION-CH36'])
    assert.equal(looksLikeProductCode(id), false, id);
  // The FIRST segment carries the code — requiring a digit in every segment
  // also looked right and threw away four real products whose second segment
  // names a material.
  assert.equal(looksLikeProductCode('BM0703-OAK'), true);
  assert.equal(looksLikeProductCode(''), false);
  assert.equal(looksLikeProductCode(null), false);
});

test('la página de producto entrega sus variantes VERBATIM', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${
    JSON.stringify({ props: { pageProps: { pageData: {
      Name: 'CH24 Wishbone Chair', Variants: [{ Sku: '5714413946903', ProductionDays: 54 }],
    } } } })
  }</script></body></html>`;
  const page = slimPage(parseNextData(html));
  assert.equal(page.name, 'CH24 Wishbone Chair');
  // The matcher that reads these was measured against this exact shape;
  // re-shaping them here would put a thinner vocabulary in between.
  assert.deepEqual(page.Variants, [{ Sku: '5714413946903', ProductionDays: 54 }]);
  assert.equal(parseNextData('<html>sin script</html>'), null);
  assert.equal(parseNextData('<script id="__NEXT_DATA__">no es json</script>'), null);
  assert.equal(slimPage(null), null);
});

/* ────────────────────────── el configurador, contra datos reales ────────── */

test('CH24: los ejes reales, la clave compuesta y el precio publicado', () => {
  const vm = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {});
  assert.equal(vm.modelId, 'CH24');
  assert.equal(vm.modelName, 'Wishbone Chair');
  assert.deepEqual(vm.axes.map((a) => a.label), ['Gliders', 'Frame', 'Seat']);
  // A composed key, not a guessed one: the master publishes the template.
  assert.match(vm.priceKey.key, /^CH24_\d+_\d+$/);
  assert.equal(vm.matched, 'primary');
  assert.equal(vm.currency, 'USD');
  assert.ok(vm.listPriceUsd > 0);
  assert.equal(vm.ready, true);
  assert.deepEqual(vm.unresolved, []);
});

test('la certificación FSC se renombró en UN lado, y no puede romper el cruce', () => {
  // Found live: the blob master still says "FSC™-certified Oak" while the
  // product page now prints "FSC™ Mix-certified oak". With the two sides
  // disagreeing, EVERY CH24 configuration matched zero variants — no reference,
  // no lead time, on a chair that is in stock.
  const renamed = {
    ...PAGE,
    Variants: PAGE.Variants.map((v) => JSON.parse(
      JSON.stringify(v).replace(/FSC™-certified/g, 'FSC™ Mix-certified'),
    )),
  };
  const before = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {});
  const after = resolveCarlHansenConfigurator(SPEC, PRICES, renamed, {});
  assert.equal(after.variant?.sku, before.variant.sku, 'el renombre no puede perder la variante');

  // …and the fix must NOT be to delete the certification marker: the same axis
  // carries "FSC™-certified Oak" AND "Oak FSC-70" as two different leaves, at
  // two different prices. Collapsing them would attach the wrong EAN, which is
  // worse than attaching none.
  // Read off the master itself rather than one configuration's axes: CH24
  // publishes several configurations and the two oaks do not both appear in
  // any single one, which is precisely how a strip would look safe in testing
  // and mis-price in production.
  const master = JSON.stringify(SPEC);
  assert.ok(master.includes('FSC™-certified Oak'));
  assert.ok(master.includes('Oak FSC-70'));
  // The alias only collapses the word that moved.
  assert.equal(canonicalLabel('FSC™ Mix-certified oak'), canonicalLabel('FSC™-certified Oak'));
  assert.notEqual(canonicalLabel('Oak FSC-70'), canonicalLabel('FSC™-certified Oak'));
});

test('elegir un eje cambia la clave, la referencia y el precio', () => {
  const base = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {});
  const frame = base.axes.find((a) => a.label === 'Frame');
  const other = frame.options.find((o) => !o.selected);
  const next = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {
    selection: { ...base.selection, [frame.id]: other.key },
  });
  assert.notEqual(next.priceKey.key, base.priceKey.key);
  assert.equal(next.axes.find((a) => a.label === 'Frame').selected.key, other.key);
  // A real EAN, and a different one — the variant IS the configuration.
  assert.match(base.variant.sku, /^\d{13}$/);
  assert.notEqual(next.variant?.sku, base.variant.sku);
});

test('nunca inventa un precio: una clave que no resuelve no cotiza', () => {
  // The rule that matters most in the whole port. An empty price list is the
  // cleanest way to ask for a key that resolves to nothing.
  const vm = resolveCarlHansenConfigurator(SPEC, { ...PRICES, modelPrices: {} }, PAGE, {});
  assert.equal(vm.listPriceUsd, null);
  assert.equal(vm.matched, null);
  // …and it SAYS so, as a blocker. Silence would read as free.
  assert.equal(vm.ready, false);
  assert.ok(vm.unresolved.some((i) => i.level === 'blocker'));
});

test('sin lista de precios sigue siendo una silla, con su ficha y sus ejes', () => {
  // BA103 and AJ52 are real: Carl Hansen publishes a master for them and no
  // price file in USD, EUR or DKK alike. The configurator must still show the
  // piece and say why it cannot price it.
  const vm = resolveCarlHansenConfigurator(SPEC, null, PAGE, {});
  assert.equal(vm.modelName, 'Wishbone Chair');
  assert.ok(vm.axes.length >= 3, 'los ejes salen de la ficha, no de los precios');
  assert.equal(vm.listPriceUsd, null);
  assert.equal(vm.priceState, 'unknown');
  assert.equal(vm.ready, false);
});

test('el stock NO se proyecta — Carl Hansen es hecho a pedido', () => {
  // The fixture DOES carry stock — 3,945 units on the default variant — so this
  // is a real drop, not an assertion about an absent field.
  const raw = PAGE.Variants.find((v) => Number(v?.Stock) > 0);
  assert.ok(raw, 'la captura tiene que traer stock para que la prueba signifique algo');

  const vm = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {});
  // A zero in Odense means "wait 54 days", not "cannot sell". `productionDays`
  // is the field that answers the visitor's actual question, and it is the one
  // that survives.
  assert.equal(JSON.stringify(vm.variant).toLowerCase().includes('"stock"'), false);
  assert.ok(vm.leadTimeDays > 0);
  assert.equal(vm.variant.productionDays, 10);
});

test('cada eje dice de qué está hecho, para que la UI elija instrumento', () => {
  // The picker renders a swatch grid for wood/upholstery/cord and buttons for
  // everything else. Reading that off the tree is what keeps a model Carl
  // Hansen adds next year from needing a hardcoded list here.
  const vm = resolveCarlHansenConfigurator(SPEC, PRICES, PAGE, {});
  const seat = vm.axes.find((a) => a.label === 'Seat');
  assert.equal(seat.kind, 'cord', 'en una Wishbone el asiento ES el papel trenzado');
  for (const axis of vm.axes) {
    assert.ok(axis.options.length > 0, `${axis.label} sin opciones`);
    assert.equal(axis.options.filter((o) => o.selected).length, 1, `${axis.label}: una sola selección`);
  }
});
