/**
 * INGEST WORKER — parse and split a dropped folder, off the main thread.
 *
 * One CAD export is tens of megabytes of geometry; parsing a library of them on
 * the UI thread is what made the reference studio's import feel like a hang. The
 * ORCHESTRATION (sequence, sidecar pairing, casualty collection, taxonomy
 * proposals) is `vm/ingest`'s and is pure; this file supplies the three effects
 * it cannot have: reading a file, measuring the meshes, and re-exporting each
 * piece as a stamped GLB.
 *
 * WHAT CROSSES BACK is deliberately everything the next step needs and nothing
 * more: the GLB bytes (transferred, never copied), the piece's plan and
 * footprint, and the MEASURED MESH NODES. Those nodes are what `vm/parts`
 * classifies, so "detect parts" never has to re-download and re-parse a file
 * ingest already had open.
 *
 * A file that will not parse is a CASUALTY, never an abort: dropping a folder
 * has to yield the twenty-nine good models.
 */
import { meshPlanFromVertices } from '@veta/geometry';
import { bundleTextures, collectMeshes, exportPieceGlb } from '@veta/mesh-pipeline';
import type { FileLike, IngestPiece, MeshLike, ThreeLike } from '@veta/mesh-pipeline';
import { runIngest } from '../vm/ingest.ts';
import type { IngestedPiece } from '../vm/ingest.ts';
import type { MeasuredNode, PlanRef, UpAxis } from '../vm/types.ts';
import type { IngestRequest, IngestResponse, MeasureRequest, MeasureResponse } from './protocol.ts';
import { transfersOf, workerScope } from './protocol.ts';
import { loadThree, sceneRootOf } from './threeDeps.ts';

const scope = workerScope();

const reply = (message: IngestResponse | MeasureResponse): void => {
  scope.postMessage(message, transfersOf(message));
};

scope.addEventListener('message', (event) => {
  const req = event.data as IngestRequest | MeasureRequest;
  if (req?.kind === 'ingest') { void run(req); return; }
  if (req?.kind === 'measure') { void measure(req); }
});

/** Re-read ONE published GLB for its nodes and its plan — what makes «detect
 *  parts» work on a model ingested before parts existed. */
async function measure(req: MeasureRequest): Promise<void> {
  try {
    const three = await loadThree();
    const object = await three.parseGlb(req.buffer);
    if (!object) throw new Error('The file could not be read.');
    object.updateMatrixWorld(true);
    const meshes = collectMeshes(object);
    if (!meshes.length) throw new Error('The file carries no geometry.');
    reply({
      kind: 'measure-done',
      id: req.id,
      nodes: measureNodes(three.THREE, meshes),
      plan: planOf(meshes, req.upAxis),
    });
  } catch (e) {
    reply({ kind: 'measure-failed', id: req.id, error: (e as Error)?.message || 'Measure failed.' });
  }
}

/** A dropped `File` with its tree path re-attached (see `IngestRequest.paths`). */
function fileLike(file: File, path: string): FileLike {
  return {
    name: file.name,
    relPath: path || file.name,
    arrayBuffer: () => file.arrayBuffer(),
  };
}

