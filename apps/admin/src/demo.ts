/**
 * A demo network, so the built shell opens on something clickable.
 *
 * DATA ONLY. No rule is stated here and nothing imports it but `main.tsx` — a
 * seed that starts encoding behaviour is a second source of truth, which is
 * exactly what `vm/*` exists to prevent.
 */
import type { MemoryAdminStoreOptions } from './store/memory.ts';

export function demoSeed(): MemoryAdminStoreOptions {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-08-01T12:00:00.000Z');

  return {
    dealers: [
      {
        id: 'dealer-sd',
        slug: 'santo-domingo',
        name: 'Santo Domingo',
        status: 'active',
        locale: 'es',
        currency: 'USD',
        pricing: { mode: 'full', multiplier: 1.35 },
        contact: { email: 'ventas@sd.example' },
        updatedAt: now,
      },
      {
        id: 'dealer-pc',
        slug: 'punta-cana',
        name: 'Punta Cana',
        status: 'active',
        locale: 'es',
        currency: 'USD',
        pricing: { mode: 'from', multiplier: 1.5 },
        contact: {},
        updatedAt: now,
      },
    ],
    locations: [
      {
        id: 'loc-naco',
        dealerId: 'dealer-sd',
        name: 'Showroom Naco',
        lat: 18.4735,
        lng: -69.9312,
        territory: { kind: 'radiusKm', radiusKm: 35 },
        address: { line1: 'Av. Tiradentes 32', city: 'Santo Domingo' },
        hours: { text: 'Lun–Sáb 9:00–19:00' },
        routingPriority: 1,
        updatedAt: now,
      },
      {
        id: 'loc-bavaro',
        dealerId: 'dealer-pc',
        name: 'Bávaro',
        lat: 18.582,
        lng: -68.4055,
        territory: null,
        address: { city: 'Punta Cana' },
        hours: { text: 'Lun–Vie 10:00–18:00' },
        routingPriority: 0,
        updatedAt: now,
      },
    ],
    models: [
      { id: 'model-corner', name: 'Corner', slug: 'corner', widthCm: 120, depthCm: 120, planSvg: null },
      { id: 'model-seat', name: 'Seat', slug: 'seat', widthCm: 100, depthCm: 95, planSvg: null },
      { id: 'model-ottoman', name: 'Ottoman', slug: 'ottoman', widthCm: 80, depthCm: 80, planSvg: null },
    ],
    leads: [
      {
        id: 'lead-1',
        dealerId: 'dealer-sd',
        contact: { name: 'Ana Pérez', email: 'ana@example.do', phone: '+18095551212' },
        note: 'Quiere el modular en gris claro',
        status: 'pending',
        verdict: { ok: true },
        estimate: { amountMinor: 452_000, currency: 'USD' },
        build: {
          pieces: [
            { uid: 'p1', modelId: 'model-corner', x: 0, y: 0, rot: 0 },
            { uid: 'p2', modelId: 'model-seat', x: 120, y: 0, rot: 0 },
            { uid: 'p3', modelId: 'model-seat', x: 220, y: 0, rot: 0 },
          ],
        },
        source: { routing: { policy: 'territory', outcome: 'routed', reason: 'territory:routed' } },
        createdAt: now - day,
      },
      {
        id: 'lead-2',
        dealerId: 'dealer-pc',
        contact: { name: 'Luis Fermín', email: 'luis@example.do' },
        note: null,
        status: 'contacted',
        verdict: { ok: false, violations: [{ message: 'Two corners cannot dock on the same edge' }] },
        estimate: { amountMinor: 318_500, currency: 'USD' },
        build: {
          pieces: [
            { uid: 'p1', modelId: 'model-corner', x: 0, y: 0, rot: 0 },
            { uid: 'p2', modelId: 'model-ottoman', x: 130, y: 20, rot: 45 },
          ],
        },
        source: { routing: { policy: 'nearest', outcome: 'routed', reason: 'nearest:routed', distanceKm: 12.4 } },
        createdAt: now - 2 * day,
      },
      {
        id: 'lead-3',
        dealerId: null,
        contact: { name: 'Marta Objío', phone: '+18295559090' },
        note: 'Llamó desde Santiago',
        status: 'pending',
        verdict: null,
        estimate: null,
        build: null,
        source: { routing: { policy: null, outcome: 'manual', reason: 'manual:manual' } },
        createdAt: now - 3 * day,
      },
    ],
    keys: [
      {
        id: 'key-pk',
        kind: 'publishable',
        prefix: 'pk_live_7ac1…',
        scopes: ['catalog:read', 'configurations:write', 'leads:write', 'events:write'],
        allowedOrigins: ['https://tienda.example'],
        createdAt: now - 30 * day,
        lastUsedAt: now - 2 * 60 * 60 * 1000,
        revokedAt: null,
      },
      {
        id: 'key-sk',
        kind: 'secret',
        prefix: 'sk_live_0b93…',
        scopes: ['catalog:read', 'leads:read'],
        allowedOrigins: [],
        createdAt: now - 20 * day,
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    routing: { cascade: ['territory', 'nearest', 'manual'], maxDistanceKm: 150 },
  };
}
