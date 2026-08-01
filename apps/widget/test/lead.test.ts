/**
 * The lead form's logic. A LEAD IS NEVER LOST — so validation asks the minimum,
 * a permissive email check never rejects a real address, and the payload is
 * idempotent so a retry cannot double-file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRectRoom } from '@veta/layout';
import { buildLeadPayload, emptyLeadForm, leadDedupeKey, validateLead } from '../src/vm/lead.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const placed: PlacedPiece[] = [
  { uid: 'p1', pieceId: 'm-fireside', x: 0, y: 0, rot: 0, material: { code: 'B0021' } },
  { uid: 'p2', pieceId: 'm-ottoman', x: 69, y: 0, rot: 90 },
];

const form = (over: Partial<ReturnType<typeof emptyLeadForm>> = {}) => ({ ...emptyLeadForm(), ...over });

test('a name and ONE way to reach the person is the whole requirement', () => {
  assert.equal(validateLead(form({ name: 'Ana', phone: '809 555 1234' })).ok, true);
  assert.equal(validateLead(form({ name: 'Ana', email: 'ana@example.com' })).ok, true);
});

test('a missing name or missing contact is reported as an i18n KEY', () => {
  const missing = validateLead(form({}));
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.name, 'form.name');
  assert.equal(missing.errors.contact, 'form.contactHint');
});

test('a half-typed phone does not count as contactable', () => {
  // A truncated number is the shape that burns a real outreach attempt.
  const short = validateLead(form({ name: 'Ana', phone: '809-519' }));
  assert.equal(short.ok, false);
  assert.equal(short.errors.contact, 'form.contactHint');
  // …but the floor stays at 8 digits: the shortest real national numbers in use
  // are 8, and rejecting those would lose leads in whole countries.
  assert.equal(validateLead(form({ name: 'Ana', phone: '12 34 56 78' })).ok, true);
  // Formatting is irrelevant — digits are what count.
  assert.equal(validateLead(form({ name: 'Ana', phone: '(809) 555-1234' })).ok, true);
  assert.equal(validateLead(form({ name: 'Ana', phone: '+1 809 555 1234' })).ok, true);
});

test('an invalid-looking email is REPORTED, and real oddities are accepted', () => {
  assert.equal(validateLead(form({ name: 'Ana', email: 'nope' })).errors.email, 'form.emailInvalid');
  for (const address of ['ana+quote@example.co.uk', 'a@b.io', 'ana.perez@sub.domain.museum']) {
    assert.equal(validateLead(form({ name: 'Ana', email: address })).ok, true, address);
  }
});

test('the payload carries the design and asserts NO money', () => {
  const body = buildLeadPayload({
    form: form({ name: 'Ana', phone: '8095551234', note: 'Entrega en Santiago' }),
    placed,
    room: makeRectRoom(400, 300),
    collectionSlug: 'duna',
    build: 'ENCODED',
    source: { locale: 'es' },
  });
  assert.deepEqual(body.contact, { name: 'Ana', phone: '8095551234' });
  assert.equal(body.note, 'Entrega en Santiago');
  assert.equal(body.collectionSlug, 'duna');
  const build = body.build as { encoded: string; pieces: unknown[]; room: unknown };
  assert.equal(build.encoded, 'ENCODED');
  assert.equal(build.pieces.length, 2);
  assert.ok(build.room);
  const serialized = JSON.stringify(body);
  assert.equal(/"estimate"|"total"|"priceUsd"/.test(serialized), false, 'the client must never assert a price');
  assert.equal(/"verdict"|"ok":true/.test(serialized), false, 'the client must never assert a verdict');
});

test('empty optional fields are OMITTED, not sent as empty strings', () => {
  const body = buildLeadPayload({
    form: form({ name: 'Ana', email: 'ana@example.com' }),
    placed, collectionSlug: 'duna', build: '',
  });
  assert.equal('phone' in body.contact, false);
  assert.equal('note' in body, false);
  assert.equal(body.contact.email, 'ana@example.com');
});

test('a 3D snapshot rides on the source bag when one was captured', () => {
  const body = buildLeadPayload({
    form: form({ name: 'Ana', phone: '8095551234' }),
    placed, collectionSlug: 'duna', build: 'E',
    snapshot: 'data:image/png;base64,AAA',
    source: { locale: 'fr' },
  });
  assert.equal((body.source as { snapshot?: string }).snapshot, 'data:image/png;base64,AAA');
  assert.equal((body.source as { locale?: string }).locale, 'fr');
});

test('the dedupe key is stable per (contact + design) and moves when either does', () => {
  const a = form({ name: 'Ana', email: 'ana@example.com', phone: '809 555 1234' });
  const key = leadDedupeKey(a, 'BUILD1');
  assert.equal(leadDedupeKey(a, 'BUILD1'), key, 'a retry must reuse the key');
  // Formatting of the same contact must not mint a second lead.
  assert.equal(leadDedupeKey(form({ ...a, email: 'ANA@example.com', phone: '(809) 555-1234' }), 'BUILD1'), key);
  assert.notEqual(leadDedupeKey(a, 'BUILD2'), key, 'a new design is a new lead');
  assert.notEqual(leadDedupeKey(form({ ...a, email: 'otro@example.com' }), 'BUILD1'), key);
});
