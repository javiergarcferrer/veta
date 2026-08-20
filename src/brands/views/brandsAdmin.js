/**
 * MARCAS — every projection the brand admin renders.
 *
 * The page derives NOTHING: it fetches, holds UI state (search / tab / sort /
 * the open brand) and renders what these resolvers return. Everything with a
 * rule in it — what a slug may be, whether a brand can be saved, which module
 * set a row is really running, what a module set can actually READ, and what a
 * dropped folder of swatches or a price list would WRITE — lives here, pure and
 * testable.
 *
 * The three `plan*` functions are the same posted-money discipline the rest of
 * the app uses for imports: they compute the rows, the caller writes them in ONE
 * `bulkPut`. Nothing here touches the db, React or the network.
 */

import { moduleSetFor, moduleSetById, modulesValue, MODULE_SETS, MODULE_ADAPTERS } from '../modules/index.js';

export const BRAND_SORT_OPTIONS = [
  { key: 'name', label: 'Nombre' },
  { key: 'models', label: 'Modelos' },
  { key: 'updated', label: 'Actualizada' },
];

/** Case/accent-insensitive key for matching a material by name across sources —
 *  the same fold the Ligne Roset catalog merge uses, written locally so the
 *  brand layer owns no LR import. */
export function foldName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

/** 'Ligne Roset' → 'ligne-roset'. The slug is the brand's public handle AND the
 *  default `products.brand` scope, so it is ascii, lower-case and hyphenated. */
export function brandSlugify(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const LOCALES = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
];
export const BRAND_LOCALES = LOCALES;

const localeLabel = (l) => LOCALES.find((x) => x.value === l)?.label || String(l || '').toUpperCase();

/** The environment tables a brand owns — the ones `brand_id` was added to. Used
 *  by the list's counts and by the "what is inside this brand" panel. */
export const ENVIRONMENT_TABLES = Object.freeze([
  { key: 'models', label: 'Modelos' },
  { key: 'materials', label: 'Materiales' },
  { key: 'fabrics', label: 'Telas por modelo' },
  { key: 'dealers', label: 'Distribuidores' },
  { key: 'requests', label: 'Solicitudes' },
]);

/**
 * Tally rows by `brandId` — the counts every brand surface shows. `rows` is any
 * list carrying a brandId; a row with none belongs to no brand and is reported
 * separately under `orphans` rather than being silently added to brand #1.
 */
export function tallyByBrand(rows) {
  const by = new Map();
  let orphans = 0;
  for (const r of rows || []) {
    const id = r?.brandId;
    if (!id) { orphans += 1; continue; }
    by.set(id, (by.get(id) || 0) + 1);
  }
  return { by, orphans };
}

/**
 * THE LIST. `counts` is `{ models, materials, fabrics, dealers, requests }`,
 * each a Map(brandId → n) from `tallyByBrand`.
 */
