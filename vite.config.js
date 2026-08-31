import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';

// Relative asset base, so the built app works under any host path.
// Override with VITE_BASE when deploying somewhere unusual.
const base = process.env.VITE_BASE || './';

// The CLEAN public configurator URLs. Both spellings stay live (links carrying
// either are already out in the world) and both serve the SAME document —
// main.jsx keys off the pathname, which the rewrite must preserve.
const CONFIGURATOR_PATHS = ['/configurator', '/configurator/', '/configurador', '/configurador/'];

export default defineConfig(({ mode }) => {
  // Load env from every source (empty prefix = all vars, not just VITE_-prefixed).
  // A Vercel ↔ Supabase integration injects SUPABASE_URL and SUPABASE_ANON_KEY
  // automatically; we pick those up and forward them into the client bundle as
  // the VITE_-prefixed names the app code already reads (db/supabaseClient,
  // lib/configuratorEmbed). No manual mirroring in project settings required.
  const env = loadEnv(mode, process.cwd(), '');

  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
  const supabaseAnon = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

  // `npm run dev` half of the clean-URL contract: production hosts rewrite
  // /configurator[/] and /configurador[/] to configurator.html (see the deploy
  // note in that file); the dev + preview servers do the same here so the
  // public widget is reachable at its real URL locally.
  const rewriteCleanUrls = (req, _res, next) => {
    const path = (req.url || '').split('?')[0];
    if (CONFIGURATOR_PATHS.includes(path)) {
      const q = (req.url || '').slice(path.length);
      req.url = `/configurator.html${q}`;
    }
    next();
  };
  const configuratorCleanUrls = {
    name: 'configurator-clean-urls',
    configureServer(server) { server.middlewares.use(rewriteCleanUrls); },
    configurePreviewServer(server) { server.middlewares.use(rewriteCleanUrls); },
  };

  return {
    base,
    plugins: [react(), configuratorCleanUrls],
    resolve: {
      // The codebase imports with explicit `.js` / `.jsx` extensions
      // (`from '../lib/format.js'`) — an ESM-purist discipline that predates
      // the TypeScript migration. esbuild's dev pipeline resolves those to
      // `.ts`/`.tsx` transparently, but Rollup (the production builder) does
      // not. These aliases rewrite any relative `*.js` / `*.jsx` import to its
      // extension-less form so Vite's own resolver can find either `.ts`,
      // `.tsx`, or the original `.js`/`.jsx`.
      alias: [
        { find: /^(\.{1,2}\/.*)\.jsx$/, replacement: '$1' },
        // (?!chunk-): never strip the extension off the dep optimizer's own
        // `./chunk-XXXXXXXX.js` imports inside /node_modules/.vite/deps/* —
        // aliasing those to extensionless URLs 404s them and the dev server
        // serves an app that can't boot. Source files never import ./chunk-*.
        { find: /^(\.{1,2}\/(?!chunk-).*)\.js$/, replacement: '$1' },
      ],
      extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    },
    // Inject ONLY the two public-by-design Supabase vars into the client
    // bundle. SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET / POSTGRES_*
    // are never referenced here and must never leak into the browser.
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnon),
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        // Two HTML entries loading the SAME bundle: index.html (the admin app,
        // hash-routed) and configurator.html (the public widget, mounted
        // straight from main.jsx off the clean pathname).
        input: {
          main: join(process.cwd(), 'index.html'),
          configurator: join(process.cwd(), 'configurator.html'),
        },
        output: {
          // Vendor tiers, matched by DIRECTORY rather than by package entry.
          // The object form (`{ react: ['react', …] }`) resolves each name to
          // ONE module — the package's main entry — so a subpath export like
          // `react/jsx-runtime` stays unclaimed and is absorbed by whichever
          // manual chunk reaches it first. Matching on the directory claims
          // every subpath (react/jsx-runtime, react-dom/client, …) for the tier
          // it belongs to, which is what lets the dynamic import()s in the
          // widget's 3D path actually stay dynamic.
          manualChunks(id) {
            const m = id.replace(/\\/g, '/');
            if (!m.includes('/node_modules/')) return undefined;
            // React FIRST: it is the tier every other tier borrows from, and
            // claiming it up front is what stops a heavier chunk taking the
            // jsx runtime hostage.
            if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(m)) return 'react';
            // Stable vendor tiers split out of the app's `index` chunk: these
            // change far less often than our code (which rebuilds every
            // deploy), so giving them their own hashed files lets the browser
            // keep them cached across releases.
            if (/\/node_modules\/@supabase\//.test(m)) return 'supabase';
            if (/\/node_modules\/lucide-react\//.test(m)) return 'icons';
            return undefined;
          },
        },
      },
    },
    worker: { format: 'es' },
  };
});
