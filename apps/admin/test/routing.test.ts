/**
 * ROUTING CONFIG — the cascade, edited.
 *
 * Pinned: the editor round-trips the document the API parses, ORDER is the
 * product (moving a stage is not a sort), an all-off cascade is saved as an
 * explicit "manual" rather than as an empty list that would silently read back
 * as the default, and the preview is the ENGINE — the same `routeLead` the API
 * calls, against the brand's real network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingConfig } from '@veta/catalog';

import {
  defaultRoutingDraft,
  moveStage,
  parseCentroidText,
  previewRouting,
  routableFrom,
  routingDraftOf,
  setHonorPinned,
  setMaxDistance,
  toggleStage,
  validateRoutingDraft,
} from '../src/vm/index.ts';
import type { AdminDealer, AdminLocation, RoutingDraft } from '../src/vm/index.ts';

const stages = (draft: RoutingDraft) => draft.stages.filter((s) => s.enabled).map((s) => s.policy);

/* --------------------------------- the draft ------------------------------- */

test('the draft shows every policy — enabled ones first, in the brand’s order', () => {
  const draft = routingDraftOf({ cascade: ['nearest', 'manual'] });
  assert.deepEqual(draft.stages.map((s) => s.policy), ['nearest', 'manual', 'territory', 'round-robin']);
  assert.deepEqual(stages(draft), ['nearest', 'manual']);
});

test('an empty or junk stored config opens on the conservative default', () => {
  assert.deepEqual(stages(routingDraftOf({})), ['territory', 'nearest', 'manual']);
  assert.deepEqual(stages(routingDraftOf('nonsense')), ['territory', 'nearest', 'manual']);
  assert.deepEqual(stages(defaultRoutingDraft()), ['territory', 'nearest', 'manual']);
});

test('the draft round-trips the document the API parses', () => {
  const stored = {
    cascade: ['territory', 'round-robin'],
    maxDistanceKm: 80,
    honorPinnedDealer: false,
    postalCentroids: { '10101': { lat: 18.47, lng: -69.9 } },
  };
  const saved = validateRoutingDraft(routingDraftOf(stored)).value!;
  assert.deepEqual(saved, parseRoutingConfig(stored));
});

/* -------------------------------- the editing ------------------------------ */

test('toggling a stage adds or removes it from the cascade', () => {
  const draft = toggleStage(routingDraftOf({ cascade: ['nearest'] }), 'territory');
  assert.ok(stages(draft).includes('territory'));
  assert.deepEqual(stages(toggleStage(draft, 'nearest')), ['territory']);
});

test('moving a stage is a MOVE — order is the product, and the ends do not wrap', () => {
  const draft = routingDraftOf({ cascade: ['territory', 'nearest', 'manual'] });
  assert.deepEqual(stages(moveStage(draft, 'nearest', -1)), ['nearest', 'territory', 'manual']);
  assert.deepEqual(stages(moveStage(draft, 'nearest', 1)), ['territory', 'manual', 'nearest']);
  // At the top, up is a no-op — never a wrap to the bottom.
  assert.equal(moveStage(draft, 'territory', -1), draft);
  assert.equal(moveStage(draft, 'round-robin', 1), draft);
  assert.equal(moveStage(draft, 'nearest', 0), draft);
});

/* ------------------------------- the validation ---------------------------- */

test('an all-off cascade saves as “manual only”, never as an empty list', () => {
  let draft = routingDraftOf({ cascade: ['nearest'] });
  draft = toggleStage(draft, 'nearest');
  const result = validateRoutingDraft(draft);
  assert.equal(result.ok, true);
  // An empty cascade READS BACK as the default — saving one would quietly
  // re-enable territory+nearest behind the admin's back.
  assert.deepEqual(result.value!.cascade, ['manual']);
  assert.match(result.warnings.join(' '), /manual only/);
  assert.deepEqual(parseRoutingConfig(result.value).cascade, ['manual']);
});

test('the distance cap is a positive number, or nothing', () => {
  const draft = routingDraftOf({ cascade: ['nearest'] });
  assert.ok(validateRoutingDraft(setMaxDistance(draft, '-4')).errors.maxDistanceKm);
  assert.ok(validateRoutingDraft(setMaxDistance(draft, 'far')).errors.maxDistanceKm);
  assert.equal(validateRoutingDraft(setMaxDistance(draft, '')).value!.maxDistanceKm, null);
  assert.equal(validateRoutingDraft(setMaxDistance(draft, '120')).value!.maxDistanceKm, 120);
});

