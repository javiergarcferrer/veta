/**
 * FIDELIDAD — «¿este modelo se ve como se tiene que ver?», as a BLOCK of the
 * Estudio's inspector, not as a screen of its own.
 *
 * It used to be a whole pane (a second 3D canvas beside the Gestor's table) and
 * that was one surface too many: the owner asked three times for ONE dashboard.
 * So the ANSWERS moved here — the same six checks, rendered at the top of the
 * workbench's inspector, over the build THE STUDIO'S OWN STAGE just did. There
 * is exactly ONE WebGL context on the page and it is the stage the dealer is
 * already orbiting.
 *
 * WHAT THIS FILE STILL OWNS:
 *   • `resolveChecks` — PURE, unchanged, and the only place the six verdicts are
 *     written. Its caller feeds it a `BuildReport` of what its build actually
 *     produced; while a build is in flight the render-derived rows read `idle`
 *     rather than reporting the previous model's findings as this one's.
 *   • `meshVersionFor` — the GLB's own `alcoverMeshV` stamp, read off the BYTES
 *     (glTF `asset.extras`, which the loader doesn't keep) and memoized per URL
 *     for the session, so «Optimizar mallas» has a per-model truth.
 *
 * WHAT IT NO LONGER OWNS: the live 3D pane, its engine, its fabric bolt strip,
 * the estado/«Estudio» buttons, and «Foto de producto» — the path-traced
 * product still, retired 2026-08 at the owner's word. It was the file's only
 * reason to build a second, DRESSED scene (and the only reason the app carried
 * three-gpu-pathtracer + three-mesh-bvh at all). The stage IS the live view; the estado pill
 * lives on the model's own table row, one click away in the same grid.
 */
import { AlertTriangle, Check, Minus, X } from 'lucide-react';
import { ALCOVER_MESH_V } from './togoModelLoader.js';
import { readGlbMeshVersion } from './sceneImport.js';

/* ── The shapes this module reads ────────────────────────────────────────────
 * Structural on purpose: `row` is a `resolveModelManager` row and `resolved` an
 * entry of `resolveTogoModels().resolvedById`, both produced by JS/TS modules
 * the View must not re-derive. Typed to what is USED here (and no wider), so a
 * contract change surfaces at the call site instead of silently type-checking. */

/** The per-code appearance descriptor the configurador upholsters from. Kept
 *  because `resolveChecks` reads it to explain a tela verdict; the merged
 *  inspector has no bolt strip (the stage renders part tints, not cloth), so it
 *  passes null and the tela row reads its honest "sin tela" state. */
export type FabricDescriptor = {
  textureUrl: string | null;
  normalUrl?: string | null;
  rgb: string | null;
  tint?: boolean;
  pbr?: {
    dif: string | null; rough: number | null; spec: number | null;
    tileCm: number | null; tileCmY: number | null;
  } | null;
};

/** What the checks need off a `resolveModelManager` row. */
export type FidelityRow = {
  id: string;
  name: string;
  collection: string;
  estado: string;
  meshKind: string;
  skuBound: boolean;
  partsRoles: string[];
  partsSkuCount: number;
  ownFinishes: boolean;
  svg: boolean;
  widthCm: number;
  depthCm: number;
};

/** What they need off `resolveTogoModels().resolvedById[id]` — notably `parts`
 *  WITH the colección's estructura palette already injected. */
export type FidelityResolved = {
  widthCm?: number | null;
  depthCm?: number | null;
  collection?: string | null;
  mesh?: { url?: string | null; scale?: number | null; upAxis?: string | null; rotateY?: number | null } | null;
  parts?: unknown;
  unitPrice?: number | null;
  reference?: string | null;
};

export type FidelityLevel = 'ok' | 'warn' | 'bad' | 'idle';
export type FidelityCheck = { key: string; label: string; level: FidelityLevel; detail: string };

/* ── The mesh-pipeline stamp, per URL ───────────────────────────────────────*/

export type MeshVersion = number | null;   // null = unreadable (offline, foreign host, not a GLB)
const meshVersions = new Map<string, MeshVersion>();

/**
 * The GLB's own `alcoverMeshV`, memoized per URL for the session.
 *
 * Read off the BYTES rather than the parsed model because that stamp lives in
 * glTF `asset.extras`, which the mesh loader doesn't keep — and because the
 * bytes are already in the browser's HTTP cache the moment the mesh renders, so
 * the answer costs a cache hit, once per model, ever.
 */
