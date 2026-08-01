/**
 * THE MEMBER-PLANE ADAPTER — ⚠️ TYPED AND MOCKED, NOT YET VERIFIED.
 *
 * The studio is a MEMBER-plane app: every request rides the signed-in user's
 * JWT and lands under RLS, never a service-role key (that key belongs to no
 * request path — `withTenant` in `@veta/api` is the only tenant plane the API
 * itself uses). This adapter is the shape that will carry it.
 *
 * WHAT IS REAL HERE: the mapping — which table, which columns, which bucket,
 * how a `StudioModel` becomes a row and back. That is the part worth writing
 * now, because it is the part the workflow's types have to agree with.
 *
 * WHAT IS NOT: any of it has run against a live project. The queries are
 * written against a STRUCTURAL client interface (`SupabaseLike`) rather than
 * `@supabase/supabase-js` — the package is not a dependency of this app, and
 * inventing one to type a stub would be a lie in the manifest. Wire it by
 * passing the real client (it satisfies the interface structurally) once a
 * project and its migrations exist, and only then delete this warning.
 *
 * Nothing else in the app may import this module's client type — the workflow
 * knows `StudioStore` and nothing more.
 */
import type { StudioModel } from '../vm/types.ts';
import type { StoredPalette, StudioStore, UploadedMesh } from './types.ts';

/** The slice of a supabase-js client this adapter uses. The real client
 *  satisfies it structurally; a test double is ten lines. */
export interface SupabaseLike {
  from(table: string): PostgrestLike;
  storage: { from(bucket: string): StorageBucketLike };
}

export interface PostgrestLike {
  select(columns?: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  upsert(rows: unknown, options?: { onConflict?: string }): {
    select(columns?: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  delete(): { eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }> };
}

export interface StorageBucketLike {
  upload(path: string, body: ArrayBuffer | Blob, options?: { contentType?: string; upsert?: boolean }):
    PromiseLike<{ data: { path: string } | null; error: { message: string } | null }>;
  remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
}

export interface SupabaseStudioStoreOptions {
  modelsTable?: string;
  palettesTable?: string;
  meshBucket?: string;
  /** The org this session authors for. RLS enforces it server-side; sending it
   *  is what lets an insert land in the right tenant at all. */
  orgId: string;
  now?: () => number;
}

/* ── Row mapping ────────────────────────────────────────────────────────────*/

/** The stored row shape (snake_case, jsonb for the authored bags). */
export interface StudioModelRow {
  id: string;
  org_id: string;
  name: string;
  collection: string | null;
  group_name: string | null;
  category: string | null;
  mesh_url: string | null;
  mesh_up_axis: string | null;
  mesh_scale: number | null;
  mesh_rotate_y: number | null;
  mesh_version: number | null;
  mesh_bytes: number | null;
  mesh_source_url: string | null;
  mesh_source_name: string | null;
  plan_svg: string | null;
  width_cm: number | null;
  depth_cm: number | null;
  product_root: string | null;
  parts: unknown;
  status: string;
  published_at: string | null;
  updated_at: string | null;
}

const iso = (ms: number | null | undefined): string | null =>
  (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);
const ms = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function toRow(model: StudioModel, orgId: string): StudioModelRow {
  return {
    id: model.id,
    org_id: orgId,
    name: model.name,
    collection: model.collection || null,
    group_name: model.group,
    category: model.category,
    mesh_url: model.mesh?.url ?? null,
    mesh_up_axis: model.mesh?.upAxis ?? null,
    mesh_scale: model.mesh?.scale ?? null,
    mesh_rotate_y: model.mesh?.rotateY ?? null,
    mesh_version: model.mesh?.meshVersion ?? null,
    mesh_bytes: model.mesh?.bytes ?? null,
    mesh_source_url: model.mesh?.sourceUrl ?? null,
    mesh_source_name: model.mesh?.sourceName ?? null,
    plan_svg: model.plan?.svg ?? null,
    width_cm: model.plan?.widthCm ?? null,
    depth_cm: model.plan?.depthCm ?? null,
    product_root: model.productRoot,
    parts: model.parts ?? null,
    status: model.status,
    published_at: iso(model.publishedAt),
    updated_at: iso(model.updatedAt),
  };
}

export function fromRow(row: StudioModelRow): StudioModel {
  const upAxis = row.mesh_up_axis === 'z' ? 'z' : 'y';
  return {
    id: row.id,
    name: row.name || '',
    collection: row.collection || '',
    group: row.group_name,
    category: row.category,
    mesh: row.mesh_url
      ? {
        url: row.mesh_url,
        upAxis,
        scale: row.mesh_scale,
        rotateY: row.mesh_rotate_y,
        meshVersion: row.mesh_version,
        bytes: row.mesh_bytes,
        sourceUrl: row.mesh_source_url,
        sourceName: row.mesh_source_name,
      }
      : null,
    plan: row.plan_svg
      ? { svg: row.plan_svg, widthCm: Number(row.width_cm) || 0, depthCm: Number(row.depth_cm) || 0 }
      : null,
    productRoot: row.product_root,
    parts: (row.parts as StudioModel['parts']) ?? null,
    status: row.status === 'published' ? 'published' : 'draft',
    publishedAt: ms(row.published_at),
    updatedAt: ms(row.updated_at) ?? 0,
  };
}

/* ── The adapter ────────────────────────────────────────────────────────────*/

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data == null) throw new Error(`${what}: no data returned`);
  return res.data;
}

