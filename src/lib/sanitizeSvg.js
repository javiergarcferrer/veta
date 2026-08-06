// SVG sanitizer — strips the executable surface from an UNTRUSTED SVG string
// before it's injected into the DOM via dangerouslySetInnerHTML. Catalog model
// outlines (togo_models.svg, per-piece plan markup) are dealer-authored and
// stored in the DB, so a hostile/broken paste must never run script in our page.
//
// Modeled on lib/gmail.js `sanitizeSignatureHtml`, but for SVG and DELIBERATELY
// DOM-FREE: a pure string transform behaves identically in the browser, in the
// node tests, and in any SSR-ish path — and it avoids a DOMParser round-trip,
// which can silently mangle SVG namespaces/elements. It removes exactly the
// executable content — <script> blocks, on* event-handler attributes, and
// javascript:/vbscript:/data:text/html URLs in href/xlink:href/src — and leaves
// ordinary <path>/<g>/<rect>/<polygon>/style markup untouched. Safe to apply
// twice (stripping already-clean geometry is a no-op).

/** Decode numeric character entities so scheme obfuscation can't hide the colon
 *  (`java&#9;script:`) or the letters (`&#106;avascript:`). Out-of-range folds away. */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
    .replace(/&#(\d+);?/g, (_, d) => { const n = parseInt(d, 10); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; });
}

/** True when a link value carries an executable scheme (entities decoded and all
 *  whitespace folded away first, so `java\tscript:` is caught too). */
function isDangerousUrl(value) {
  const v = decodeEntities(value || '').replace(/\s+/g, '').toLowerCase();
  return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html');
}

/**
 * Neutralize active content in an untrusted SVG markup string. Pure string
 * transform (no document/DOMParser needed).
 *
 * @param {string} markup raw SVG (or SVG fragment) string
 * @returns {string} the same markup with script/event-handlers/js-URLs stripped
 */
export function sanitizeSvg(markup) {
  let s = String(markup || '');
  if (!s) return '';

  // 1. <script> — paired, then self-closing, then any stray opening tag.
  s = s
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '');

  // 2. on* event-handler attributes (onload/onerror/onbegin/onclick/…), any quoting.
  s = s.replace(/\son[a-z][a-z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Dangerous URL schemes in href / xlink:href / src → drop the whole attribute.
  s = s.replace(
    /\s(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, dq, sq, uq) => (isDangerousUrl(dq ?? sq ?? uq) ? '' : match),
  );

  return s;
}