export function resolveBrandsList({ brands, counts = {}, search = '', status = 'all', sort } = {}) {
  const all = (brands || []).map((b) => {
    const modules = moduleSetFor(b);
    const n = (key) => counts?.[key]?.get?.(b.id) || 0;
    const models = n('models');
    return {
      id: b.id,
      slug: b.slug || '',
      name: b.name || b.slug || 'Sin nombre',
      locale: b.locale || 'es',
      localeLabel: localeLabel(b.locale),
      currency: (b.currency || 'USD').toUpperCase(),
      active: b.active !== false,
      statusLabel: b.active !== false ? 'Activa' : 'Inactiva',
      statusCls: b.active !== false ? 'status-pill-active' : 'status-pill-inactive',
      primaryColor: b.branding?.primaryColor || null,
      logoUrl: b.branding?.logoUrl || null,
      moduleSetId: modules.setId,
      moduleLabel: modules.label,
      moduleSummary: modules.summary,
      /** True when the stored selection named a set the registry doesn't have —
       *  the row is running Ligne Roset's modules and the admin must say so. */
      moduleFellBack: modules.fellBack,
      mixed: Object.keys(modules.overrides).length > 0,
      catalogBrand: b.settings?.catalogBrand || b.slug || '',
      models,
      materials: n('materials'),
      fabrics: n('fabrics'),
      dealers: n('dealers'),
      requests: n('requests'),
      empty: models === 0 && n('materials') === 0,
      updatedAt: b.updatedAt || b.createdAt || 0,
    };
  });

  const tabs = [
    { key: 'all', label: 'Todas', count: all.length },
    { key: 'active', label: 'Activas', count: all.filter((r) => r.active).length },
    { key: 'inactive', label: 'Inactivas', count: all.filter((r) => !r.active).length },
  ];

  const needle = String(search || '').trim().toLowerCase();
  let rows = all.filter((r) => {
    if (status === 'active' && !r.active) return false;
    if (status === 'inactive' && r.active) return false;
    if (!needle) return true;
    return [r.name, r.slug, r.moduleLabel, r.currency, r.catalogBrand]
      .some((v) => String(v || '').toLowerCase().includes(needle));
  });

  const key = sort?.key || 'name';
  const dir = sort?.dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    if (key === 'models') return (a.models - b.models) * dir;
    if (key === 'updated') return (a.updatedAt - b.updatedAt) * dir;
    return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) * (sort?.dir === 'desc' ? -1 : 1);
  });

  return {
    rows,
    tabs,
    empty: all.length === 0,
    noMatches: all.length > 0 && rows.length === 0,
  };
}

/**
 * WHAT A MODULE SET CAN READ — the capability cards the admin shows beside the
 * picker. Three cards, one per adapter, each answering the only two questions a
 * dealer has: what can I drop on it, and what will it understand?
 */
export function resolveModuleCapabilities(modules) {
  const set = moduleSetFor(modules);
  return {
    setId: set.setId,
    label: set.label,
    summary: set.summary,
    fellBack: set.fellBack,
    overrides: set.overrides,
    cards: [
      {
        slot: 'geometry',
        title: 'Geometría',
        id: set.geometry.id,
        label: set.geometry.label,
        summary: set.geometry.summary,
        facts: [
          { label: 'Acepta', value: set.geometry.extensions.join(' · ') },
          ...(set.geometry.sidecar?.length
            ? [{ label: 'Texturas que acompañan', value: set.geometry.sidecar.join(' · ') }]
            : []),
          { label: 'Taxonomía', value: 'grupo · categoría · colección · modelo · variante' },
        ],
      },
      {
        slot: 'materials',
        title: 'Materiales',
        id: set.materials.id,
        label: set.materials.label,
        summary: set.materials.summary,
        facts: [
          { label: 'Acepta', value: set.materials.extensions.join(' · ') },
          { label: 'Devuelve', value: 'código · nombre · color exacto · textura' },
          // WHERE THE SWATCH PHOTO COMES FROM is the fact a dealer most needs
          // before importing: a brand with no CDN paints its own scans, and
          // that is a working answer, not a gap.
          {
            label: 'Muestras',
            value: set.materials.swatch?.urlFor('0000')
              ? `${set.materials.swatch.label} (foto del fabricante)`
              : 'las muestras importadas (sin CDN del fabricante)',
          },
        ],
      },
      {
        slot: 'catalog',
        title: 'Catálogo y precios',
        id: set.catalog.id,
        label: set.catalog.label,
        summary: set.catalog.summary,
        facts: [
          { label: 'SKU', value: set.catalog.skuHint },
          {
            label: 'Grados',
            value: set.catalog.grades.length ? set.catalog.grades.join(' ') : 'sin grados (un precio por SKU)',
          },
          { label: 'Lista de precios', value: set.catalog.priceColumns.join(',') },
          // WHERE THE CATALOG COMES FROM. A brand bought through a distributor
          // that publishes its stock online imports the whole book from there
          // instead of from a spreadsheet somebody re-keys; one without such a
          // source says so, because "drop a CSV" is then the only way in and a
          // dealer needs to know that before choosing the module set.
          {
            label: 'Origen',
            value: set.catalog.source?.supported
              ? `catálogo del distribuidor (${set.catalog.source.label})`
              : 'la lista de precios que subas',
          },
          // A brand whose model pages publish an offered-fabric roster can be
          // linked to them; one that doesn't simply never shows the control.
          {
            label: 'Telas por modelo',
            value: set.catalog.fabricLink?.supported
              ? `enlace al catálogo del fabricante (${set.catalog.fabricLink.label})`
              : 'todas las telas del grado',
          },
        ],
      },
    ],
  };
}

