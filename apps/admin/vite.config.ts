/**
 * Admin build. Deliberately plain: this app is forms and tables, so there is no
 * worker split and no manual chunking to justify — the only dependencies of
 * size are React and the two pure engine packages it imports (`@veta/catalog`
 * for the routing cascade and the pricing rules, `@veta/geometry` for the DXF).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
});
