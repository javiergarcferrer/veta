import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { initTheme } from './lib/theme.js';
import { captureError } from './lib/errorLog.js';
import { safeDynamicImport } from './lib/dynamicImport.js';
import { configuratorForPathname } from './brands/configurators/index.js';

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

// Clean public URLs for the configurators. `/configurador` and `/configurator`
// (both spellings stay live — links carrying either are already out in the
// world) belong to Togo permanently; every other brand gets a suffix,
// `/configurador/carl-hansen`. Which brand a path names is decided ONCE, in
// `brands/configurators`, and never re-derived here.
//
// Each mounts a DIFFERENT standalone widget, because the brands do not compose
// the same thing: Togo composes modules on a floor plan, Carl Hansen composes
// one piece by its axes. None of them has router dependencies (they read
// window.location only), so they mount directly at the path and the URL stays
// clean. Every other path runs the hash-routed admin shell.
// ONE LAZY IMPORT PER BRAND, and they must stay literal `import()` calls: the
// bundler resolves these statically, so a computed path would silently produce
// no chunk at all. The registry decides WHICH id is wanted; this decides what
// that id loads, and the split means a visitor configuring a chair never
// downloads the sofa's 3D graph.
const CONFIGURATOR_VIEWS = {
  togo: React.lazy(() => safeDynamicImport(() => import('./pages/embed/TogoEmbed.jsx'))),
  'carl-hansen': React.lazy(() => safeDynamicImport(() => import('./pages/embed/CarlHansenEmbed.jsx'))),
};

// The admin SHELL is lazy for the same reason the widget is: the public
// configurator boots through this entry, and a static `import Shell` would drag
// the whole admin graph — contexts, auth, Supabase client, the model manager —
// into the render-blocking entry chunk that the public widget never renders.
const Shell = React.lazy(() => safeDynamicImport(() => import('./app/Shell.jsx')));

const configurator = configuratorForPathname(window.location.pathname);
// An unknown suffix (`/configurador/carl-hanson`) resolves to NOTHING rather
// than to the default brand: opening a sofa configurator for someone who asked
// for a chair is worse than a 404.
const ConfiguratorView = configurator ? CONFIGURATOR_VIEWS[configurator.id] : null;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {ConfiguratorView ? (
        <React.Suspense fallback={null}>
          <ConfiguratorView />
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
