import { db, newId, assignPartyNumber } from '../db/database.js';
import { findPhoneOwner } from './phone.js';

/**
 * Party helpers — the two directories (clients + professionals) treated as ONE
 * dichotomous list. This module owns the two operations that cross the wall
 * between them:
 *
 *   • convertParty  — move a contact from one list to the other, carrying its
 *                     data AND its shared number (a client that turns out to be
 *                     a decorator, without retyping anything).
 *   • linkOrCreateCustomer — resolve a loose web-lead contact (name/phone/email)
 *                     to a real client row: link the existing one or create a
 *                     new one, so a "Solicitud web" becomes a client on file
 *                     instead of three lines of freeform notes.
 *
 * The numbering rule (a number is never reused across the two lists) lives in
 * assignPartyNumber (db layer); this module just uses it.
 */

// Fields every party carries — copied verbatim when a contact moves between the
// two directories. Kind-specific fields (customer address block / statement
// token; professional trade number) are handled separately in mapConvertedParty.
const SHARED_PARTY_FIELDS = [
  'name', 'rnc', 'rncStatus', 'company', 'email', 'phone', 'notes', 'address',
  'city', 'instagramId', 'instagramUsername',
  'leadSource', 'lifecycleStage', 'ownerUserId', 'lastContactedAt',
];

/**
 * Pure projection of a source record into the target kind's field shape.
 * `to` is 'professional' | 'customer'. Shared fields copy across; the target's
 * own fields are seeded (empty when the source has no counterpart). id, number
 * and timestamps are the caller's job — this is only the carried-over data, so
 * it can be unit-tested without a db.
 */
export function mapConvertedParty(record = {}, to) {
  const out = {};
  for (const f of SHARED_PARTY_FIELDS) {
    if (record[f] !== undefined && record[f] !== null) out[f] = record[f];
  }
  out.name = String(record.name || '').trim();
  out.tags = Array.isArray(record.tags) ? record.tags : [];
  if (to === 'professional') {
    out.tradeNumber = record.tradeNumber || '';
  } else {
    out.contactName = record.contactName || '';
    out.state = record.state || '';
    out.zip = record.zip || '';
    out.country = record.country || '';
  }
  return out;
}

/**
 * Move a contact between the two lists. `from` is 'customer' | 'professional';
 * the contact is re-created on the other side with the same data and — the
 * whole point of the shared sequence — the SAME number, then the original is
 * removed. Deleting AFTER the new row lands means a mid-way failure leaves a
 * recoverable duplicate, never a vanished contact. Returns the new id + number.
 *
 * The shared numbering already guarantees the contact's number is free on the
 * other side; the 23505 fallback is belt-and-suspenders (allocate a fresh one).
 */
export async function convertParty({ record, from, profileId }) {
  if (!record?.id) throw new Error('convertParty: record with an id is required');
  const to = from === 'customer' ? 'professional' : 'customer';
  const toTable = to === 'professional' ? 'professionals' : 'customers';
  const fromTable = from === 'customer' ? 'customers' : 'professionals';
  const now = Date.now();
  const base = {
    id: newId(),
    profileId,
    ...mapConvertedParty(record, to),
    createdAt: record.createdAt || now,
    updatedAt: now,
  };

  let created;
  const number = record.number ?? null;
  if (number != null) {
    try {
      created = { ...base, number };
      await db[toTable].put(created);
    } catch (err) {
      if (err?.code !== '23505') throw err;
      created = await assignPartyNumber({ table: toTable, profileId, build: (n) => ({ ...base, number: n }) });
    }
  } else {
    created = await assignPartyNumber({ table: toTable, profileId, build: (n) => ({ ...base, number: n }) });
  }

  await db[fromTable].delete(record.id);
  return { id: created.id, to, number: created.number };
}

/**
 * Resolve a web-lead contact to a CLIENT id: link the existing client (matched
 * by phone first — one-number-one-contact — then email), else create a new one
 * carrying the contact's fields, numbered in the shared sequence. Returns the
 * client id, or null when the contact is empty.
 *
 * If the phone already belongs to a PROFESSIONAL, we can't put it on a client
 * (the number identifies one contact), so the client is created without the
 * phone and the number is noted — the lead still lands, nothing is lost.
 */
export async function linkOrCreateCustomer({ contact = {}, profileId }) {
  const name = String(contact.name || '').trim();
  const phone = String(contact.phone || '').trim();
  const email = String(contact.email || '').trim();
  if (!name && !phone && !email) return null;

  const [customers, professionals] = await Promise.all([
    db.customers.where('profileId').equals(profileId).toArray(),
    phone ? db.professionals.where('profileId').equals(profileId).toArray() : Promise.resolve([]),
  ]);

  let phoneTakenByPro = false;
  if (phone) {
    const owner = findPhoneOwner(phone, { customers, professionals });
    if (owner?.kind === 'customer') return owner.row.id;
    if (owner?.kind === 'professional') phoneTakenByPro = true;
  }

  if (email) {
    const key = email.toLowerCase();
    const existing = customers.find((c) => String(c.email || '').trim().toLowerCase() === key);
    if (existing) return existing.id;
  }

  const now = Date.now();
  const created = await assignPartyNumber({
    table: 'customers',
    profileId,
    build: (number) => ({
      id: newId(), profileId, number,
      name: name || email || phone || 'Cliente web',
      rnc: '', rncStatus: '', company: '',
      email, phone: phoneTakenByPro ? '' : phone,
      notes: phoneTakenByPro && phone
        ? `Tel. de la solicitud web (ya registrado en otro contacto): ${phone}`
        : '',
      contactName: '', address: '', city: '', state: '', zip: '', country: '',
      leadSource: 'web', lifecycleStage: 'lead', tags: [],
      createdAt: now, updatedAt: now,
    }),
  });
  return created.id;
}
