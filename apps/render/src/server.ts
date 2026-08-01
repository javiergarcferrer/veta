/**
 * Node boot — where the injected renderer becomes a real browser.
 *
 * `service.ts` knows nothing about playwright and `browser.ts` knows nothing
 * about HTTP; this file is the only place the two meet, which is what keeps the
 * routing/auth/cache tests browser-free.
 *
 * The pool is LAZY: booting the process launches no chromium, so a host whose
 * harness has not been built yet still answers `/health` truthfully (503 with a
 * reason) instead of crashing at start.
 */

import { serve } from '@hono/node-server';

import { BrowserPool } from './browser.ts';
import { createRenderService } from './service.ts';

const port = Number(process.env.PORT ?? 8788);
const hostname = process.env.HOST ?? '0.0.0.0';

const pool = new BrowserPool();
const { app } = createRenderService({
  renderer: {
    render: (job) => pool.render(job),
    available: () => pool.available(),
  },
});

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[veta-render] listening on http://${hostname}:${info.port}`);
  if (!process.env.RENDER_INTERNAL_SECRET) {
    // Fail-closed is already the behaviour (`secretMatches` refuses without
    // one); say so at boot rather than letting every request 401 mysteriously.
    console.warn('[veta-render] RENDER_INTERNAL_SECRET is unset — every /render will 401');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.close().then(() => process.exit(0));
    });
  });
}