/** Every set the picker offers, with the one line that decides it. */
export function moduleSetOptions() {
  return MODULE_SETS.map((s) => ({
    id: s.id,
    label: s.label,
    summary: s.summary,
    geometry: s.geometry.label,
    materials: s.materials.label,
    catalog: s.catalog.label,
  }));
}

/** The per-slot adapters, for the "mix" control. */
export function moduleAdapterOptions(slot) {
  return (MODULE_ADAPTERS[slot] || []).map((a) => ({ id: a.id, label: a.label, summary: a.summary }));
}

/** A brand row → the edit form's fields. */
export function formFromBrand(brand) {
  const modules = moduleSetFor(brand);
  return {
    name: brand?.name || '',
    slug: brand?.slug || '',
    locale: brand?.locale || 'es',
    currency: (brand?.currency || 'USD').toUpperCase(),
    active: brand?.active !== false,
    logoUrl: brand?.branding?.logoUrl || '',
    primaryColor: brand?.branding?.primaryColor || '',
    moduleSet: modules.setId,
    geometry: modules.geometry.id,
    materials: modules.materials.id,
    catalog: modules.catalog.id,
    catalogBrand: brand?.settings?.catalogBrand ?? (brand?.slug || ''),
  };
}

/**
 * THE DRAFT — one rule set for create AND edit, so a brand can never be created
 * through one set of rules and edited through another.
 */
export function resolveBrandDraft({ form, brands, editingId = null } = {}) {
  const name = String(form?.name || '').trim();
  const slug = brandSlugify(form?.slug || form?.name || '');
  const currency = String(form?.currency || '').trim().toUpperCase();
  const set = moduleSetById(form?.moduleSet) ? form.moduleSet : null;

  const taken = (brands || []).some((b) => b.id !== editingId && brandSlugify(b.slug) === slug && slug);

  const issues = [];
  if (!name) issues.push({ key: 'name', text: 'Ponle nombre a la marca.' });
  if (!slug) issues.push({ key: 'slug', text: 'El identificador no puede quedar vacío.' });
  if (taken) issues.push({ key: 'slug', text: `Ya hay una marca con el identificador «${slug}».` });
  if (!/^[A-Z]{3}$/.test(currency)) issues.push({ key: 'currency', text: 'La moneda va en código ISO de 3 letras (USD, EUR, DOP).' });
  if (!set) issues.push({ key: 'moduleSet', text: 'Elige el juego de módulos de importación.' });

  const capabilities = resolveModuleCapabilities({
    set: set || undefined,
    geometry: form?.geometry,
    materials: form?.materials,
    catalog: form?.catalog,
  });

  return {
    slug,
    issues,
    canSave: issues.length === 0,
    capabilities,
    /** The exact row patch the page writes — one shape, so create and edit can
     *  never store a brand two different ways. */
    patch: {
      name,
      slug,
      locale: String(form?.locale || 'es'),
      currency: currency || 'USD',
      active: form?.active !== false,
      branding: {
        logoUrl: String(form?.logoUrl || '').trim() || null,
        primaryColor: String(form?.primaryColor || '').trim() || null,
      },
      modules: modulesValue(set || undefined, {
        geometry: form?.geometry, materials: form?.materials, catalog: form?.catalog,
      }),
      settings: {
        // The price-list scope — which `products.brand` this environment reads.
        // Left blank it takes the brand's own identifier, so a new brand starts
        // with an EMPTY catalog of its own (zero rows under that key) rather
        // than with no scope at all: the difference matters, because an unset
        // scope is what would otherwise have to fall through to another
        // manufacturer's SKUs. Pointing two brands at one catalog stays
        // possible — that is the whole reason it is a field and not the slug.
        catalogBrand: String(form?.catalogBrand ?? '').trim() || slug || null,
      },
    },
  };
}

