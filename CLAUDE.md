# VETA — agent bootstrap

A configurator for modular furniture served to a manufacturer's dealers and their customers, plus
the back office that feeds it: model library, material catalog, dealer network, lead inbox, quotes.
ONE deploy serves MANY BRANDS: a brand is an isolated environment (its own models, materials,
dealers, leads, price list) that names which **import modules** read its files (`src/brands/modules`,
resolved by id at runtime). VETA's engines were extracted from **RosetSoft** and are ported back in
`upstream sync:` commits; presentation and RosetSoft's business layers stay there. React/Vite/Supabase.

- **What is this, how do I run it, where do the money rules live?** → `README.md`.
- **How must it LOOK / read?** → `docs/design-system.md` (type ladder, numerals, the notice band,
  bound labels, hit targets, depth — each rule with the test that keeps it).
- **What shapes a session, and where does a new rule go?** → `docs/harness.md`.

## The seven lenses — ask BEFORE the first line, name one in the report only if it changed the diff
1. **Scalability** — what breaks at 100× the rows? A read is bounded or paged, never neither
   (PostgREST stops at 1000 and returns SUCCESS — `_shared/readAllPages.ts`); a truncation says so.
2. **Cognitive ergonomics** — what must the reader hold in their head? All of `docs/design-system.md`.
3. **Semantic heuristics** — does the name predict the behaviour? A name that lies is worse than none.
4. **Information architecture** — findable without knowing it exists? Every route is OFFERED somewhere.
5. **Queuing** — what happens to work arriving while this is busy? Idempotent retries; say what you dropped.
6. **Resilience** — what does this do when its dependency is down, and does it TELL THE TRUTH?
   Degrade, never blank; bad input → `null`, never a plausible wrong number.
7. **Ontological** — is this word already taken? One concept, one home, one name; never invent a fact
   the domain does not have (a model nobody swept shows its code, not a guessed name).

## The loop
1. **Reconcile** — the SessionStart hook fetched `origin/main` and printed ahead/behind; read it.
2. **Act** — find the root cause yourself; smallest diff that can move the signal.
3. **Verify** — run the ONE signal for this change (below) AND pass the diff through the seven lenses.
   Red → fix and re-run the SAME signal; never report done on red, never relax the verifier.
4. **Ship** — commit and push the session's branch (`git push -u origin <branch>`); `main` deploys.
5. **Report** — outcome + signal state, no play-by-play.

## Signals — match the signal to the change
`npm run typecheck` (tsc + unbound-name sweeps over src AND the Deno functions) · `npm test` (the
suite; the two DB tests need `VETA_TEST_PG`, skip without it, FAIL under CI) · `npm run build` ·
`npm run e2e:carl-hansen` (Chromium, after a build — the public picker end to end, with screenshots
under `SHOTS=<dir>`). UI only → typecheck + build + the design tests (they are in `npm test`);
a logic module (`src/lib|core|db`, `supabase/functions/*`) → its same-named test; every push → CI
runs typecheck → test → build. An invariant worth keeping goes in a TEST, never in chat memory.

## Hard rules
- **MVVM**: Model (`src/lib/*`, pure) → ViewModel (`resolveX` in `src/core/*`, pure, no React/db) →
  View (fetch, UI state, render). A new derivation is a `resolveX` on a barrel, never math in a View.
- **A brand is a module set, never a branch in shared code**: SKU grammar, grade ladder, swatch source
  come from `activeCatalogModule()`; `if (brand === 'x')` in shared code is a bug (`tests/brandBoundary`).
- **Deno ↔ Vite is a hard wall**: `src/*` and `supabase/functions/*` never import each other; a rule
  needed on both sides lives at both, parity-pinned by a test.
- **Public surfaces read through an Edge Function on the service role** (`togo-embed`, `carl-hansen`,
  `fredericia-embed`); an anon client gets nothing from PostgREST. No cost, margin or dealer identity
  crosses to a public widget. A price that does not resolve prices NOTHING — never interpolate.
- **Money**: modo pieza XOR modo componentes, never both; a quote is FROZEN by a DB trigger — a wrong
  quote is superseded, never edited (`README.md` → Where the money rules live).
- **Migrations**: `YYYYMMDDHHMMSS_desc.sql` timestamped later than EVERY existing file, additive and
  idempotent, ending `notify pgrst, 'reload schema';` (`tests/migrationOrder`, `tests/schema`).
- **Design system** — `docs/design-system.md`, pinned by `tests/designSystem`, `typeContrast`,
  `targetSize`, `formLabels`, `notice`. The ones that bite: the type ladder is CLOSED (`text-[Npx]`
  fails); text starts at ink-500; a tinted band is `<Notice>`, never hand-typed; a caption over a
  control is a `<label>` that WRAPS it; a figure read as a set is `.num`, an identifier `.code`;
  depth off the warm ladder (xs · sm · soft · md · pop); a truncation is a NUMBER, never a silence.
- **Upstream**: each port is one commit `upstream sync: <from>..<to>` naming what was ported and what
  was skipped. Permanent divergences (the brand seam) are not "fixed" back.
- **Stay in your diff** — surface pre-existing bugs, don't fold them in. "It's a cache issue" is a
  banned diagnosis. Diagnose once, act once; reply in the owner's language, code in English.
- **Report SHORT, in the OWNER'S words.** Javier reads every reply, often on a phone, and prefers
  succinctness. Bullets, numbers over adjectives; what he can DO now, what is in progress, what you
  need from him. No commit hashes, test names, file paths or repo jargon in chat — the Stop hook
  (`.claude/hooks/report-lint.mjs`) bounces a reply that carries them. That prose belongs in the
  commit message, which is read once on purpose.
