/**
 * THE LEAD FORM — validation and payload, as pure functions.
 *
 * The law this whole widget exists to serve: A LEAD IS NEVER LOST. That shapes
 * every decision here —
 *
 *   • validation asks for a NAME and ONE way to reach the person (phone OR
 *     email). Anything more is a field to abandon the form on;
 *   • an invalid-looking email is REPORTED, never silently dropped, because the
 *     visitor may have typed a real address our regex doesn't love;
 *   • a rule violation does NOT block the payload — the API stores a flagged
 *     lead deliberately. The submit button is disabled by `error` severity in
 *     the rules VM, and that is a UI decision the visitor can see, not a silent
 *     refusal at the wire.
 *
 * Errors are returned as i18n KEYS, not sentences: the View translates, which
 * keeps this module pure and the copy in one place.
 */

import type { PlacedPiece } from './editor.ts';
import type { LeadBody } from './client.ts';
import type { Room } from '@veta/layout';

export interface LeadForm {
  name: string;
  phone: string;
  email: string;
  note: string;
}

export interface LeadValidation {
  ok: boolean;
  /** field → i18n key. Empty when the form is submittable. */
  errors: Partial<Record<'name' | 'contact' | 'email', string>>;
}

export const emptyLeadForm = (): LeadForm => ({ name: '', phone: '', email: '' , note: '' });

// Deliberately permissive: `x@y.z`. A stricter regex rejects real addresses
// (new TLDs, plus-addressing, unicode locals) and a rejected real address is a
// lost lead — the server and the human on the other end do the real check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits only, so "(809) 555-1234" and "+1 809 555 1234" both count as typed. */
const digits = (s: string): string => String(s ?? '').replace(/\D+/g, '');

export function validateLead(form: LeadForm): LeadValidation {
  const errors: LeadValidation['errors'] = {};
  const name = String(form.name ?? '').trim();
  const phone = String(form.phone ?? '').trim();
  const email = String(form.email ?? '').trim();

  if (!name) errors.name = 'form.name';
  // A DIGIT FLOOR, because a half-typed number reads as contactable and burns a
  // real outreach attempt. The floor is 8: the platform is multi-country, and
  // the shortest real national numbers in use (Denmark, Norway, Chile) are 8
  // digits — demanding the 10 a Dominican number has would reject them.
  const hasPhone = digits(phone).length >= 8;
  const hasEmail = email.length > 0;
  if (!hasPhone && !hasEmail) errors.contact = 'form.contactHint';
  if (hasEmail && !EMAIL_RE.test(email)) errors.email = 'form.emailInvalid';

  return { ok: Object.keys(errors).length === 0, errors };
}

export interface LeadPayloadInput {
  form: LeadForm;
  placed: readonly PlacedPiece[];
  room?: Room | null;
  collectionSlug: string;
  /** The share string of the exact design being sent. */
  build: string;
  /** A 3D snapshot as a PNG data URL — what the brand sees in their inbox. */
  snapshot?: string | null;
  /** Where this lead came from (embed host, locale, campaign…). */
  source?: Record<string, unknown>;
  /** Stable per (design + contact) so a double-tap or a retry is ONE lead. */
  dedupeKey?: string;
}

/**
 * The POST body for `/v1/leads`.
 *
 * `build` carries the placed pieces AND their picks, because the API re-derives
 * BOTH the verdict and the estimate from it server-side — the client asserts
 * neither. A payload that claimed a price would contribute nothing but noise.
 */
export function buildLeadPayload(input: LeadPayloadInput): LeadBody {
  const form = input.form;
  const contact: LeadBody['contact'] = { name: String(form.name ?? '').trim() };
  const phone = String(form.phone ?? '').trim();
  const email = String(form.email ?? '').trim();
  if (phone) contact.phone = phone;
  if (email) contact.email = email;

  const body: LeadBody = {
    contact,
    collectionSlug: input.collectionSlug,
    build: {
      encoded: input.build,
      room: input.room ?? null,
      pieces: input.placed.map((p) => ({
        uid: p.uid,
        modelId: p.pieceId,
        x: p.x,
        y: p.y,
        rot: p.rot,
        material: p.material ?? null,
        partMaterials: p.partMaterials ?? null,
      })),
    },
    source: { ...(input.source ?? {}), ...(input.snapshot ? { snapshot: input.snapshot } : {}) },
  };
  const note = String(form.note ?? '').trim();
  if (note) body.note = note;
  if (input.dedupeKey) body.dedupeKey = input.dedupeKey;
  return body;
}

/**
 * A dedupe key for THIS design and THIS visitor: the same person tapping submit
 * twice (or a retry after a timeout) must land ONE lead, while the same person
 * coming back next week with a new design must land a new one.
 *
 * A cheap 32-bit string hash is enough — the key is an idempotence token inside
 * the API's own window, never a security boundary.
 */
export function leadDedupeKey(form: LeadForm, build: string): string {
  const seed = [String(form.email ?? '').trim().toLowerCase(), digits(form.phone), build].join('|');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return `lead_${(hash >>> 0).toString(36)}_${seed.length.toString(36)}`;
}
