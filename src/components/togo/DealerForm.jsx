import { Check, Boxes, Store, Coins, Inbox, AlertTriangle, Info } from 'lucide-react';
import { DEALER_LOCALES, DEALER_PRICING_MODES, dealerSlugify } from '../../core/quote/index.js';
import { dealerInboxUrl } from '../../lib/togoEmbed.js';

/**
 * The dealer form — the four decisions that configure one storefront's copy of
 * the SHARED Togo configurator, each stated as what it does to THEIR widget.
 *
 * Used by both the alta (guided create) and the edición of a saved dealer, so a
 * dealer can never be created through one set of choices and edited through
 * another. It derives NOTHING: `draft` is `resolveDealerDraft(...)`
 * (core/quote/views/dealerWorkspace) and this only renders it.
 *
 *   • Identidad  — the slug is the `?dealer=` key, so it is the one field with a
 *                  uniqueness rule the wizard blocks on.
 *   • Catálogo   — WHICH collections they carry, read off the real togo_models
 *                  set with live piece counts. «Todas» stores NO list, so a
 *                  collection added next month reaches them automatically.
 *   • Precios    — the two knobs everybody conflates (FX vs markup), made
 *                  legible by running one REAL catalog piece through the chain.
 *   • Entrega    — where their leads land, and the fact that Alcover does not
 *                  auto-quote them.
 */

const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

// The slug rule is the Model's (`dealerSlugify`); aliased so the field can
// rewrite what you type without a second definition drifting from it.
const slugOf = dealerSlugify;

