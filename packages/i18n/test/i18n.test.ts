/**
 * @veta/i18n — the locale-layer fitness test.
 *
 * Ported from the reference configurator's `togoI18n.test.js` and extended for
 * the platform: the widget ships to brands worldwide, so a missing translation
 * is a bug (a silent Spanish leak on someone's German site), not a detail.
 *
 * What is pinned: identical key sets across locales, every key populated,
 * the fixed `inbox.*` + `price.from` contract, EVERY `@veta/rules` message key
 * present in all four locales, safe degradation (es fallback, key echo),
 * interpolation, and locale precedence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  RULES_MESSAGE_KEYS,
  dictionary,
  hasKey,
  isLocale,
  localeKeys,
  piecesLabel,
  resolveLocale,
  t,
} from '../src/index.ts';

// The fixed contract the dealer lead inbox consumes — never rename or drop.
const REQUIRED_INBOX_KEYS = [
  'inbox.title',
  'inbox.empty',
  'inbox.loading',
  'inbox.error',
  'inbox.pieces',
  'inbox.note',
  'inbox.estimate',
  'inbox.contact',
  'inbox.markContacted',
  'inbox.reopen',
  'inbox.status.pending',
  'inbox.status.contacted',
  'inbox.status.converted',
  'inbox.status.dismissed',
];

/**
 * Loan words that are legitimately IDENTICAL in all four locales. Everything
 * else must differ somewhere, or a locale was left as an un-translated paste.
 * Keep this list tiny and justified — it is the escape hatch the test earns.
 */
const IDENTICAL_BY_DESIGN = new Set(['fabric.catOutdoor']);

test('locales are exactly the four supported tags', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['es', 'en', 'fr', 'de']);
  assert.equal(DEFAULT_LOCALE, 'es');
  assert.ok(isLocale('fr'));
  assert.ok(!isLocale('xx'));
  assert.ok(!isLocale(null));
});

test('all four locales have IDENTICAL key sets', () => {
  const esKeys = [...localeKeys('es')].sort();
  assert.ok(esKeys.length > 150, `es dictionary looks too small (${esKeys.length} keys)`);
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual([...localeKeys(locale)].sort(), esKeys, `locale "${locale}" key set differs from es`);
  }
});

test('every locale actually populates every key (non-empty, no key echo)', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of localeKeys('es')) {
      const val = t(locale, key);
      assert.notEqual(val, key, `[${locale}] key "${key}" echoed the key (missing)`);
      assert.ok(val.trim().length > 0, `[${locale}] key "${key}" is empty`);
    }
  }
});

test('exact inbox.* + price.from contract keys exist in all four locales', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const keys = new Set<string>(localeKeys(locale));
    for (const key of [...REQUIRED_INBOX_KEYS, 'price.from']) {
      assert.ok(keys.has(key), `[${locale}] contract key "${key}" is missing`);
    }
  }
  assert.equal(t('es', 'inbox.title'), 'Solicitudes');
  assert.equal(t('es', 'inbox.markContacted'), 'Marcar contactado');
  assert.equal(t('es', 'price.from'), 'Desde');
  assert.equal(t('en', 'price.from'), 'From');
  assert.equal(t('fr', 'price.from'), 'À partir de');
  assert.equal(t('de', 'price.from'), 'Ab');
});

test('every @veta/rules message key is translated in all four locales', () => {
  for (const key of RULES_MESSAGE_KEYS) {
    assert.ok(hasKey(key), `rules key "${key}" is not in the dictionary`);
    for (const locale of SUPPORTED_LOCALES) {
      const val = t(locale, key);
      assert.notEqual(val, key, `[${locale}] rules key "${key}" is missing`);
    }
  }
  // The engine's own params must survive interpolation into the copy.
  assert.match(t('es', 'rules.count.min', { count: 1, min: 2 }), /1/);
  assert.match(t('de', 'rules.extent.maxWidth', { widthCm: 320, maxWidthCm: 300 }), /320/);
  // The four edge labels a View substitutes into the adjacency messages.
  for (const edge of ['left', 'right', 'front', 'back']) {
    assert.ok(hasKey(`rules.edge.${edge}`), `missing edge label rules.edge.${edge}`);
  }
});

