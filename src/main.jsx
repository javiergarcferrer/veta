import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { initTheme } from './lib/theme.js';
import { captureError } from './lib/errorLog.js';
import { safeDynamicImport } from './lib/dynamicImport.js';
import { isConfiguratorPathname } from './lib/togoEmbed.js';

// Catch what the handled-error funnel (userMessageFor) doesn't see: uncaught
// sync errors and rejected promises. Feeds the in-app error console.
window.addEventListener('error', (e) => {
  if (e?.message && /ResizeObserver loop|Script error\.?$/i.test(e.message)) return; // benign noise
  captureError(e?.error || e?.message, {
    type: 'window',
    source: e?.filename ? `${e.filename}:${e.lineno || ''}` : '',
  });
});
window.addEventListener('unhandledrejection', (e) => {
  captureError(e?.reason ?? 'Unhandled rejection', { type: 'promise' });
});

// Re-affirm the theme the inline boot script in index.html / configurator.html
// already painted, and start following the OS while the user is on "system".
initTheme();

// Re-affirm the installed-PWA flag the inline boot script stamped. It has to
// land before the first style resolution (src/index.css picks the shell's
// height rule off it), which a module-graph write cannot promise — hence both.
// On iOS `navigator.standalone` is DEFINITIVE (true only for a home-screen
// launch) and must NOT fall through to `matchMedia('(display-mode:
// standalone)')`, which iOS Safari can mis-match in a normal tab; the query
// covers Android/desktop installs, where the flag is undefined.
try {
  const iosFlag = window.navigator.standalone;
  const standalone =
    typeof iosFlag === 'boolean'
      ? iosFlag
      : window.matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('is-standalone', standalone);
} catch {
  /* unsupported — no-op */
}

// Clean public URLs for the configurator: /configurador and /configurator (both
// spellings stay live — links carrying either are already out in the world).
// They share this entry and this bundle, and each mounts the SAME standalone
// widget. The widget has no router dependencies (it reads window.location only),
// so it mounts directly at that path and the URL stays clean. Every other path
// runs the hash-routed admin shell.
const TogoEmbedStandalone = React.lazy(() => safeDynamicImport(() => import('./pages/embed/TogoEmbed.jsx')));

// The admin SHELL is lazy for the same reason the widget is: the public
// configurator boots through this entry, and a static `import Shell` would drag
// the whole admin graph — contexts, auth, Supabase client, the model manager —
// into the render-blocking entry chunk that the public widget never renders.
const Shell = React.lazy(() => safeDynamicImport(() => import('./app/Shell.jsx')));

const isConfiguratorPath = isConfiguratorPathname(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isConfiguratorPath ? (
        <React.Suspense fallback={null}>
          <TogoEmbedStandalone />
        </React.Suspense>
      ) : (
        <HashRouter>
          <React.Suspense fallback={null}>
            <Shell />
          </React.Suspense>
        </HashRouter>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
