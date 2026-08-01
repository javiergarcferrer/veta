/**
 * THE STORE SEAM — the studio's only door to persistence, and it is INJECTED.
 *
 * Nothing in `vm/*` or `ui/*` knows what a table is called or which plane the
 * request rides. The shell takes a `StudioStore` and the tests take the
 * in-memory one, which is why the whole workflow is testable end to end without
 * a project, a network or a key.
 *
 * Two implementations ship:
 *   • `createMemoryStore` — real, complete, deterministic (tests + a demo shell);
 *   • `createSupabaseStudioStore` — the MEMBER-plane adapter, typed and mocked.
 *     Marked clearly: wiring it needs a live project, and until then it must not
 *     pretend to be verified.
 */
import type { StudioModel } from '../vm/types.ts';

/** A shared finish palette, owned by a collection rather than by a model. */
export interface StoredPalette {
  id: string;
  collection: string;
  /** The part group key it applies to; null = the collection's structure palette. */
  groupKey: string | null;
  label: string | null;
  options: { id: string; label: string; rgb: string; metal?: number; rough?: number }[];
  default: string | null;
  updatedAt: number;
}

/** An uploaded mesh, as the store reports it back. */
export interface UploadedMesh {
  url: string;
  bytes: number;
}

/**
 * Everything the studio needs to persist. Deliberately small: one list, one
 * save, one delete per kind, plus the bytes. A surface that needs a narrower
 * read adds a `resolve*` over `listModels`, never a new query here.
 */
export interface StudioStore {
  listModels(): Promise<StudioModel[]>;
  /** Upsert. Returns the row as stored, so the caller adopts server-side
   *  defaults (timestamps, generated ids) instead of guessing them. */
  saveModel(model: StudioModel): Promise<StudioModel>;
  /** A fan-out is MANY rows and one intent — saved together so a half-applied
   *  palette can't leave a collection disagreeing with itself. */
  saveModels(models: readonly StudioModel[]): Promise<StudioModel[]>;
  deleteModel(id: string): Promise<void>;

  /** Store mesh bytes and hand back a servable URL. `bytes` is the transferable
   *  the worker produced — the caller never re-reads the file. */
  uploadMesh(fileName: string, bytes: ArrayBuffer, contentType?: string): Promise<UploadedMesh>;
  /** Best-effort reclaim. A URL a sibling row still points at is the caller's
   *  problem to ref-count, exactly as it is server-side. */
  removeMesh(url: string): Promise<void>;
  /** The bytes back, for an optimize pass over what is already published. */
  fetchMesh(url: string): Promise<ArrayBuffer>;

  listPalettes(): Promise<StoredPalette[]>;
  savePalette(palette: StoredPalette): Promise<StoredPalette>;
}
