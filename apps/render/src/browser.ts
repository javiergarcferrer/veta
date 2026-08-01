/**
 * THE BROWSER PLANE — one chromium, a small pool of pages, one image per call.
 *
 * ENV CONTRACT (all optional; the defaults are this sandbox's own layout):
 *   PLAYWRIGHT_BROWSERS_PATH  Browsers root. Default `/opt/pw-browsers`.
 *                             Scanned for `chromium*<rev>/chrome-linux/chrome`,
 *                             highest revision wins.
 *   VETA_CHROMIUM_PATH        An exact executable, skipping the scan. Set this
 *                             on any host whose layout is not playwright's.
 *   VETA_HARNESS_HTML         The built harness page. Default
 *                             `<pkg>/dist/harness.html` (see scripts/bundleHarness.ts).
 *   VETA_RENDER_POOL          Concurrent pages. Default 2.
 *   VETA_RENDER_TIMEOUT_MS    Per-job ceiling inside the page. Default 60000.
 *
 * WHY playwright-core AND AN EXPLICIT PATH: `playwright` (the full package)
 * downloads a browser at install time, which a container image must not do; and
 * `chromium.launch()` with no path resolves the revision THIS playwright build
 * declares, which on a host provisioned by a different version simply doesn't
 * exist. The path is therefore the contract, not an escape hatch.
 *
 * ONE BROWSER, N PAGES. A chromium process costs ~100 MB and several seconds to
 * boot; a page costs a tab. But a page also owns a WebGL context, and contexts
 * are the scarce resource (chromium caps them and silently kills the oldest), so
 * the pool is deliberately small and pages are REUSED — the harness keeps its
 * renderer alive across jobs, so the second render on a page is an order of
 * magnitude cheaper than the first.
 */

import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

import type { RenderJob } from './jobs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

export const DEFAULT_BROWSERS_PATH = '/opt/pw-browsers';
export const DEFAULT_POOL_SIZE = 2;
export const DEFAULT_JOB_TIMEOUT_MS = 60_000;

/** What the harness answers (mirrors `HarnessResult` across the CDP wire). */
export interface HarnessResult {
  ok: boolean;
  dataUrl?: string;
  width: number;
  height: number;
  warnings: string[];
  ms: number;
  error?: string;
}

export interface RenderOutput {
  image: Buffer;
  contentType: 'image/png' | 'image/jpeg';
  warnings: string[];
  /** True when the data-URL path failed and the clipped screenshot saved it. */
  usedScreenshotFallback: boolean;
  ms: number;
}

export class RenderUnavailableError extends Error {
  readonly code: 'chromium-missing' | 'harness-missing';
  constructor(code: 'chromium-missing' | 'harness-missing', message: string) {
    super(message);
    this.name = 'RenderUnavailableError';
    this.code = code;
  }
}

export class RenderFailedError extends Error {
  readonly warnings: string[];
  constructor(message: string, warnings: string[] = []) {
    super(message);
    this.name = 'RenderFailedError';
    this.warnings = warnings;
  }
}

// ── Finding chromium ────────────────────────────────────────────────────────

