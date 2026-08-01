// Node boot. `apps/api` is a plain Node service (not an Edge Function) so the
// workspace engines (@veta/rules, @veta/catalog, @veta/layout) are imported
// directly rather than re-implemented across a runtime wall.

import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { closeDb } from './db.ts';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '0.0.0.0';

const server = serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`[veta-api] listening on http://${hostname}:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closeDb().then(() => process.exit(0));
    });
  });
}
