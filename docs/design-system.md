# The VETA design system

VETA inherits RosetSoft's design system whole: `src/index.css` and
`tailwind.config.js` are byte-identical to upstream, so every token, primitive
and floor below is the same object here. What was NOT here until 2026-09-02 was
the part that keeps it — the tests — and the drift the upstream page predicts
had already happened (199 arbitrary px sizes off the ladder, 45 quiet tokens on
text, 13 hand-typed notice bands, a KPI tile re-implemented beside the
primitive). The sweep landed with the tests; §15 records it.

A back-office is read under load. The dealer opens it between a customer in the
showroom and a container at the port; they are not studying it, they are
*checking* it. Every rule below exists to make that check cost less attention,
and each one is written as **the perceptual fact → the rule it produces → the
test that keeps it**. Nothing here is taste. Where a value is defended, it was
measured — with fontkit, with a contrast calculation, or against the app's own
surfaces — and the measurement is in the source next to the value. The counts
quoted inside the chapters ("thirteen tiles", "126 bands") are upstream's, kept
because they are the evidence the rule was written on.

- **Tokens** live in `src/index.css` (`:root` / `.dark`) and `tailwind.config.js`.
- **The figure primitives** live in `src/components/quant/Figures.jsx` (View)
  over `src/lib/quant.ts` (Model).
- **The notice band** is `src/components/primitives/Notice.jsx` over `.notice-*`.
- **The rules are executable**: `tests/designSystem.test.js`,
  `tests/typeContrast.test.js`, `tests/targetSize.test.js`,
  `tests/formLabels.test.js`, `tests/notice.test.js`.
- **Charts** (§8) stay upstream: VETA draws none today. The day it does, the
  library (`charts/MiniCharts.jsx`) and its table-twin rule come with them.

---

## 1. The floors are about eyes, not about brand

Human contrast sensitivity peaks around 2–6 cycles per degree and falls off
steeply above it (Campbell & Robson, 1968). Small type and faint type land on
the same falling limb of that curve, so a label that is **both** small and quiet
is penalised twice — which is exactly what dense back-office UI drifts toward,
one "just a caption" at a time.

**Rules**

| | |
|---|---|
| **11px is the floor.** | Nothing renders smaller. One documented exemption: `.eyebrow-xs`, which is all-caps, semibold and letterspaced — uppercase has no x-height penalty, so a tracked 10px cap reads at roughly the size of 13px lowercase. A *second* exemption would mean the floor is wrong; raise the floor instead. |
| **Text starts at ink-500.** | On the app's own surfaces the ink ramp measures ink-300 → 2.13:1, ink-400 → 3.37:1, ink-500 → 4.95:1. ink-500 is the first rung that clears the 4.5:1 of WCAG SC 1.4.3. ink-400 is for **non-text** — icons, hairlines, a null em-dash — where SC 1.4.11's 3:1 applies. |
| **Hit targets are 24px, 44px on a finger.** | SC 2.5.8 sets 24×24; Apple asks 44pt. `.btn` and `.btn-icon` carry `coarse:min-h-11`; a row too tight for visible chrome uses `.btn-icon-sm`, which paints an invisible 24×24 (44×44 coarse) `::before` centred on the glyph. |
| **The floor is universal; the tokens are not.** | Four surfaces ship their own palettes (§8). All four obey these floors. Thirty-six declarations in the ATLAS console skin sat between 8.8px and 10.9px purely because the floor test only ever scanned `text-[Npx]` utilities and never raw CSS — the test reads both now. |

Pinned by `tests/typeContrast.test.js`, `tests/targetSize.test.js`,
`tests/designSystem.test.js`.

---

## 2. A scale step must be tellable apart

Two sizes that read the same give the reader no hierarchy and give the codebase
two values to keep in step. 13px against 14px is a 7% difference — below the
just-noticeable difference for type at reading sizes. It never signalled
anything; it only drifted.

**The ladder is closed. Eight rungs, each with one job:**

