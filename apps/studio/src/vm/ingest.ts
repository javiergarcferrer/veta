/**
 * INGEST — a dropped folder becomes a review list of pieces.
 *
 * The heavy half (`loadPiecesFromFiles` → per-file parse → `splitScene` →
 * `exportPieceGlb`) is `@veta/mesh-pipeline`'s and runs in a Web Worker. This
 * module is the ORCHESTRATION around it, and it is pure so the whole workflow
 * can be tested without a DOM:
 *
 *   • `planIngest` — what the drop CONTAINS before anything is parsed: models vs
 *     sidecar bitmaps, the library layout's taxonomy proposal per file (one
 *     SHAPE measured over the whole drop, so every sibling file files
 *     identically), and the one summary line a review step shows above the rows.
 *   • `runIngest` — the batch itself, with the two effectful steps injected
 *     (`loadScene` reads a file, `finishPiece` turns a split piece into its
 *     transferable payload). A file that won't parse is a CASUALTY, never an
 *     abort: dropping a folder must yield the twenty-nine good models.
 *   • `reduceIngest` — worker events folded into the state the shell renders.
 *   • `ingestDrafts` — accepted pieces become draft models.
 */
import {
  MODEL_EXT_RE,
  TEXTURE_EXT_RE,
  dirOf,
  libraryProposalFor,
  loadPiecesFromFiles,
  lrArchvizLayout,
  nameFromFile,
  relPathOf,
  summarizeFolderProposals,
  texturesByFolder,
} from '@veta/mesh-pipeline';
import type {
  BatchIngestDeps,
  FileLike,
  IngestFailure,
  IngestPiece,
  LibraryLayout,
  ThreeLike,
} from '@veta/mesh-pipeline';
import type { MeasuredNode, PlanRef, StudioModel, UpAxis } from './types.ts';
import { emptyModel } from './types.ts';

export type { IngestFailure };

/** The taxonomy a path proposes. Always distinct from whatever the dealer
 *  eventually types — a proposal is never a decision. */
export interface FolderProposal {
  group: string | null;
  category: string | null;
  collection: string | null;
}

export interface IngestPlanRow {
  file: FileLike;
  /** The file name read as a piece name (the per-article conversion case). */
  name: string;
  path: string;
  proposal: FolderProposal;
}

export interface IngestPlan {
  /** Files that will be parsed. */
  models: FileLike[];
  /** Sidecar bitmaps — never parsed, never counted as work, never a casualty. */
  textures: FileLike[];
  /** Files that are neither (a PDF caught by a folder multi-select). */
  rejected: FileLike[];
  rows: IngestPlanRow[];
  summary: { groups: number; categories: number; collections: number };
  layoutId: string;
}

/**
 * Read a drop WITHOUT touching a byte of it.
 *
 * ONE DROP, ONE SHAPE: the taxonomy levels are read positionally and where they
 * sit is a property of the TREE, not of any one path, so the layout is measured
 * once over EVERY dropped path (bitmaps included — a `.jpg` beside the models
 * still hangs off the same tree) and every file is filed against that plan.
 */
export function planIngest(
  files: Iterable<FileLike> | ArrayLike<FileLike> | null | undefined,
  layout: LibraryLayout<any> = lrArchvizLayout,
): IngestPlan {
  const list: FileLike[] = Array.from((files || []) as ArrayLike<FileLike>);
  const textures = list.filter((f) => TEXTURE_EXT_RE.test(f?.name || ''));
  const rest = list.filter((f) => !TEXTURE_EXT_RE.test(f?.name || ''));
  const models = rest.filter((f) => MODEL_EXT_RE.test(f?.name || ''));
  const rejected = rest.filter((f) => !MODEL_EXT_RE.test(f?.name || ''));
  const shape = layout.resolveShape(list.map(relPathOf));
  const rows: IngestPlanRow[] = models.map((file) => {
    const lib = libraryProposalFor(file, layout, shape);
    return {
      file,
      name: nameFromFile(file.name),
      path: relPathOf(file),
      proposal: { group: lib.group, category: lib.category, collection: lib.collection },
    };
  });
  return {
    models,
    textures,
    rejected,
    rows,
    summary: summarizeFolderProposals(rows.map((r) => ({
      folderGroup: r.proposal.group,
      folderCategory: r.proposal.category,
      folderCollection: r.proposal.collection,
    }))),
    layoutId: layout.id,
  };
}

/** Which sidecar bitmaps belong to a given model file — ITS OWN folder's,
 *  nobody else's (a manufacturer reuses `DCMAP1.JPG` across a whole library). */
export function texturesFor(files: readonly FileLike[], file: FileLike): FileLike[] {
  return texturesByFolder(files as FileLike[]).get(dirOf(relPathOf(file))) || [];
}

/** One piece, as it crosses back from the worker: everything the review list and
 *  the parts detector need, plus the GLB bytes (a transferable). */
