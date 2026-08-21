/**
 * Carl Hansen & Søn — the configurator axes.
 *
 * The PIM model master (blob `models/<MODEL>/<MODEL>_en.json`) ships a
 * `selectionTrees` map keyed `<CONFIG>_<Axis>` (`CH24_Frame`, `CH24_Seat`,
 * `CH24_ExtraMont`, `CH07_SeatBack`, …), each an arbitrarily deep tree of
 * `choices`. This module flattens ONE configuration's trees into the axes a
 * configurator renders, and nothing else: no React, no fetch, no DB.
 *
 * Three things in here are load-bearing and are pinned in
 * `tests/carlHansen.test.js`:
 *
 * 1. **The choice KEY is not the price code.** CH24's black paper cord sits
 *    under key `04` and prices as `02`. Never key a price off the tree key.
 *
 * 2. **`isPriceDefinator` is INHERITED down the chain.** The spec's rule is
 *    "ancestor-or-self", so once a node is flagged every descendant is a price
 *    definator too. On CH24 the leaves carry it directly; the inheritance is
 *    what keeps a differently-shaped model from silently pricing at nothing.
 *
 * 3. **Axis order in `selectionTrees` is NOT the price-key order.** CH24's
 *    trees enumerate ExtraMont → Frame → Seat, but its price key is
 *    `CH24_<Seat>_<Frame>`; CH07's is `CH07_<Frame>_<SeatBack>`. The order is
 *    per-model DATA, published in `configurations[].componentMapping[]
 *    .priceString` as a mustache template. We carry those templates onto the
 *    axes (`ChAxis.priceTemplates`) so `composePriceKey` can render the
 *    model's own template instead of hardcoding anybody's axis order.
 *
 * Because the templates live NEXT TO the trees rather than inside them,
 * `parseSelectionTree` accepts EITHER the whole model master (preferred — it
 * can then read `configurations` and the default SKU) or the bare
 * `selectionTrees` map (then it degrades to tree order, which is why the
 * parameter is typed `unknown`).
 */

/** Scalar fields of a choice node, verbatim — `priceCode`, `visualCode`,
 *  `woodPropertyCode`, … Anything a price/SKU template may reference. */
export type ChFields = Record<string, string>;

/** One node of an axis tree. Terminal nodes (`children: []`) are the pickable
 *  options; the branches above them are the UI's grouping (Wood → Oak →
 *  Oak FSC-70 → Soap) and carry the labels a product variant is matched on. */
export interface ChChoice {
  /** Key in the parent's `choices` map — this is the SELECTION VALUE. */
  key: string;
  /** Keys from the axis root down to and including this node. */
  path: string[];
  label: string;
  fullLabel: string;
  description: string;
  /** ERP encodings. `''` in the source is normalized to null — an empty
   *  segment must never be joined silently into a price key. */
  priceCode: string | null;
  axPriceCode: string | null;
  dfoPriceCode: string | null;
  visualCode: string | null;
  /** True when this node OR an ancestor carries `isPriceDefinator: true`. */
  isPriceDefinator: boolean;
  isSelectable: boolean;
  /** `hideInNavigator === true` — a structural node the UI doesn't show and a
   *  product variant's configuration text doesn't mention. */
  hidden: boolean;
  isDefault: boolean;
  /** Swatch image published on the node itself. Mostly empty on upholstery
   *  (see `swatchUrlFor` for the materials-page join). */
  swatch: string | null;
  /** Every scalar field of the raw node, for template rendering. */
  fields: ChFields;
  children: ChChoice[];
}

/** The mustache templates a configuration publishes for its ERP keys. */
export interface ChPriceTemplates {
  /** e.g. `CH24_{{Seat.priceCode}}_{{Frame.priceCode}}` */
  price: string | null;
  /** The AX encoding (often identical to `price`). */
  axPrice: string | null;
  /** The DFO encoding, e.g. `CH24_{{Frame.dfoPriceCode}}_{{Seat.dfoPriceCode}}` */
  dfoPrice: string | null;
  /** Add-on codes, e.g. `{{ExtraMont.priceCode}}_{{Height.priceCode}}` */
  addOn: string | null;
  /** The SKU/visual template — used only to resolve the default selection. */
  sku: string | null;
  /** The configuration's own default SKU, e.g. `CH24_1201020_10__FSC-70_None`. */
  defaultSku: string | null;
}

