# The harness — every file that shapes a Claude session

VETA is worked on almost entirely by Claude Code sessions, each starting cold in
a fresh container. The people who would normally carry a codebase's context —
the senior who knows why, the reviewer who catches drift, the ops hand who
reconciles the branch before building — are not there. The harness is what
stands in for them: **every file that changes what a session does before it has
read a line of product code.** This page is its index and its load order,
ported from RosetSoft's on 2026-09-02 and pinned by `tests/harness.test.js`,
which reads the inventory below and fails when a listed file is gone, a hook is
unregistered, or `CLAUDE.md` outgrows its job.

The rule for reading it: **a file only shapes a session if the session actually
loads it.** So the inventory is ordered by *how* a file reaches the model,
because that decides whether a rule written there is a rule or a wish.

---

## 0. The bar

A session must be able to start cold, on a shared `main`, and finish a change
that is correct under the seven lenses with no human in the loop except the
owner reading a three-line report on a phone. Concretely, every session, without
being asked:

1. **The toolchain exists** before the first signal runs.
2. **The ground is current** — `origin/main` fetched, the migration high-water
   mark and the last upstream sync known — before the first edit.
3. **The rules are one hop away** and do not contradict each other.
4. **What is current is distinguishable from what is history.**
5. **A brand-specific need never becomes a code fork** — it is a module set
   (`src/brands/modules`), and `tests/brandBoundary` refuses the branch.
6. **The report is readable by the owner** — short, his words, no repo jargon.

Items 1 and 2 are the SessionStart hook. Item 5 is the strongest part of the
harness (the brand seam and its tests). Item 6 is the Stop hook. Items 3 and 4
are this page's job, and §3 records what it found.

---

## 1. Load tiers — how a file reaches the model

| Tier | Mechanism | What it means for a rule written there |
|---|---|---|
| **T0 · always, outside the repo** | The Claude Code system prompt, the owner's user preferences, the session's own instructions (branch, attribution). | Cannot be edited here. Anything in the repo that contradicts T0 loses silently. |
| **T1 · auto-loaded every session** | Root `CLAUDE.md` (injected whole); `.claude/settings.json` (hooks run before the first turn). | These are the rules. Their COST is paid every turn, so length here is the harness's scarcest budget. |
| **T2 · loaded on a named trigger** | `README.md` and the `docs/` rule pages, linked by name from `CLAUDE.md` with a "read before X" trigger. | A rule here holds only if the trigger in T1 is unambiguous and the session obeys it. |
| **T3 · loaded only by accident** | Dated plans, audits, handoffs. VETA has none yet; when one lands it goes under `docs/` with a date in its name and a status line at the top. | History and decisions — *what was decided when*, never a standing instruction. |
| **T4 · machine, not prose** | The fitness tests (`designSystem`, `typeContrast`, `targetSize`, `formLabels`, `notice`, `harness`, `brandBoundary`, `migrationOrder`, `schema`, `brandIsolation`, `modelStudioLayout`, …), the browser harness (`scripts/e2e-carl-hansen-pick.mjs`) and the CI gate (`.github/workflows/ci.yml`). | The only tier that cannot be ignored. A rule that matters lands here; prose in T1/T2 is the explanation of a T4 pin, not a substitute for one. |

---

## 2. Inventory

Every row's first column is a real path and the test checks it exists.

### T1 — auto-loaded

| File | What it changes | Verdict |
|---|---|---|
| `CLAUDE.md` | The fast-start: what VETA is, where the rule pages are, the seven lenses in one screen, the loop, the signal per change type, the hard rules, the report style. | new 2026-09-02 · **ceiling pinned** (≤120 lines, ≤12 KB): growth goes to `docs/`, never here |
| `.claude/settings.json` | Registers the SessionStart and Stop hooks. Tracked, so a web session — which clones fresh — receives it. | new |
| `.claude/hooks/session-start.sh` | Web sessions only: installs `node_modules` if missing, fetches `origin/main`, prints ahead/behind + dirty count, the latest migration filename and the last `upstream sync:` commit. Turns loop step 1 from prose into a mechanism. | new |
| `.claude/hooks/report-lint.mjs` | Stop hook: lints the final message against the report rule (commit hashes, test names, file paths, run numbers, the jargon list — code spans exempt). A hit exits 2 with the tokens as feedback; `stop_hook_active` guards the second pass, so it nudges once and never loops. | new |

VETA carries no skills, agents, commands or workflows yet. When one lands, its
frontmatter `description` is T1 (it is injected into the tool list and decides
when it fires) and its body is T2; `tests/harness.test.js` already validates
the frontmatter of whatever appears under `.claude/skills` and `.claude/agents`.

### T2 — loaded on a named trigger

| File | Trigger in `CLAUDE.md` | What it changes | Verdict |
|---|---|---|---|
| `README.md` | «What is this, how do I run it, where do the money rules live?» | Brands and import modules (DROP vs SOURCE), the commands, the two front doors, the two money rules, the database and brand isolation, following upstream. | keep |
| `docs/design-system.md` | «How must it LOOK / read?» | The perceptual rules VETA inherits from RosetSoft over byte-identical tokens: floors, the closed ladder, numerals, one recipe per job, the notice band, hue, depth, labels, what survives an interruption — and the test behind each. | new (ported) |
| `docs/harness.md` | «What shapes a session?» | This page. | new |

