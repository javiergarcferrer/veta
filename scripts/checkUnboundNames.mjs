#!/usr/bin/env node
/**
 * UNBOUND NAMES — the pass that keeps `ReferenceError` off the dealer's screen.
 *
 * The root tsconfig runs `checkJs:false` on purpose (the TS migration is
 * incremental), but "not typechecked" also means "not SCOPE-checked": a free
 * identifier in a `.jsx` is left as a global read by esbuild, so it BUILDS,
 * deploys, and throws on first render. Two of those shipped in two days —
 * `newId is not defined` (Edge Functions, 2026-08-16) and «Can't find variable:
 * models» on the Configurador (2026-08-17) — and the two tsconfigs exist to
 * catch the shape. This script is the runner for both.
 *
 * It exists as a FILE rather than the shell one-liner it replaces because that
 * one-liner could not fail. It was:
 *
 *   tsc -p cfg --noEmit 2>&1 | grep -E 'TS2304|TS2552' && echo ... && exit 1 \
 *                                                       || echo 'no unbound names'
 *
 * `2>&1 |` hands tsc's own death to `grep` as ordinary text. `sh: tsc: not
 * found` matches neither code, grep exits 1, and the `||` branch prints «no
 * unbound names» and exits 0. A tree with no install, a tsc that OOMs, a
 * renamed tsconfig — all of them reported GREEN, which is the failure the CI
 * workflow already names for migrationOrder: a guard that reports green because
 * it CAN'T SEE is worse than no guard. This one reports what it measured.
 *
 * Three things must hold before a clean sweep is allowed to mean anything:
 *   1. tsc came from the PINNED install, not from whatever is on $PATH. (In the
 *      container where this was written `node_modules` was empty and the old
 *      script quietly graded the tree with a global tsc of a different version.)
 *   2. tsc RAN — exit 0 (no diagnostics) or 2 (diagnostics present, which is the
 *      normal state here: `checkJs` surfaces migration noise we deliberately
 *      ignore). Anything else is a pass that did not happen.
 *   3. tsc actually READ our code — `--listFiles` rides along on the same pass,
 *      and we require at least one file under the project's own root. An
 *      `include` that stopped matching is the other way a guard goes hollow.
 *
 * Only then is the output grepped, and for BOTH codes: tsc downgrades TS2304 to
 * TS2552 («Cannot find name 'modelz'. Did you mean 'models'?») the moment the
 * free identifier RESEMBLES one in scope — which is exactly how one gets
 * written, so TS2304 alone would miss the common case.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The two halves of the app. `root` is what "it read our code" means here. */
export const PROJECTS = {
  names: { config: 'tsconfig.names.json', root: 'src', label: 'src' },
  functions: {
    config: 'tsconfig.functions.json',
    root: path.join('supabase', 'functions'),
    label: 'supabase/functions',
  },
};

/** tsc's contract: 0 = nothing to say, 2 = diagnostics present. Both are runs. */
const RAN = new Set([0, 2]);
const UNBOUND = /\bTS(2304|2552)\b/;

/**
 * The whole decision, as a pure function of what the spawn returned — so the
 * vacuity modes above are pinned by a test instead of by a live broken tree.
 * `lines` is tsc's combined output; `root` the directory it had to have read.
 */
export function verdict({ error, status, lines, root, label }) {
  if (error) {
    return { ok: false, message: `no se pudo ejecutar tsc para ${label}: ${error}` };
  }
  if (!RAN.has(status)) {
    return { ok: false, message: `tsc salió con ${status} en ${label} — el chequeo no llegó a correr` };
  }

  // `--listFiles` prints bare paths; diagnostics carry `(l,c): error TS…`, and
  // their detail lines are indented. Partition on that, then insist the sweep
  // touched the half it was pointed at.
  const findings = [];
  let sawOwnCode = false;
  for (const line of lines) {
    if (!line || /^\s/.test(line)) continue;
    if (/\(\d+,\d+\): (error|warning) TS\d+:/.test(line)) {
      if (UNBOUND.test(line)) findings.push(line);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line) && line.includes(`${path.sep}${root}${path.sep}`)) {
      sawOwnCode = true;
    }
  }

  if (!sawOwnCode) {
    return { ok: false, message: `tsc no leyó ningún archivo de ${label} — el include dejó de encontrar código` };
  }
  if (findings.length) {
    return { ok: false, findings, message: `NOMBRES LIBRES en ${label} (${findings.length})` };
  }
  return { ok: true, message: `${label}: sin nombres libres` };
}

function run(which) {
  const project = PROJECTS[which];
  if (!project) {
    console.error(`checkUnboundNames: proyecto desconocido «${which}» (usa: ${Object.keys(PROJECTS).join(', ')})`);
    return 1;
  }

  let tsc;
  try {
    tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  } catch {
    console.error('checkUnboundNames: falta el typescript del lockfile — corre `npm ci`.');
    return 1;
  }

  const out = spawnSync(
    process.execPath,
    [tsc, '-p', project.config, '--noEmit', '--pretty', 'false', '--listFiles'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );

  const v = verdict({
    error: out.error?.message,
    status: out.status,
    lines: `${out.stdout || ''}${out.stderr || ''}`.split('\n'),
    root: project.root,
    label: project.label,
  });

  if (v.findings) for (const f of v.findings) console.error(f);
  console[v.ok ? 'log' : 'error'](v.message);
  return v.ok ? 0 : 1;
}

// Importable for the test; only the CLI invocation exits the process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv[2]));
}