/** One configurator axis = one `selectionTrees` entry. */
export interface ChAxis {
  /** The `selectionTrees` key, e.g. `CH24_Frame`. Selections are keyed on it. */
  id: string;
  /** Configuration the axis belongs to, e.g. `CH24` / `CH24-H43`. */
  configId: string;
  /** Axis name as the price templates spell it, e.g. `Frame`. */
  name: string;
  label: string;
  description: string;
  /** The tree, for rendering. */
  choices: ChChoice[];
  /** Terminal, selectable nodes depth-first — the pickable options. */
  leaves: ChChoice[];
  /** True when any leaf is a price definator ⇒ the axis composes the price
   *  key. False for pure add-on axes (gliders, height). */
  isPriceAxis: boolean;
  /** The configuration's templates (shared by reference across its axes);
   *  null when the caller handed us bare `selectionTrees`. */
  priceTemplates: ChPriceTemplates | null;
  /** Leaf key the model itself defaults to (resolved from `defaultSKU`),
   *  or null when the model master didn't say. */
  defaultChoiceKey: string | null;
}

/* --------------------------------- helpers -------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** `''` and whitespace normalize to null: an absent code must read as absent,
 *  never as an empty key segment. */
const codeOrNull = (v: unknown): string | null => {
  const s = str(v).trim();
  return s ? s : null;
};

/** Scalar fields only — objects/arrays (`choices`, `maintainanceGuide`,
 *  `additionalData`, the EC-variable maps) are dropped. */
function scalarFields(node: Record<string, unknown>): ChFields {
  const out: ChFields = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'choices') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

function buildChoice(
  key: string,
  node: Record<string, unknown>,
  parentPath: string[],
  inheritedDefinator: boolean,
): ChChoice {
  const path = [...parentPath, key];
  const isPriceDefinator = node.isPriceDefinator === true || inheritedDefinator;
  const label = str(node.label) || key;
  const children: ChChoice[] = [];
  const raw = isObj(node.choices) ? node.choices : {};
  for (const [ck, cv] of Object.entries(raw)) {
    if (!isObj(cv)) continue;
    children.push(buildChoice(ck, cv, path, isPriceDefinator));
  }
  return {
    key,
    path,
    label,
    fullLabel: str(node.fullLabel) || label,
    description: str(node.description),
    priceCode: codeOrNull(node.priceCode),
    axPriceCode: codeOrNull(node.axPriceCode),
    dfoPriceCode: codeOrNull(node.dfoPriceCode),
    visualCode: codeOrNull(node.visualCode),
    isPriceDefinator,
    isSelectable: node.isSelectable !== false,
    hidden: node.hideInNavigator === true,
    isDefault: node.isDefault === true,
    swatch: codeOrNull(node.swatch),
    fields: scalarFields(node),
    children,
  };
}

/** Terminal, selectable nodes, depth-first. */
function collectLeaves(nodes: ChChoice[], out: ChChoice[] = []): ChChoice[] {
  for (const n of nodes) {
    if (n.children.length) collectLeaves(n.children, out);
    else if (n.isSelectable) out.push(n);
  }
  return out;
}

/** Depth-first walk of every node (branches included). */
export function walkChoices(nodes: ChChoice[], out: ChChoice[] = []): ChChoice[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children.length) walkChoices(n.children, out);
  }
  return out;
}

/** The chain of nodes from the axis root down to `key`, or null when the axis
 *  carries no such node. Matching a product variant needs the whole chain —
 *  "Oil" alone is oak, walnut AND beech. */
export function chainFor(axis: ChAxis, key: string | null | undefined): ChChoice[] | null {
  if (!key) return null;
  const target = String(key);
  const search = (nodes: ChChoice[], acc: ChChoice[]): ChChoice[] | null => {
    for (const n of nodes) {
      const next = [...acc, n];
      if (n.key === target) return next;
      const deeper = n.children.length ? search(n.children, next) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  return search(axis.choices, []);
}

/** The selected node of an axis. Accepts the axis id or its name as the
 *  selection key — the price templates speak names, the UI speaks ids. */
export function selectedChoice(
  axis: ChAxis,
  selection: Record<string, string> | null | undefined,
): ChChoice | null {
  const key = selection ? (selection[axis.id] ?? selection[axis.name]) : null;
  const chain = chainFor(axis, key);
  return chain ? chain[chain.length - 1] : null;
}

/* ------------------------------ price templates ---------------------------- */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

/** The `{{Axis.field}}` references of a template, in order. */
export function templatePlaceholders(template: string | null | undefined): Array<{ axis: string; field: string }> {
  const out: Array<{ axis: string; field: string }> = [];
  if (!template) return out;
  PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER.exec(template))) out.push({ axis: m[1], field: m[2] });
  return out;
}

/**
 * Templates for one configuration, read from its PRIMARY component mapping.
 * A configuration can map several components (a cushion, a frame); the price
 * key is the one whose mapping carries a `priceString`, first wins — measured
 * one-per-configuration across the CH24 master.
 */
