# `@veta/render` — server-side render service

Snapshot any saved configuration to a PNG/JPEG at a named camera angle. This is
the Cylindo-shaped gap: PDP imagery, ad creative, e-mail, product feeds — all
generated from the SAME engine the configurator draws with, so an image can
never disagree with what the customer configured.

```
POST /render      job JSON → image bytes        (internal secret required)
GET  /health      liveness + readiness          (no secret)
```

## ⚠️ This service is never public

It sits **behind `apps/api`**. The API authenticates the caller's key, resolves
the org, reads the catalogue under RLS, and only then forwards a fully-resolved
job here over a private network with a shared secret. That is why nothing in
this package knows about tenancy: **a job carries no org because it carries no
query** — every placement, model descriptor, material appearance and render
parameter is already in the payload.

Consequences that are load-bearing, not stylistic:

- The job is **self-contained**, which is what makes a render reproducible: the
  same job JSON renders the same bytes, whatever the catalogue has since become.
- `safeAssetUrl` accepts only `http(s)` and `data:image/` URLs. A headless
  browser that will open `file:` is a headless browser that reads the render
  host's own disk.
- Exposing this port to the internet hands anyone a browser and a URL fetcher.
  The defences here (the secret, the job ceilings, the URL scheme filter) are
  the ones that survive that mistake — they are not a substitute for the network
  boundary.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `RENDER_INTERNAL_SECRET` | — | The shared secret `apps/api` presents in `x-veta-internal-secret`. **Unset ⇒ every `/render` 401s** (fail closed). |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/pw-browsers` | Browsers root. Scanned for `chromium*<rev>/chrome-linux/chrome`; full chromium beats a headless shell, highest revision wins. |
| `VETA_CHROMIUM_PATH` | — | An exact executable, skipping the scan. |
| `VETA_HARNESS_HTML` | `<pkg>/dist/harness.html` | The built harness page. |
| `VETA_RENDER_POOL` | `2` | Concurrent pages. Each owns a WebGL context — chromium caps those. |
| `VETA_RENDER_TIMEOUT_MS` | `60000` | Per-job ceiling inside the page. |
| `VETA_RENDER_CACHE_ENTRIES` / `VETA_RENDER_CACHE_BYTES` | `256` / `256 MB` | LRU bounds (both apply). |
| `VETA_RENDER_MAX_SYNC_PIXELS` | `1600×1600` | Above this the sync endpoint returns 413 — a bigger raster wants a queue, not a longer timeout. |
| `PORT` / `HOST` | `8788` / `0.0.0.0` | |

Build-time only (never needed by a running service):

| Variable | What it does |
|---|---|
| `VETA_ESBUILD` | Module specifier / path to esbuild, for hosts that resolve it elsewhere. |
| `VETA_HARNESS_NODE_PATHS` | Extra module roots (`:`-separated) for the **browser** graph — e.g. a workspace package's `node_modules` carrying `three`. |

`playwright-core` is deliberate: the full `playwright` package downloads a
browser at install time, which a container image must not do. And
`chromium.launch()` with no path resolves the revision *that* playwright build
declares — on a host provisioned by a different version it simply does not
exist. The executable path is therefore the contract, not an escape hatch.

## The browser wall

`src/harness.ts` runs in the page, not in node. `scripts/bundleHarness.ts`
(esbuild, IIFE) inlines it — with three, three's addons and `@veta/scene` —
into `dist/harness.html`, which chromium opens over `file://`; the node side
calls `window.__vetaRender(job)` over CDP. JSON crosses that wall, code does
not, exactly like the monorepo's Deno↔Vite split.

`file://` refuses ES-module `<script src>` (cross-origin by CORS), which is why
the page is one self-contained file with the bundle inlined rather than a page
plus assets.

```bash
pnpm -F @veta/render build:harness      # → dist/harness.html
pnpm -F @veta/render dev                # boot the service
pnpm -F @veta/render typecheck          # the node service (harness excluded)
pnpm -F @veta/render typecheck:harness  # the browser program (needs `three`)
```

`dist/` is generated and git-ignored: a deploy image builds it, a checkout does
not carry ~800 KB of bundled three.

## Angles

`hero` · `front` · `plan` · `threeQuarter` — a table of **numbers**
(`DEFAULT_CAMERA_POSES`), not geometry baked into a renderer. Poses are resolved
against the scene's own MEASURED bounds via `@veta/scene`'s `frameHeight`, and
the fit is aspect-correct on both axes, so the same four entries frame a footstool
and a three-metre sectional. A brand can pass its own table; one job can nudge a
single field with `poseOverride`.

## Idempotence

`cacheKeyOf` is the sha256 of the canonical JSON of the **sanitized** job, plus
`RENDER_ENGINE_VERSION`. Two callers whose payloads differ only in junk the
sanitizer drops hit the same entry; anything that changes the picture changes
the key; and **bumping `RENDER_ENGINE_VERSION` is mandatory** whenever a harness,
pose-table or stage-rig change makes the same job render differently — otherwise
every cache in front of this service keeps serving last month's framing.

## Not built yet (deliberately)

- **Turntable frames / async jobs.** `MAX_SYNC_PIXELS` refuses a print-size
  raster rather than blocking a page on it; the queue that should own those (and
  N-frame turntables) is its own work package.
- **Golden-image tests.** The E2E pins format, size, determinism and
  angle-to-angle difference. Pixel goldens need a pinned GPU stack — the same
  scene renders differently on swiftshader and on a real driver — so they belong
  with a fixed render image, not in a portable suite.
- **Non-glTF meshes.** The bundle carries `GLTFLoader` only (the publish pipeline
  emits GLB). Another format takes the placeholder and says so in `warnings`.
