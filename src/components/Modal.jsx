import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// Open-modal stack: with STACKED modals (a confirm dialog over an open sheet),
// every instance's window-level key listener would otherwise fight — two Tab
// traps yanking focus between panels, one Escape closing both. Only the modal
// on TOP of this stack reacts to keys.
const openModals = [];

/**
 * Sheet-on-mobile, dialog-on-desktop. Below sm we anchor to the bottom and
 * fill the width edge-to-edge with a grab handle — feels native on iOS and
 * keeps controls in thumb reach. From sm up it reverts to the centered
 * dialog. Body scroll is locked while open so iOS doesn't rubber-band the
 * page underneath, and the close button is sized to a 44pt touch target.
 */
export default function Modal({ open, onClose, title, children, footer, size = 'md', flushBody = false }) {
  // The dialog panel (focus target + trap boundary) and the element that had
  // focus before we opened, so we can hand it back on close (WCAG SC 2.4.3).
  const panelRef = useRef(null);
  const prevFocusRef = useRef(null);
  // Latch onClose so the focus effect keys on `open` ALONE. Nearly every caller
  // passes an inline arrow, so keeping onClose in the deps would re-run the
  // focus side effects on every parent re-render — restore-then-steal focus on
  // each keystroke typed into a form inside the modal (untypeable inputs).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const token = {};
    openModals.push(token);
    // Remember what was focused before the modal took over, then move focus
    // onto the PANEL itself — not the first input. Auto-focusing an input pops
    // the iOS software keyboard the instant the sheet appears, which shoves the
    // dialog up and reads as jank; the panel is tabIndex=-1 so it can hold
    // focus without being a tab stop. A child that ASKS for focus (autoFocus —
    // React commits it before this passive effect runs) keeps it: we only grab
    // when nothing inside the panel holds focus yet.
    prevFocusRef.current = document.activeElement;
    const panel0 = panelRef.current;
    if (panel0 && !panel0.contains(document.activeElement)) panel0.focus();
    const onKey = (e) => {
      if (openModals[openModals.length - 1] !== token) return;   // only the topmost modal reacts
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      // Tab trap. Listening on `window` (like Escape) is deliberate: if focus
      // has somehow escaped the panel, we still catch the keystroke and pull it
      // back in, which a panel-scoped listener could not.
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) {
          // Nothing to tab to — keep focus pinned on the panel.
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const outside = !panel.contains(active);
        // The panel itself holding focus (the state right after open) is a
        // boundary too: Shift+Tab from it must wrap to the last control, not
        // escape behind the dialog. Forward Tab from the panel already lands
        // on the first child naturally.
        if (e.shiftKey && (active === first || active === panel || outside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || outside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      const i = openModals.indexOf(token);
      if (i !== -1) openModals.splice(i, 1);
      // Restore focus to whatever had it before, but only if that element is
      // still in the document (it may have been unmounted while we were open).
      const prev = prevFocusRef.current;
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
  // Render at <body> via a portal. A modal must NOT live inside the DOM of
  // whatever opened it: an ancestor with `opacity` (e.g. a dimmed
  // non-selected alternative line, opacity-70) tints its whole subtree —
  // including this fixed overlay — making the dialog translucent with the
  // page bleeding through; and an ancestor with `container-type` (the
  // quote-line container queries) or `transform` re-bases `position: fixed`
  // to that box instead of the viewport. Portaling to body escapes both.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4 animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Refined backdrop: warm dark + subtle blur so content behind reads as
          "there" but clearly behind — same technique as Linear and Stripe. */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
        aria-hidden
      />
      {/* Height cap in dvh, not vh: on iOS Safari `vh` resolves against the
          LARGEST viewport (URL bar collapsed), so a 92vh sheet ran taller
          than the visible screen whenever the bar was showing — the sheet's
          scroll content ended below the fold and its tail was unreachable
          (the configurator's fabric list, owner 2026-07-31). `dvh` tracks
          the bar. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative w-full ${widths[size] || widths.md} bg-surface shadow-pop border border-ink-100/60 flex flex-col rounded-t-2xl sm:rounded-2xl max-h-[92dvh] sm:max-h-[88dvh] pb-[env(safe-area-inset-bottom)] sm:pb-0 outline-none animate-in slide-in-from-bottom-2 sm:slide-in-from-bottom-0 sm:zoom-in-95 duration-200`}
      >
        {/* iOS-style grab handle (decorative — pointer doesn't drag, but the
            visual cue makes the sheet read as dismissible). */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center" aria-hidden>
          <div className="w-10 h-[3px] rounded-full bg-ink-200" />
        </div>
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-ink-100">
          <h2 className="font-display text-lg font-semibold text-ink-900 break-words leading-snug pr-3 min-w-0">{title}</h2>
          <button
            onClick={onClose}
            className="btn-icon -mr-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 transition-colors"
            aria-label="Cerrar"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        {/* Default body OWNS the scroll (padded). `flushBody` instead hands a
            bare, non-scrolling flex column to the child so IT can pin a header
            (e.g. a search field) and scroll only its results — one scroll
            region, never two. Without this a search-driven picker nests a
            second scroller inside this one, and iOS scrolls the focused input
            (plus the whole body) up behind the keyboard, hiding the search box.
            The child supplies its own padding in flush mode. */}
        {flushBody ? (
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
        ) : (
          <div className="overflow-y-auto overflow-x-hidden overscroll-contain px-4 sm:px-6 py-5 flex-1 min-w-0">{children}</div>
        )}
        {footer && (
          <div className="px-4 sm:px-6 py-4 border-t border-ink-100 bg-ink-50/50 sm:rounded-b-2xl flex flex-wrap items-center justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