export interface IngestedPiece {
  id: string;
  name: string;
  sourceName: string;
  upAxis: UpAxis;
  widthCm: number;
  depthCm: number;
  proposal: FolderProposal;
  /** Measured mesh nodes — what `vm/parts` classifies, so detect never has to
   *  re-download and re-parse what ingest already had open. */
  nodes: MeasuredNode[];
  plan: PlanRef | null;
  /** The re-exported, stamped GLB. Null when the piece rides its source file
   *  verbatim (a single-piece GLB drop). */
  glb: ArrayBuffer | null;
  bytes: number;
}

/** The effectful half, injected — both halves need three.js, which is why they
 *  are parameters and not imports. */
export interface IngestDeps {
  loadScene: BatchIngestDeps<FileLike>['loadScene'];
  /** Turn one split piece into its transferable payload. */
  finishPiece(piece: IngestPiece<FileLike>, three: ThreeLike, index: number): Promise<Omit<IngestedPiece, 'proposal'>>;
  layout?: LibraryLayout<any>;
  onProgress?(p: { done: number; total: number; current: string }): void;
  onPiece?(piece: IngestedPiece): void;
  onFailure?(failure: IngestFailure): void;
}

export interface IngestRunResult {
  pieces: IngestedPiece[];
  failed: IngestFailure[];
}

/**
 * Walk a drop: parse sequentially (one CAD export is tens of MB and parsing
 * thirty in parallel kills the thread that holds the dealer's afternoon), then
 * finish each piece.
 *
 * A piece that cannot be finished — the export throws, the geometry is empty —
 * is a casualty of ITS FILE, exactly like an unparsable file: collected, named,
 * never thrown.
 */
export async function runIngest(
  files: Iterable<FileLike> | ArrayLike<FileLike> | null | undefined,
  deps: IngestDeps,
): Promise<IngestRunResult> {
  const { loadScene, finishPiece, layout = lrArchvizLayout, onProgress, onPiece, onFailure } = deps;
  const batch = await loadPiecesFromFiles<FileLike>(files, { loadScene, layout, onProgress });
  const failed: IngestFailure[] = [...batch.failed];
  for (const f of batch.failed) onFailure?.(f);
  const pieces: IngestedPiece[] = [];
  if (!batch.THREE) return { pieces, failed };
  let index = 0;
  for (const piece of batch.pieces) {
    try {
      const finished = await finishPiece(piece, batch.THREE, index++);
      const out: IngestedPiece = {
        ...finished,
        proposal: {
          group: piece.folderGroup,
          category: piece.folderCategory,
          collection: piece.folderCollection,
        },
      };
      pieces.push(out);
      onPiece?.(out);
    } catch (e) {
      const failure: IngestFailure = {
        name: piece.sourceName || piece.name,
        code: 'unreadable',
        error: (e as Error)?.message || 'The piece could not be exported.',
      };
      failed.push(failure);
      onFailure?.(failure);
    }
  }
  return { pieces, failed };
}

/* ── The shell's state ──────────────────────────────────────────────────────*/

export interface IngestState {
  running: boolean;
  done: number;
  total: number;
  current: string;
  pieces: IngestedPiece[];
  failed: IngestFailure[];
}

export type IngestEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; done: number; total: number; current: string }
  | { type: 'piece'; piece: IngestedPiece }
  | { type: 'failed'; failure: IngestFailure }
  | { type: 'done' };

export function initialIngestState(): IngestState {
  return { running: false, done: 0, total: 0, current: '', pieces: [], failed: [] };
}

/** Worker events folded into what the review list renders. Immutable, and a
 *  progress event never moves the counter BACKWARDS — messages from a run that
 *  was already superseded must not rewind a live one. */
export function reduceIngest(state: IngestState, event: IngestEvent): IngestState {
  switch (event.type) {
    case 'start':
      return { ...initialIngestState(), running: true, total: Math.max(0, event.total) };
    case 'progress':
      return {
        ...state,
        running: true,
        total: event.total || state.total,
        done: Math.max(state.done, event.done),
        current: event.current || '',
      };
    case 'piece':
      return { ...state, pieces: [...state.pieces, event.piece] };
    case 'failed':
      return { ...state, failed: [...state.failed, event.failure] };
    case 'done':
      return { ...state, running: false, current: '', done: state.total || state.done };
    default:
      return state;
  }
}

/**
 * Accepted pieces → draft models. The mesh is deliberately NOT attached here:
 * the bytes still have to be uploaded, and a model row pointing at a URL that
 * does not exist yet is the one shape every later check would read as valid.
 * The caller attaches `mesh` once the upload returns.
 */
export function ingestDrafts(
  pieces: readonly IngestedPiece[] | null | undefined,
  now: number,
  idFor: (piece: IngestedPiece, index: number) => string = (p) => p.id,
): StudioModel[] {
  return (pieces || []).map((p, i) => {
    const model = emptyModel(idFor(p, i), p.name, now);
    return {
      ...model,
      collection: p.proposal.collection || '',
      group: p.proposal.group,
      category: p.proposal.category,
      plan: p.plan,
    };
  });
}
