# Following RosetSoft upstream

VETA's engines were extracted from RosetSoft (the reference implementation),
which keeps evolving in production. Until the Phase-3.5 cutover (RosetSoft
consuming VETA's API), relevant engine changes land there FIRST and are ported
here. This file is the process; `UPSTREAM.json` is the state.

## The loop

1. In a RosetSoft clone: `node scripts/upstream-diff.mjs <rosetsoft-path>`
   (from this repo's root). It lists upstream commits since the recorded
   baseline that touch the WATCHED paths, newest last.
2. Triage each commit by its body (RosetSoft commit messages carry the spec):
   - **Engine/money/data law** → port it, with its test pins, into the owning
     package (the watched-path → package map is in `UPSTREAM.json`).
   - **Presentation/chrome** (scrollbars, panes, dashboard layout) → skip;
     VETA's apps own their own chrome. Record the skip.
   - **RosetSoft-business** (quotes/WhatsApp/JARVIS wiring) → skip; that layer
     stays in RosetSoft by design.
3. Port with the extraction discipline: behavior-preserving, upstream test
   pins carried over, one signal per package.
4. Update `UPSTREAM.json`: new `baseline`, and append the ported/skipped
   commit lists to the log. Commit the sync as ONE commit per sweep
   (`upstream sync: <baseline-short>..<new-short>`).

## Standing divergences (deliberate, do not "fix" back)

- Grade tables live in ONE SkuGrammar adapter here vs three mirrored files
  upstream.
- The appearance pipeline is ONE implementation here vs three upstream.
- PostgREST's 1,000-row cap (upstream commit 17d3cc4) does not apply to the
  API's pg reads — but DOES apply to any member-plane supabase-js read the
  studio/admin store adapters make: page them when they go live.
- `vetaMeshV` is the stamp key (legacy `alcoverMeshV` accepted on read).
- 'base' stays the internal role token whatever the UI calls it («Cuerpo») —
  same rule upstream established in 817a768/17f8fff.