/** Executable layouts playwright writes, in the order they are tried. */
const EXECUTABLE_SUFFIXES = [
  join('chrome-linux', 'chrome'),
  join('chrome-linux', 'headless_shell'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-win', 'chrome.exe'),
];

/** `chromium-1194` → 1194; a name with no revision sorts last. */
function revisionOf(dir: string): number {
  const m = /(\d+)$/.exec(dir);
  return m ? Number(m[1]) : -1;
}

/**
 * The chromium this service will launch, or null.
 *
 * Prefers a FULL chromium over a headless shell: the shell has no swiftshader
 * GL stack on some builds, and a WebGL renderer that silently falls back to a
 * software rasteriser with no GL at all produces a blank canvas rather than an
 * error — the worst possible failure for an image service.
 */
export function findChromiumExecutable(browsersPath?: string): string | null {
  const explicit = process.env.VETA_CHROMIUM_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const root = browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ?? DEFAULT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;

  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch { return null; }

  const ranked = entries
    .filter((name) => name.startsWith('chromium'))
    .sort((a, b) => {
      const shellA = a.includes('headless_shell') ? 1 : 0;
      const shellB = b.includes('headless_shell') ? 1 : 0;
      if (shellA !== shellB) return shellA - shellB;      // full chromium first
      return revisionOf(b) - revisionOf(a);               // newest revision first
    });

  for (const name of ranked) {
    for (const suffix of EXECUTABLE_SUFFIXES) {
      const candidate = join(root, name, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Where the built harness page lives. */
export function harnessHtmlPath(): string {
  return process.env.VETA_HARNESS_HTML?.trim() || join(PACKAGE_ROOT, 'dist', 'harness.html');
}

/**
 * Launch flags. Every one is load-bearing for headless GL in a container:
 * swiftshader supplies the GL stack (no GPU exists), the sandbox flags are what
 * let chromium run as root in an image, and `/dev/shm` is tiny in most
 * containers — leaving it on is the classic silent tab crash.
 */
export const LAUNCH_ARGS: readonly string[] = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-color-profile=srgb',
]);

// ── The pool ────────────────────────────────────────────────────────────────

export interface BrowserPoolOptions {
  poolSize?: number;
  executablePath?: string | null;
  harnessPath?: string;
  jobTimeoutMs?: number;
}

interface Slot {
  page: Page;
  /** Renders served — used only for diagnostics. */
  jobs: number;
}

/**
 * A shared chromium plus a fixed set of harness pages, handed out one job at a
 * time. Everything is LAZY: importing this module launches nothing, so the pure
 * tests, the health check and a misconfigured host all cost zero browsers.
 */
export class BrowserPool {
  private readonly poolSize: number;
  private readonly jobTimeoutMs: number;
  private readonly harnessPath: string;
  private readonly explicitExecutable: string | null;

  private browser: Browser | null = null;
  private booting: Promise<Browser> | null = null;
  private idle: Slot[] = [];
  private created = 0;
  private waiters: ((slot: Slot) => void)[] = [];
  private closed = false;
  private harnessUrl: string | null = null;

  constructor(options: BrowserPoolOptions = {}) {
    this.poolSize = Math.max(1, Number(options.poolSize ?? process.env.VETA_RENDER_POOL ?? DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE);
    this.jobTimeoutMs = Math.max(1000, Number(options.jobTimeoutMs ?? process.env.VETA_RENDER_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS) || DEFAULT_JOB_TIMEOUT_MS);
    this.harnessPath = options.harnessPath ?? harnessHtmlPath();
    this.explicitExecutable = options.executablePath ?? null;
  }

  /** Whether a render could even be attempted — the health check's real answer. */
  async available(): Promise<{ ok: boolean; reason?: string }> {
    const exe = this.explicitExecutable ?? findChromiumExecutable();
    if (!exe) return { ok: false, reason: 'chromium-missing' };
    if (!existsSync(this.harnessPath)) return { ok: false, reason: 'harness-missing' };
    return { ok: true };
  }

  private async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const executablePath = this.explicitExecutable ?? findChromiumExecutable();
      if (!executablePath) {
        throw new RenderUnavailableError(
          'chromium-missing',
          `no chromium under ${process.env.PLAYWRIGHT_BROWSERS_PATH ?? DEFAULT_BROWSERS_PATH} (set VETA_CHROMIUM_PATH)`,
        );
      }
      if (!existsSync(this.harnessPath)) {
        throw new RenderUnavailableError(
          'harness-missing',
          `harness page not built: ${this.harnessPath} (run scripts/bundleHarness.ts)`,
        );
      }
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [...LAUNCH_ARGS],
      });
      // A browser that dies (OOM, a driver fault) must not strand the pool
      // holding a corpse: drop everything so the next job boots a fresh one.
      browser.on('disconnected', () => {
        if (this.browser === browser) {
          this.browser = null;
          this.idle = [];
          this.created = 0;
        }
      });
      this.browser = browser;
      return browser;
    })().finally(() => { this.booting = null; });
    return this.booting;
  }

  /**
   * A harness page, loaded and ready.
   *
   * `__vetaHarnessReady` is what is waited on, not `load`: the bundle is inline,
   * so the document can be "loaded" a tick before the IIFE has installed the
   * function, and evaluating too early reads `undefined is not a function` on a
   * page that is about to be perfectly fine.
   */
  private async newSlot(): Promise<Slot> {
    const browser = await this.launch();
    if (!this.harnessUrl) this.harnessUrl = pathToFileURL(this.harnessPath).href;
    const page = await browser.newPage();
    page.setDefaultTimeout(this.jobTimeoutMs);
    await page.goto(this.harnessUrl, { waitUntil: 'load' });
    await page.waitForFunction('window.__vetaHarnessReady === true', undefined, { timeout: this.jobTimeoutMs });
    return { page, jobs: 0 };
  }

  private async acquire(): Promise<Slot> {
    if (this.closed) throw new RenderFailedError('pool_closed');
    const free = this.idle.pop();
    if (free) return free;
    if (this.created < this.poolSize) {
      this.created += 1;
      try {
        return await this.newSlot();
      } catch (err) {
        this.created -= 1;
        throw err;
      }
    }
    return new Promise<Slot>((res) => { this.waiters.push(res); });
  }

  private release(slot: Slot): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(slot);
    else this.idle.push(slot);
  }

  /** A page that failed is not recycled — it is replaced, so one bad job can't poison the pool. */
  private async discard(slot: Slot): Promise<void> {
    this.created -= 1;
    try { await slot.page.close(); } catch { /* already gone */ }
    // Anyone queued behind this slot gets a fresh one rather than waiting for
    // the next completion.
    if (this.waiters.length) {
      this.created += 1;
      try {
        const fresh = await this.newSlot();
        const waiter = this.waiters.shift();
        if (waiter) waiter(fresh);
        else this.idle.push(fresh);
      } catch {
        this.created -= 1;
      }
    }
  }

  /** One sanitized job → its image bytes. */
  async render(job: RenderJob): Promise<RenderOutput> {
    const slot = await this.acquire();
    let healthy = true;
    try {
      const { width, height } = job.size;
      await slot.page.setViewportSize({ width, height });
      const result = (await slot.page.evaluate(
        (j) => (window as unknown as { __vetaRender: (job: unknown) => Promise<HarnessResult> }).__vetaRender(j),
        job as unknown,
      )) as HarnessResult;

      if (!result?.ok) {
        throw new RenderFailedError(result?.error || 'harness_failed', result?.warnings ?? []);
      }

      const contentType = job.format === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const;
      const decoded = decodeDataUrl(result.dataUrl);
      if (decoded && decoded.length > 0) {
        slot.jobs += 1;
        return { image: decoded, contentType, warnings: result.warnings ?? [], usedScreenshotFallback: false, ms: result.ms };
      }

      // FALLBACK. `toDataURL` can return an empty string when a driver refuses
      // to read back the drawing buffer — the frame IS drawn, it just can't be
      // serialized from inside the page. The canvas is in the DOM at 0,0 at
      // exactly the job's size, so a clipped screenshot is the same pixels by
      // another road. Worth having: without it that driver means no image at all.
      const shot = await slot.page.screenshot({
        clip: { x: 0, y: 0, width, height },
        type: job.format === 'jpeg' ? 'jpeg' : 'png',
        ...(job.format === 'jpeg' ? { quality: Math.round(job.quality * 100) } : {}),
        omitBackground: job.transparent && job.format === 'png',
      });
      slot.jobs += 1;
      return {
        image: Buffer.from(shot),
        contentType,
        warnings: [...(result.warnings ?? []), 'dataurl_unavailable'],
        usedScreenshotFallback: true,
        ms: result.ms,
      };
    } catch (err) {
      healthy = false;
      await this.discard(slot);
      if (err instanceof RenderFailedError || err instanceof RenderUnavailableError) throw err;
      throw new RenderFailedError((err as Error).message || 'render_failed');
    } finally {
      // A discarded slot was already replaced by `discard`; only a healthy page
      // goes back into rotation.
      if (healthy && !this.closed) this.release(slot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.idle = [];
    this.waiters = [];
    this.created = 0;
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => { /* already gone */ });
  }
}

/** `data:image/png;base64,…` → bytes, or null when the string isn't one. */
export function decodeDataUrl(dataUrl: string | null | undefined): Buffer | null {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:')) return null;
  const meta = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  if (!body) return null;
  try {
    return meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'binary');
  } catch {
    return null;
  }
}

/** The PNG signature. A render that produced *something* still has to be a PNG. */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Buffer | null | undefined): boolean {
  return !!buf && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

export function isJpeg(buf: Buffer | null | undefined): boolean {
  return !!buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