```
text-3xl   30   the one hero figure on a page              ▸ Söhne
text-2xl   24   page + quote titles, the KPI figure        ▸ Söhne
text-xl    20   section headline                           ▸ Söhne
text-lg    18   card + dialog titles                       ▸ Söhne
text-base  16   product / entity names                     ▸ Söhne
text-sm    14   running text, table data, controls  ← DEFAULT
text-xs    12   secondary / helper text
text-micro 11   dense numeric, captions, table meta
.eyebrow        small-caps section label (11)              ▸ Söhne
.eyebrow-xs     dense in-component label (10)              ▸ Söhne
```

`text-[Npx]`, `text-[Nrem]` and `text-[Npt]` are **test failures**, not style
choices. `text-[clamp(…)]` is allowed: a figure that must not clip is a
different problem (§5).

Getting here folded **1,602** arbitrary px utilities and **73** rem ones onto
the rungs — and 36 of the rem ones were below the 11px floor, invisible to the
floor test because they were spelled in rem.

**Two faces, two jobs.** Every heading role — Display / Section / Title /
Subtitle / Eyebrow — carries `font-display` (Söhne, one weight: the size and
tracking carry the hierarchy, not the weight). Everything a person reads or
scans — body, table data, form fields, buttons, chips, and every FIGURE — is
Lausanne, which ships the real 400–700 range. So weight contrast lives in
Lausanne and Söhne supplies the editorial header voice on top of it.

**`.eyebrow` is a primitive, not a recipe.** 141 sites had re-typed it by hand
(`text-micro font-semibold uppercase tracking-wide text-ink-500` and four other
near-misses). They are the same class now.

---

## 3. Numerals: a column of figures must line up

Measured with fontkit, in font units: Lausanne's default figures are
**proportional** — `0` is 1245 wide, `1` is 890, `4` is 1175. A "1" is 29%
narrower than a "0", so in an unmarked column of money every row starts its
digits at a different offset and the thousands place stops being a place.
`tnum` sets all ten to 1280 and the column becomes a grid. Both faces ship the
feature, so this is a real substitution and not a no-op the browser drops.

That matters more than it looks. Comparing magnitudes down a column is not
reading — it is a **length judgement** on the digit block, the most accurate
elementary perceptual task there is (Cleveland & McGill, 1984), and one that
costs no working memory. Proportional figures break it: the eye has to parse
each number as a word instead of measuring it as a bar.

**Rules**

- **Structural, not per-call-site.** A `<table>` is a set of figures by
  definition and inherits tabular figures for everything inside it
  (`@layer base`).
- **Numbers read one at a time inside a sentence keep the proportional
  default** — that is what proportional figures are for.
- **Figures outside a table that are still read as a set** — a KPI row, a grid
  of tiles, a totals dock — opt in with `.num`. The quant primitives carry it.
- **`.num-col`** for a numeric table column: right-aligned so the digit places
  stack, tabular so they stack straight. The unit goes in the header, never
  repeated down the rows.
- **`.code`** for an identifier that is not a quantity — NCF/e-CF, RNC,
  container ID, product reference: tabular so codes of one format align, and
  **slashed zero** so `0` can never be read as `O`. These are strings a dealer
  retypes into DGII forms and carrier trackers, where one misread glyph costs a
  filing.
- **`.num-neg`** keeps the minus sign. Colour is a second cue, never the only
  one (§6).
- The minus is **U+2212**, not the hyphen — the hyphen is 24% narrower and
  breaks the column it is supposed to sit in.

---

## 4. One recipe per job, because scanning is only free if shapes repeat

A dealer does not read a KPI row, they scan it. Scanning works because the eye
can compare two shapes in the same position at the same size without spending
attention on either. The moment two tiles differ in label case, figure size or
digit width, that free comparison turns into two separate acts of reading.

Before this system there were **thirteen** label-over-a-number components —
`Kpi` in Atlas, in ConfiguratorOverview, in ConfiguratorActivity; `Stat` in instagram/chrome,
in DealerPanel, in admin/Fredericia; `Metric` in StockCountPanel, in Difusión;
`StatTile` in CustomerContextPanel; `Tile` and `KpiTile` in Análisis 360;
`StatKpi` in Estados; `CycleStage` on the accounting dashboard — with seven
eyebrow recipes, six containers, and **three of them missing `tabular-nums`
entirely**, so their figures did not line up with the identical tile one card
over.

**There is one:**