/** ⚠️ MOCKED — see the module header. The mapping is real; the wiring is not. */
export function createSupabaseStudioStore(
  client: SupabaseLike,
  {
    modelsTable = 'studio_models',
    palettesTable = 'studio_palettes',
    meshBucket = 'studio-meshes',
    orgId,
    now = () => Date.now(),
  }: SupabaseStudioStoreOptions,
): StudioStore {
  const models = () => client.from(modelsTable);
  const palettes = () => client.from(palettesTable);
  const bucket = () => client.storage.from(meshBucket);

  const saveRows = async (rows: StudioModel[]): Promise<StudioModel[]> => {
    if (!rows.length) return [];
    const stamped = rows.map((m) => toRow({ ...m, updatedAt: now() }, orgId));
    const data = unwrap(await models().upsert(stamped, { onConflict: 'id' }).select('*'), 'saveModel');
    return (data as StudioModelRow[]).map(fromRow);
  };

  return {
    async listModels() {
      const data = unwrap(await models().select('*'), 'listModels');
      return (data as StudioModelRow[]).map(fromRow);
    },
    async saveModel(model) {
      const [saved] = await saveRows([model]);
      return saved ?? model;
    },
    async saveModels(list) {
      return saveRows([...(list || [])]);
    },
    async deleteModel(id) {
      const { error } = await models().delete().eq('id', id);
      if (error) throw new Error(`deleteModel: ${error.message}`);
    },
    async uploadMesh(fileName, bytes, contentType = 'model/gltf-binary'): Promise<UploadedMesh> {
      const safe = String(fileName || 'model').replace(/[^a-zA-Z0-9._-]+/g, '-');
      const path = `${orgId}/${now()}-${safe}`;
      const up = await bucket().upload(path, bytes, { contentType, upsert: false });
      if (up.error) throw new Error(`uploadMesh: ${up.error.message}`);
      return { url: bucket().getPublicUrl(up.data?.path || path).data.publicUrl, bytes: bytes.byteLength };
    },
    async removeMesh(url) {
      // Best effort by design: a URL a sibling row still points at must not be
      // reclaimed, and only the caller knows the reference count.
      const path = url.split(`${meshBucket}/`).pop() || '';
      if (!path) return;
      await bucket().remove([path]);
    },
    async fetchMesh(url) {
      const path = url.split(`${meshBucket}/`).pop() || '';
      const res = await bucket().download(path);
      if (res.error || !res.data) throw new Error(`fetchMesh: ${res.error?.message || 'not found'}`);
      return res.data.arrayBuffer();
    },
    async listPalettes() {
      const data = unwrap(await palettes().select('*'), 'listPalettes');
      return data as StoredPalette[];
    },
    async savePalette(palette) {
      const data = unwrap(
        await palettes().upsert([{ ...palette, org_id: orgId, updated_at: iso(now()) }], { onConflict: 'id' }).select('*'),
        'savePalette',
      );
      return (data as StoredPalette[])[0] ?? palette;
    },
  };
}
