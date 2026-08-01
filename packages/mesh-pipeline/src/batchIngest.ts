/**
 * BATCH FOLDER INGEST — many model files into ONE aggregated piece list.
 *
 * pCon.planner has no batch export: converting a manufacturer's DWGs, the dealer
 * gets ONE FILE PER MODEL, so a whole collection arrives as a folder of thirty
 * files rather than as one laid-out scene. Each file still goes through the same
 * load + cluster pipeline as a single drop (a converted file can itself hold
 * several pieces), and everything found lands in one list for one review pass.
 *
 * Files are walked STRICTLY SEQUENTIALLY: one CAD export is tens of MB of
 * geometry, and parsing thirty in parallel is how the tab dies with the dealer's
 * afternoon of conversions in it.
 *
 * A file that won't parse NEVER aborts the batch — dropping a folder must yield
 * the twenty-nine good models, not a dead run because one DWG converted badly.
 * Casualties come back in `failed` so a review list can name them and the dealer
 * knows exactly which ones to redo.
 *
 * SOME PRODUCTS BRING THEIR OWN MATERIALS: a product folder holds the mesh AND
 * the bitmaps its materials name. Those ride the same drop, are paired to the
 * mesh of THEIR folder (sidecarTextures), and get baked into the exported GLB —
 * so an Intervalle imports as walnut and green lacquer instead of a grey shell.
 *
 * The LOADER IS INJECTED: reading a file is browser plumbing (object URLs, the
 * three loaders, a LoadingManager), while everything here — the sequence, the
 * sidecar pairing, the casualty collection, the taxonomy proposals — is engine
 * logic that must be testable without a DOM.
 */
import type { LibraryLayout } from './library/types.ts';
import { lrArchvizLayout } from './library/lrArchviz.ts';
import type { FileLike } from './sidecarTextures.ts';
import { TEXTURE_EXT_RE, dirOf, relPathOf, texturesByFolder } from './sidecarTextures.ts';
import type { Object3DLike, ThreeLike } from './three.ts';
import type { ScenePiece, SplitSceneOpts, UpAxis } from './splitScene.ts';
import { splitScene } from './splitScene.ts';

/**
 * What the loaders cover. The batch checks this BEFORE touching a file so a
 * stray PDF/DWG caught by a folder multi-select is refused for free, instead of
 * paying a loader import to fail on it.
 */
export const MODEL_EXT_RE = /\.(fbx|glb|gltf|obj|dae|3ds)$/i;

/**
 * A file name read as a piece name — the same cleaning the single-file drop
 * does. Converting one DWG at a time, the dealer names the OUTPUT after the
 * article ("Prado_2-plazas.glb"), so for a one-piece file the filename beats
 * anything inside the export (a CAD tool writes block ids as node names).
 */
export const nameFromFile = (fileName: unknown): string =>
  String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

/** A loaded scene and the three namespace its objects belong to. */
export interface LoadedScene {
  THREE: ThreeLike;
  object: Object3DLike;
}

export interface IngestPiece<F extends FileLike = FileLike> extends ScenePiece {
  /**
   * PER FILE, never per batch: a folder mixes exports from different CAD
   * sessions and different source DWGs, so one model can be y-up and the next
   * z-up. One axis for the whole run lays half of them down.
   */
  upAxis: UpAxis;
  /**
   * The original file rides along so a review list can show which conversion a
   * piece came from (two files can both fall back to "Piece 1") and so a
   * one-piece file can be uploaded VERBATIM instead of re-exported.
   */
  sourceFile: F;
  sourceName: string;
  /** Taxonomy PROPOSALS off where the file sits in the library — null per level
   *  when the drop can't tell, and always distinct from whatever the dealer ends
   *  up typing in the review step. */
  folderGroup: string | null;
  folderCategory: string | null;
  folderCollection: string | null;
}

/** Why one file didn't make it. The CODE is the durable part; the message is a
 *  default a caller may replace with its own copy. */
export type IngestFailureCode = 'unsupported' | 'no-pieces' | 'unreadable';

export interface IngestFailure {
  name: string;
  code: IngestFailureCode;
  error: string;
}

const DEFAULT_MESSAGES: Record<IngestFailureCode, string> = {
  unsupported: 'Not a 3D model (.fbx, .glb, .obj, .dae, .3ds).',
  'no-pieces': 'No pieces detected — was the 3D geometry exported?',
  unreadable: 'The file could not be read.',
};

export interface BatchIngestDeps<F extends FileLike = FileLike> {
  /**
   * Read ONE file into an Object3D, with its folder's sidecar bitmaps in hand.
   * The caller owns the loaders (GLTFLoader / OBJLoader / FBXLoader /
   * ColladaLoader / TDSLoader), the object URLs and the texture bundling.
   */
  loadScene(file: F, ctx: { textures: F[] }): Promise<LoadedScene>;
  /** How this drop's paths are read; defaults to the LR ARCHVIZ layout. */
  layout?: LibraryLayout<any>;
  /** Fired BEFORE each file starts; `done` counts the files already finished. */
  onProgress?(progress: { done: number; total: number; current: string }): void;
  /** Per-code copy, for a surface that speaks to the dealer in its own language. */
  messages?: Partial<Record<IngestFailureCode, string>>;
  splitOpts?: SplitSceneOpts;
}

