/**
 * Segmented "saved views" row — the primary status dimension (Shopify's
 * All / Active / Draft / … tab strip). Presentational only: the parent owns
 * `activeTab` and decides what each key filters.
 *
 * Mobile-first: the strip is horizontally scrollable (a phone can't fit
 * Todas / Borrador / Enviada / Aceptada / Rechazada side by side at 360px),
 * with momentum scroll contained so a swipe on the tabs doesn't drag the
 * whole page. The active tab reads as a filled pill so it's unmistakable at
 * arm's length; inactive tabs are quiet text that darken on hover.
 *
 * Each tab can carry an optional `count` rendered as a trailing number —
 * the at-a-glance "12 enviadas" affordance. Counts are computed by the
 * parent (it has the data); we just render whatever we're handed.
 *
 * A tab counted at ZERO is not a filter, it is a trapdoor: tapping it costs a
 * tap, a repaint and a second tap to get back, and it can only ever land on an
 * empty list. It keeps its PLACE — the strip is the list's vocabulary, and a
 * strip that reshuffles as the data moves destroys the muscle memory it exists
 * to build — and stops being a control: not focusable, no hover, and its count
 * chip drops the status colour, so "there are none of these" is legible from
 * the strip without reading a digit. The ACTIVE tab is never deadened; you can
 * archive the last borrador while standing on Borrador, and a disabled tab
 * under your feet is a room with no door.
 *
 * Implemented as a radio-group (role="tablist" would imply tab panels we
 * don't have) — `aria-pressed` on each toggle reads correctly to AT, and
 * ArrowLeft / ArrowRight move between tabs like a native segmented control.
 */
export default function FilterTabs({ tabs, activeTab, onTabChange }) {
  if (!tabs || tabs.length === 0) return null;

  // The zero-count rule (see the header) has one guard: if NOTHING has a count
  // — the rows are still loading, or the list is genuinely empty — deadening is
  // off. A strip of seven disabled tabs is not a signal, it is a control that
  // looks broken, and it would flash on every page that renders its header
  // before its data lands.
  const anyCount = tabs.some((t) => t.count > 0);
  const isDead = (t) => anyCount && t.count === 0 && t.key !== activeTab;

  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.key === activeTab);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    // Step OVER the empty tabs — the arrow keys are the pointer's equal here,
    // and landing the caret on a view with nothing in it is the same trapdoor
    // the disabled state closes for the mouse.
    let next = idx + dir;
    while (next >= 0 && next < tabs.length && isDead(tabs[next])) next += dir;
    // Clamp at the ends rather than wrap — wrapping a 5-item strip is
    // disorienting on a control this small.
    if (next < 0 || next >= tabs.length) return;
    onTabChange(tabs[next].key);
  }

  return (
    <div
      role="group"
      aria-label="Filtrar por estado"
      onKeyDown={onKeyDown}
      className="-mx-1 flex items-center gap-0.5 overflow-x-auto overscroll-x-contain px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => {
        const active = t.key === activeTab;
        const dead = isDead(t);
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onTabChange(t.key)}
            disabled={dead}
            title={dead ? `Ninguna en «${t.label}»` : undefined}
            aria-pressed={active}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 min-h-9 coarse:min-h-10 text-sm font-medium whitespace-nowrap transition-all ${
              active
                ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 shadow-xs active:scale-[0.98]'
                : dead
                  // Text stays at the ink-500 floor (§1) — a count of zero is
                  // information, not decoration, and greying the word below the
                  // floor to say "inert" would make it the least legible thing
                  // in the strip. What goes is the AFFORDANCE: no hover, no
                  // press, and the chip loses its colour below.
                  ? 'text-ink-500 cursor-default'
                  : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 active:scale-[0.98]'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span
                className={`tabular-nums rounded-full px-1.5 py-px text-micro font-semibold ${
                  active
                    ? 'bg-brand-100 text-brand-700'
                    : t.pillCls && !dead
                      ? t.pillCls
                      : 'bg-ink-100 text-ink-500'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
