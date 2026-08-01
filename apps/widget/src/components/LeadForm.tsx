/**
 * THE LEAD FORM — the one screen the whole widget exists for.
 *
 * A LEAD IS NEVER LOST: a failed submit keeps every typed character on screen
 * and offers a retry (the payload is idempotent through its dedupe key, so
 * retrying cannot double-file it), and a rule violation never silently blocks
 * the send — the CTA that got here was already disabled, visibly, with a reason.
 *
 * Validation is `vm/lead`'s, returned as i18n KEYS: this component only decides
 * where to put the sentence.
 */

import { useState } from 'react';
import { t, type Locale } from '@veta/i18n';
import { emptyLeadForm, validateLead, type LeadForm as LeadFormValues } from '../vm/lead.ts';

export interface LeadFormProps {
  locale: Locale;
  brandName: string;
  submitting: boolean;
  error: string;
  onSubmit: (form: LeadFormValues) => void;
  onBack: () => void;
}

export default function LeadForm({ locale, brandName, submitting, error, onSubmit, onBack }: LeadFormProps) {
  const [form, setForm] = useState<LeadFormValues>(emptyLeadForm);
  const [touched, setTouched] = useState(false);
  const validation = validateLead(form);
  const show = (field: 'name' | 'contact' | 'email'): string => (
    touched && validation.errors[field] ? t(locale, validation.errors[field]!) : ''
  );

  const set = (key: keyof LeadFormValues) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <form
      className="lead"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (validation.ok) onSubmit(form);
      }}
    >
      <button type="button" className="btn btn--quiet" onClick={onBack}>{t(locale, 'form.back')}</button>
      <h2 className="lead__title">{t(locale, 'form.title')}</h2>
      <p className="lead__subtitle">{t(locale, 'form.subtitle', { store: brandName })}</p>

      <label className="field">
        <span className="field__label">{t(locale, 'form.name')}</span>
        <input
          className="input"
          value={form.name}
          placeholder={t(locale, 'form.namePlaceholder')}
          autoComplete="name"
          onChange={set('name')}
        />
        {show('name') ? <span className="field__error">{show('name')}</span> : null}
      </label>

      <label className="field">
        <span className="field__label">{t(locale, 'form.phone')}</span>
        <input
          className="input"
          value={form.phone}
          placeholder={t(locale, 'form.phonePlaceholder')}
          inputMode="tel"
          autoComplete="tel"
          onChange={set('phone')}
        />
      </label>

      <label className="field">
        <span className="field__label">{t(locale, 'form.email')}</span>
        <input
          className="input"
          value={form.email}
          placeholder={t(locale, 'form.emailPlaceholder')}
          inputMode="email"
          autoComplete="email"
          onChange={set('email')}
        />
        {show('email') ? <span className="field__error">{show('email')}</span> : null}
      </label>

      <label className="field">
        <span className="field__label">{t(locale, 'form.note')}</span>
        <textarea
          className="input"
          value={form.note}
          placeholder={t(locale, 'form.notePlaceholder')}
          rows={3}
          onChange={set('note')}
        />
      </label>

      <p className="lead__hint">{t(locale, 'form.contactHint')}</p>
      {show('contact') ? <p className="field__error">{show('contact')}</p> : null}
      {error ? <p className="field__error" role="alert">{error}</p> : null}

      <button type="submit" className="btn btn--primary" disabled={submitting}>
        {t(locale, submitting ? 'inbox.loading' : 'form.submit')}
      </button>
    </form>
  );
}
