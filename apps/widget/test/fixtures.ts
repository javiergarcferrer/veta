/**
 * Test fixtures — an invented brand ("Duna"), never real brand data.
 *
 * The platform ships ZERO furniture data (IP discipline, action plan §1.4), and
 * that includes its tests: every model, fabric and price here is made up. The
 * shape is the API's own `GET /v1/catalog` payload — camelCase, money in MINOR
 * units, dealer presentation ALREADY APPLIED — so the projection is exercised
 * across the boundary it really crosses.
 */

import type { CatalogPayload } from '../src/vm/client.ts';

export const catalogPayload: CatalogPayload = {
  currency: 'USD',
  dealer: { slug: null, mode: 'full', multiplier: 1 },
  collections: [
    {
      id: 'col-1',
      slug: 'duna',
      name: 'Duna',
      status: 'published',
      renderParams: {
        layout: { gridCm: 2, edgeSnapCm: 12, dockCm: 50, linkOverlapCm: { duna: 9 } },
        render: { fallback: 'placeholder' },
      },
      taxonomy: {},
      sortOrder: 0,
    },
    {
      id: 'col-2',
      slug: 'prototypes',
      name: 'Prototypes',
      status: 'draft',
      renderParams: {},
      taxonomy: {},
      sortOrder: 1,
    },
  ],
  models: [
    {
      id: 'm-fireside',
      collectionId: 'col-1',
      slug: 'fireside',
      name: 'Fireside',
      status: 'published',
      tags: ['fireside'],
      widthCm: 78,
      depthCm: 102,
      heightCm: 70,
      meshPath: 'meshes/fireside.glb',
      meshParams: { scale: 1 },
      mount: null,
      defaultRot: 0,
      sku: '12345678',
      sortOrder: 0,
      price: { amountMinor: 100000, currency: 'USD' },
      family: {
        root: '12345678',
        graded: true,
        grades: ['A', 'C'],
        byGrade: {
          A: { amountMinor: 100000, currency: 'USD', reference: '12345678A' },
          C: { amountMinor: 120000, currency: 'USD', reference: '12345678C' },
        },
      },
      partFamilies: null,
    },
    {
      id: 'm-ottoman',
      collectionId: 'col-1',
      slug: 'ottoman',
      name: 'Ottoman',
      status: 'published',
      tags: ['ottoman'],
      widthCm: 100,
      depthCm: 70,
      heightCm: 40,
      meshPath: null,
      meshParams: {},
      mount: null,
      defaultRot: 0,
      sku: '22345678',
      sortOrder: 1,
      price: { amountMinor: 60000, currency: 'USD' },
      family: null,
      partFamilies: null,
    },
    {
      // Drafts never reach a visitor.
      id: 'm-draft',
      collectionId: 'col-1',
      slug: 'prototype',
      name: 'Prototype',
      status: 'draft',
      tags: [],
      widthCm: 90,
      depthCm: 90,
      heightCm: null,
      meshPath: null,
      meshParams: {},
      mount: null,
      defaultRot: 0,
      sku: null,
      sortOrder: 2,
      price: null,
      family: null,
      partFamilies: null,
    },
    {
      id: 'm-cushion',
      collectionId: 'col-1',
      slug: 'cushion',
      name: 'Cushion',
      status: 'published',
      tags: ['cushion'],
      widthCm: 50,
      depthCm: 50,
      heightCm: 20,
      meshPath: null,
      meshParams: {},
      mount: 'seat',
      defaultRot: 0,
      sku: '32345678',
      sortOrder: 3,
      price: { amountMinor: 12000, currency: 'USD' },
      family: null,
      partFamilies: null,
    },
    {
      // Another collection's model — it must not leak into Duna's palette.
      id: 'm-other',
      collectionId: 'col-2',
      slug: 'other',
      name: 'Other',
      status: 'published',
      tags: [],
      widthCm: 60,
      depthCm: 60,
      heightCm: 60,
      meshPath: null,
      meshParams: {},
      mount: null,
      defaultRot: 0,
      sku: '42345678',
      sortOrder: 0,
      price: { amountMinor: 5000, currency: 'USD' },
      family: null,
      partFamilies: null,
    },
  ],
  materials: [
    {
      id: 'mat-tissu',
      name: 'TISSU',
      category: 'fabric',
      sourceAdapter: 'pcon-ofml',
      params: {},
      colors: [
        { id: 'c1', code: 'B0021', name: 'Bleu Paon', grade: 'C', rgb: '#1d4a5a', texturePath: 'tex/tissu.jpg', normalPath: null, sortOrder: 0 },
        { id: 'c2', code: 'B0032', name: 'Sable', grade: 'C', rgb: '#c8b79a', texturePath: null, normalPath: null, sortOrder: 1 },
      ],
    },
    {
      id: 'mat-cuir',
      name: 'CUIR',
      category: 'leather',
      sourceAdapter: 'manual',
      params: {},
      colors: [
        { id: 'c3', code: 'L0100', name: 'Noir', grade: 'X', rgb: '#181818', texturePath: null, normalPath: null, sortOrder: 0 },
      ],
    },
  ],
  rulesets: [
    {
      collectionId: 'col-1',
      version: 2,
      status: 'active',
      rules: {
        schema: 1,
        params: { rotationStepDeg: 0 },
        rules: [
          { id: 'fabric-picked', type: 'option', severity: 'warning', require: [{ path: 'material.code', op: 'set' }] },
          { id: 'max-three', type: 'count', severity: 'error', max: 3 },
        ],
      },
    },
    {
      // A draft ruleset is the studio's business — it must never judge a design.
      collectionId: 'col-1',
      version: 3,
      status: 'draft',
      rules: { schema: 1, rules: [{ id: 'max-one', type: 'count', severity: 'error', max: 1 }] },
    },
  ],
  partRoles: [],
};