```jsx
import { Stat, StatGrid, Delta, Num, Unit } from '@/components/quant/Figures.jsx';

<StatGrid cols={4}>
  <Stat label="Comprometido" value={formatDop(total)} hint="12 pedidos"
        icon={Wallet} tint="tint-brand" to="/pedidos"
        delta={d?.pct} goodWhen="up" deltaLabel="vs. mes anterior" />
</StatGrid>
```

- **Four loudness rungs, straight off the type ladder** — `hero`, `kpi`
  (default), `panel`, `dense`. The component invents no sizes of its own.
- **Four chromes, and no fifth** — `card` (the KPI tile), `box` (an outlined
  panel metric), `subtle` (a faint nested fill), `bare`.
- **The icon leads the label**, on one line. The plate qualifies the word; a
  plate parked on the far side of the tile reads as a second object competing
  with the figure below.
- **`h-full` on the card is load-bearing.** A row of cards that end at
  different heights reads as a row of *different things* — the eye takes a
  ragged bottom edge as a grouping cue long before it reads a label.
- **The label leads the figure.** A reader scanning a row needs to know what
  they are looking at before the number, or they read the number twice.

Surfaces with their own vocabulary keep it and adapt: `GlanceStat` (the
accounting band's `items` API), `StatCard`, `Metric`, `StatTile`, `CycleStage`
are all **prop adapters** over `<Stat>` now. That is the allowed shape — a
rename, never a re-implementation.

---

## 5. A figure that can clip is worse than a figure that overflows

`.stat-card` clips (it has to — `overflow-hidden` is what rounds its corner
bloom), so a figure that does not fit is chopped **silently**. "RD$ 110,000.0C"
reads as a number that is not the number.

So money on a tile sizes off **the tile** — a container query (`cqi`, via
`.stat-card`'s `container-type`), never the viewport. Sizing off `vw` inverted
exactly when it mattered: the tiles live inside the content area and the grid
goes to five columns at xl, so the tiles get *narrower* while `vw` reports a
*wider* screen. `<Stat fluid>` is that clamp.

---

## 5b. The notice band, and the two ways a recipe goes missing

The band is the sentence a page needs you to read before you act on what is
under it — "no se pudo leer todo el catálogo", "falta el RNC para el 606", "el
cobro está conciliado con el banco". 126 of them were hand-typed across 62
files and no two agreed: three radii, five paddings, three type sizes, and both
`-700` and `-800` foregrounds *inside the same valence*.

That is §4's rule failing in the one place nobody had written it down. But the
interesting part is **how** it failed, because it failed twice, in two
different ways:

**A recipe that was never written.** Nothing named "the band", so every author
rebuilt it from parts. The fix is the fix §4 always prescribes: one recipe
(`.notice` + `.notice-{info,success,warn,danger}`), one component
(`primitives/Notice.jsx`), and a test that fails when the next one is
hand-typed. Two rungs only — the default, and `.notice-sm` for a band inside
something already tight. Not five paddings' worth of opinion.

**A recipe whose second half was optional.** 59 of the 126 had no `dark:`
anything, so an amber strip meaning *careful* stayed amber-50 on the dark
canvas — the brightest object on the screen. Nobody decided that. It is what
happens when the dark half is a second thing to remember at every call site
rather than a property of the recipe. So the band takes its foreground from
`text-status-{valence}-ink`, a custom property that **swaps with the theme**,
and the dark rule sets only the tint. The call site cannot forget a step that
no longer exists.

That second failure is §6's lesson arriving late. §6 moved 95 *figures* onto
those inks because `text-amber-700` measures ~3:1 in dark mode; the bands were
still spelling valence in the same four raw Tailwind classes, and had been the
whole time. A rule fixed for one kind of object does not travel to the next by
itself.

Measured **on the tint**, not on the page — a band moves the ground out from
under the ink, so the documented figure-on-surface numbers do not apply:

| | light | dark |
|---|---|---|
| `notice-warn` (amber) | 4.84:1 | 9.71:1 |
| `notice-danger` (red) | 5.91:1 | 6.26:1 |
| `notice-success` (emerald) | 5.21:1 | 8.40:1 |
| `notice-info` (sky) | 5.57:1 | 7.33:1 |

All clear 4.5:1, so a band is legal down to the 11px floor its dense variant
allows. `tests/notice.test.js` recomputes all eight rather than trusting this
table.

**The band has a spine.** A 3px left bar in the valence's MARK tone
(`--viz-warning` etc., 3:1 — a bar is a non-text mark under SC 1.4.11, which is
exactly what §6 reserves those tones for). This was decided by screenshot, not
by argument: with a 1px `-200` edge all round, the tint is a 2–4% step off
white and the border barely darker, so the band read as a faint highlight
somebody forgot to delete. The bar is the one high-contrast element in it, so
the band gets weight *and* its valence is legible from the spine before the
pale fill is parsed — which is also what keeps it honest for the ~8% of men who
cannot separate the amber tint from the red one. The mark tones are
theme-invariant, so the spine needs no dark rule; the tint does.

**What is exempt is a different OBJECT, never a different file**: a pill
(`rounded-full` / `inline-flex` — an inline chip in a row), anything
interactive (that is a button), an edge strip (`border-t` with no radius — a
full-bleed band inside a panel), a `ring-1 ring-inset` panel, a `.card`, and
`border-dashed`. Note what is *not* exempt: `rounded-2xl` and a `bg-{hue}-500/x`
dark variant. The first sweep spared those and it was wrong — a bigger radius
does not make a band a different object, it makes it a band that drifted. Seven
were converted by hand rather than left as a hole for the next one to fall in.

---

## 6. Meaning never rides on hue alone

Roughly 8% of men have a red-green colour vision deficiency, and a projector, a
sunlit showroom tablet or a printed page each drop a hue independently. WCAG SC
1.4.1 says the same thing in fewer words.

- **Every delta carries three cues**: an arrow (position/shape), a signed
  number (text), and colour — in that order of importance. The colour is the
  one that can be lost.
- **Status marks and status text are two different tokens.** `--viz-good`
  measures **3.36:1** on the light surface: correct for a dot, a bar or an
  arrowhead under SC 1.4.11's 3:1, and *illegal* for the number beside it,
  which is text and owes 4.5:1. So `text-status-good` paints the mark and
  `text-status-good-ink` paints the figure.
- **The four figure inks are measured on both grounds**: good 5.48:1 light /
  8.66:1 dark, critical 6.47 / 6.18, warning 5.02 / 9.97, info 5.93 / 7.77.
  Before they existed the boards spelled valence in raw Tailwind
  (`text-emerald-700`, `text-rose-600`, `text-sky-700`, `text-amber-700`) — every
  one of which measures around **3:1 in dark mode**, so an accented figure was
  the least legible thing on the board exactly where the board was saying *look
  at this one*. 95 figure lines were moved onto the tokens.
- **A measured tint + foreground pair is a different thing** and keeps its
  Tailwind values: `.status-pill-*` is verified at 4.5:1 per variant by
  `tests/statusPills.test.js`. Two steps, not one mid-tone.
- **Chart colour comes from the job, never the call site**: identity `SERIES`,
  de-emphasis `MUTED`, magnitude/order `SEQ`/`seqSteps`, state `STATUS`,
  polarity `DIVERGING`. A literal hex or a `bg-emerald-500` on a mark is a bug.

---

## 7. A number alone has no meaning; a comparison does — and you may not invent one

"RD$ 412,900" is a string. "RD$ 412,900, +18% vs. el mes pasado" is a fact
someone can act on. Making the reader hold last month in their head is exactly
the working-memory tax a back-office exists to remove.

`src/lib/quant.ts` owns this, and it refuses three things the boards were
getting wrong:

1. **Direction is not valence.** Ventas up is good, gastos up is bad, headcount
   moving is neither. `toneFor(dir, goodWhen)` has no flattering default and
   `'neither'` is a legitimate answer. The accounting `DeltaChip` painted *every*
   rise green, on gastos and pagos included; it also painted a flat period green,
   because it tested `delta >= 0`.
2. **A change in a percentage is measured in points.** 20% → 25% rose five
   POINTS (a 25% relative rise). "+25%" printed beside a figure reading "25%" is
   unrecoverable for the reader — the two look identical and mean different
   things. `formatPoints` writes "pp"; `formatDeltaPct` writes "%".
3. **Growth from zero is not a percentage.** 0 → 40 is not +∞% and not +100%;
   it has none. `deltaOf` returns `pct: null` and the View shows the absolute
   change. A missing baseline renders **nothing** — never "0%", which is a
   measurement the app never took.

There is one delta renderer (`<Delta>`); `DeltaChip` in PeriodNav and in
instagram/chrome are prop adapters over it.

Precision is deliberately low. A delta is read for magnitude and direction;
"+18.43%" invites a precision the underlying figures do not have. Under 10% it
keeps one decimal, because "+0%" for a real 0.4% move is the worse lie.

---

## 8. Every chart owes a table — upstream, for now

VETA draws no charts. The rule is recorded so it arrives with the first one: a
mark shows the SHAPE and cannot carry the figures a dealer copies into a form,
so every standalone mark wears a `<ChartFrame>` with a table twin, colour comes
from the job (`SERIES` / `MUTED` / `SEQ` / `STATUS` / `DIVERGING`) never the
call site, and a new shape goes IN the library, never beside it. Port
`charts/MiniCharts.jsx` and `lib/viz.js` together with the chart tests.

---

## 9. Grouping is spatial before it is anything else

Gestalt proximity and common region: the eye groups by distance and by shared
background *before* it reads a border, a colour or a label. So the gap inside a
group must be smaller than the gap between groups — the app's rhythm is
`gap-1`/`gap-1.5` within a cluster, `gap-2`/`gap-3` between clusters, `gap-4`+
between sections, with `.section-rule` (an eyebrow plus a fading hairline) for
the page's own layers.

Elevation is the other grouping channel, and it is a ladder of four, warm-tinted
(shadow colour is ink-700, not black, so depth reads as editorial paper rather
than cold SaaS): `shadow-xs` hairline → `shadow-sm`/`.card` resting → `soft`/`md`
raised-and-hover → `pop` floating overlay. `shadow-focus` and `shadow-glow` are
not elevation; they are state.

---

## 10. Motion is optional, and the theme is one variable swap

`prefers-reduced-motion` is honoured globally in `@layer base` — every enter/exit
animation, hover lift and count-up. `CountUp` checks it too and lands on the
final figure immediately.

Light and dark are a **variable swap**, never a per-component `dark:` sweep: one
toggle re-skins the app because `--ink-*`, `--brand-*`, `--surface*`, `--canvas`
and `--viz-*` are all that change. **Light values are frozen** — the exact hexes
the app always shipped — so a dark-mode problem is fixed in `.dark`, never by
editing `:root`. A `dark:` variant at a call site is a sign the value should have
been a token; that is how 95 figure colours ended up illegible in dark mode.

An inline `<head>` script stamps `.dark` before first paint and must mirror
`lib/theme.js` exactly.

---

## 10b. Depth is warm, and the default is not

`tailwind.config.js` overrides `xs / sm / soft / md / pop` with a ladder whose
shadow **colour** is ink-700 (#3b3830) rather than black — hairline → resting
card → raised → floating overlay. The config comment says why: depth should
read as warm editorial paper, not cold SaaS.

It does not override `DEFAULT`, `lg`, `xl`, `2xl` or `inner`, which still
resolve to Tailwind's `rgb(0 0 0 / 0.1)`. So `shadow-2xl` on a drawer is not a
bigger version of the ladder — it is a different, colder light source, on the
one object where the difference shows most, because a floating panel is all
edge. Fourteen overlays were doing exactly that: the drawer, three lightboxes,
the story viewer, three dropdown menus, the chart tooltip, a toggle knob.

**Pick the rung by the job, not by how big you want it**: `pop` for anything
floating (drawer, lightbox, menu, tooltip), `md` for raised, `sm` for a resting
card, `xs` for a hairline. Pinned by `designSystem.test.js`.

*The count was wrong first.* A bare `\bshadow\b` grep said 48 across 16 files;
the real number, measured only inside `className`, is 14 across 12. The rest
were the word in prose — `ConfiguratorStage` and `ModelStudio` discuss three.js shadow
maps at length. Same lesson the bounded-reads sweep wrote down: a scanner that
over-reports earns an exemption list, which is the failure, not the finding.

---

## 10c. The destructive fill is warm

`.btn-danger` rode Tailwind `red-600` (#dc2626): the only pure red on a clay
page, and in dark mode the brightest object on the screen — louder than the
brand CTA beside it, which is precisely the wrong thing to be loudest. Put side
by side in the lab, it reads as imported from another product.

`--danger` (#b3372f) is the same family as the terracotta and **more legible**:
white measures **5.99:1** on it against 4.83:1 on red-600. It is a third role
the status family did not have — the four `--viz-*` are MARK tones (3:1, for a
dot or a bar), the four `-ink` are TEXT, and a solid button carrying a white
label is neither. One value in both themes, because a solid fill's contrast
with its own label does not depend on the page behind it. Hover moves
brightness rather than stepping to `red-700`, which would walk back out of the
family.

---

## 11. Four surfaces, one set of floors

| Surface | Where | Type | Colour |
|---|---|---|---|
| **App** | the back-office | Lausanne + Söhne | warm ink ramp + terracotta, light **and** dark |
| **Paper** | `/#/q/…`, the customer's quote link | matches the printed document | forced light — it is the dealer's paper on a customer's device |
| **Sub-brand** | the Ligne Roset plan configurator, the dealer inbox | Verlag / monochrome editorial | the partner's identity, not ours |
| **Public, ours** | `/configurador/carl-hansen`, `/configurador/fredericia` | the app's own type | the app's tokens, forced light — a manufacturer's range shown by us |

The **floors** (11px, 4.5:1 text, 24px targets, tabular figures in a set, no
meaning in hue alone, a bound label) apply to all four. Only the **tokens**
differ. The paper and the sub-brand are exempt from the token rules by path in
`tests/designSystem.test.js` — a surface earns an exemption by being a different
ground, never by being a different opinion. The public brand configurators are
NOT exempt: they are the app's tokens shown to a visitor, and the picker rewrite
of 2026-09-02 (§15) is the worked example of the rules applied to one.

---

## 12. A label is a target, not a caption

§1 puts a 24/44px floor under everything you can click, and `targetSize.test.js`
holds it — for buttons. Form fields fell through it, because the target a field
is *supposed* to have was never created.

A `<label>` bound to its control is not decoration: the browser makes the word
part of the control. `.input` is ~38px tall and the caption over it is an 11px
line plus `mb-1.5`, so binding them roughly **doubles** the acquirable area, and
— the part Fitts's law actually cares about — makes the thing you are already
reading the thing you tap. No re-aim. Unbound, the same word is inert pixels and
the field is a 38px slot you have to find separately.

Three more things ride on that binding, and all four are lost together:

- **The name.** Unbound, the field announces as "edit text, blank" — a dealer
  tabbing a 16-field contact sheet hears sixteen identical inputs, and voice
  control ("toca Teléfono") cannot reach any of them.
- **The error.** The red sentence under a field is visually adjacent and
  programmatically orphaned until `aria-describedby` says it belongs there.
- **Autofill.** The label is one of the signals a browser and a password manager
  read to decide what a field wants.

The app already shipped the right recipe — `Empleados.jsx` and the accounting
module's `<FieldRow>` — and the wrong one in seventeen files beside them: **84
captions** painted `.label` onto a `<div>` above a bare `<input>`, and seven more
used a real `<label>` that closed before its control ever opened, which reads as
correct and binds to nothing.

**Three bindings, and which one is which is decided by what is in the block:**

| The block holds | Binding | Shape |
|---|---|---|
| the control, alone | **wrap** (the default) | `<label className="block"><span className="label">Teléfono</span><input className="input" …/></label>` |
| the control **and** something else you can click | `htmlFor` / `id` | the caption row carries a live save chip, a *Copiar* button, a DGII lookup |
| a **set** of controls | `role="group"` + `aria-labelledby` | a `Choice` row, a repeating list of button rows |

Wrapping is the default because there is no id to invent and none to get out of
sync when a field is copied into the next form — which is exactly how these 84
drifted apart in the first place. `htmlFor` earns its place only when the caption
row holds more than the name; folding "Guardando…" into a field's own name is
worse than not binding it.

**A label may name exactly one thing**, so a caption over a `Choice` is a group
name, and it belongs in the primitive: `<Choice label="Desde" …>` renders the
caption and points the group's `aria-labelledby` at it, so the visible word and
the accessible name are one string with nothing to drift. Thirteen call sites
read as "Desde" over three anonymous buttons before that.

**And a `<label>` wraps its control and nothing else you can click.** Clicking
anywhere inside a label activates its control, so a button in there fires twice
— `ExpedienteForm`'s "Aplicar tasa BPD" was calling `preventDefault()` to undo a
focus it never asked for. That workaround was the tell.

Pinned by `tests/formLabels.test.js`. It reads the two other bindings as legal
(an inner `<label htmlFor>`, an `id` something names itself by), so the escape
hatch from a red is to bind the caption, never to list an exemption. Where the
text really is a section heading rather than a field's name, `.eyebrow` is the
primitive for that job.

---

## 13. What survives an interruption

Chapters 1–13 are about the screen a person is looking at. This one is about
the screen they came back to. The dealer works between a customer in the
showroom and a container at the port: the phone rings mid-form, a chat needs
checking mid-invoice, the tablet sleeps. An interruption is the normal case
here, not the edge, and four things decide what it costs.

**The dialog is the app's, not the browser's.** `window.confirm`, `alert` and
`prompt` are banned outright. A native dialog carries no title, no danger tone,
none of the type ladder, and on a phone it is a system sheet the dealer
dismisses by reflex — the same reflex that dismisses the cookie banner. The app
has `useConfirm` (title + message + `confirmLabel` + `tone`) and `useToast`,
and a confirmation names the object and what survives it: not "¿Está seguro?"
but "Se eliminan el pago y su asiento contable. La cuota vuelve a quedar
pendiente."

**A write in flight cannot be fired twice.** 800ms of network on a showroom
tablet with nothing changing on screen is a second tap, and a second tap on
«Crear pedido» is a second order — with its own number, because the sequence
assigner retries on the collision and hands the duplicate a clean one. Nothing
errors. The guard is `<BusyButton>` (or `useBusy()` where the same flag drives
something else), and it is **two locks**: `busy` state so the button re-renders
disabled, plus a ref that flips synchronously, because two clicks inside one
React batch both read the old state and only the ref has already moved.

The rule is scoped to handlers that **write**. 47 buttons in this tree fire an
async handler with no `disabled`; 29 are `copy`, `clear`, `handleSignOut` —
idempotent, where a guard is ceremony. A rule that flagged all 47 would earn an
exemption list within a month, and an exemption list is how a rule stops being
one.

**Undo is one thing and it rides the toast.** The toast is already the app's
transient-feedback channel and already owns the bottom-centre corner, so an
undo affordance belongs *inside* it — `toast(msg, { action: { label, onAction } })`
— and nothing renders a second one. A toast with an action stays up 6s rather
than 2.8s: 2.8s is enough to notice a message and not enough to read it, decide
and reach the button.

And the word means one thing. **Deshacer** is cancelling an action that has not
happened yet — `Gmail.jsx` holds the remote call behind the snackbar, so
undoing means the write never went. **Revertir** is writing the opposite of a
posted fact: the original stays in the book and the reversal is a new row with
today's date. A confirmation titled «Deshacer cobro» for the second promises
the reader that nothing will have happened, and delivers a permanent pair of
entries. (`glossary.md` holds both; `docs/invariants.md` holds why money can
only ever do the second.)

**A draft survives leaving.** A route whose URL names an editing session —
`…/nuevo`, `…/:id/editar` — is the app declaring that this is a *place*. A
place is somewhere you navigate to, which means navigating away is a normal
thing to do, which means losing what was typed is the app breaking its own
promise. Two answers satisfy it: the draft **is** a row already
(`ensurePersisted`, the quote builder's answer — strongest, nothing to restore
because nothing was ever only in memory), or the draft is **mirrored**
(`primitives/useDraftGuard`: debounced `localStorage` copy, synchronous read
before the `useState` it seeds, `beforeunload` while there is something to
lose).

Three things the mirror gets right and a hand-rolled one usually does not:

- the flag is **`hasContent`, not `dirty`** — a form nobody typed into must not
  leave a draft that greets the next visit with a banner over nothing;
- **`enabled` is not `hasContent`** — an empty form *clears* the mirror, so
  opening a saved record for a look would delete the half-entered new one
  waiting behind it;
- the restore is **announced** (`DraftRestored`), stamped with when, and offers
  «Empezar en blanco». A form that silently fills itself from Tuesday's draft
  is indistinguishable from one showing the document as it stands, and the
  person who can least afford to guess is the one about to burn an e-NCF on it.

This chapter is scoped to editor **routes**, on purpose. 35 route elements
render an `<input>`; most are filters over a list or a four-field create-modal,
and a modal is dismissed deliberately. The URL is the discriminator because it
is the app's own declaration about which of these is a place.

---

## 14. What the tests actually pin

| Test | Keeps |
|---|---|
| `designSystem.test.js` | the closed type ladder (utilities **and** raw CSS), the 11px floor in raw CSS, the numeral roles, one figure recipe, one delta renderer, no raw valence colour on a figure, no off-ramp grey on an app surface, light values frozen in both themes, reduced motion, the warm destructive fill, the warm depth ladder |
| `typeContrast.test.js` | the 11px floor in utilities, ink-500 as the text floor outside the dark chrome and the studio |
| `targetSize.test.js` | 24×24 hit targets, 44 on coarse |
| `formLabels.test.js` | a field's caption is bound to it — wrap, `htmlFor`, or a named group; and a `<label>` wraps its control alone |
| `notice.test.js` | one recipe for the tint band; the 3px spine in the valence's mark tone; every variant measured at 4.5:1 on BOTH grounds; no two tones paint alike |
| `modelStudioLayout.test.js` | the model studio's height chain and its flat rail — the last layout that broke silently |

Upstream also pins `valenceInk`, `statusPills`, `confirmDialog`, `busyWrites`,
`undo`, `draftSurvival`, `fileSize` and `icons`. They come the day VETA has the
object each one guards (a status column, a write button that can double-fire,
an editor route) — not before, because a rule with nothing to bite earns an
exemption list.

A red here is a routing problem, not a rule problem. Raising a floor, widening
an exemption list or relaxing a matcher records the finding instead of fixing
it — the legal moves are to use the primitive, add the token, or extract the
sibling.

---

## 15. The sweep of 2026-09-02, and the picker it was done for

The owner's screenshot of `/configurador/carl-hansen`: sixty identical text
tiles, «CH24 · dining-chairs», under «257 piezas publicadas». Every rule above
had an instance on that one screen — a slice that hid 197 chairs in silence, a
count in proportional figures, a code in a bare monospace, an unbound search
field, an amber band typed by hand, captions at ink-400. The rewrite is the
worked example: `resolveChPicker` (ViewModel) groups the range by shelf in the
house's editorial order and reports its truncation as a number; the View is
photo cards with the name a visitor knows, the designer, the code in `.code`,
a `.section-rule` per shelf, a bound `<label>`, `<Notice>` for the two things
that can go wrong, and «Ver 48 más» instead of a cliff. The Edge Function lends
each card the face the page cache already held (name, designer, shelf, cover)
— a description of the chair, never its price. `scripts/e2e-carl-hansen-pick.mjs`
measures it in a real browser, desktop and phone.

The sweep the tests forced, all landed in the same change:

| Rule | Found | Done |
|---|---|---|
| closed ladder | 199 `text-[Npx]` (9 · 10 · 11 · 12 · 13 · 15) | folded onto micro / xs / sm / base |
| 11px floor | 40 of those under 11 | raised to `text-micro` |
| text floor ink-500 | 45 `text-ink-400` on sized text; 3 `text-ink-300` | raised; the sidebar chrome and the studio exempt by ground |
| eyebrow primitive | 14 hand-typed | `.eyebrow` |
| notice recipe | 13 hand-typed bands, 7 with no dark half | `<Notice>` |
| one figure recipe | `dashboard/StatTile.jsx` re-typed the tile | a prop adapter over `<Stat>` |
| label wraps control alone | 2 `<label>`s wrapping a button | `htmlFor` / `id` |
| 24px targets | 1 bare `p-1` | `.btn-icon-sm` |