export interface BatchIngestResult<F extends FileLike = FileLike> {
  /** The three namespace the returned meshes belong to — null only when nothing
   *  loaded at all, so it is always present when `pieces` is non-empty. */
  THREE: ThreeLike | null;
  pieces: IngestPiece<F>[];
  failed: IngestFailure[];
}

/** The taxonomy proposals for ONE dropped file. `shape` is the layout's plan for
 *  the whole drop — pass it whenever the caller HAS the batch (that is what
 *  makes every sibling file in one drop read identically); omit it on a genuine
 *  single-file drop, where the layout derives the one path's own shape. */
export const libraryProposalFor = (
  file: FileLike,
  layout: LibraryLayout<any> = lrArchvizLayout,
  shape?: unknown,
) => layout.parsePath(relPathOf(file), shape);

/** How many DISTINCT groups/categories/collections a piece list proposes — the
 *  one line a review step shows above the rows. */
export function summarizeFolderProposals(
  pieces: readonly Pick<IngestPiece, 'folderGroup' | 'folderCategory' | 'folderCollection'>[],
): { groups: number; categories: number; collections: number } {
  const groups = new Set<string>();
  const categories = new Set<string>();
  const collections = new Set<string>();
  for (const p of pieces || []) {
    if (p?.folderGroup) groups.add(p.folderGroup);
    if (p?.folderCategory) categories.add(p.folderCategory);
    if (p?.folderCollection) collections.add(p.folderCollection);
  }
  return { groups: groups.size, categories: categories.size, collections: collections.size };
}

/**
 * Walk a dropped batch: sequential parse, casualties collected not thrown.
 */
export async function loadPiecesFromFiles<F extends FileLike>(
  files: Iterable<F> | ArrayLike<F> | null | undefined,
  deps: BatchIngestDeps<F>,
): Promise<BatchIngestResult<F>> {
  const { loadScene, layout = lrArchvizLayout, onProgress, messages, splitOpts } = deps;
  const list: F[] = Array.from((files || []) as ArrayLike<F>);
  const messageFor = (code: IngestFailureCode) => messages?.[code] || DEFAULT_MESSAGES[code];

  // The drop splits in two BEFORE anything is read: the meshes, and the bitmaps
  // that dress them. A sidecar is not a model and must never surface as a
  // casualty — "couldn't read: DCMAP1.JPG" would name the dealer's own textures
  // as broken files, and the progress counter would count them as work.
  const models = list.filter((f) => !TEXTURE_EXT_RE.test(f?.name || ''));
  const texturesByDir = texturesByFolder(list);

  const pieces: IngestPiece<F>[] = [];
  const failed: IngestFailure[] = [];
  let THREE: ThreeLike | null = null;
  let done = 0;

  // ONE DROP, ONE SHAPE. The taxonomy levels are read POSITIONALLY, and where
  // they sit is a property of the TREE, not of any one path — so the batch is
  // measured once, here, and every file is filed against the same plan. Measured
  // over EVERY dropped path (not just the parsable ones): a `.jpg` sitting
  // beside the models still hangs off the same tree and still says where its
  // levels are.
  const shape = layout.resolveShape(list.map(relPathOf));

  for (const file of models) {
    onProgress?.({ done, total: models.length, current: file.name });
    let code: IngestFailureCode = 'unreadable';
    try {
      if (!MODEL_EXT_RE.test(file.name)) {
        code = 'unsupported';
        throw new Error(messageFor('unsupported'));
      }
      // ITS OWN folder's bitmaps, nobody else's. A manufacturer ships one
      // product per folder and reuses the same DOS map names (DCMAP1.JPG) across
      // the whole library, so pairing by anything wider than the exact folder
      // dresses a shelf in the sofa next door's fabric.
      const loaded = await loadScene(file, { textures: texturesByDir.get(dirOf(relPathOf(file))) || [] });
      // three is module-cached behind the caller's dynamic import, so every file
      // yields the SAME namespace — hold the first one and hand it back for the
      // re-export.
      THREE = THREE || loaded.THREE;
      const split = splitScene(loaded.THREE, loaded.object, splitOpts);
      if (!split.pieces.length) {
        code = 'no-pieces';
        throw new Error(messageFor('no-pieces'));
      }
      // One file, one piece = the normal per-article conversion → the filename
      // IS the model name. Several pieces means the dealer laid a few articles
      // out in one plan, and there the clustered node names are all we have.
      const single = split.pieces.length === 1;
      // Read ONCE per file, against the BATCH's shape: every piece split out of
      // it came from the same file at the same place in the library, so they all
      // inherit the same group/category/collection proposal.
      const lib = libraryProposalFor(file, layout, shape);
      for (const p of split.pieces) {
        pieces.push({
          ...p,
          name: (single && nameFromFile(file.name)) || p.name,
          folderGroup: lib.group,
          folderCategory: lib.category,
          folderCollection: lib.collection,
          upAxis: split.upAxis,
          sourceFile: file,
          sourceName: file.name,
        });
      }
    } catch (e: any) {
      failed.push({ name: file.name, code, error: e?.message || messageFor(code) });
    }
    done++;
  }

  return { THREE, pieces, failed };
}
