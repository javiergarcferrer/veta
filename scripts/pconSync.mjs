#!/usr/bin/env node
/**
 * `npm run pcon:sync` — the back-office job that reads a manufacturer's OFML
 * catalog out of pCon and prints it as rows VETA can import.
 *
 * IT PRINTS. It does not write to the database, and that is deliberate for as
 * long as this integration is new: a sweep that silently replaced a live price
 * list on its first run would be indistinguishable from one that worked. Look
 * at the JSON, check a dozen prices against the manufacturer's own list, THEN
 * wire the writer.
 *
 * ── WHY A NODE SCRIPT AND NOT AN EDGE FUNCTION ──────────────────────────────
 * `@easterngraphics/wcf` decodes SOAP with `DOMParser`, which Deno Deploy does
 * not have and cannot be given. Node can be, via `@xmldom/xmldom`. See
 * `src/lib/pcon/eaiws.ts`.
 *
 * ── WHAT YOU NEED BEFORE THIS RUNS ──────────────────────────────────────────
 *   PCON_CLIENT_ID       issued by EasternGraphics (support@easterngraphics.com).
 *                        There is NO self-registration; every other variable is
 *                        useless without it.
 *   PCON_CLIENT_SECRET   for a confidential client. Omit for a public one.
 *   PCON_REFRESH_TOKEN   from a completed authorization-code flow. Mint it with
 *                        `--login` below, once, at a keyboard.
 *   PCON_EAIWS_URL       the EAIWS/Gatekeeper base URL, from the licence.
 *   PCON_STARTUP         the startup file naming this manufacturer's data.
 *   PCON_MANUFACTURER    e.g. `desede` — the catalog root to sweep.
 *   PCON_GRADE_PROPERTY  e.g. `Leder.Qualitaet`. UNSET ⇒ everything sweeps
 *                        ungraded, one row per article, which is a legitimate
 *                        answer and not a fallback for a wrong guess.
 *   PCON_COVER_PROPERTY  the cover/finish property, for the material roster.
 *   VETA_BRAND           the brand id these rows belong to.
 *
 * Usage:
 *   node scripts/pconSync.mjs --login          print the authorize URL, then
 *                                              exchange the code you paste back
 *   node scripts/pconSync.mjs --manufacturers  list what this account can see
 *   node scripts/pconSync.mjs --limit 20       sweep, bounded
 *   node scripts/pconSync.mjs --out cat.json   write the rows to a file
 */

import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import {
  authorizeUrl, basicAuthHeader, createPkce, createState, exchangeCode,
  readRedirect, refresh, DEFAULT_SCOPES, LONGTERM_SCOPE,
} from '../src/lib/pcon/oauth.ts';
import { listManufacturers, openSession } from '../src/lib/pcon/eaiws.ts';
import { sweep } from '../src/lib/pcon/sync.ts';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const env = (name, required = false) => {
  const v = (process.env[name] || '').trim();
  if (!v && required) {
    console.error(`\n  Missing ${name}. See the header of this file for what each variable is and where it comes from.\n`);
    process.exit(1);
  }
  return v;
};

const CLIENT_ID = env('PCON_CLIENT_ID');
const CLIENT_SECRET = env('PCON_CLIENT_SECRET');
const basicAuth = CLIENT_ID && CLIENT_SECRET ? basicAuthHeader(CLIENT_ID, CLIENT_SECRET) : null;