/** The open brand's environment panel: what is inside it, and what is missing. */
export function resolveBrandEnvironment({ brand, counts = {}, productCount = null } = {}) {
  if (!brand) return null;
  const modules = moduleSetFor(brand);
  const n = (key) => counts?.[key] || 0;
  const catalogBrand = brand.settings?.catalogBrand || '';
  return {
    id: brand.id,
    name: brand.name || brand.slug,
    slug: brand.slug,
    active: brand.active !== false,
    modules: resolveModuleCapabilities(brand.modules),
    counts: ENVIRONMENT_TABLES.map((t) => ({ ...t, value: n(t.key) })),
    catalogBrand,
    productCount,
    // Honest, actionable gaps — never invented rows.
    gaps: [
      ...(n('models') === 0 ? [{ key: 'models', text: 'Sin modelos: suelta la biblioteca 3D en «Modelos».' }] : []),
      ...(n('materials') === 0 ? [{ key: 'materials', text: `Sin materiales: importa las muestras con «${modules.materials.label}».` }] : []),
      ...(!catalogBrand ? [{ key: 'catalog', text: 'Sin catálogo de precios asignado: importa una lista o apunta la marca a uno existente.' }] : []),
      ...(catalogBrand && productCount === 0 ? [{ key: 'catalog', text: `El catálogo «${catalogBrand}» está vacío: importa la lista de precios.` }] : []),
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  IMPORT PLANS — pure: compute the rows, the caller writes them once        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A drop of parsed COLORS → the `materials` rows to write.
 *
 * Colours group into materials by the adapter's own answer (`color.material`,
 * usually the folder they sat in); anything the drop didn't file lands under
 * `fallbackName`. An EXISTING material of the same name is extended, never
 * replaced: a colour already there is UPDATED in place (a re-scan is a better
 * scan of the same cloth) and the rest are appended, so re-importing a folder
 * converges instead of duplicating.
 *
 * @returns { rows, summary: { materials, newMaterials, colors, newColors, updatedColors } }
 */
export function planMaterialImport({
  colors, existing = [], profileId, brandId = null, fallbackName = 'IMPORTADO',
  now = Date.now(), newId,
} = {}) {
  const byKey = new Map();
  for (const m of existing || []) {
    if (m?.brandId && brandId && m.brandId !== brandId) continue;
    byKey.set(foldName(m?.name), m);
  }

  const groups = new Map();
  for (const c of colors || []) {
    if (!c?.code) continue;
    const name = foldName(c.material?.name || fallbackName) || foldName(fallbackName);
    if (!groups.has(name)) {
      groups.set(name, {
        name: c.material?.name || fallbackName,
        grade: c.material?.grade || null,
        category: c.material?.category || 'fabric',
        colors: [],
      });
    }
    const g = groups.get(name);
    if (!g.grade && c.material?.grade) g.grade = c.material.grade;
    g.colors.push(c);
  }

  const rows = [];
  let newMaterials = 0;
  let newColors = 0;
  let updatedColors = 0;

  for (const [key, g] of groups) {
    const current = byKey.get(key) || null;
    const colorsOut = [...(current?.colors || [])];
    const indexByCode = new Map(colorsOut.map((c, i) => [String(c?.code || ''), i]));
    for (const c of g.colors) {
      const entry = {
        code: String(c.code),
        name: c.name || String(c.code),
        ...(c.rgb ? { rgb: c.rgb } : null),
        ...(c.textureUrl ? { textureUrl: c.textureUrl } : null),
        ...(c.normalUrl ? { normalUrl: c.normalUrl } : null),
        ...(c.roughnessUrl ? { roughnessUrl: c.roughnessUrl } : null),
        ...(c.metalnessUrl ? { metalnessUrl: c.metalnessUrl } : null),
        ...(c.displacementUrl ? { displacementUrl: c.displacementUrl } : null),
        ...(c.anisotropyUrl ? { anisotropyUrl: c.anisotropyUrl } : null),
        ...(c.swatchOwn ? { swatchOwn: true } : null),
        ...(c.pbr && typeof c.pbr === 'object' ? c.pbr : null),
      };
      const at = indexByCode.get(entry.code);
      if (at == null) {
        indexByCode.set(entry.code, colorsOut.length);
        colorsOut.push(entry);
        newColors += 1;
      } else {
        // Keep whatever the existing row carried that this scan didn't answer
        // (an uploaded photo id, a previous PBR port).
        colorsOut[at] = { ...colorsOut[at], ...entry };
        updatedColors += 1;
      }
    }
    if (current) {
      rows.push({ ...current, colors: colorsOut, grade: current.grade || g.grade || null, updatedAt: now });
    } else {
      newMaterials += 1;
      rows.push({
        id: typeof newId === 'function' ? newId() : `mat_${key}_${now}`,
        profileId,
        ...(brandId ? { brandId } : null),
        category: g.category,
        name: g.name,
        grade: g.grade || null,
        colors: colorsOut,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return {
    rows,
    summary: {
      materials: rows.length,
      newMaterials,
      colors: newColors + updatedColors,
      newColors,
      updatedColors,
    },
  };
}

/**
 * A price list → the `products` rows to write, decoded by the brand's OWN
 * catalog module.
 *
 * Every row keeps the brand's catalog scope (`products.brand`), so a brand's
 * price list can never leak into another brand's picker. An existing SKU is
 * UPDATED (price/name), a new one is created — re-importing the same list
 * therefore changes nothing, which is what makes it safe to re-run after a
 * correction.
 *
 * @returns { rows, summary: { total, created, updated, skipped }, sample }
 */
export function planPriceListImport({
  records, brand, profileId, existing = [], now = Date.now(), newId,
} = {}) {
  const modules = moduleSetFor(brand);
  const catalogBrand = brand?.settings?.catalogBrand || brand?.slug || '';
  const byRef = new Map();
  for (const p of existing || []) byRef.set(String(p?.reference || '').toUpperCase(), p);

  const rows = [];
  const sample = [];
  let skipped = 0;
  let created = 0;
  let updated = 0;

  for (const record of records || []) {
    let parsed = null;
    try { parsed = modules.catalog.parsePriceRow(record); } catch { parsed = null; }
    if (!parsed?.reference) { skipped += 1; continue; }
    const key = String(parsed.reference).toUpperCase();
    const current = byRef.get(key) || null;
    if (sample.length < 5) sample.push(parsed);
    if (current) {
      updated += 1;
      rows.push({
        ...current,
        name: parsed.name || current.name || '',
        priceUsd: parsed.priceUsd,
        brand: catalogBrand || current.brand,
        updatedAt: now,
      });
    } else {
      created += 1;
      rows.push({
        id: typeof newId === 'function' ? newId() : `prod_${key}_${now}`,
        profileId,
        brand: catalogBrand,
        reference: parsed.reference,
        name: parsed.name || parsed.root,
        subtype: parsed.grade ? `Grado ${parsed.grade}` : '',
        family: '',
        category: '',
        priceUsd: parsed.priceUsd,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return {
    rows,
    sample,
    summary: { total: rows.length, created, updated, skipped },
  };
}

/**
 * A SOURCE-DRIVEN catalog → the `products` rows to write.
 *
 * The sibling of `planPriceListImport`, and the difference is the row: a CSV
 * answers a reference and a price, while a distributor's storefront answers a
 * reference, a price, a photo gallery, a product type, a family and whether the
 * thing can be bought at all. Both are pure — compute the rows, the caller
 * writes them in ONE `bulkPut` — and both keep the brand's catalog scope
 * (`products.brand`), so one brand's catalog can never leak into another's
 * picker.
 *
 * `rows` is what a catalog adapter's `source.rows(payload)` returned: the
 * decode is the BRAND'S (its SKU grammar produced the root and the grade), and
 * this is only the write.
 *
 * ── RE-IMPORTING MUST CONVERGE, NOT ACCUMULATE ──────────────────────────────
 * An existing SKU is UPDATED IN PLACE — price, name, taxonomy, photos, stock —
 * and a new one is created. So the second run of the same catalog changes
 * exactly the rows the supplier changed, which is what makes it safe to re-run
 * after a price move. The row's `id`, its `createdAt` and anything a dealer
 * edited that the source has no opinion about (`cost`, `dimensions`) survive
 * untouched: the supplier publishes a price list, not our margin.
 *
 * ── WHAT AN ABSENT ROW MEANS, AND WHY NOTHING IS DELETED ────────────────────
 * A SKU that has disappeared from the store is NOT deleted and NOT deactivated
 * here. It may be discontinued; it may equally be a collection that was
 * re-handled, a vendor rename, or a page that failed to load — and a delete is
 * the one operation a re-run can't take back. `missing` reports them so the
 * importer can say "31 SKUs of this catalog are no longer on the store" and a
 * human decides. It is only computed when `existing` is the WHOLE catalog scope
 * (`fullScope`), because a chunked lookup of only the SKUs being imported
 * cannot tell absent-from-the-store from absent-from-the-query.
 *
 * @returns { rows, missing, summary: { total, created, updated, skipped,
 *            missing, photos, unavailable }, sample }
 */
export function planCatalogSourceImport({
  rows: parsed, brand, profileId, existing = [], fullScope = false,
  now = Date.now(), newId,
} = {}) {
  const catalogBrand = brand?.settings?.catalogBrand || brand?.slug || '';
  const byRef = new Map();
  for (const p of existing || []) byRef.set(String(p?.reference || '').toUpperCase(), p);

  const rows = [];
  const sample = [];
  const seen = new Set();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let photos = 0;
  let unavailable = 0;

  for (const row of parsed || []) {
    const key = String(row?.reference || '').trim().toUpperCase();
    // A row with no reference or no price prices nothing. It is counted, never
    // written as a zero — a $0 SKU in a picker is a quote waiting to happen.
    if (!key || !(Number(row?.priceUsd) > 0)) { skipped += 1; continue; }
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);

    if (row.imageSrc) photos += 1;
    if (row.stockQty === 0) unavailable += 1;
    if (sample.length < 5) sample.push(row);

    // The fields the SOURCE owns. Everything else on an existing row is the
    // dealer's and is spread over from `current` below.
    const fromSource = {
      brand: catalogBrand,
      reference: key,
      name: row.name || row.family || key,
      subtype: row.subtype || '',
      family: row.family || '',
      familyCode: row.familyCode || '',
      category: row.category || '',
      priceUsd: Number(row.priceUsd),
      listPriceUsd: row.listPriceUsd ?? null,
      stockQty: row.stockQty ?? null,
      imageSrc: row.imageSrc || '',
      imageSrcs: row.imageSrcs?.length ? row.imageSrcs : null,
      active: true,
      updatedAt: now,
    };

    const current = byRef.get(key) || null;
    if (current) {
      updated += 1;
      rows.push({ ...current, ...fromSource, brand: catalogBrand || current.brand });
    } else {
      created += 1;
      rows.push({
        id: typeof newId === 'function' ? newId() : `prod_${key}_${now}`,
        profileId,
        ...fromSource,
        createdAt: now,
      });
    }
  }

  // Only meaningful over the whole scope — see WHAT AN ABSENT ROW MEANS.
  const missing = fullScope
    ? (existing || [])
      .filter((p) => p?.active !== false && !seen.has(String(p?.reference || '').toUpperCase()))
      .map((p) => String(p.reference))
    : [];

  return {
    rows,
    missing,
    sample,
    summary: {
      total: rows.length,
      created,
      updated,
      skipped,
      missing: missing.length,
      photos,
      unavailable,
    },
  };
}
