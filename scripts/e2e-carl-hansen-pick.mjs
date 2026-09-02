#!/usr/bin/env node
/**
 * E2E SMOKE + MEASUREMENT: the Carl Hansen picker, end to end, in a real
 * Chromium — desktop (click) and an emulated iPhone (tap).
 *
 * WHY IT EXISTS. The owner's screenshot of 2026-09-02: the picker was a wall
 * of sixty identical text tiles («CH24 · dining-chairs») under a caption that
 * said «257 piezas publicadas». Nothing in typecheck, build or the node suite
 * can see a screen; the ViewModel tests pin the projection, and this harness
 * pins what a visitor actually gets — cards with a name, a designer and a
 * photo, shelves with a heading, a search that narrows, a «Ver más» that
 * reaches the chairs the old slice hid, and a tap that lands on a ficha with a
 * list price. It is the Playwright measurement harness the RosetSoft studio
 * rework used (dist served locally, the network stubbed at the wire), kept as
 * a script so the next rework measures instead of arguing.
 *
 * WHAT IT STUBS. `/functions/v1/carl-hansen` by `op`, with the repo's own
 * fixtures: the real sitemap of 2026-09-02 wearing the faces the furniture
 * index knows (`picker-models.json`, 257 rows, 126 named), the CH24 master,
 * its VAT0-USD price list and its product page. Photos off `admincms.
 * carlhansen.com` are answered with a local placeholder so the run is
 * deterministic and offline.
 *
 * HOW TO RUN.  npm run build && npm run e2e:carl-hansen
 * Needs a Chromium: CHROMIUM_BIN, or the preinstalled /opt/pw-browsers/chromium.
 * `SHOTS=<dir>` writes screenshots there (desktop + phone, picker + ficha).
 * Not part of `npm test` (needs a browser); a manual / browser-CI gate.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, devices } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const FIX = join(ROOT, 'tests', 'fixtures', 'carlHansen');
const PORT = 5058;
const CHROMIUM = process.env.CHROMIUM_BIN || '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS || '';

if (!existsSync(join(DIST, 'configurator.html'))) {
  console.error('dist/configurator.html no existe — corre `npm run build` primero');
  process.exit(2);
}

const load = (n) => JSON.parse(readFileSync(join(FIX, n), 'utf8'));
const MODELS = load('picker-models.json');
const CH24 = { model: load('CH24_en.model.json'), prices: load('CH24_prices_VAT0-USD.json'), page: load('ch24.pageData.json') };

/** The wire, by op — the same shapes `supabase/functions/carl-hansen/index.ts` emits. */
function answer(body) {
  switch (body?.op) {
    case 'models': return { ok: true, models: MODELS, count: MODELS.length, faces: 'cached' };
    case 'model': return body.modelId === 'CH24'
      ? { ok: true, modelId: 'CH24', model: CH24.model }
      : { ok: false, error: `Carl Hansen no publica ficha para ${body.modelId}.` };
    case 'prices': return body.modelId === 'CH24'
      ? { ok: true, modelId: 'CH24', market: 'VAT0-USD', prices: CH24.prices }
      : { ok: false, error: `Carl Hansen no publica lista VAT0-USD para ${body.modelId}.`, reason: 'no-price-list' };
    case 'page': return body.modelId === 'CH24'
      ? { ok: true, modelId: 'CH24', path: '/en/en/collection/chairs/dining-chairs/ch24', page: { ...CH24.page, Variants: CH24.page.Variants, media: CH24.page.MediaList } }
      : { ok: false, error: `${body.modelId} no tiene página de producto.` };
    case 'asset': return { ok: true, modelId: body.modelId, asset: null };
    default: return { ok: false, error: `op desconocida "${body?.op}"` };
  }
}

