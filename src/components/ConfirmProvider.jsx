import { createContext, useCallback, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import Modal from './Modal.jsx';

/**
 * App-wide confirm dialog + toast — the styled, in-app replacement for native
 * window.confirm / window.alert that clashed with the design system and were
 * easy to mis-tap on mobile.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title, message, confirmLabel, tone: 'danger' })) { … }
 *
 *   const toast = useToast();
 *   toast('Enlace copiado');            // success (default)
 *   toast('No se pudo copiar', { tone: 'error' });
 *
 * Mounted once high in the tree (App). The dialog is promise-based: confirm()
 * resolves true on confirm, false on cancel / backdrop / Escape.
 */
// The default's SIGNATURE is the contract TypeScript sees — `useConfirm()` is
// typed by inference from this value, so a zero-arg default made every
// `confirm({ … })` call in a .tsx file a type error (TS2554) even though it
// worked at runtime. Taking the options object here is what makes the hook
// usable from TypeScript at all.
const ConfirmCtx = createContext(async (_opts) => false);
const ToastCtx = createContext(() => {});

export function useConfirm() { return useContext(ConfirmCtx); }
export function useToast() { return useContext(ToastCtx); }

let toastSeq = 0;

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null); // { opts, resolve }
  const [toasts, setToasts] = useState([]);
  // `input` turns the dialog into the styled replacement for window.prompt:
  // confirm resolves to the TYPED STRING instead of true, cancel still to
  // false. One dialog, because a second overlay for one extra field would be
  // a second set of focus, Escape and mobile-sheet rules to keep in step.
  const [value, setValue] = useState('');

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    const o = typeof opts === 'string' ? { message: opts } : opts;
    setValue(o.input?.defaultValue || '');
    setDialog({ opts: o, resolve });
  }), []);

  function settle(val) {
    // With an input, confirming resolves to the trimmed string — and an empty
    // one resolves false, so a caller's `if (!name) return` keeps working.
    const o = dialog?.opts || {};
    if (dialog) dialog.resolve(val && o.input ? (value.trim() || false) : val);
    setDialog(null);
  }

  // `action` is what makes UNDO possible without a second overlay: the toast is
  // already the app's transient-feedback channel and already owns this corner,
  // so an undo affordance belongs in it rather than beside it. When one is
  // given the toast stays up longer, because a person has to read it, decide,
  // and reach — 2.8s is enough to notice a message and not enough to act on one.
  const toast = useCallback((message, opts = {}) => {
    const id = ++toastSeq;
    const action = opts.action || null;
    const duration = opts.duration ?? (action ? 6000 : 2800);
    setToasts((ts) => [...ts, { id, message, tone: opts.tone || 'success', action }]);
    if (duration > 0) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), duration);
    return id;
  }, []);

  const o = dialog?.opts || {};
  const danger = o.tone === 'danger';

  return (
    <ConfirmCtx.Provider value={confirm}>
      <ToastCtx.Provider value={toast}>
        {children}
        <Modal
          open={!!dialog}
          onClose={() => settle(false)}
          title={o.title || 'Confirmar'}
          size="sm"
          footer={(
            <>
              <button type="button" className="btn-ghost" onClick={() => settle(false)}>{o.cancelLabel || 'Cancelar'}</button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={danger
                  ? 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 transition-colors'
                  : 'btn-primary'}
              >
                {o.confirmLabel || 'Confirmar'}
              </button>
            </>
          )}
        >
          {o.message && <p className="text-sm text-ink-700 whitespace-pre-line leading-relaxed">{o.message}</p>}
          {o.input && (
            <label className="block mt-3">
              <span className="label">{o.input.label}</span>
              <input className="input" autoFocus value={value} placeholder={o.input.placeholder || ''}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); settle(true); } }} />
            </label>
          )}
        </Modal>
        {toasts.length > 0 && createPortal(
          <div className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[90] flex flex-col items-center gap-2 px-4 pointer-events-none">
            {toasts.map((t) => {
              const Icon = t.tone === 'error' ? AlertCircle : t.tone === 'info' ? Info : CheckCircle2;
              const cls = t.tone === 'error' ? 'text-status-critical-ink' : t.tone === 'info' ? 'text-ink-500' : 'text-status-good-ink';
              return (
                <div key={t.id} className="pointer-events-auto flex items-center gap-2 rounded-lg bg-surface border border-ink-200 shadow-pop px-3.5 py-2.5 text-sm text-ink-800 animate-in fade-in slide-in-from-bottom-2 duration-200 max-w-md">
                  <Icon size={16} className={`${cls} shrink-0`} aria-hidden />
                  <span className="min-w-0">{t.message}</span>
                  {t.action && (
                    <button
                      type="button"
                      onClick={async () => {
                        setToasts((ts) => ts.filter((x) => x.id !== t.id));
                        await t.action.onAction();
                      }}
                      className="btn-ghost shrink-0 -my-1 text-xs font-medium"
                    >
                      {t.action.label}
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