/** One interactive sign-in, to mint the refresh token the job then reuses. */
async function login() {
  if (!CLIENT_ID) {
    console.error([
      '',
      '  PCON_CLIENT_ID is not set, and it cannot be self-registered.',
      '',
      '  pCon.login has no client-registration endpoint. EasternGraphics issues',
      '  the id by email — send them, per their docs:',
      '',
      '    client_id (the one you want), name, redirect_uris,',
      '    default_redirect_uri, required_scopes, intended_flows,',
      '    supports_long_term_tokens, pcon_session, contact_email',
      '',
      '  to support@easterngraphics.com. Everything else here works the moment',
      '  they answer.',
      '',
    ].join('\n'));
    process.exit(1);
  }
  const redirectUri = opt('redirect', 'http://localhost:5173/pcon/callback');
  const pkce = await createPkce();
  const state = createState();
  const scopes = flag('longterm') ? [...DEFAULT_SCOPES, LONGTERM_SCOPE] : DEFAULT_SCOPES;

  console.log('\n  Open this, sign in, then paste the FULL redirected URL back here:\n');
  console.log(`  ${authorizeUrl({ clientId: CLIENT_ID, redirectUri, challenge: pkce, state, scopes })}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question('  redirected URL: ')).trim();
  rl.close();

  const code = readRedirect(new URL(pasted).search, state);
  const tokens = await exchangeCode({
    clientId: CLIENT_ID, code, redirectUri, verifier: pkce.verifier, basicAuth,
  });

  console.log('\n  Store this, it is the credential the unattended sweep spends:\n');
  console.log(`  PCON_REFRESH_TOKEN=${tokens.refreshToken}\n`);
  console.log(`  (scope: ${tokens.scope || '(none reported)'}; access token expires in ${tokens.expiresIn}s)\n`);
}

/** Trade the stored refresh token for a usable access token. */
async function accessToken() {
  const refreshToken = env('PCON_REFRESH_TOKEN', true);
  const tokens = await refresh({
    clientId: env('PCON_CLIENT_ID', true), refreshToken, basicAuth,
  });
  return tokens.accessToken;
}

async function connect() {
  return openSession({
    baseUrl: env('PCON_EAIWS_URL', true),
    userToken: await accessToken(),
    startup: env('PCON_STARTUP') || undefined,
    packageGroups: env('PCON_PACKAGE_GROUPS') || undefined,
    locale: env('PCON_LOCALE') || 'en-US',
  });
}

async function manufacturers() {
  const session = await connect();
  try {
    const list = await listManufacturers(session);
    console.log(`\n  ${list.length} manufacturer(s) visible to this account:\n`);
    for (const m of list) console.log(`    ${m.id.padEnd(24)} ${m.name}`);
    console.log('\n  If the one you want is missing, it is a SUBSCRIPTION, not a bug.\n');
  } finally {
    await session.close();
  }
}

async function run() {
  const manufacturer = env('PCON_MANUFACTURER', true);
  const session = await connect();
  try {
    const started = Date.now();
    const result = await sweep({
      session,
      root: [manufacturer],
      limit: Number(opt('limit', 50)),
      maxDepth: Number(opt('depth', 8)),
      withGeometry: flag('geometry'),
      withCovers: !flag('no-covers'),
      mapping: {
        brand: env('VETA_BRAND') || manufacturer,
        gradeProperty: env('PCON_GRADE_PROPERTY') || null,
        coverProperty: env('PCON_COVER_PROPERTY') || null,
        gradeAlias: null,
      },
      composeSku: (root, grade) => (grade ? `${root}-${grade}` : root),
      onProgress: (msg, done, total) => {
        if (flag('quiet')) return;
        process.stderr.write(`\r  ${String(done).padStart(4)}/${total}  ${msg.slice(0, 60).padEnd(60)}`);
      },
    });
    process.stderr.write('\n');

    const { stats } = result;
    console.error([
      '',
      `  articles swept : ${stats.articles}${stats.truncated ? '  (TRUNCATED — partial catalog)' : ''}`,
      `  rows produced  : ${stats.rows}`,
      `  without price  : ${stats.unpriced}`,
      `  without grade  : ${stats.ungraded}`,
      `  failed         : ${stats.failed}`,
      `  covers found   : ${result.covers.length}`,
      `  elapsed        : ${((Date.now() - started) / 1000).toFixed(1)}s`,
      '',
    ].join('\n'));
    for (const w of result.warnings) console.error(`  ! ${w}`);
    if (result.warnings.length) console.error('');

    const payload = JSON.stringify(
      { rows: result.rows, covers: result.covers, stats: result.stats, warnings: result.warnings },
      null, 2,
    );
    const out = opt('out');
    if (out) { await writeFile(out, payload); console.error(`  written to ${out}\n`); }
    else console.log(payload);

    // A sweep that produced nothing usable must not exit 0 — a nightly job
    // reading its own exit code would call an empty catalog a success.
    if (!stats.rows || stats.looksUnlicensed) process.exitCode = 2;
  } finally {
    await session.close();
  }
}

const main = flag('login') ? login : flag('manufacturers') ? manufacturers : run;
main().catch((err) => {
  console.error(`\n  pCon sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
