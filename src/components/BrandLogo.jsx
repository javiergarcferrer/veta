/**
 * A brand's own mark, wherever its identity is shown.
 *
 * The logo is the brand's, not the product's, so it comes from the row
 * (`branding.logoUrl`) — never bundled, never guessed from a slug. A brand
 * without one is not a broken brand: it falls back to its initials on a tinted
 * chip, which reads as deliberate rather than as a missing image, and a URL
 * that fails to load degrades to the same thing instead of leaving the browser's
 * torn-image glyph in the chrome.
 *
 * `tone="chrome"` is for the always-dark nav: most manufacturer wordmarks are
 * black on transparent (Ligne Roset's is), which is invisible there, so on that
 * surface the mark is knocked out to white. On paper-white surfaces it renders
 * as supplied.
 */
import { useState } from 'react';

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '—';
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function BrandLogo({ brand, size = 20, tone = 'surface', className = '' }) {
  const [broken, setBroken] = useState(false);
  const url = brand?.branding?.logoUrl || null;
  const name = brand?.name || '';
  const color = brand?.branding?.primaryColor || null;

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={name}
        title={name}
        onError={() => setBroken(true)}
        style={{ height: size }}
        className={`w-auto max-w-full object-contain shrink-0 ${tone === 'chrome' ? 'invert brightness-0 contrast-200' : ''} ${className}`}
      />
    );
  }

  return (
    <span
      title={name}
      aria-label={name}
      style={{ height: size, minWidth: size, background: color || undefined }}
      className={`shrink-0 inline-flex items-center justify-center rounded px-1.5 text-[10px] font-semibold tracking-wide ${
        color ? 'text-white' : 'bg-ink-700 text-ink-100'
      } ${className}`}
    >
      {initialsOf(name)}
    </span>
  );
}
