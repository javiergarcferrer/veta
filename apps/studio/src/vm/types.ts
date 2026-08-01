/**
 * THE STUDIO DOMAIN — what an authoring session is about.
 *
 * One brand-agnostic row (`StudioModel`) plus the three measured shapes the
 * workers hand back. Everything else in `vm/*` is a pure function over these;
 * the React shell only renders what a `resolve*` returned.
 *
 * Deliberately NOT the storage schema: the store adapter maps this to whatever
 * a tenant's tables look like (`store/types.ts`), so the workflow never learns
 * a column name.
 */
import type { PartsMap } from '@veta/materials';

/** Which axis a CAD export calls "up". Per FILE, never per batch (batchIngest). */
export type UpAxis = 'y' | 'z';

/** A model's dealer-confirmed part tagging — the `@veta/materials` shape,
 *  renamed here because in the studio it is always a DRAFT being edited. */
export type PartsDraft = PartsMap;

/** Where a model's servable mesh lives, and how it is oriented. */
export interface MeshRef {
  url: string;
  upAxis: UpAxis;
  /** Manual overrides the loader can't infer; null = derive. */
  scale?: number | null;
  rotateY?: number | null;
  /** The GLB's own pipeline stamp, when it has been read off the bytes. */
  meshVersion?: number | null;
  bytes?: number | null;
  /** The untouched upload, kept as provenance (a multi-piece drop shares it). */
  sourceUrl?: string | null;
  sourceName?: string | null;
}

/** The 2D plan a tile renders — the mesh seen from above, viewBox = real cm. */
export interface PlanRef {
  svg: string;
  widthCm: number;
  depthCm: number;
}

/** One mesh node as the workers measure it: the material name the part tagger
 *  keys off, and its world box. `min`/`max` are in the SOURCE file's units and
 *  the SOURCE axis convention — `vm/parts` remaps and unit-scales them. */
export interface MeasuredNode {
  materialName: string | null;
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export type ModelStatus = 'draft' | 'published';

/**
 * One authored model. `parts` is the confirmed tagging (roles, bound part SKU
 * roots, billed counts, merges, labels, finish palettes); `productRoot` is the
 * BASE product binding, which is what makes the piece quotable at all.
 */
export interface StudioModel {
  id: string;
  name: string;
  /** The model family (Togo, Prado…) — the unit a finish palette belongs to. */
  collection: string;
  group: string | null;
  category: string | null;
  mesh: MeshRef | null;
  plan: PlanRef | null;
  productRoot: string | null;
  parts: PartsDraft | null;
  status: ModelStatus;
  publishedAt: number | null;
  updatedAt: number;
}

/** A blank model — every optional field explicitly null, so a draft written by
 *  one surface reads identically everywhere else. */
export function emptyModel(id: string, name: string, now: number): StudioModel {
  return {
    id,
    name,
    collection: '',
    group: null,
    category: null,
    mesh: null,
    plan: null,
    productRoot: null,
    parts: null,
    status: 'draft',
    publishedAt: null,
    updatedAt: now,
  };
}