async function run(req: IngestRequest): Promise<void> {
  try {
    const three = await loadThree();
    const files = req.files.map((f, i) => fileLike(f, req.paths?.[i] || ''));

    await runIngest(files, {
      onProgress: (p) => reply({ kind: 'ingest-progress', id: req.id, ...p }),
      onFailure: (failure) => reply({ kind: 'ingest-failed-file', id: req.id, failure }),
      onPiece: (piece) => reply({ kind: 'ingest-piece', id: req.id, piece }),

      async loadScene(file, ctx) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        // Its OWN folder's bitmaps, resolved by basename through the loading
        // manager — a manufacturer reuses `DCMAP1.JPG` across a whole library.
        const bundle = bundleTextures(three.THREE, ctx.textures);
        try {
          const loader = await three.loaderFor(ext, bundle.manager);
          if (!loader) throw new Error(`No loader for .${ext}`);
          const buffer = await file.arrayBuffer();
          const parsed = ext === 'obj' || ext === 'dae'
            ? loader.parse(new TextDecoder().decode(new Uint8Array(buffer)), '')
            : await parseBinary(loader, ext, buffer);
          const object = sceneRootOf(ext, parsed);
          if (!object) throw new Error('The file parsed to nothing.');
          // A loader resolves the moment the MESH is parsed, while the texture
          // reads finish on their own callbacks — reading the maps at that
          // instant gives image-less shells, indistinguishable from "the bitmap
          // was missing".
          await bundle.settled();
          return { THREE: three.THREE, object };
        } finally {
          bundle.dispose();
        }
      },

      async finishPiece(piece: IngestPiece<FileLike>, THREE: ThreeLike, index: number) {
        const nodes = measureNodes(THREE, piece.meshes);
        const plan = planOf(piece.meshes, piece.upAxis);
        const glb = await exportPieceGlb(THREE, piece.meshes, {
          exporter: three.exporter(),
          utils: three.utils,
        });
        const out: Omit<IngestedPiece, 'proposal'> = {
          id: `${req.id}-${index}`,
          name: piece.name,
          sourceName: piece.sourceName,
          upAxis: piece.upAxis as UpAxis,
          widthCm: plan?.widthCm || piece.widthCm,
          depthCm: plan?.depthCm || piece.depthCm,
          nodes,
          plan,
          glb,
          bytes: glb.byteLength,
        };
        return out;
      },
    });
    reply({ kind: 'ingest-done', id: req.id });
  } catch (e) {
    reply({ kind: 'ingest-error', id: req.id, error: (e as Error)?.message || 'Ingest failed.' });
  }
}

async function parseBinary(loader: any, ext: string, buffer: ArrayBuffer): Promise<any> {
  if (ext === 'glb' || ext === 'gltf') return loader.parseAsync(buffer, '');
  return loader.parse(buffer, '');
}

/**
 * One box + material name per mesh node, IN TRAVERSAL ORDER — the exact input
 * `partKeysFor` needs, and the order matters: unnamed materials key by node
 * index, so a shifted index re-tags one part as another.
 */
function measureNodes(THREE: ThreeLike, meshes: readonly MeshLike[]): MeasuredNode[] {
  return meshes.map((m) => {
    const box = new THREE.Box3().setFromObject(m as any);
    const min: [number, number, number] = [box.min.x, box.min.y, box.min.z];
    const max: [number, number, number] = [box.max.x, box.max.y, box.max.z];
    const material: any = Array.isArray((m as any).material) ? (m as any).material[0] : (m as any).material;
    return {
      materialName: material?.name ? String(material.name) : null,
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
  });
}

/** The piece's world-space triangles, de-indexed, as the flat array
 *  `meshPlanFromVertices` eats. */
function worldTriangles(meshes: readonly MeshLike[]): number[] {
  const out: number[] = [];
  for (const mesh of meshes) {
    const geometry: any = (mesh as any).geometry;
    const position = geometry?.attributes?.position;
    if (!position) continue;
    const matrix: any = (mesh as any).matrixWorld;
    const e = matrix?.elements;
    const push = (i: number): void => {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (!e) { out.push(x, y, z); return; }
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      out.push(
        (e[0] * x + e[4] * y + e[8] * z + e[12]) / w,
        (e[1] * x + e[5] * y + e[9] * z + e[13]) / w,
        (e[2] * x + e[6] * y + e[10] * z + e[14]) / w,
      );
    };
    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) push(index.getX(i));
    } else {
      for (let i = 0; i < position.count; i++) push(i);
    }
  }
  return out;
}

/** The 2D plan, derived from the SAME geometry that was just exported — so a
 *  tile can never disagree with the 3D it came from. */
function planOf(meshes: readonly MeshLike[], upAxis: string): PlanRef | null {
  const tris = worldTriangles(meshes);
  if (tris.length < 9) return null;
  const plan = meshPlanFromVertices(tris, { upAxis: upAxis === 'z' ? 'z' : 'y' });
  return plan ? { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm } : null;
}