### T4 — the machine

| File | What it pins |
|---|---|
| `.github/workflows/ci.yml` | typecheck → test (with a real Postgres for the schema tests) → build, on `main` and every pull request. |
| `tests/harness.test.js` | This page: every inventoried path exists; the SessionStart hook is registered, tracked, executable and remote-gated; the Stop hook lints the report and honours `stop_hook_active`; any skill/agent has valid frontmatter; `CLAUDE.md` ≤120 lines / ≤12 KB; the root holds no stray markdown; every page `CLAUDE.md` links exists. |
| `tests/designSystem.test.js` · `tests/typeContrast.test.js` · `tests/targetSize.test.js` · `tests/formLabels.test.js` · `tests/notice.test.js` | The design system (see that page's §14). |
| `tests/brandBoundary.test.js` · `tests/brandModules.test.js` · `tests/brandIsolation.test.js` | The brand seam: no brand named in shared code; each module set resolves; RLS hands each user only its brands. |
| `tests/migrationOrder.test.js` · `tests/schema.test.js` | The migration chain builds from zero, idempotently, and agrees with the data layer. |
| `tests/modelStudioLayout.test.js` | The model studio's height chain — the last layout contract that broke silently. |
| `scripts/e2e-carl-hansen-pick.mjs` | The public Carl Hansen picker in a real Chromium, desktop and phone: shelves, faces, counts, «Ver más», search, the ficha's price. Not in `npm test` (needs a browser); `npm run e2e:carl-hansen` after a build. |

---

## 3. What the port found (2026-09-02)

| # | Where | The finding | Done |
|---|---|---|---|
| 1 | The repo root | No `CLAUDE.md` at all: a session started from `README.md`, which explains the product and says nothing about how to work here — the loop, the signals, the report rule were tribal. | `CLAUDE.md` written, ceiling pinned. |
| 2 | `.claude/` | Nothing tracked: no hook could reach a web session, so every one started with no `node_modules` and no fetch. | Settings + two hooks tracked. |
| 3 | `src/` vs `docs/design-system.md` (RosetSoft) | The tokens are byte-identical to upstream (`index.css`, `tailwind.config.js`) but none of the rules were pinned here, and they had drifted exactly as the upstream page predicts: **199** arbitrary px sizes off the ladder (40 of them under the 11px floor), **45** quiet ink tokens on text, **13** hand-typed notice bands (7 with no dark half), **14** re-typed eyebrows, a KPI tile re-implemented beside the primitive, two `<label>`s wrapping a button, one 20px hit target. | Swept to zero and pinned by the five ported tests. The customer's quote page and the plan configurator keep their own surfaces (exempt by ground, listed in the tests). |
| 4 | `/configurador/carl-hansen` | The picker was sixty identical text tiles («CH24 · dining-chairs») under a caption claiming 257: the model list carried nothing but a code. | The page cache lends the face (name, designer, shelf, cover) through the Edge Function; the ViewModel groups by shelf, searches, and reports its truncation as a number; the browser harness measures it. |

---

## 4. Gaps against the bar — ranked

1. **No glossary, no invariants page.** RosetSoft indexes its money/data pins
   and its vocabulary; VETA's pins live only in the tests and in `README.md`'s
   money section. Fine at this size; the day a second person needs "why is X
   written that way" answered in one hop, `docs/invariants.md` with the
   upstream generator (`scripts/invariantsIndex.mjs`) is the port. **Open.**
2. **Upstream drift is measured by hand.** The hook prints the last
   `upstream sync:` commit; nothing compares the shared engine files against
   RosetSoft. A script that diffs the byte-shared modules and lists what moved
   upstream since the last sync would turn a judgement into a list. **Open.**
3. **The browser harness runs by hand.** CI has no Chromium; the picker's e2e
   is a manual gate. A browser job in CI is a one-step addition once the runner
   has a browser. **Open.**
4. **Plans carry no status.** None exist yet; the rule (dated name, status line
   at the top) is written here so the first one lands right. **Pre-empted.**

## 5. Where a new rule goes

| It is… | It goes in… | Because… |
|---|---|---|
| An invariant a diff can break | a **test** (`tests/<module>.test.js` or a fitness test) | T4 is the only tier that cannot be ignored |
| A rule every session needs in its first minute | `CLAUDE.md` — ONE line, linking the page that explains it | T1 is paid every turn; the ceiling is pinned |
| The explanation, the trap, the measured gap | the matching page (`README.md` · `docs/design-system.md` · this page) | T2 is loaded on a trigger, so it can be long |
| A repeatable procedure with a trigger phrase | `.claude/skills/<name>/SKILL.md` | The description IS the trigger; the body is loaded on demand |
| A mechanism a session must run without being asked | `.claude/hooks/` + `.claude/settings.json` | Prose that says «always do X first» is a wish; a hook is a guarantee |
| A decision with a date, a plan, a handoff | `docs/<name>-<date>.md` with a status line | T3 is history; it must look like history |

Never at the repo root, never in chat memory, never in two places without a
parity test welding them.