export async function meshVersionFor(url: string): Promise<MeshVersion> {
  if (meshVersions.has(url)) return meshVersions.get(url) ?? null;
  let v: MeshVersion = null;
  try {
    if (/\.glb$/i.test(url.split(/[?#]/)[0])) {
      const res = await fetch(url);
      if (res.ok) v = readGlbMeshVersion(await res.arrayBuffer());
    }
  } catch { v = null; }
  meshVersions.set(url, v);
  return v;
}

/* ── What a build produced ──────────────────────────────────────────────────*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Engine = any;

/**
 * The facts a build OBSERVED, handed in by whoever built. The studio's stage
 * fills it from its own load (mesh parsed or not, how many meshes, which of
 * them brought a factory texture, which groups a palette actually dresses); a
 * surface that upholsters would fill the two fabric halves too.
 */
export type BuildReport = {
  meshLoaded: boolean;
  meshCount: number;
  factoryMeshes: number;
  finishMaterials: number;
  fabricWithScan: boolean;
  fabricPixels: boolean;
};

/* ── The panel ──────────────────────────────────────────────────────────────*/

type Props = {
  row: FidelityRow | null;
  resolved: FidelityResolved | null;
  /** What the caller's build produced. Null = nothing built yet. */
  report: BuildReport | null;
  /** A build in flight — the render-derived rows go idle rather than lie. */
  building?: boolean;
  /** The GLB's pipeline stamp; `undefined` while it's being read. */
  meshV?: MeshVersion | undefined;
};

export default function ModelFidelityPanel({ row, resolved, report, building = false, meshV }: Props) {
  if (!row) {
    return (
      <div className="border-b border-ink-200 px-3 py-3 text-[11px] leading-snug text-ink-400">
        Elige un modelo de la tabla para editarlo y revisar si trajo su malla, su textura y su acabado.
      </div>
    );
  }

  const checks = resolveChecks({ row, resolved, report, meshV, code: '', fab: null, building });

  return (
    <section className="space-y-2 border-b border-ink-200 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="label mb-0">Fidelidad</span>
        <span className="text-[10px] text-ink-400">Como lo ve el cliente</span>
      </div>

      <ul className="space-y-1">
        {checks.map((c) => <li key={c.key}><CheckRow check={c} /></li>)}
      </ul>

    </section>
  );
}

/* ── The checks ─────────────────────────────────────────────────────────────*/

/**
 * The six answers, in the order a broken model breaks: geometry, then its
 * pipeline, then what is painted on it, then whether it can be sold.
 *
 * Pure over the build report, so what is displayed is what was OBSERVED. While a
 * build is in flight the render-derived rows read `idle` rather than reporting a
 * stale group's findings as this model's.
 */
export function resolveChecks({
  row, resolved, report, meshV, code, fab, building,
}: {
  row: FidelityRow;
  resolved: FidelityResolved | null;
  report: BuildReport | null;
  meshV: MeshVersion | undefined;
  code: string;
  fab: FabricDescriptor | null;
  building: boolean;
}): FidelityCheck[] {
  const meshUrl = resolved?.mesh?.url ? String(resolved.mesh.url) : '';
  // A build in flight has no findings yet — reporting the PREVIOUS group's would
  // attribute one model's textures to another.
  const rep: BuildReport | null = building ? null : report;

  const malla: FidelityCheck = !meshUrl
    ? { key: 'malla', label: 'Malla', level: 'warn', detail: 'Sin modelo 3D — se dibuja la forma genérica.' }
    : rep == null
      ? { key: 'malla', label: 'Malla', level: 'idle', detail: 'Cargando…' }
      : rep.meshLoaded
        ? { key: 'malla', label: 'Malla', level: 'ok', detail: `${row.meshKind === 'glb' ? 'GLB' : 'Archivo fuente'} cargado · ${rep.meshCount} mallas.` }
        : { key: 'malla', label: 'Malla', level: 'bad', detail: 'No cargó: el cliente ve la forma genérica, no la pieza.' };

  const optim: FidelityCheck = !meshUrl
    ? { key: 'optim', label: 'Optimizada', level: 'idle', detail: 'No aplica.' }
    : row.meshKind !== 'glb'
      ? { key: 'optim', label: 'Optimizada', level: 'warn', detail: 'El slot tiene un export fuente, no un GLB servible.' }
      : meshV === undefined
        ? { key: 'optim', label: 'Optimizada', level: 'idle', detail: 'Leyendo el archivo…' }
        : meshV == null
          ? { key: 'optim', label: 'Optimizada', level: 'idle', detail: 'No se pudo leer el sello del archivo.' }
          : meshV >= ALCOVER_MESH_V
            ? { key: 'optim', label: 'Optimizada', level: 'ok', detail: `Malla v${meshV}: normales, soldado y cuantización ya horneados.` }
            : { key: 'optim', label: 'Optimizada', level: 'warn', detail: `Malla v${meshV} — «Optimizar mallas» la aligera y se suaviza en el navegador.` };

  const factory: FidelityCheck = rep == null
    ? { key: 'factory', label: 'Material propio', level: 'idle', detail: 'Cargando…' }
    : rep.factoryMeshes > 0
      ? { key: 'factory', label: 'Material propio', level: 'ok', detail: `${rep.factoryMeshes} malla${rep.factoryMeshes === 1 ? '' : 's'} con la textura de fábrica (madera, laca…).` }
      : { key: 'factory', label: 'Material propio', level: 'idle', detail: 'Sin texturas propias: se viste completo con la tela.' };

  const tela: FidelityCheck = !code
    ? { key: 'tela', label: 'Tela', level: 'idle', detail: 'Sin tela — cuerpo base del configurador.' }
    : rep == null
      ? { key: 'tela', label: 'Tela', level: 'idle', detail: 'Cargando…' }
      : rep.fabricWithScan
        ? (rep.fabricPixels
          ? { key: 'tela', label: 'Tela', level: 'ok', detail: `Textura real aplicada (#${code})${fab?.tint ? ', teñida de la familia' : ''}.` }
          : { key: 'tela', label: 'Tela', level: 'bad', detail: `La textura de #${code} se enlazó pero llegó vacía.` })
        : fab?.textureUrl
          ? { key: 'tela', label: 'Tela', level: 'bad', detail: `La textura de #${code} no cargó: se pintó color plano.` }
          : fab
            ? { key: 'tela', label: 'Tela', level: 'warn', detail: `#${code} no tiene textura enlazada: color plano.` }
            : { key: 'tela', label: 'Tela', level: 'warn', detail: `#${code} no está en la biblioteca: solo el tono del muestrario.` };

  const estructura: FidelityCheck = rep == null
    ? { key: 'estructura', label: 'Estructura', level: 'idle', detail: 'Cargando…' }
    : rep.finishMaterials > 0
      ? {
        key: 'estructura',
        label: 'Estructura',
        level: 'ok',
        detail: `${rep.finishMaterials} acabado${rep.finishMaterials === 1 ? '' : 's'} aplicado${rep.finishMaterials === 1 ? '' : 's'}${row.ownFinishes ? '' : ' (paleta de la colección)'}.`,
      }
      : row.partsRoles.includes('structure')
        ? { key: 'estructura', label: 'Estructura', level: 'warn', detail: 'Hay partes marcadas Estructura pero ninguna paleta las viste.' }
        : { key: 'estructura', label: 'Estructura', level: 'idle', detail: 'Sin partes de estructura.' };

  const sku: FidelityCheck = row.skuBound
    ? {
      key: 'sku',
      label: 'SKU',
      level: 'ok',
      detail: `Base vinculada${row.partsSkuCount ? ` · ${row.partsSkuCount} SKU de partes` : ''}${resolved?.unitPrice ? '' : ' (sin precio resuelto)'}.`,
    }
    : row.partsSkuCount > 0
      ? { key: 'sku', label: 'SKU', level: 'warn', detail: `Sin SKU base; ${row.partsSkuCount} parte${row.partsSkuCount === 1 ? '' : 's'} sí vinculada${row.partsSkuCount === 1 ? '' : 's'}.` }
      : { key: 'sku', label: 'SKU', level: 'bad', detail: 'Sin vincular: la pieza no puede cotizarse.' };

  return [malla, optim, factory, tela, estructura, sku];
}

const LEVEL_ICON = { ok: Check, warn: AlertTriangle, bad: X, idle: Minus } as const;
const LEVEL_CLASS: Record<FidelityLevel, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  idle: 'text-ink-400',
};

function CheckRow({ check }: { check: FidelityCheck }) {
  const Icon = LEVEL_ICON[check.level];
  return (
    <div className="flex items-start gap-2 text-[11px] leading-snug">
      <Icon size={13} className={`mt-px shrink-0 ${LEVEL_CLASS[check.level]}`} aria-hidden />
      <span className="w-[5.6rem] shrink-0 font-medium text-ink-700">{check.label}</span>
      <span className="min-w-0 text-ink-500">{check.detail}</span>
    </div>
  );
}
