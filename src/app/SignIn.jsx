import { useState } from 'react';
import { Mail, Lock, LogIn, AlertCircle, ArrowLeft, MailCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { userMessageFor } from '../lib/errorMessages.js';

/**
 * Sign-in for the admin app. Deliberately minimal: email + password (whatever
 * AuthContext already supports) plus the "forgot password" round-trip it
 * exposes. There is NO sign-up form — accounts are created in Supabase and
 * activated by an admin; a random visitor finds no door open here.
 *
 * The public surfaces (the configurator's clean URLs and `#/dealer/:token`)
 * never reach this screen — see Shell.jsx.
 */
export default function SignIn() {
  const { signIn, resetPassword, recoveryError, clearRecoveryError } = useAuth();
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [resetSent, setResetSent] = useState(false);

  const isReset = mode === 'reset';
  const shownError = error || recoveryError;

  function switchTo(next) {
    setMode(next);
    setError(null);
    setResetSent(false);
    setBusy(false);
    setPassword('');
    clearRecoveryError?.();
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    clearRecoveryError?.();
    try {
      if (isReset) {
        await resetPassword(email.trim());
        // Confirm generically — resetPasswordForEmail doesn't reveal whether
        // the address has an account (anti-enumeration), and neither do we.
        setResetSent(true);
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(userMessageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-canvas p-6">
      <div className="card-auth">
        <div className="text-center mb-8">
          <div className="font-wordmark text-2xl tracking-[0.18em] text-ink-900 mb-1.5">VETA</div>
          <h1 className="font-display text-sm font-semibold text-ink-700">
            {isReset ? 'Restablecer contraseña' : 'Iniciar sesión'}
          </h1>
          <p className="text-xs text-ink-400 mt-1 leading-relaxed">
            {isReset ? 'Te enviaremos un enlace para crear una nueva.' : 'Correo y contraseña de tu equipo.'}
          </p>
        </div>

        {isReset && resetSent ? (
          <div className="space-y-5">
            <div role="status" className="flex items-start gap-2.5 text-xs text-emerald-800 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/40 rounded-lg px-3 py-3">
              <MailCheck size={16} className="flex-shrink-0 mt-0.5" aria-hidden />
              <span>
                Si <b className="font-medium">{email.trim()}</b> tiene una cuenta, te enviamos un enlace
                para restablecer tu contraseña. Revisa tu correo (y la carpeta de spam).
              </span>
            </div>
            <button type="button" onClick={() => switchTo('signin')} className="btn-secondary w-full justify-center">
              <ArrowLeft size={14} aria-hidden /> Volver a iniciar sesión
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label" htmlFor="signin-email">Correo</label>
              <div className="relative">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
                <input
                  id="signin-email"
                  type="email"
                  className="input pl-9"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  inputMode="email"
                  enterKeyHint={isReset ? 'send' : 'next'}
                  required
                  autoFocus
                />
              </div>
            </div>

            {!isReset && (
              <div>
                <label className="label" htmlFor="signin-password">Contraseña</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
                  <input
                    id="signin-password"
                    type="password"
                    className="input pl-9"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    enterKeyHint="go"
                    required
                  />
                </div>
              </div>
            )}

            {shownError && (
              <div role="alert" className="flex items-start gap-2 text-xs text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 rounded-lg px-3 py-2.5">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden />
                <span>{shownError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn-primary w-full justify-center mt-2 disabled:opacity-60 disabled:cursor-wait"
            >
              {busy
                ? <><Loader2 size={14} className="animate-spin" aria-hidden /> {isReset ? 'Enviando…' : 'Entrando…'}</>
                : isReset
                  ? <><Mail size={14} aria-hidden /> Enviar enlace</>
                  : <><LogIn size={14} aria-hidden /> Entrar</>}
            </button>

            <button
              type="button"
              onClick={() => switchTo(isReset ? 'signin' : 'reset')}
              className="w-full text-center text-[12px] text-ink-500 hover:text-ink-700 inline-flex items-center justify-center gap-1 transition-colors"
            >
              {isReset ? <><ArrowLeft size={12} aria-hidden /> Volver a iniciar sesión</> : '¿Olvidaste tu contraseña?'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