test('translations are real, not es copies (allowlisted loan words aside)', () => {
  for (const key of localeKeys('es')) {
    if (IDENTICAL_BY_DESIGN.has(key)) continue;
    const source = t('es', key);
    const others = ['en', 'fr', 'de'].map((l) => t(l, key));
    assert.ok(
      others.some((v) => v !== source),
      `key "${key}" is identical across every locale ("${source}") — likely untranslated`,
    );
  }
});

test('the allowlist is not stale (every entry really is identical everywhere)', () => {
  for (const key of IDENTICAL_BY_DESIGN) {
    const source = t('es', key);
    const others = ['en', 'fr', 'de'].map((l) => t(l, key));
    assert.ok(
      others.every((v) => v === source),
      `"${key}" is now translated — drop it from IDENTICAL_BY_DESIGN`,
    );
  }
});

test('t() falls back to the es entry when the locale is unknown', () => {
  assert.equal(t('zz', 'launch.cta'), t('es', 'launch.cta'));
  assert.equal(t('zz', 'launch.cta'), 'Empezar a diseñar');
  assert.equal(t(null, 'launch.cta'), 'Empezar a diseñar');
  assert.equal(t(undefined, 'launch.cta'), 'Empezar a diseñar');
});

test('t() returns the key itself for an unknown key (never throws)', () => {
  assert.equal(t('es', 'this.key.does.not.exist'), 'this.key.does.not.exist');
  assert.equal(t('fr', 'nope'), 'nope');
  assert.doesNotThrow(() => t('es', 'launch.cta', undefined));
  assert.ok(!hasKey('this.key.does.not.exist'));
});

test('{var} interpolation substitutes provided vars and leaves unknown placeholders', () => {
  assert.equal(t('es', 'piece.add', { name: 'Ottoman' }), 'Agregar Ottoman');
  assert.equal(t('en', 'chip.pickFabricFor', { name: 'Corner' }), 'Choose the fabric for Corner');
  assert.equal(t('es', 'announce.rotated', { deg: 90 }), 'Pieza girada a 90 grados');
  assert.equal(t('es', 'dims.set', { w: 200, d: 100 }), 'Conjunto 200 × 100 cm');
  // A placeholder with no matching var is left intact (not "undefined").
  assert.equal(t('es', 'piece.add', {}), 'Agregar {name}');
  assert.equal(t('es', 'piece.add'), 'Agregar {name}');
});

test('piecesLabel pluralizes per locale', () => {
  assert.equal(piecesLabel('es', 1), '1 pieza');
  assert.equal(piecesLabel('es', 3), '3 piezas');
  assert.equal(piecesLabel('en', 1), '1 piece');
  assert.equal(piecesLabel('fr', 2), '2 pièces');
  assert.equal(piecesLabel('de', 1), '1 Teil');
});

test('resolveLocale precedence: query > brand > navigator > es', () => {
  assert.equal(resolveLocale({ queryLang: 'fr', brandLocale: 'de' }), 'fr');
  assert.equal(resolveLocale({ queryLang: 'xx', brandLocale: 'de' }), 'de');
  assert.equal(resolveLocale({ queryLang: null, brandLocale: 'en' }), 'en');
  assert.equal(resolveLocale({ brandLocale: 'zz', navigator: ['de-AT', 'en'] }), 'de');
  assert.equal(resolveLocale({ navigator: ['pt-BR', 'fr-CA'] }), 'fr');
  assert.equal(resolveLocale({ brandLocale: 'zz' }), 'es');
  assert.equal(resolveLocale({}), 'es');
  assert.equal(resolveLocale(), 'es');
  // A valid query tag always wins, even over a valid brand locale.
  assert.equal(resolveLocale({ queryLang: 'de', brandLocale: 'fr' }), 'de');
  // Region subtags resolve on their primary subtag.
  assert.equal(resolveLocale({ queryLang: 'fr-CA' }), 'fr');
  assert.equal(resolveLocale({ queryLang: 'EN-gb' }), 'en');
});

test('dictionary() exposes a whole locale and degrades to es', () => {
  assert.equal(dictionary('de')['toolbar.plan'], 'Grundriss');
  assert.equal(dictionary('zz')['toolbar.plan'], dictionary('es')['toolbar.plan']);
  assert.equal(localeKeys('zz').length, 0);
});