/** A titled step block — the wizard's rhythm, shared by create and edit. */
function Section({ icon: Icon, step, title, blurb, children, issues }) {
  return (
    <section className="rounded-xl border border-ink-200/80 bg-surface overflow-hidden">
      <header className="flex items-start gap-2.5 px-4 py-3 border-b border-ink-100">
        <span className="icon-tile tint-brand w-8 h-8 shrink-0"><Icon size={15} /></span>
        <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold leading-tight">
            <span className="text-ink-500 tabular-nums mr-1.5">{step}</span>{title}
          </h3>
          <p className="text-micro text-ink-500 leading-snug mt-0.5">{blurb}</p>
        </div>
      </header>
      <div className="p-4 space-y-3">
        {issues?.length > 0 && (
          <ul className="space-y-1">
            {issues.map((i) => (
              <li key={i.key} className="flex items-start gap-1.5 text-micro text-amber-700 dark:text-amber-300">
                <AlertTriangle size={12} className="mt-px shrink-0" /> {i.text}
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </section>
  );
}

/** A labelled control with the one line that says what it does to the widget. */
function Field({ label, hint, children, className = '' }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-micro text-ink-500 leading-snug mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The CATÁLOGO picker — the headline new option. Two states, because they mean
 * genuinely different things: «todas» is the ABSENCE of a filter (it keeps
 * following the catalog), a picked list is a frozen set the admin owns.
 */
function CollectionPicker({ catalog, value, onChange }) {
  const all = catalog.all;
  const selected = new Set(catalog.selectedLabels);

  const toggle = (label) => {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label); else next.add(label);
    onChange([...next]);
  };

  // No readable catalog (ninguno publicado todavía, o aún cargando): no hay nada
  // que elegir y no se toca lo guardado.
  if (!catalog.catalogKnown) {
    return (
      <p className="text-micro text-ink-500 leading-relaxed">
        Todavía no hay modelos publicados en el catálogo, así que no hay colecciones que elegir.
        {catalog.all
          ? ' Este distribuidor servirá lo que se publique en Modelos.'
          : ` Se conserva su selección guardada: ${catalog.selectedLabels.join(', ') || '—'}.`}
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={all}
          className={`chip-action ${all ? 'border-ink-900 bg-ink-900 text-ink-50 hover:bg-ink-800 hover:text-ink-50' : ''}`}
        >
          {all && <Check size={12} />} Todas las colecciones
        </button>
        <button
          type="button"
          onClick={() => onChange(all ? [] : value)}
          aria-pressed={!all}
          className={`chip-action ${!all ? 'border-ink-900 bg-ink-900 text-ink-50 hover:bg-ink-800 hover:text-ink-50' : ''}`}
        >
          {!all && <Check size={12} />} Solo algunas
        </button>
      </div>

      {!all && (
        <div className="rounded-lg border border-ink-200 divide-y divide-ink-100 max-h-64 overflow-y-auto">
          {catalog.options.map((o) => (
            <label
              key={o.key}
              className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-ink-50 transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(o.label)}
                onChange={() => toggle(o.label)}
                className="shrink-0"
              />
              <span className="text-sm text-ink-800 truncate flex-1 min-w-0">{o.label}</span>
              <span className="text-micro text-ink-500 tabular-nums shrink-0">
                {o.missing ? (
                  <span className="text-amber-600 dark:text-amber-400">ya no está en el catálogo</span>
                ) : (
                  <>
                    {o.count} {o.count === 1 ? 'pieza' : 'piezas'}
                    {o.priced < o.count && <span className="text-amber-600 dark:text-amber-400"> · {o.count - o.priced} sin precio</span>}
                  </>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      {catalog.unknown.length > 0 && (
        <p className="text-micro text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>
            {catalog.unknown.map((u) => u.label).join(', ')}: ya no está en el catálogo. Sigue guardado y sin servir
            ninguna pieza hasta que lo destildes arriba.
          </span>
        </p>
      )}

      <p className="text-micro text-ink-500 tabular-nums">
        Su configurador servirá <strong className="text-ink-800 font-semibold">{catalog.servedPieces}</strong>
        {' '}de {catalog.catalogPieces} {catalog.catalogPieces === 1 ? 'pieza' : 'piezas'}
        {all && ' — y cualquier pieza nueva que se publique.'}
      </p>
    </div>
  );
}

/**
 * The PRECIOS preview: one real piece off the catalog walked through the whole
 * chain. Never a sample number — with no priced piece in the served catalog it
 * says exactly that.
 */
export function DealerPricePreview({ pricing }) {
  if (!pricing.ok) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 px-3 py-2.5">
        <p className="text-micro text-ink-500 leading-relaxed flex items-start gap-1.5">
          <Info size={12} className="mt-px shrink-0" /> {pricing.note}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/40 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-ink-100">
        <p className="text-micro uppercase tracking-[0.08em] text-ink-500 font-semibold">
          Ejemplo real · {pricing.sample.label}
        </p>
        <p className="mt-1 flex flex-wrap items-baseline gap-2 font-display">
          <span className="text-sm text-ink-500 tabular-nums">{pricing.headline.from}</span>
          <span className="text-ink-400" aria-hidden>→</span>
          <span className={`text-lg font-semibold tabular-nums ${pricing.headline.muted ? 'text-ink-500' : 'text-ink-900'}`}>
            {pricing.headline.to}
          </span>
        </p>
        <p className="text-micro text-ink-500 mt-0.5">Lo que ve el visitante de este distribuidor.</p>
      </div>
      <dl className="divide-y divide-ink-100">
        {pricing.steps.map((s) => (
          <div key={s.key} className="px-3 py-1.5 flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className="text-micro text-ink-600">{s.label}</span>
              <span className="block text-micro text-ink-500 truncate">{s.hint}</span>
            </dt>
            <dd className="text-micro tabular-nums text-ink-800 shrink-0">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function DealerForm({ form, setForm, draft, dealer = null }) {
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const stepIssues = (key) => draft.steps.find((s) => s.key === key)?.issues || [];

  // Typing the name auto-fills the slug while it still tracks the name (so an
  // edited slug is never clobbered).
  const setName = (v) => setForm((f) => {
    const tracks = !f.slug || f.slug === slugOf(f.name);
    return { ...f, name: v, slug: tracks ? slugOf(v) : f.slug };
  });

  return (
    <div className="space-y-3">
      <Section
        icon={Store} step="1." title="Identidad"
        blurb="Cómo se llama, con qué clave se enlaza su widget y en qué idioma le habla a sus visitantes."
        issues={stepIssues('identidad')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field className="sm:col-span-2" label="Nombre" hint="Aparece en su bandeja de solicitudes y en el título de la pestaña.">
            <input className="input" value={form.name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Muebles Paris Rive Gauche" />
          </Field>
          <Field label="Slug (clave del enlace)" hint="Es el «?dealer=» de su enlace y de su embed. Cambiarlo rompe los enlaces ya compartidos.">
            <input className="input font-mono" value={form.slug} onChange={(e) => setField('slug', slugOf(e.target.value))} placeholder="paris-rive-gauche" />
          </Field>
          <Field label="Correo de contacto" hint="Interno: a quién le escribes tú. El visitante nunca lo ve.">
            <input className="input" type="email" value={form.contactEmail} onChange={(e) => setField('contactEmail', e.target.value)} placeholder="ventas@distribuidor.com" />
          </Field>
          <Field label="Idioma del configurador" hint="Traduce el widget y su bandeja de solicitudes completos.">
            <select className="input" value={form.locale} onChange={(e) => setField('locale', e.target.value)}>
              {DEALER_LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Logo (URL)" hint="Se muestra sobre el configurador. Vacío ⇒ solo la marca del fabricante.">
            <input className="input" value={form.logoUrl} onChange={(e) => setField('logoUrl', e.target.value)} placeholder="https://…/logo.png" />
          </Field>
        </div>
      </Section>

      <Section
        icon={Boxes} step="2." title="Catálogo"
        blurb="Qué colecciones vende este distribuidor. Es lo único que decide qué piezas puede colocar su visitante."
        issues={stepIssues('catalogo')}
      >
        <CollectionPicker
          catalog={draft.catalog}
          value={form.collections}
          onChange={(v) => setField('collections', v)}
        />
      </Section>

      <Section
        icon={Coins} step="3." title="Precios"
        blurb="Dos perillas distintas: la TASA convierte de dólares a su moneda; el MARGEN es su markup. Se aplican una tras otra."
        issues={stepIssues('precios')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Moneda (ISO 4217)" hint="Solo etiqueta el precio; no convierte nada por su cuenta.">
            <input className="input uppercase" maxLength={3} value={form.currency} onChange={(e) => setField('currency', e.target.value.toUpperCase())} placeholder="EUR" />
          </Field>
          <Field label="Tasa (USD → moneda)" hint="Cuántas unidades de su moneda vale 1 USD. Deja 1 si cobra en dólares.">
            <input className="input tabular-nums" type="number" min="0" step="0.0001" value={form.usdRate} onChange={(e) => setField('usdRate', e.target.value)} placeholder="1" />
          </Field>
          <Field label="Margen del distribuidor (×)" hint="Su markup sobre el retail de Alcover. 1 = mismo precio; 1.35 = 35% encima.">
            <input className="input tabular-nums" type="number" min="0" step="0.01" value={form.priceMultiplier} onChange={(e) => setField('priceMultiplier', e.target.value)} placeholder="1" />
          </Field>
        </div>

        <Field label="Presentación de precios" hint={draft.pricing.pricingHint}>
          <select className="input" value={form.pricingMode} onChange={(e) => setField('pricingMode', e.target.value)}>
            {DEALER_PRICING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>

        <DealerPricePreview pricing={draft.pricing} />
        <p className="text-micro text-ink-500 leading-relaxed">
          El margen de Alcover ({money(draft.pricing.marginPct)}%) sale de Configuración y es el mismo para todos los distribuidores.
        </p>
      </Section>

      <Section
        icon={Inbox} step="4." title="Entrega de solicitudes"
        blurb="Dónde caen sus leads y quién los trabaja."
      >
        <ul className="space-y-1.5 text-xs text-ink-600 leading-relaxed">
          <li className="flex items-start gap-1.5">
            <Check size={13} className="mt-0.5 shrink-0 text-status-good-ink" />
            Cada solicitud de su widget entra en una bandeja privada, con un enlace propio y sin cuenta ni contraseña.
          </li>
          <li className="flex items-start gap-1.5">
            <Check size={13} className="mt-0.5 shrink-0 text-status-good-ink" />
            Alcover <strong className="font-semibold text-ink-800">no cotiza automáticamente</strong> los leads de un distribuidor: se quedan en su bandeja y los trabaja él.
          </li>
          <li className="flex items-start gap-1.5">
            <Check size={13} className="mt-0.5 shrink-0 text-status-good-ink" />
            Tú los ves igual en Solicitudes, filtrados por distribuidor.
          </li>
        </ul>
        {dealer?.inboxToken ? (
          <p className="text-micro text-ink-500 break-all font-mono">{dealerInboxUrl(dealer.inboxToken)}</p>
        ) : (
          <p className="text-micro text-ink-500">El enlace de la bandeja se genera al guardar; lo copias del kit de instalación.</p>
        )}
        <Field label="Notas internas" hint="Solo para ti — nunca sale al widget ni a la bandeja del distribuidor.">
          <textarea className="input min-h-[60px]" value={form.notes} onChange={(e) => setField('notes', e.target.value)} placeholder="Contacto, acuerdo comercial, condiciones…" />
        </Field>
        <label className="inline-flex items-center gap-2 text-sm text-ink-700 cursor-pointer select-none">
          <input type="checkbox" checked={form.active} onChange={(e) => setField('active', e.target.checked)} />
          Activo
          <span className="text-micro text-ink-500">— inactivo apaga su enlace y su embed al instante.</span>
        </label>
      </Section>
    </div>
  );
}
