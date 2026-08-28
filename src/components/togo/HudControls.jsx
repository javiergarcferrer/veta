/**
 * The configurator's HUD controls — the chrome of the "game window": the
 * adaptive tool button, the phone tools menu, and the measurement that
 * decides between them.
 *
 * They live here rather than inside the page for the ordinary reason: they hold
 * no configurator state. Each one takes its words and handler and renders.
 *
 * View layer: React + DOM, no db, no derivation. Anything that computes a
 * number belongs in core/quote/views/configuratorView.
 */
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';

// Fine pointer (mouse/trackpad) → keyboard hints are worth screen space. A
// device doesn't change pointer class mid-session, so this is computed once.
const FINE_POINTER = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

// The clearance the two top clusters keep between them before the tools fold
// back to glyphs. Generous on purpose: controls that ALMOST touch read as one
// run-on cluster, and the eye then has to parse where one ends.
const TOOLBAR_MIN_GAP = 28;

/**
 * Fold the tools bar down to glyphs when it and the left-hand cluster would
 * collide. MEASURED, not a breakpoint — how much room the tools have depends on
 * the collection name, on whether undo/redo are showing, and on the locale (the
 * German labels run half again as long as the Spanish ones any breakpoint would
 * have been tuned for), so the only honest test is where the two boxes actually
 * land.
 *
 * Always measures from the UNFOLDED state: reading a folded bar can only ever
 * report that it still fits, so it could never expand again. The un-fold and the
 * re-fold happen inside one layout pass, before paint — nothing flashes.
 *
 * The observer watches the LEFT cluster only. Watching the tools too would have
 * it resize itself inside its own callback — the classic ResizeObserver loop.
 */
function useToolbarFit(leftRef, toolsRef, deps) {
  useLayoutEffect(() => {
    const left = leftRef.current;
    const tools = toolsRef.current;
    if (!left || !tools) return undefined;
    const fit = () => {
      tools.removeAttribute('data-compact');
      const l = left.getBoundingClientRect();
      const r = tools.getBoundingClientRect();
      if (!r.width) return;                       // hidden (phone) — nothing to fold
      if (r.left - l.right < TOOLBAR_MIN_GAP) tools.setAttribute('data-compact', 'on');
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(left);
    window.addEventListener('resize', fit);
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * A HUD control: glyph, its words when the bar has room for them.
 *
 * `label` is what makes it adaptive. A glyph alone is a guess the visitor has
 * to make every visit — recognition beats recall — so where the toolbar has
 * width the word rides beside the icon and nobody has to hover at all. When the
 * bar stamps `data-compact="on"` (its two clusters would otherwise collide) the
 * word folds away and the control returns to its circle.
 *
 * Without `label` (the camera cluster) it stays a plain circle — those glyphs
 * are universal and the cluster is deliberately small.
 */
function HudIcon({ title, label, onClick, danger = false, active = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      aria-pressed={active || undefined}
      className={`hud-panel hud-tool ${label ? 'hud-tool-labelled' : 'w-10 h-10 coarse:w-11 coarse:h-11'} rounded-full inline-flex items-center justify-center transition active:scale-90 hover:bg-ink-900/5 ${danger ? 'text-red-600 ring-1 ring-inset ring-red-600/40 hover:!bg-red-600 hover:text-white' : active ? 'text-brand-700 ring-1 ring-inset ring-brand-500/60' : 'text-ink-700'}`}
    >
      {children}
      {label && <span className="hud-tool-label text-xs font-medium leading-none whitespace-nowrap">{label}</span>}
    </button>
  );
}

/** The mobile tools menu — one glass button that opens a labelled dropdown, so a
 *  phone shows a single tidy affordance instead of a wrapping row of look-alike
 *  icon squares. Each item is icon + words + what it does; a divider sets the destructive
 *  "Vaciar el plano" apart. Closes on pick, outside tap, or Escape. */
function HudMenu({ items = [], label = 'Herramientas' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="hud-panel w-11 h-11 grid place-items-center transition active:scale-90 hover:bg-ink-100/60 text-ink-700"
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <div role="menu" className="hud-panel absolute top-full right-0 mt-1.5 w-[17rem] max-w-[calc(100vw-1.5rem)] p-1.5 flex flex-col togo-rise">
          {items.map((it, i) => (it.divider ? (
            <div key={`d${i}`} className="my-1 mx-2 border-t border-ink-200/60" />
          ) : (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick?.(); }}
              className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition active:scale-[0.98] ${it.danger ? 'text-red-600 hover:bg-red-50' : 'text-ink-700 hover:bg-ink-100/70'}`}
            >
              <span className="shrink-0 grid place-items-center w-5 pt-0.5">{it.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block leading-tight">{it.label}</span>
                {/* A phone has no hover, so this row is the ONLY place a touch
                    visitor can learn what the tool does — the tooltip's second
                    line moves inline here rather than being lost with it. */}
                {it.hint && <span className={`block text-micro leading-snug mt-0.5 ${it.danger ? 'text-status-critical-ink/70' : 'text-ink-500'}`}>{it.hint}</span>}
              </span>
            </button>
          )))}
        </div>
      )}
    </div>
  );
}

export { FINE_POINTER, useToolbarFit, HudIcon, HudMenu };
