# VETA

Multi-brand 3D product configurator platform: engine packages, authoring
studio, embeddable widget SDK, and a tenant-aware API — for furniture first,
and material-driven products (flooring, stone, finishes) after that.

- `docs/platform-action-plan.md` — the phased build plan (vision → work packages).
- `CONTRACTS.md` — inter-package export contracts and layering rules.
- `packages/` — pure engines (geometry, mesh-pipeline, materials, layout, scene).
- `apps/` — api, studio, widget, admin, render (arrive in later phases).

Workspace: pnpm + TypeScript. `pnpm run check` = typecheck + tests + build.
Packages are consumed as TS source inside the workspace; apps bundle them.
The three.js namespace is dependency-injected into engine code (never a static
value import in `packages/*/src`) so engines stay code-split and testable.
