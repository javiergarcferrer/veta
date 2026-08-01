/**
 * The widget's build.
 *
 * Two deliberate choices:
 *
 *  • `manualChunks` splits three.js out by itself. It is by far the heaviest
 *    dependency and only the 3D view, the exports and AR ever touch it — with it
 *    in the entry chunk, every visitor who only arranges a plan would download a
 *    renderer they never open.
 *  • `target: 'es2022'` matches the workspace tsconfig. The widget runs on
 *    consumer phones, but every engine that can do WebGL2/WebXR is well past
 *    ES2022, and down-levelling only inflates the bundle.
 *
 * NOTE — undeclared optional dependencies (`@google/model-viewer`, `qrcode`)
 * are imported through a runtime variable specifier marked `@vite-ignore` (see
 * `src/lib/dynamicImport.ts`), so this build succeeds with them absent. Do not
 * "fix" those into literal imports.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
  server: { port: 5174 },
});
