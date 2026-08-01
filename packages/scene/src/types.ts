/**
 * Shared scene types — the DATA the engine consumes, and the shapes it injects.
 *
 * three.js itself is DEPENDENCY-INJECTED (CONTRACTS.md: a package's `src` may
 * only `import type` from 'three'), so every three object crossing this API is typed
 * structurally and loosely: the engine is code-split behind a dynamic import, the
 * callers pass the real namespace, and the tests pass small stubs. Tightening
 * these to the real `three` types would force every stub to implement the whole
 * module — the exact coupling the injection exists to avoid.
 */

/** The injected three.js namespace (`import * as THREE from 'three'`). */
export type ThreeApi = Record<string, any>;
/** A THREE.Object3D / Group / Mesh — whatever the injected namespace built. */
export type ThreeObject = any;
/** A THREE.Material (or an array of them, on a multi-material mesh). */
export type ThreeMaterial = any;
/** A THREE.Texture. */
export type ThreeTexture = any;

/** A point in the plan's 2D space (cm for a room, CSS px for a silhouette). */
export interface Point2 { x: number; y: number }

/**
 * A piece's model descriptor: where its real mesh lives plus the manual
 * orientation/scale overrides the loader can't infer. `url` is resolved by the
 * caller (a dealer upload beats a static manifest) — the engine only reads it.
 */
export interface ModelDescriptor {
  url?: string;
  upAxis?: 'y' | 'z' | string;
  rotateY?: number;
  scale?: number;
}

/** A loaded model as the builder wants it: the parsed object + its descriptor. */
export interface LoadedModel {
  object: ThreeObject;
  desc?: ModelDescriptor | null;
}

/**
 * The dealer-confirmed part tagging stored alongside a model (jsonb in the app).
 * Opaque to the engine — every read goes through the injected `PartsTaxonomy`,
 * which is what owns the rules.
 */
export interface PartsData {
  mats?: Record<string, string>;
  merges?: Record<string, string>;
  finishes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One option of a part group's finish palette (metal legs, a lacquered base). */
export interface FinishOption {
  id: string;
  label: string;
  rgb: string;
  /** 0–1 continuous metalness; absent = dielectric. */
  metal?: number;
  rough?: number;
}

/** A part group's finish palette, normalized by the taxonomy. */
export interface FinishSpec {
  label: string | null;
  options: FinishOption[];
  default: string | null;
}

/** One mesh node as the taxonomy sees it: its source material name + world size. */
export interface PartNode {
  materialName?: string | null;
  size?: readonly [number, number, number] | number[] | null;
}

/**
 * THE PART TAXONOMY, injected.
 *
 * Every rule about what a mesh IS — its key, its role, which group it merges
 * into, which finish palette it carries — belongs to `@veta/materials`
 * (CONTRACTS.md: `PART_ROLES`, `partKeyFor`, `partRoleFor`, `baseKeyOf`,
 * `hasParts`, `partKeysFor`). Scene owns the three.js side only, so the rules
 * arrive as one object rather than being re-decided here.
 *
 * `DEFAULT_PARTS_TAXONOMY` binds materials' real functions and fills the three
 * lookups materials does not export yet (`mergedKeyOf`, `finishSpecOf`,
 * `finishOptionOf`) with the answers an unmerged, unfinished model gives — so
 * omitting the parameter renders the dealer's confirmed tagging correctly and
 * only merges/finish palettes need wiring.
 */
export interface PartsTaxonomy {
  /** The taggable roles. A role NOT in this list is silence, not a decision. */
  readonly PART_ROLES: readonly string[];
  /** "Fabric~2" → "Fabric" (the material key a split cluster belongs to). */
  baseKeyOf(partKey: string): string;
  /** A node's stable key: its source material name, else a positional fallback. */
  partKeyFor(materialName: string | null | undefined, nodeIndex: number): string;
  /** Keys for every node of a model, in traversal order (may split by shape). */
  partKeysFor(nodes: readonly PartNode[]): string[];
  /** The role a node plays. Untagged reads as 'base'. */
  partRoleFor(
    parts: PartsData | null | undefined,
    materialName: string | null | undefined,
    nodeIndex: number,
    partKey?: string,
  ): string;
  /** Whether the model carries any non-base tagging. */
  hasParts(parts: PartsData | null | undefined): boolean;
  /** The group a key really belongs to, after following the dealer's merges. */
  mergedKeyOf(parts: PartsData | null | undefined, key: string): string;
  /** A group's finish palette, or null when it has none. */
  finishSpecOf(parts: PartsData | null | undefined, key: string): FinishSpec | null;
  /** The option a pick resolves to — picked id, else default, else the first. */
  finishOptionOf(spec: FinishSpec | null | undefined, optionId?: string | null): FinishOption | null;
}

/**
 * The footprint a real model is placed into: its catalogue size, its collection
 * (which decides the seam bleed), its tagging, and the build-scoped material
 * factories the group owns.
 */
export interface PlacementFootprint {
  widthCm?: number | null;
  depthCm?: number | null;
  collection?: string | null;
  parts?: PartsData | null;
  partFinishes?: Record<string, string> | null;
  materialForRole?: (role: string) => ThreeMaterial;
  finishMaterialFor?: (groupKey: string, option: FinishOption) => ThreeMaterial | null;
}

/** A piece as the scene spec describes it (plan cm; x/z are world, y is up). */
export interface ScenePiece {
  x?: number;
  z?: number;
  /** Clockwise screen rotation in degrees — negated onto the world Y axis. */
  rotationDeg?: number;
  widthCm?: number | null;
  depthCm?: number | null;
  /** Seat-mounted accessories ride at their platform height. */
  mountHeightCm?: number | null;
  collection?: string | null;
  fabricCode?: string | null;
  label?: string | null;
  /** Procedural-fallback form hint (arm count), when the caller resolved one. */
  form?: { armCount?: number } | null;
  parts?: PartsData | null;
  partFinishes?: Record<string, string> | null;
  partMaterials?: Record<string, { code?: string | null } | null> | null;
  [key: string]: unknown;
}

/** The whole scene spec: the placed pieces, already centred by the caller. */
export interface SceneSpec {
  pieces?: ScenePiece[] | null;
  [key: string]: unknown;
}

/** A room boundary in plan centimetres (world = plan cm 1:1, plan-y → world-Z). */
export interface RoomSpec {
  shape?: string;
  corners?: Point2[] | null;
}