function templatesFor(config: Record<string, unknown>): ChPriceTemplates | null {
  const mapping = isObj(config.componentMapping) ? config.componentMapping : null;
  if (!mapping) return null;
  for (const value of Object.values(mapping)) {
    if (!isObj(value)) continue;
    const price = codeOrNull(value.priceString);
    const sku = codeOrNull(value.skuString);
    if (!price && !sku) continue;
    return {
      price,
      axPrice: codeOrNull(value.axPriceString),
      dfoPrice: codeOrNull(value.dfoPriceString),
      addOn: codeOrNull(value.addOnPriceString),
      sku,
      defaultSku: codeOrNull(config.defaultSKU),
    };
  }
  return null;
}

/**
 * Resolve each axis's default leaf from the configuration's `defaultSKU` by
 * running its own `skuString` template backwards
 * (`CH24_{{Frame.visualCode}}_{{Seat.visualCode}}__{{Frame.woodPropertyCode}}…`
 *  against `CH24_1201020_10__FSC-70_None`).
 *
 * Fail-safe by construction: any mismatch just returns an empty map and
 * `defaultSelection` falls back to `isDefault` / first selectable leaf. The
 * default SKU is a nicety (it opens the configurator on the chair the brand
 * photographs), never a correctness requirement.
 */
function defaultsFromSku(templates: ChPriceTemplates | null): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (!templates?.sku || !templates.defaultSku) return out;
  const refs = templatePlaceholders(templates.sku);
  if (!refs.length) return out;

  // Build an anchored regex from the template: literals escaped, each
  // placeholder a run of non-`_` characters (measured: no code contains one).
  let pattern = '^';
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER.exec(templates.sku))) {
    pattern += templates.sku.slice(cursor, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern += '([^_]*)';
    cursor = m.index + m[0].length;
  }
  // Trailing literal is deliberately NOT anchored: the published defaultSKU
  // drops the template's `_Standard` suffix.
  const match = new RegExp(pattern).exec(templates.defaultSku);
  if (!match) return out;

  refs.forEach((ref, i) => {
    const value = match[i + 1];
    if (value == null || value === '') return;
    let byField = out.get(ref.axis);
    if (!byField) { byField = new Map(); out.set(ref.axis, byField); }
    if (!byField.has(ref.field)) byField.set(ref.field, value);
  });
  return out;
}

/* --------------------------------- parsing --------------------------------- */

/**
 * Flatten a model master's `selectionTrees` into axes.
 *
 * @param selectionTrees EITHER the whole model master (so the price templates
 *   and default SKU come along) OR the bare `selectionTrees` map.
 * @param configId Keep only this configuration's axes (EXACT match — `CH24`
 *   must not swallow `CH24-H43`). Omitted ⇒ every axis, in source order.
 */
export function parseSelectionTree(selectionTrees: unknown, configId?: string): ChAxis[] {
  if (!isObj(selectionTrees)) return [];

  const isModel = isObj(selectionTrees.selectionTrees);
  const trees = isModel ? (selectionTrees.selectionTrees as Record<string, unknown>) : selectionTrees;
  const configs = isModel && Array.isArray(selectionTrees.configurations)
    ? (selectionTrees.configurations as unknown[])
    : [];

  // configId → its templates + per-axis default codes.
  const templatesByConfig = new Map<string, ChPriceTemplates>();
  const defaultsByConfig = new Map<string, Map<string, Map<string, string>>>();
  for (const c of configs) {
    if (!isObj(c)) continue;
    const id = str(c.id);
    if (!id) continue;
    const t = templatesFor(c);
    if (!t) continue;
    templatesByConfig.set(id, t);
    defaultsByConfig.set(id, defaultsFromSku(t));
  }

  const axes: ChAxis[] = [];
  for (const [key, value] of Object.entries(trees)) {
    if (!isObj(value)) continue;
    const name = str(value.name) || key.slice(key.lastIndexOf('_') + 1);
    const cfg = key.endsWith(`_${name}`) ? key.slice(0, key.length - name.length - 1) : key.slice(0, key.lastIndexOf('_'));
    if (configId != null && cfg !== configId) continue;

    const choices: ChChoice[] = [];
    const rawChoices = isObj(value.choices) ? value.choices : {};
    for (const [ck, cv] of Object.entries(rawChoices)) {
      if (!isObj(cv)) continue;
      choices.push(buildChoice(ck, cv, [], value.isPriceDefinator === true));
    }
    const leaves = collectLeaves(choices);
    const templates = templatesByConfig.get(cfg) || null;

    // Default leaf from the SKU template: match on whichever field the
    // template referenced for this axis (usually visualCode).
    let defaultChoiceKey: string | null = null;
    const wanted = defaultsByConfig.get(cfg)?.get(name);
    if (wanted) {
      for (const [field, want] of wanted) {
        const hit = leaves.find((l) => l.fields[field] === want);
        if (hit) { defaultChoiceKey = hit.key; break; }
      }
    }

    axes.push({
      id: key,
      configId: cfg,
      name,
      label: str(value.label) || name,
      description: str(value.description),
      choices,
      leaves,
      isPriceAxis: leaves.some((l) => l.isPriceDefinator),
      priceTemplates: templates,
      defaultChoiceKey,
    });
  }
  return axes;
}