test('the editor warns about a cascade that cannot do what it says', () => {
  const capWithoutNearest = validateRoutingDraft(
    setMaxDistance(routingDraftOf({ cascade: ['territory'] }), '50'),
  );
  assert.match(capWithoutNearest.warnings.join(' '), /only applies to the “nearest” stage/);

  const afterRoundRobin = validateRoutingDraft(routingDraftOf({ cascade: ['round-robin', 'nearest'] }));
  assert.match(afterRoundRobin.warnings.join(' '), /unreachable/);

  const afterManual = validateRoutingDraft(routingDraftOf({ cascade: ['manual', 'nearest'] }));
  assert.match(afterManual.warnings.join(' '), /never run/);
});

test('postal centroids parse by line, and a junk line is NAMED', () => {
  const { centroids, bad } = parseCentroidText('10101 18.47,-69.9\nrubbish\nA1B 2C3 45,-75');
  assert.deepEqual(centroids['10101'], { lat: 18.47, lng: -69.9 });
  assert.deepEqual(bad, [2, 3]);
  const draft = { ...routingDraftOf({}), postalCentroids: 'nope' };
  assert.match(validateRoutingDraft(draft).errors.postalCentroids!, /line 1/);
});

test('honorPinnedDealer survives the round trip in both directions', () => {
  const off = validateRoutingDraft(setHonorPinned(routingDraftOf({}), false)).value!;
  assert.equal(off.honorPinnedDealer, false);
  assert.equal(routingDraftOf(off).honorPinnedDealer, false);
  assert.equal(routingDraftOf({}).honorPinnedDealer, true);
});

/* --------------------------------- preview --------------------------------- */

const dealers: AdminDealer[] = [
  {
    id: 'd-1', slug: 'sd', name: 'Santo Domingo', status: 'active', locale: 'es', currency: 'USD',
    pricing: { mode: 'full', multiplier: 1 }, contact: {}, updatedAt: 0,
  },
  {
    id: 'd-2', slug: 'pc', name: 'Punta Cana', status: 'active', locale: 'es', currency: 'USD',
    pricing: { mode: 'full', multiplier: 1 }, contact: {}, updatedAt: 0,
  },
];

const locations: AdminLocation[] = [
  {
    id: 'l-1', dealerId: 'd-1', name: 'Naco', lat: 18.47, lng: -69.93,
    territory: { kind: 'radiusKm', radiusKm: 30 }, address: {}, hours: {}, routingPriority: 0, updatedAt: 0,
  },
  {
    id: 'l-2', dealerId: 'd-2', name: 'Bávaro', lat: 18.58, lng: -68.4,
    territory: null, address: {}, hours: {}, routingPriority: 0, updatedAt: 0,
  },
];

test('the preview runs the REAL engine against the REAL network', () => {
  const rows = previewRouting(
    [
      { label: 'Capital', lead: { geo: { lat: 18.48, lng: -69.9 } } },
      { label: 'East coast', lead: { geo: { lat: 18.6, lng: -68.4 } } },
      { label: 'No position', lead: {} },
    ],
    dealers,
    locations,
    routingDraftOf({ cascade: ['territory', 'nearest', 'manual'] }),
  );
  assert.deepEqual(rows.map((r) => r.dealerName), ['Santo Domingo', 'Punta Cana', null]);
  assert.deepEqual(rows.map((r) => r.decision.reason), ['territory:routed', 'nearest:routed', 'manual:manual']);
});

test('the preview follows the DRAFT, so an admin sees the change before saving', () => {
  const east = [{ label: 'East coast', lead: { geo: { lat: 18.6, lng: -68.4 } } }];
  const draft = routingDraftOf({ cascade: ['territory', 'manual'] });
  assert.equal(previewRouting(east, dealers, locations, draft)[0]!.decision.dealerId, null,
    'no territory covers the east coast yet');

  // Switching `nearest` on lands it BELOW `manual`, which ends the cascade —
  // so the preview still says "manual", and the warning says why. This is the
  // whole reason the preview exists: the admin sees it before saving.
  const enabled = toggleStage(draft, 'nearest');
  assert.equal(previewRouting(east, dealers, locations, enabled)[0]!.decision.reason, 'manual:manual');
  assert.match(validateRoutingDraft(enabled).warnings.join(' '), /never run/);

  // Moved above it, the same stage decides.
  const ordered = moveStage(enabled, 'nearest', -1);
  assert.equal(previewRouting(east, dealers, locations, ordered)[0]!.dealerName, 'Punta Cana');
});

test('an invalid draft previews NOTHING rather than a half-parsed config', () => {
  const broken = setMaxDistance(routingDraftOf({}), '-1');
  assert.deepEqual(previewRouting([{ label: 'x', lead: {} }], dealers, locations, broken), []);
});

test('routableFrom hands the engine the network, and nothing commercial', () => {
  const network = routableFrom(dealers, locations);
  assert.deepEqual(network.dealers[0], { id: 'd-1', slug: 'sd', status: 'active' });
  assert.equal(JSON.stringify(network).includes('multiplier'), false);
  assert.equal(JSON.stringify(network).includes('pricing'), false);
});
