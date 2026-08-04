// Compact per-quote line preview — the "which quote is this?" dropdown used
// by surfaces that list several quotes side by side (the chat's Documentos
// modal): sections as headers, item lines as "qty × name · amount". Pure
// projection over the quote's lines; amounts in the quote's USD figures (the
// caller formats/converts with the quote's own rate, like its total).
import { isPricedLine } from '../../../lib/constants.js';
import { lineTotal, lineQty } from '../../../lib/pricing.js';

/**
 * resolveQuoteLinePreview(lines) → [{ id, kind:'section'|'item', label, qty,
 * optional, amountUsd }] in sortOrder. Non-selected alternatives are omitted
 * (they're not part of the deal); optional lines show flagged with their
 * price (they identify the quote even though the total excludes them).
 */
export function resolveQuoteLinePreview(lines = []) {
  const rows = [...(lines || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const out = [];
  for (const l of rows) {
    if (!l) continue;
    if (l.kind === 'section') {
      const label = (l.name || l.description || '').trim();
      if (label) out.push({ id: l.id, kind: 'section', label, qty: 0, optional: false, amountUsd: null });
      continue;
    }
    if (l.alternativeGroup && !l.isSelectedAlternative) continue;
    out.push({
      id: l.id,
      kind: 'item',
      label: (l.name || l.reference || l.description || 'Artículo').trim(),
      qty: lineQty(l),
      optional: !!l.isOptional,
      // Optional lines still carry their figure (it identifies the quote);
      // truly unpriced lines (ranges pending, no price) show without one.
      amountUsd: isPricedLine(l) || l.isOptional ? lineTotal(l) : null,
    });
  }
  return out;
}