/**
 * The selection a configurator opens on: the model's own default when the
 * master published one, else the leaf flagged `isDefault`, else the first
 * selectable leaf. An axis with no selectable leaf is omitted rather than
 * given an empty value.
 */
export function defaultSelection(axes: ChAxis[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const axis of axes || []) {
    const fromModel = axis.defaultChoiceKey
      ? axis.leaves.find((l) => l.key === axis.defaultChoiceKey)
      : null;
    const flagged = axis.leaves.find((l) => l.isDefault);
    const first = axis.leaves[0];
    const pick = fromModel || flagged || first;
    if (pick) out[axis.id] = pick.key;
  }
  return out;
}

/**
 * EVERY selection a configuration offers — the cartesian product of its axes'
 * selectable leaves.
 *
 * This is what turns "configure one chair and import it" into "import the
 * range". `defaultSelection` above answers what a configurator OPENS on; this
 * answers what the model can BE, which is the question a bulk import asks.
 *
 * ── COVERAGE IS DELIBERATELY WIDER THAN THE CATALOG ─────────────────────────
 * Most combinations produce nothing: `buildCarlHansenProductRows` only writes a
 * row when a published VARIANT matches the selection's label chain, and
 * coverage there is partial by design (a variant whose configuration we cannot
 * place must not inherit somebody else's price). So this enumerates the
 * possibility space and the row builder is the filter — never the other way
 * round, because guessing which combinations are "real" up front is exactly
 * how a third of a range goes missing.
 *
 * ── THE CAP IS REPORTED, NEVER SILENT ───────────────────────────────────────
 * Axes multiply. CH24 is 24 combinations across three axes and CH24-CHSColors
 * is 22, but a model with five 10-leaf axes would be 100,000 — enough to hang a
 * phone building selections nobody asked for. So the walk stops at `cap` and
 * says so through `truncated`. A caller that ignores that flag reports a
 * partial import as a complete one, which is the failure this returns a flag to
 * prevent.
 *
 * An axis with no selectable leaf is SKIPPED rather than emptying the product:
 * a model whose one add-on axis is unselectable still has its real frames and
 * seats, and returning [] for it would drop the model from the catalog.
 */
export function enumerateSelections(
  axes: ChAxis[] | null | undefined,
  { cap = 2000 }: { cap?: number } = {},
): { selections: Array<Record<string, string>>; truncated: boolean; total: number } {
  const usable = (axes || []).filter((a) => (a?.leaves || []).some((l) => l?.isSelectable !== false));
  if (!usable.length) return { selections: [], truncated: false, total: 0 };

  // How big the product WOULD be, computed before building anything so the
  // report is honest even when the walk stops early.
  let total = 1;
  for (const axis of usable) {
    const n = axis.leaves.filter((l) => l?.isSelectable !== false).length;
    total *= n;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) { total = Number.MAX_SAFE_INTEGER; break; }
  }

  let selections: Array<Record<string, string>> = [{}];
  let truncated = false;
  for (const axis of usable) {
    const leaves = axis.leaves.filter((l) => l?.isSelectable !== false);
    const next: Array<Record<string, string>> = [];
    for (const base of selections) {
      for (const leaf of leaves) {
        if (next.length >= cap) { truncated = true; break; }
        next.push({ ...base, [axis.id]: leaf.key });
      }
      if (truncated) break;
    }
    selections = next;
  }
  return { selections, truncated: truncated || total > selections.length, total };
}

/** Every configuration id a model master publishes, in published order.
 *  Disabled ones are INCLUDED and flagged — Carl Hansen disables a
 *  configuration without withdrawing the pieces already sold under it, so a
 *  bulk read that dropped them would lose real catalogue. */
export function configurationIds(
  model: unknown,
): Array<{ id: string; friendlyName: string; disabled: boolean }> {
  const raw = isObj(model) && Array.isArray(model.configurations) ? model.configurations : [];
  const seen = new Set<string>();
  const out: Array<{ id: string; friendlyName: string; disabled: boolean }> = [];
  for (const c of raw) {
    if (!isObj(c)) continue;
    const id = str(c.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, friendlyName: str(c.friendlyName), disabled: c.isDisabled === true });
  }
  return out;
}
