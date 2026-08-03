/**
 * DEMO CATALOG — a self-contained fixture so the widget can run with NO API
 * behind it (`?demo=1`, or a build with neither key nor api base). Everything
 * here is INVENTED: the "Vira" modular collection from the rules fixtures,
 * placeholder prices, flat-color materials. No brand's assets, names or
 * price-list data may ever enter this file — the demo shows the ENGINE.
 *
 * Rendering rides the procedural fallback (`renderParams.fallback`), so the
 * demo needs no mesh bytes; fabrics resolve to their fixture rgb (the
 * appearance pipeline's flat-color degrade, working as designed).
 */
import type { CatalogPayload, MaterialView, ModelView } from './client.ts';

const COLLECTION_ID = 'demo-vira';

function money(amountMinor: number) {
  return { amountMinor, currency: 'USD' };
}

function family(root: string, base: number): ModelView['family'] {
  return {
    root,
    graded: true,
    grades: ['A', 'B', 'C'],
    byGrade: {
      A: { amountMinor: base, currency: 'USD', reference: `${root}A` },
      B: { amountMinor: Math.round(base * 1.18), currency: 'USD', reference: `${root}B` },
      C: { amountMinor: Math.round(base * 1.42), currency: 'USD', reference: `${root}C` },
    },
  };
}

function model(
  slug: string, name: string, tags: string[],
  widthCm: number, depthCm: number, base: number, sortOrder: number,
): ModelView {
  return {
    id: `demo-${slug}`,
    collectionId: COLLECTION_ID,
    slug,
    name,
    status: 'published',
    tags,
    widthCm,
    depthCm,
    heightCm: 72,
    meshPath: null,
    meshParams: {},
    mount: null,
    defaultRot: 0,
    sku: `${10000000 + sortOrder * 10}`,
    sortOrder,
    price: money(base),
    family: family(`${10000000 + sortOrder * 10}`, base),
    partFamilies: null,
  };
}

const swatch = (id: string, name: string, code: string, rgb: string, sortOrder: number) => ({
  id, name, code, grade: 'A', rgb, texturePath: null, normalPath: null, sortOrder,
});

const MATERIALS: MaterialView[] = [
  {
    id: 'demo-tela',
    name: 'Demo Weave',
    category: 'Telas',
    sourceAdapter: 'simple',
    params: {},
    colors: [
      swatch('c-oat', 'Oat', '9001', '#b3a289', 0),
      swatch('c-terracotta', 'Terracotta', '9002', '#b06a4b', 1),
      swatch('c-olive', 'Olive', '9003', '#7a7d54', 2),
      swatch('c-graphite', 'Graphite', '9004', '#4a4d52', 3),
      swatch('c-paon', 'Peacock', '9005', '#2e6f77', 4),
    ],
  },
  {
    id: 'demo-boucle',
    name: 'Demo Bouclé',
    category: 'Telas',
    sourceAdapter: 'simple',
    params: {},
    colors: [
      swatch('c-ivory', 'Ivory', '9101', '#e4ddd0', 0),
      swatch('c-moss', 'Moss', '9102', '#5c6b4f', 1),
      swatch('c-rust', 'Rust', '9103', '#9c4f33', 2),
    ],
  },
];

export const DEMO_CATALOG: CatalogPayload = {
  currency: 'USD',
  dealer: { slug: null, mode: 'full', multiplier: 1 },
  collections: [{
    id: COLLECTION_ID,
    slug: 'vira',
    name: 'Vira (demo)',
    status: 'published',
    renderParams: { fallback: 'procedural-togo', seamBleed: 1.04 },
    taxonomy: {},
    sortOrder: 0,
  }],
  models: [
    model('armchair', 'Armchair', ['seat'], 100, 102, 189_500, 0),
    model('loveseat', 'Loveseat', ['seat'], 140, 102, 262_000, 1),
    model('sofa', 'Three-Seat Sofa', ['seat', 'sofa'], 200, 102, 348_000, 2),
    model('corner', 'Corner', ['corner'], 102, 102, 214_000, 3),
    model('chaise', 'Chaise Longue', ['lounge'], 100, 160, 296_500, 4),
    model('ottoman', 'Ottoman', ['ottoman'], 90, 90, 98_000, 5),
  ],
  materials: MATERIALS,
  partRoles: [],
  rulesets: [{
    collectionId: COLLECTION_ID,
    version: 1,
    status: 'active',
    rules: {
      schema: 1,
      params: { rotationStepDeg: 0 },
      rules: [
        { id: 'max-pieces', type: 'count', max: 12, severity: 'error' },
        { id: 'fabric-picked', type: 'option', severity: 'warning',
          require: [{ path: 'material.code', op: 'set' }] },
      ],
    },
  }],
};
