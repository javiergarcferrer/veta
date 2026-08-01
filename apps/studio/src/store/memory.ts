/**
 * THE IN-MEMORY STORE — a real implementation, not a stub.
 *
 * It is what the tests run against and what the shell boots with when no
 * adapter is configured, so it has to behave like the real thing where the
 * workflow can tell the difference: an upsert returns the STORED row (the
 * caller adopts it), a save stamps `updatedAt`, mesh bytes are held so an
 * optimize pass can read them back, and every read hands out COPIES — a caller
 * mutating what it listed must not silently edit the store.
 *
 * Clock and id generator are injected so a test's expectations are exact.
 */
import type { StudioModel } from '../vm/types.ts';
import type { StoredPalette, StudioStore, UploadedMesh } from './types.ts';

export interface MemoryStoreOptions {
  models?: readonly StudioModel[];
  palettes?: readonly StoredPalette[];
  now?: () => number;
  /** Only used for mesh URLs; models arrive with their own ids. */
  uid?: () => string;
}

export interface MemoryStore extends StudioStore {
  /** Everything held, for assertions. Copies, like every other read. */
  snapshot(): { models: StudioModel[]; palettes: StoredPalette[]; meshes: string[] };
  /** How many bytes a stored URL holds — the optimize tests' scale. */
  meshBytes(url: string): number;
}

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)) as T);

export function createMemoryStore({
  models = [],
  palettes = [],
  now = () => Date.now(),
  uid = () => `mesh-${Math.random().toString(36).slice(2, 10)}`,
}: MemoryStoreOptions = {}): MemoryStore {
  const rows = new Map<string, StudioModel>(models.map((m) => [m.id, clone(m)]));
  const paletteRows = new Map<string, StoredPalette>(palettes.map((p) => [p.id, clone(p)]));
  const meshes = new Map<string, ArrayBuffer>();

  const put = (model: StudioModel): StudioModel => {
    const stored: StudioModel = { ...clone(model), updatedAt: now() };
    rows.set(stored.id, stored);
    return clone(stored);
  };

  return {
    async listModels() {
      return [...rows.values()].map(clone);
    },
    async saveModel(model) {
      return put(model);
    },
    async saveModels(list) {
      return (list || []).map(put);
    },
    async deleteModel(id) {
      rows.delete(id);
    },
    async uploadMesh(fileName, bytes): Promise<UploadedMesh> {
      const safe = String(fileName || 'model').replace(/[^a-zA-Z0-9._-]+/g, '-');
      const url = `memory://${uid()}/${safe}`;
      meshes.set(url, bytes.slice(0));
      return { url, bytes: bytes.byteLength };
    },
    async removeMesh(url) {
      meshes.delete(url);
    },
    async fetchMesh(url) {
      const buf = meshes.get(url);
      // The same failure a 404 is: the caller collects it as this model's
      // casualty and the batch carries on.
      if (!buf) throw new Error(`No mesh stored at ${url}`);
      return buf.slice(0);
    },
    async listPalettes() {
      return [...paletteRows.values()].map(clone);
    },
    async savePalette(palette) {
      const stored: StoredPalette = { ...clone(palette), updatedAt: now() };
      paletteRows.set(stored.id, stored);
      return clone(stored);
    },
    snapshot() {
      return {
        models: [...rows.values()].map(clone),
        palettes: [...paletteRows.values()].map(clone),
        meshes: [...meshes.keys()],
      };
    },
    meshBytes(url) {
      return meshes.get(url)?.byteLength ?? 0;
    },
  };
}
