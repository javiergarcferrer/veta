/**
 * THE HARNESS BUNDLER — `src/harness.ts` + `src/harness.html` → `dist/harness.html`.
 *
 * The harness is TypeScript that imports three, three's addons and `@veta/scene`
 * (whose packages are themselves TS source, resolved through pnpm's workspace
 * links). A browser can execute none of that, and `file://` refuses module
 * scripts outright, so exactly one build step exists: esbuild flattens the
 * whole graph into ONE classic IIFE and it is INLINED into the page.
 *
 * ESBUILD IS OPTIONAL AT RUNTIME, ON PURPOSE.
 * It is a build-time input, not a service dependency: a render host that ships
 * a prebuilt `dist/harness.html` never needs it, and the pure half of this
 * package (jobs, cache key, routing) must stay testable without it. So it is
 * imported through a RUNTIME specifier — which also means `tsc` doesn't demand
 * the types — and a missing install produces one clearly-coded error that the
 * tests skip loudly on instead of a red signal nobody can act on.
 *
 * Resolution knobs (both optional, both documented in README.md):
 *   VETA_ESBUILD             — module specifier / absolute path to esbuild.
 *   VETA_HARNESS_NODE_PATHS  — extra module roots (`:`-separated) for the
 *                              browser graph, e.g. a workspace package's own
 *                              `node_modules` that carries `three`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/render`. */
export const PACKAGE_ROOT = resolve(HERE, '..');
/** Where the marker in `harness.html` is replaced by the bundle. */
export const BUNDLE_MARKER = '/*VETA_HARNESS_BUNDLE*/';
export const DEFAULT_OUT_DIR = join(PACKAGE_ROOT, 'dist');
export const HARNESS_HTML_NAME = 'harness.html';

/** Why a bundle could not be produced — machine-readable so tests can skip. */
export type BundleFailureCode = 'esbuild-missing' | 'build-failed' | 'template-missing';

export class HarnessBundleError extends Error {
  readonly code: BundleFailureCode;
  constructor(code: BundleFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarnessBundleError';
    this.code = code;
  }
}

export interface BundleOptions {
  outDir?: string;
  /** Extra module roots for resolving the BROWSER graph (three, addons). */
  nodePaths?: string[];
  minify?: boolean;
  /** Injected in tests; production resolves the real module. */
  esbuild?: EsbuildLike | null;
}

/** The sliver of esbuild's JS API this script uses. */
export interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>;
}

export interface BundleResult {
  /** Absolute path of the written page. */
  htmlPath: string;
  /** Size of the inlined script, bytes. */
  scriptBytes: number;
  /** Size of the written page, bytes. */
  htmlBytes: number;
}

/** Module roots to hand esbuild, from the option or the documented env var. */
export function resolveNodePaths(explicit?: string[]): string[] {
  if (explicit?.length) return explicit;
  const env = process.env.VETA_HARNESS_NODE_PATHS;
  return env ? env.split(delimiter).map((p) => p.trim()).filter(Boolean) : [];
}

/**
 * Load esbuild, or say precisely why not.
 *
 * The specifier is a VARIABLE so the module is resolved at call time, never at
 * import time — this file must be importable (and typecheckable) in a checkout
 * where esbuild was never installed.
 */
export async function loadEsbuild(): Promise<EsbuildLike> {
  const specifier = process.env.VETA_ESBUILD?.trim() || 'esbuild';
  try {
    const mod = await import(specifier);
    const api = (mod?.default ?? mod) as EsbuildLike;
    if (typeof api?.build !== 'function') {
      throw new Error(`module '${specifier}' has no build()`);
    }
    return api;
  } catch (cause) {
    throw new HarnessBundleError(
      'esbuild-missing',
      `esbuild is not installed (tried '${specifier}'). ` +
      'Add it to apps/render devDependencies and install, or point VETA_ESBUILD at a copy.',
      { cause },
    );
  }
}

/**
 * A script body → something safe to sit between `<script>` tags.
 *
 * An HTML parser closes a classic script at the literal `</script`, wherever it
 * appears — inside a string, inside a regex, anywhere. Bundled three has such
 * strings. Escaping the slash keeps the JS identical and the parser out of it;
 * `<!--` gets the same treatment (it opens an HTML-comment-like token that the
 * old script grammar still honours).
 */
export function escapeForInlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** Template + bundle → the finished page. Pure, so it is unit-testable. */
export function inlineBundle(template: string, js: string): string {
  if (!template.includes(BUNDLE_MARKER)) {
    throw new HarnessBundleError('template-missing', `harness.html has no ${BUNDLE_MARKER} marker`);
  }
  return template.replace(BUNDLE_MARKER, () => escapeForInlineScript(js));
}

/**
 * Build the harness page. Throws `HarnessBundleError` and nothing else — the
 * caller (a test, a deploy step) branches on `.code`.
 */
export async function bundleHarness(options: BundleOptions = {}): Promise<BundleResult> {
  const esbuild = options.esbuild ?? await loadEsbuild();
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const templatePath = join(PACKAGE_ROOT, 'src', HARNESS_HTML_NAME);

  let template: string;
  try {
    template = await readFile(templatePath, 'utf8');
  } catch (cause) {
    throw new HarnessBundleError('template-missing', `cannot read ${templatePath}`, { cause });
  }

  let js: string;
  try {
    const result = await esbuild.build({
      absWorkingDir: PACKAGE_ROOT,
      entryPoints: [join(PACKAGE_ROOT, 'src', 'harness.ts')],
      bundle: true,
      // CLASSIC script, not a module: `file://` blocks `type="module"` as
      // cross-origin, and there is no server to serve it from.
      format: 'iife',
      platform: 'browser',
      // The pool runs the chromium playwright ships; nothing older ever loads
      // this page, so no transpilation tax is paid for browsers we never see.
      target: ['chrome120'],
      minify: options.minify ?? true,
      sourcemap: false,
      legalComments: 'none',
      write: false,
      nodePaths: resolveNodePaths(options.nodePaths),
      define: { 'process.env.NODE_ENV': '"production"' },
      // Workspace packages export `./src/index.ts` directly.
      resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
      conditions: ['import', 'default'],
      logLevel: 'silent',
    });
    js = result.outputFiles?.[0]?.text ?? '';
    if (!js) throw new Error('esbuild produced no output');
  } catch (cause) {
    if (cause instanceof HarnessBundleError) throw cause;
    throw new HarnessBundleError('build-failed', `harness bundle failed: ${(cause as Error).message}`, { cause });
  }

  const html = inlineBundle(template, js);
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, HARNESS_HTML_NAME);
  await writeFile(htmlPath, html, 'utf8');
  return { htmlPath, scriptBytes: Buffer.byteLength(js), htmlBytes: Buffer.byteLength(html) };
}

// CLI: `node --import tsx scripts/bundleHarness.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bundleHarness()
    .then((r) => {
      console.log(`[veta-render] harness → ${r.htmlPath} (${(r.htmlBytes / 1024).toFixed(0)} KB)`);
    })
    .catch((err) => {
      console.error(`[veta-render] ${(err as Error).message}`);
      process.exit(1);
    });
}