/** A quiet placeholder for the manufacturer's CDN — the harness is offline. */
const PLACEHOLDER = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#efeee9"/>'
  + '<path d="M120 230 L120 120 Q120 80 160 80 L240 80 Q280 80 280 120 L280 230 M140 230 L140 170 L260 170 L260 230" fill="none" stroke="#c9c5b8" stroke-width="10" stroke-linecap="round"/></svg>',
);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  // The deploy contract (configurator.html): /configurador/* → configurator.html.
  const entry = /^\/(configurador|configurator)(\/|$)/.test(path) ? 'configurator.html' : 'index.html';
  const file = join(DIST, path === '/' ? 'index.html' : path);
  const target = existsSync(file) && !file.endsWith('/') && extname(file) ? file : join(DIST, entry);
  try {
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' });
    res.end(readFileSync(target));
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1');

let failed = false;
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

async function run(label, contextOpts, tap) {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await page.route('**/functions/v1/carl-hansen*', (r) => {
    let body = null;
    try { body = JSON.parse(r.request().postData() || 'null'); } catch { body = null; }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(body)) });
  });
  await page.route('https://admincms.carlhansen.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER }));

  const act = async (loc, name) => {
    try {
      await loc.first().waitFor({ state: 'visible', timeout: 15000 });
      if (tap) await loc.first().tap(); else await loc.first().click();
    } catch (e) {
      e.message = `[paso: ${name}] ${e.message}`;
      throw e;
    }
    await page.waitForTimeout(600);
  };
  const check = (ok, what) => {
    if (!ok) { failed = true; console.error(`  ✗ ${label}: ${what}`); } else console.log(`  ✓ ${label}: ${what}`);
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/configurador/carl-hansen`, { timeout: 30000 });
    await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
    await page.getByRole('heading', { name: /carl hansen/i }).waitFor({ timeout: 15000 });
    await page.getByText(/piezas publicadas/i).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);

    // 1. The picker has shelves, and the cards have faces.
    const shelves = await page.locator('.section-rule > span[id^="ch-shelf-"]').allTextContents();
    // Dining (28) + lounge (31) chairs already overflow one page of 48, so the
    // first paint is two shelves — seating, which is what the house is known for.
    check(shelves.length >= 2, `shelves on the first page: ${shelves.slice(0, 5).join(' · ')}`);
    check(shelves[0] === 'Sillas de comedor', `seating leads (first shelf: ${shelves[0]})`);
    const cards = page.locator('ul li button.card');
    const n = await cards.count();
    check(n === 48, `cards on the first page: ${n} (page = 48)`);
    // CH24 and CH24P are both a «Wishbone Chair»; the code tells them apart.
    const wishbone = page.locator('button.card').filter({ has: page.locator('.code', { hasText: /^CH24$/ }) });
    check(await wishbone.count() === 1 && /Wishbone Chair/.test(await wishbone.textContent()), 'the CH24 card reads «Wishbone Chair»');
    const wishboneText = (await wishbone.count()) ? await wishbone.textContent() : '';
    check(/Hans J\. Wegner/.test(wishboneText) && /CH24/.test(wishboneText), 'the designer and the code are on the card');
    const img = wishbone.locator('img');
    check(await img.count() === 1 && (await img.getAttribute('loading')) === 'lazy', 'the cover is lazy-loaded');
    const counts = await page.getByText(/piezas publicadas/).textContent();
    check(/257 piezas publicadas/.test(counts), `the count is the whole catalogue: «${counts.trim()}»`);
    await shot(page, `${label}-picker`);

    // 2. The truncation is a number the visitor can act on.
    const more = page.getByRole('button', { name: /^Ver \d+ más$/ });
    check(await more.count() === 1, `«Ver más» is offered: «${(await more.textContent())?.trim()}»`);
    await act(more, 'ver-mas');
    const n2 = await page.locator('ul li button.card').count();
    check(n2 === 96, `after «Ver más»: ${n2} cards`);

    // 3. Search narrows across name, code, designer and shelf.
    const search = page.getByRole('searchbox', { name: /buscar una pieza/i });
    await search.fill('wegner butacas');
    await page.waitForTimeout(400);
    const narrowed = await page.locator('ul li button.card').count();
    const shelvesNow = await page.locator('.section-rule > span[id^="ch-shelf-"]').allTextContents();
    check(narrowed > 0 && narrowed < 48 && shelvesNow.length === 1 && shelvesNow[0] === 'Butacas',
      `«wegner butacas» → ${narrowed} cards, one shelf (${shelvesNow.join(', ')})`);
    await search.fill('togo');
    await page.waitForTimeout(400);
    check(await page.getByText(/Nada coincide con «togo»/).count() === 1, 'an empty search says so and offers the way out');
    await act(page.getByRole('button', { name: /ver todas las piezas/i }), 'clear');
    check(await page.locator('ul li button.card').count() === 48, 'clearing the search restores the first page');

    // 4. A tap lands on the ficha with a list price.
    await search.fill('wishbone');
    await page.waitForTimeout(400);
    await act(page.locator('button.card').filter({ has: page.locator('.code', { hasText: /^CH24$/ }) }), 'open');
    await page.getByText(/precio de lista/i).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const price = await page.locator('aside .num').first().textContent();
    check(/^\$[\d,]+$/.test((price || '').trim()), `the ficha shows a list price: ${price?.trim()}`);
    check(await page.getByRole('heading', { name: /wishbone chair/i }).count() === 1, 'the ficha is titled by the chair\'s name');
    await shot(page, `${label}-ficha`);

    // 5. Back keeps the search the visitor typed.
    await act(page.getByRole('button', { name: /todas las piezas/i }), 'back');
    check((await search.inputValue()) === 'wishbone', 'going back keeps the query');

    check(errors.length === 0, errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  } catch (e) {
    failed = true;
    console.error(`  ✗ ${label}: ${e.message.split('\n')[0]}`);
    await shot(page, `${label}-FAILED`);
  } finally {
    await browser.close();
  }
}

await run('desktop', { viewport: { width: 1440, height: 900 } }, false);
await run('iphone', { ...devices['iPhone 13'] }, true);
server.close();
console.log(failed ? '\nE2E carl-hansen: FAILED' : '\nE2E carl-hansen: OK');
process.exit(failed ? 1 : 0);
