/**
 * Studio build. Two things are deliberate:
 *
 *   • `worker.format: 'es'` — the workers dynamically `import('three')` and its
 *     addons, and a classic worker cannot. Losing that would put three's module
 *     evaluation back on the main thread, which is the debt this app exists not
 *     to carry.
 *   • the manual chunk for three — it is by far the largest dependency and is
 *     shared by the stage and both workers; splitting it keeps the shell's first
 *     paint independent of it.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('/node_modules/three/') ? 'three' : undefined),
      },
    },
  },
});
