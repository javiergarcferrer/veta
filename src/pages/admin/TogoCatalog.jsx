import { useMemo, useState, useCallback, useEffect } from 'react';
import { Loader2, Check, AlertCircle, Shield, Link2, FolderOpen } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { uploadTogoMesh, removeTogoMesh } from '../../db/togoMeshUpload.js';
import { loadMeshPlan } from '../../lib/togo/meshPlanCache.js';
import {
  loadSceneFile, splitScene, exportPieceGlb, loadPiecesFromFiles,
  summarizeFolderProposals, ACCEPT_TEXTURES,
} from '../../components/togo/sceneImport.js';
import { relPathOf } from '../../brands/index.js';
import { groupFamilies } from '../../lib/catalog.js';
import { sanitizeSvg } from '../../lib/sanitizeSvg.js'; // SECURITY (L6): scrub untrusted SVG before innerHTML
import { PRODUCT_LIST_COLUMNS } from '../../lib/constants.js';
import {
  resolveModelManager, resolveTogoModelCards, resolveTogoModels, togoPickerFamilies,
} from '../../core/quote/index.js';
import { useTogoThumbnails } from '../../components/togo/togoThumbnails.js';
import EmptyState from '../../components/EmptyState.jsx';
import Modal from '../../components/Modal.jsx';
import ModelStudio, { ProductBindModal, ACCEPT_3D as ACCEPT_3D_SET } from '../../components/togo/ModelStudio.jsx';
import ModelManager from './ModelManager.jsx';
import useFileIntake, { supportsDirectoryPicker } from '../../components/primitives/useFileIntake.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';

// Exported so TogoWorkspace's workspace-wide drop target accepts the same set.
// One definition (the studio's) reaches both. Deliberately MESHES ONLY: the
// sidecar bitmaps below ride the folder zones as `sidecarAccept`, never as
// content, so a lone .jpg dropped on the workspace is still refused as "that
// isn't a model" instead of being handed to the importer.
export const ACCEPT_3D = ACCEPT_3D_SET;

// iOS/iPadOS Safari has no `webkitdirectory` at all — computed once (a
// browser capability, never changes at runtime) so the picker button can hide
// itself instead of offering a folder dialog that quietly can't pick folders.
const CAN_PICK_FOLDER = supportsDirectoryPicker();

// The «Grupo» datalist in the review step comes from the ACTIVE BRAND's geometry
// module (`modules.groups`) — VERBATIM, never re-cased here: the parser hands
// back those exact strings as its `group`, so a dealer picking from the list and
// the detector reading the path must land on the same one, or the same grupo
// ends up stored two ways. Offered, never enforced — the input stays free text,
// because a library folder we haven't seen still has to be typeable, and a brand
// whose library has no top division simply offers none.

/**
 * The "Modelos" section of the Togo workspace (TogoWorkspace) — the
 * dealer-managed catalog the configurator reads. This module is the section's
 * DATA half AND the owner of the one thing its three panes share: the SELECTED
 * MODEL. Admin-only; the workspace owns the masthead + section nav.
 *
 * ONE DASHBOARD, ONE GRID, nothing hidden behind anything (owner, three times
 * over: «merge the studio and the management side into one»). There is no
 * Gestor|Estudio switch, no drill-in, no «Volver al gestor» and no separate
 * fidelity screen — `ModelStudio` lays out ONE grid, two panes:
 *
 *      ┌───────────┬──────────────────────────┬────────────┐
 *      │  PIEZAS   │   ESCENARIO 3D           │  MALLA     │
 *      │  (lista,  │                          │  FIDELIDAD │
 *      │   a la    │                          │  PORTADA   │
 *      │   izq.)   ├──────────────────────────┴────────────┤
 *      │           │   FICHA · tarjetas en 2–3 columnas    │
 *      └───────────┴───────────────────────────────────────┘
 *
 * And ONE fold-out: «Tabla» gives the list the whole dashboard — every column,
 * selección múltiple, publicar en lote, «Completar con Claude» — then «Pieza»
 * folds it back. Same component, same rows, same selection; only the density
 * changes. That is `listMode`, and it lives here beside `selectedId` for the
 * same reason: two panes read it, so neither owns it.
 *
 * SELECTING A ROW IS OPENING IT. One click, and the stage and the inspector are
 * already on that piece — which only works because `selectedId` lives HERE and
 * both halves are controlled by it. Two components each holding their own
 * "current model" is exactly how the old master→detail split drifted.
 *
 * This component fetches everything the three panes share EXACTLY ONCE — the
 * model rows, the lazy LR catalog, the fabric links, the reorder writes and the
 * add-model flow — so the table's estado pill and the stage can never be
 * looking at two different snapshots of the same row.
 *
 * Upload a piece's 3D model (.fbx/.glb/…) → its top-down plan AND its footprint
 * are derived from the mesh IN THE BROWSER (meshToPlan), so the 2D tile and the
 * 3D view are always the same object → name it, bind it to a Ligne Roset product
 * for pricing, and save. The mesh is the single source — there is no separate 2D
 * import.
 *
 * Architecture: a model's BOUND state is a property of its own row (productRoot),
 * so the studio renders instantly from the tiny togo_models query. The full LR
 * products catalog (thousands of SKUs) is a LAZY dependency — loaded only when the
 * dealer actually opens a picker to bind/rebind (or adds/imports). Visiting the
 * section with everything already bound never pays the multi-second catalog load.
 */
export default function TogoModels({ droppedFile = null, onDroppedFileConsumed }) {
  // THE ACTIVE BRAND decides how a dropped library is read (its geometry
  // module) — the reads below need no brand plumbing of their own, the data
  // layer already scopes them (db/brandScope).
  const { isAdmin, profileId, brand, brandModules } = useApp();
  // The ACTIVE BRAND's sample-piece capability, if it has one (see below).
  const seeds = brandModules?.seeds || null;
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  // ── THE selection. The table sets it, the stage renders it, the inspector
  // edits it — one value, one owner, no handshake between panes.
  const [selectedId, setSelectedId] = useState(null);
  // The ids in the order the TABLE is showing them (its filters, search and
  // sort). «Anterior/siguiente» in the studio walks THIS, not the raw
  // catalogue — stepping out of the list you filtered to is never what you
  // meant. `setNavIds` is a plain state setter, so it is stable and the table's
  // publish effect can depend on it safely.
  const [navIds, setNavIds] = useState(null);

  // The LR catalog is fetched ONLY once a binding UI asks for it — or once the
  // dealer picks a first model, since the inspector's fidelity block prices the
  // piece it opens. Until then the query resolves null (cheap) and bound state
  // comes from each model's row.
  const [needCatalog, setNeedCatalog] = useState(false);
  const requestCatalog = useCallback(() => setNeedCatalog(true), []);
  const select = useCallback((modelId) => {
    setSelectedId(modelId || null);
    if (modelId) setNeedCatalog(true);
  }, []);
  // PROJECTED (PRODUCT_LIST_COLUMNS): neither the picker families nor the SKU
  // suggestions read the table's server-side search columns — the egress cut.
  const products = useLiveQuery(
    () => (needCatalog && profileId
      ? db.products.where('profileId').equals(profileId).columns(PRODUCT_LIST_COLUMNS).cached(300_000).toArray()
      : Promise.resolve(null)),
    [profileId, needCatalog], null,
  );
  const families = useMemo(() => togoPickerFamilies(products), [products]);
  // The bolts a COVER can be dressed in — the same `materials` the public
  // configurator loads, so the picker in the inspector can only offer cloth the
  // index will actually be able to render. Small table, read once.
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).cached(300_000).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const cards = useMemo(() => resolveTogoModelCards(models, families), [models, families]);
  // Distinct collections in first-appearance order (cards are pre-sorted by
  // sortOrder), for the "Colección" datalists.
  const collections = useMemo(() => [...new Set(cards.map((c) => c.collection))], [cards]);

  // ── The two projections the inspector's FIDELIDAD block reads, both looked up
  // by the one selection (lookups only — every derivation is in the VM).
  //
  // The manager row carries the storage facts (malla, SKU, partes, paleta
  // propia); `resolveTogoModels` carries what the CLIENT gets — notably `parts`
  // with the colección's estructura injected, which is what the «Foto de
  // producto» dresses the piece with. The publish gate is LIFTED for that read:
  // dropping `active === false` is a rule about the customer's palette, and the
  // whole point of this screen is reviewing drafts before they become live.
  const managerRows = useMemo(() => resolveModelManager(models || []).rows, [models]);
  const fidelityRow = useMemo(
    () => (selectedId ? managerRows.find((r) => r.id === selectedId) || null : null),
    [managerRows, selectedId],
  );
  const previewable = useMemo(
    () => (models || []).map((m) => (m?.active === false ? { ...m, active: true } : m)),
    [models],
  );
  const resolvedById = useMemo(
    () => resolveTogoModels(previewable, products).resolvedById,
    [previewable, products],
  );
  const fidelityResolved = selectedId ? (resolvedById[selectedId] || null) : null;

  // The stored Ligne Roset materials links (model_fabrics, keyed per family
  // root) — a tiny table; fetched once here so the inspector's "Telas" row can
  // show its live linked state.
  const fabricLinks = useLiveQuery(
    () => (profileId ? db.modelFabrics.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  // Reordering the configurador's palette lives ON THE TABLE now (ModelManager:
  // drag a row, or Alt+↑↓). It rides the same `planTogoReorder` and the same
  // per-row `update()` of `sortOrder` — fed the manager's own palette-ordered
  // rows, so what gets renumbered is exactly the sequence the dealer sees.

  const importSeeds = useCallback(async () => {
    // The seeds are the ACTIVE BRAND's OWN sample pieces, handed over by its
    // module set — never imported from here, which is what used to make one
    // manufacturer's sofa offerable inside another's environment. Lazy (they
    // carry inline SVG plans) and through safeDynamicImport, like every other
    // code-split load in the app.
    const seedRows = await safeDynamicImport(() => seeds.load());
    if (!seedRows?.length) return;
    // One-off direct fetch so seed auto-binding works without making the whole
    // tab eagerly load the catalog (this only runs from the empty state).
    // Projected like every other catalog read — seed auto-binding only needs
    // the family name + root.
    const prods = await db.products.where('profileId').equals(profileId).columns(PRODUCT_LIST_COLUMNS).toArray();
    const togoFams = groupFamilies(prods).filter((f) => /togo/i.test(f.name || ''));
    const autoRoot = (seed) => {
      const keys = (seed.match || []).filter((k) => k !== 'togo');
      const hit = togoFams.find((f) => { const n = (f.name || '').toLowerCase(); return keys.some((k) => k && n.includes(k)); });
      return hit ? hit.root : null;
    };
    const existing = new Set((models || []).map((m) => (m.name || '').toLowerCase()));
    const base = models?.length ? Math.max(...models.map((m) => m.sortOrder || 0)) + 1 : 0;
    let i = 0;
    for (const s of seedRows) {
      if (existing.has(s.name.toLowerCase())) continue;
      await db.togoModels.put({
        id: newId(), profileId, name: s.name, productRoot: autoRoot(s), productReference: null,
        widthCm: s.widthCm, depthCm: s.depthCm, svg: s.svg, sortOrder: base + i++,
        active: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  }, [models, profileId, seeds]);

  // A brand's sample pieces are ITS OWN FURNITURE, so the affordance exists
  // exactly where the module set declares one. Seeding another manufacturer's
  // empty catalog with someone else's sofa would be inventing data — an empty
  // brand shows an empty brand.
  const canSeed = !!seeds?.load;

  // ── WHICH LIST is up: the rail beside the stage, or the whole-dashboard
  // table. It lives HERE, next to the selection, because it decides two things
  // at once — how ModelManager renders and how ModelStudio lays its grid out —
  // and a value two components read is a value neither of them owns. NOT
  // persisted: it is a posture for the next thirty seconds («let me publish
  // these borradores»), and a dealer opening Modelos wants the piece.
  const [listMode, setListMode] = useState('rail');

  const [addOpen, setAddOpen] = useState(false);

  if (!isAdmin) {
    return <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo Togo." />;
  }

  const nextSort = cards.length ? Math.max(...cards.map((c) => c.sortOrder || 0)) + 1 : 0;

  return (
    <>
      {/* ONE surface. The studio lays out the grid and the table is its left
          column — handed in as a node rather than rendered beside it, so there
          is a single scroll/height budget for the whole dashboard and the table
          is literally where the rail used to be. */}
      <ModelStudio
        modules={brandModules}
        brandName={brand?.name || null}
        cards={cards}
        navIds={navIds}
        models={models}
        collections={collections}
        materials={materials}
        families={families}
        products={products}
        fabricLinks={fabricLinks}
        profileId={profileId}
        selectedId={selectedId}
        onSelect={select}
        fidelityRow={fidelityRow}
        fidelityResolved={fidelityResolved}
        onNeedCatalog={requestCatalog}
        onAddModel={() => setAddOpen(true)}
        onImportSeeds={canSeed ? importSeeds : null}
        listExpanded={listMode === 'tabla'}
        table={(
          <ModelManager
            models={models}
            selectedId={selectedId}
            onSelect={select}
            mode={listMode}
            onModeChange={setListMode}
            onAddModel={() => setAddOpen(true)}
            onImportSeeds={canSeed ? importSeeds : undefined}
            // The table's «Sugerir SKUs con Claude» narrows the catalog in the
            // browser exactly like the studio's own suggestion panel, so it
            // takes the SAME lazy read — never a second fetch of 27k rows.
            products={products}
            onNeedCatalog={requestCatalog}
            onOrderChange={setNavIds}
          />
        )}
      />

      {/* Always mounted (it always was): a model dropped anywhere on the
          workspace lands here through `droppedFile` and opens the flow over the
          dashboard — the dealer never has to find a view first. A saved piece
          SELECTS ITSELF, so the upload lands on the stage as the borrador it
          is, one click from published on its own row. */}
      <AddModelModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onOpenRequest={() => setAddOpen(true)}
        modules={brandModules}
        brandName={brand?.name || null}
        families={families}
        collections={collections}
        onNeedCatalog={requestCatalog}
        profileId={profileId}
        nextSort={nextSort}
        onCreated={select}
        droppedFile={droppedFile}
        onDroppedFileConsumed={onDroppedFileConsumed}
      />
    </>
  );
}

/**
 * The unified add-model flow — ONE drop zone for both a single piece and a full
 * multi-piece scene. Drop a 3D model (.fbx/.glb/…) and we load it once, cluster
 * its meshes on the floor plane (splitScene), and route by what we find:
 *   • ONE piece   → the single-model editor: derive the 2D plan + footprint from
 *                   the mesh, name it, bind it to an LR product for pricing, save.
 *   • MANY pieces → the batch review: pCon exports a whole plan into one file, so
 *                   a scene laid out with air between the pieces (> ~20 cm)
 *                   becomes N models in one drag, each re-exported as its own GLB.
 * The dealer never has to pick the right box first — if it's a single model, we
 * know. The mesh is the single source in both paths; there is no separate 2D
 * import.
 *
 * It is a modal now (it was the card at the top of the wall) but it stays MOUNTED
 * while closed: a model dropped anywhere on the workspace lands here through
 * `droppedFile`, and that has to work whether or not the dealer opened it first.
 * The flow itself is unchanged — same parse, same upload, same review, same
 * writes.
 */
function AddModelModal({
  open, onClose, onOpenRequest, modules, brandName = null, families, collections = [],
  onNeedCatalog, profileId, nextSort, onCreated, droppedFile = null, onDroppedFileConsumed,
}) {
  // ── THE BRAND'S GEOMETRY MODULE. Everything this flow knows about the shape
  // of a 3D library comes from here: which extensions are models, and what a
  // path says about a piece. Ligne Roset's module wraps the ARCHVIZ engine
  // verbatim, so a dealer dropping that tree gets exactly what he always did;
  // a brand on the generic module reads Collection/Model.glb instead.
  const geometry = modules?.geometry || null;
  const groupOptions = modules?.groups || [];
  const isModel = useCallback(
    (file) => (geometry ? geometry.accepts(file) : /\.(fbx|glb|gltf|obj|dae|3ds)$/i.test(String(file?.name || ''))),
    [geometry],
  );
  const modelHint = geometry?.extensions?.join(', ') || '.fbx, .glb, .obj';
  /** The taxonomy the brand's module reads out of one dropped path, against the
   *  batch's own shape. ONE reader for both the single-file and the folder
   *  flow, so two files from the same drop can never be filed differently. */
  const readTaxonomy = useCallback((file, shape) => (
    geometry ? geometry.parsePath(relPathOf(file), shape) : { group: null, category: null, collection: null, model: null, variant: null }
  ), [geometry]);
  const [stage, setStage] = useState('idle');   // idle | parsing | single | review | importing | done
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);   // a warning the flow survives (a truncated folder read)
  const [busy, setBusy] = useState(false);      // in-editor op (axis flip)

  // Single-piece editor state.
  const [plan, setPlan] = useState(null);       // { svg, widthCm, depthCm }
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  // The picked family's display name — ModelBrowser hands us the whole model,
  // so the trigger can label the choice without waiting on the catalog load.
  const [rootName, setRootName] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [meshUrl, setMeshUrl] = useState(null);
  // The ORIGINAL upload (pCon's export from the LR DWG), kept beside the
  // servable GLB so the conversion chain stays auditable — { url, name }.
  // url is null when the drop already WAS a GLB (it is its own source).
  const [source, setSource] = useState(null);
  const [upAxis, setUpAxis] = useState('y');
  const [saving, setSaving] = useState(false);

  // Multi-piece review state.
  const [scene, setScene] = useState(null);     // { THREE, upAxis, pieces: [{ name, widthCm, depthCm, meshes, include }] }
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [result, setResult] = useState(null);   // { created, failed: [names] }

  // Collection is the same concept in both flows (single field / "para todas").
  const [collection, setCollection] = useState('');

  // A single-item feed for the SAME thumbnail engine the configurator palette
  // uses, so the single-model preview shows the studio-rig 3D render beside the
  // derived plan. Hook stays unconditional (empty array until there's a mesh).
  const pendingThumbInput = useMemo(
    () => (meshUrl && plan
      ? [{ id: 'pending:' + meshUrl, name, widthCm: plan.widthCm, depthCm: plan.depthCm, mesh: { url: meshUrl, scale: null, upAxis, rotateY: 0 } }]
      : []),
    [meshUrl, plan, name, upAxis],
  );
  const pendingThumbs = useTogoThumbnails(pendingThumbInput);
  const pendingThumb = meshUrl ? pendingThumbs['pending:' + meshUrl] : null;

  // What the LIBRARY PATH proposed (never what the dealer has since typed) —
  // the one summary line above the review rows.
  const folderSummary = useMemo(() => summarizeFolderProposals(scene?.pieces), [scene]);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setError(null); setNotice(null); setResult(null); setPlan(null); setScene(null);
    setProgress({ done: 0, total: 0, current: '' });   // never show a previous batch's counter
    setMeshUrl((prev) => { if (prev) removeTogoMesh(prev); return null; });   // drop an orphan from a re-pick
    if (!isModel(file)) {
      setError(`Sube un modelo 3D o una escena (${modelHint}).`); setStage('idle'); return;
    }
    setStage('parsing');
    try {
      // Load the file once and cluster its meshes → we can tell a single piece
      // from a laid-out scene before asking the dealer anything.
      const { THREE, object } = await loadSceneFile(file);
      const split = splitScene(THREE, object);
      if (!split.pieces.length) {
        setError('No se detectaron piezas en el archivo. ¿Exportaste la geometría 3D?');
        setStage('idle'); return;
      }
      if (split.pieces.length === 1) {
        // The whole file IS the piece. What the configurator SERVES is a compact
        // GLB re-export — FBX parsing is the heaviest step in the load path — and
        // the original file rides along as the model's SOURCE, so the
        // DWG→pCon→export chain stays auditable and re-convertible. A GLB drop
        // is already its own source; it uploads once.
        const isGlb = /\.(glb|gltf)$/i.test(file.name);
        const glbFile = isGlb ? file : new File(
          [await exportPieceGlb(THREE, split.pieces[0].meshes)],
          file.name.replace(/\.[^.]+$/, '') + '.glb',
          { type: 'model/gltf-binary' },
        );
        const url = await uploadTogoMesh(glbFile);
        const p = await loadMeshPlan(url, { upAxis: split.upAxis });
        if (!p?.svg) { setError('El modelo no produjo una planta legible. ¿Está en cm y de pie?'); removeTogoMesh(url); setStage('idle'); return; }
        const srcUrl = isGlb ? null : await uploadTogoMesh(file).catch(() => null);
        setSource({ url: srcUrl, name: file.name });
        setMeshUrl(url); setUpAxis(split.upAxis); setPlan(p);
        setName((n) => n || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
        onNeedCatalog();
        setStage('single');
      } else {
        // A laid-out scene → the batch review; each detected piece becomes a model.
        // Every piece points at the ONE file it came from (uploaded once at
        // import, shared as the source of all its pieces).
        // One file IS its own batch, so its shape is read off itself.
        const lib = readTaxonomy(file, geometry?.resolveShape([relPathOf(file)]));
        setScene({
          THREE,
          upAxis: split.upAxis,
          pieces: split.pieces.map((p) => ({
            ...p, include: true, upAxis: split.upAxis, sourceFile: file, sourceName: file.name,
            folderGroup: lib.group, folderCategory: lib.category, folderCollection: lib.collection,
            variant: lib.variant || null,
            group: lib.group || '', category: lib.category || '', collection: lib.collection || '',
          })),
        });
        setStage('review');
      }
    } catch (e) {
      console.error('[togo] upload failed', e);
      setError(e?.message || 'No se pudo leer el archivo.');
      setStage('idle');
    }
  }, [onNeedCatalog, isModel, modelHint, readTaxonomy, geometry]);

  // MANY files at once — the dealer's real workflow: LR ships DWGs, pCon
  // exports ONE FILE PER MODEL, and a collection lands as a folder of them.
  // Each file's pieces aggregate into the same review pass the scene split
  // already had; a file that fails to parse is reported and never aborts the
  // rest of the batch.
  //
  // A lone file goes straight to the single-model editor — UNLESS it came out
  // of a FOLDER, because then it carries a grupo/categoría/colección proposal
  // and the review step is the only surface that shows them (a category folder
  // holding one model must not silently lose what the drop already told us).
  const onManyFiles = useCallback(async (files) => {
    if (!files?.length) return;
    const fromFolder = (f) => String(f?.relPath || f?.webkitRelativePath || '').includes('/');
    if (files.length === 1 && !fromFolder(files[0])) { onFile(files[0]); return; }
    setError(null); setNotice(null); setResult(null); setPlan(null); setScene(null);
    setMeshUrl((prev) => { if (prev) removeTogoMesh(prev); return null; });
    setSource((prev) => { if (prev?.url) removeTogoMesh(prev.url); return null; });
    setStage('parsing');
    setProgress({ done: 0, total: files.length, current: files[0]?.name || '' });
    try {
      const batch = await loadPiecesFromFiles(files, { onProgress: setProgress });
      const bad = batch.failed?.length ? `No se pudieron leer: ${batch.failed.map((x) => x.name).join(', ')}.` : null;
      if (!batch.pieces.length) {
        setError(bad || 'No se detectaron piezas en los archivos.');
        setStage('idle');
        return;
      }
      if (bad) setError(bad);   // the good ones still import; the bad ones are named
      // ONE DROP, ONE SHAPE — measured over EVERY dropped path (the sidecar
      // bitmaps included: a .jpg beside the models still hangs off the same
      // tree and still says where its levels are), then every piece is filed
      // against that one plan by the BRAND's module. This is the ONLY taxonomy
      // read in the batch path: `loadPiecesFromFiles` is the three.js half and
      // returns the three `folder*` fields null on purpose.
      const shape = geometry?.resolveShape(Array.from(files).map(relPathOf));
      setScene({
        THREE: batch.THREE,
        upAxis: batch.pieces[0].upAxis || 'y',
        // The library proposals seed the row's EDITABLE fields and stay beside
        // them untouched, so the summary line keeps reporting what was detected
        // however much the dealer corrects.
        pieces: batch.pieces.map((p) => {
          const lib = p.sourceFile
            ? readTaxonomy(p.sourceFile, shape)
            : { group: p.folderGroup, category: p.folderCategory, collection: p.folderCollection, variant: null };
          return {
            ...p, include: true,
            folderGroup: lib.group, folderCategory: lib.category, folderCollection: lib.collection,
            variant: lib.variant || null,
            group: lib.group || '', category: lib.category || '', collection: lib.collection || '',
          };
        }),
      });
      setStage('review');
    } catch (e) {
      console.error('[togo] batch upload failed', e);
      setError(e?.message || 'No se pudo leer la carpeta.');
      setStage('idle');
    }
  }, [onFile, geometry, readTaxonomy]);

  const busyIntake = stage === 'parsing' || stage === 'importing';
  // The zone: files AND whole folder trees (LR ships its library as
  // <grupo>/<categoría>/…/<archivo>, so the drop already knows the taxonomy).
  const intake = useFileIntake({
    accept: geometry?.accept || ACCEPT_3D,
    // SOME PRODUCTS BRING THEIR OWN MATERIALS: an LR product folder holds the
    // mesh AND the bitmaps its materials name (DCMAP1.JPG…). They come in with
    // the drop and get baked into the piece's GLB at conversion — filtered out
    // here, the walnut shelf imports as a grey shell. They are SIDECARS, never
    // content: a folder of pure bitmaps still rejects exactly as before.
    sidecarAccept: geometry?.sidecarAccept || ACCEPT_TEXTURES,
    multiple: true,
    directories: true,
    disabled: busyIntake,
    onFiles: onManyFiles,
    onReject: () => setError(`Sube un modelo 3D o una escena (${modelHint}).`),
    // The walk delivered a PREFIX of the tree. Not an error — what arrived is
    // importable — but the dealer has to know the rest never came, or a
    // half-read library reads as a complete one.
    onTruncated: (n) => setNotice(`La carpeta supera el máximo por lectura: se leyeron los primeros ${n} archivos. Importa esos y vuelve a soltar el resto.`),
  });
  // The native folder picker is a SECOND intake: `webkitdirectory` replaces
  // multi-file selection in the dialog, so «Elegir archivos» and «Elegir
  // carpeta» cannot be the same input. Only `intake` carries `rootProps` — two
  // zones off one surface would double-deliver every drop.
  const folderIntake = useFileIntake({
    accept: geometry?.accept || ACCEPT_3D,
    sidecarAccept: geometry?.sidecarAccept || ACCEPT_TEXTURES,   // the product folder's own textures (see above)
    multiple: true,
    pickDirectories: true,
    disabled: busyIntake,
    onFiles: onManyFiles,
    // Without this, a folder that matched zero 3D files (wrong folder, or one
    // that's pure textures/seed junk) read as the picker silently doing
    // nothing — the dealer would watch the OS dialog close and see no error,
    // no import, nothing to act on.
    onReject: () => setError(`Esa carpeta no contiene modelos 3D reconocibles (${modelHint}).`),
  });

  // A model dropped anywhere on the Togo workspace (any tab — the workspace-wide
  // intake in TogoWorkspace) lands here and runs the same unified flow as a
  // direct zone drop; the flow opens itself so the dealer sees it.
  useEffect(() => {
    if (!droppedFile) return;
    onOpenRequest?.();
    onFile(droppedFile);
    onDroppedFileConsumed?.();
  }, [droppedFile, onFile, onDroppedFileConsumed, onOpenRequest]);

  // The mesh sometimes exports lying on its side; flip the vertical axis and
  // re-derive the plan from the same upload (single-model path).
  const flipAxis = async () => {
    if (!meshUrl || busy) return;
    const next = upAxis === 'z' ? 'y' : 'z';
    setBusy(true);
    try { const p = await loadMeshPlan(meshUrl, { upAxis: next }); setUpAxis(next); setPlan(p); }
    catch { /* keep current */ } finally { setBusy(false); }
  };

  // Drop the single-piece editor without saving; clears the orphan mesh upload.
  const cancelSingle = () => {
    setMeshUrl((prev) => { if (prev) removeTogoMesh(prev); return null; });
    setSource((prev) => { if (prev?.url) removeTogoMesh(prev.url); return null; });
    setPlan(null); setName(''); setRoot(''); setRootName(''); setCollection(''); setUpAxis('y'); setStage('idle');
    onClose?.();
  };

  const save = async () => {
    if (!plan || !name.trim() || saving) return;
    setSaving(true);
    // Minted here so the dashboard can OPEN on the piece the moment it saves:
    // the upload lands on the stage as the borrador it is, with its own row
    // selected and one click from published.
    const id = newId();
    try {
      await db.togoModels.put({
        id, profileId, name: name.trim(),
        productRoot: root || null, productReference: null,
        // null for 'Togo'/empty so legacy default semantics stay uniform (the
        // resolver defaults null → 'Togo').
        collection: collection.trim() && collection.trim() !== 'Togo' ? collection.trim() : null,
        widthCm: plan.widthCm, depthCm: plan.depthCm, svg: plan.svg,
        meshUrl: meshUrl || null, meshUpAxis: meshUrl ? upAxis : null, meshScale: null, meshRotateY: 0,
        meshSourceUrl: source?.url || null, meshSourceName: source?.name || null,
        ingestedAt: meshUrl ? Date.now() : null,
        // BORRADOR, always (owner rule 2026-08). An uploaded piece used to go
        // live to the PUBLIC configurator the instant it saved — a mesh nobody
        // had looked at yet, at whatever fidelity it imported with, in front of
        // customers. Upload is an intake, not a publication: it lands here, you
        // review it in the dashboard, and you publish it deliberately from the
        // estado pill. Nothing else changes — `active` is the same flag
        // `resolveTogoModels` and the togo-embed payload already gate on.
        sortOrder: nextSort, active: false, createdAt: Date.now(), updatedAt: Date.now(),
      });
      setPlan(null); setName(''); setRoot(''); setRootName(''); setCollection(''); setMeshUrl(null); setSource(null); setUpAxis('y');
      setStage('idle');
      onCreated?.(id);
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  const setPiece = (i, patch) => setScene((s) => ({
    ...s, pieces: s.pieces.map((p, j) => (j === i ? { ...p, ...patch } : p)),
  }));

  const runImport = async () => {
    const included = scene.pieces.filter((p) => p.include);
    if (!included.length) return;
    setStage('importing');
    setProgress({ done: 0, total: included.length, current: included[0].name });
    const failed = [];
    let created = 0, sort = nextSort;
    // 'Togo'/empty normalize to null so the legacy default semantics stay
    // uniform (the resolver defaults null → 'Togo'); grupo y categoría have no
    // such default, they are simply absent when blank.
    const norm = (v) => { const t = String(v ?? '').trim(); return t || null; };
    const normCol = (v) => { const t = String(v ?? '').trim(); return t && t !== 'Togo' ? t : null; };
    const col = normCol(collection);
    // Each SOURCE file uploads once and is shared by every piece that came out
    // of it — a laid-out scene of eight modules keeps ONE original, not eight
    // copies. Keyed by the File object itself; a failed source upload is not a
    // failed import (provenance is metadata, the GLB is the product).
    const sourceUrls = new Map();
    for (const piece of included) {
      setProgress((pr) => ({ ...pr, current: piece.name }));
      try {
        // Multi-FILE batches can mix axis conventions per file; a single scene's
        // pieces all inherit the scene's. Either way the piece knows best.
        const axis = piece.upAxis || scene.upAxis;
        const blob = await exportPieceGlb(scene.THREE, piece.meshes);
        const slug = piece.name.normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'pieza';
        const url = await uploadTogoMesh(new File([blob], `${slug}.glb`, { type: 'model/gltf-binary' }));
        const piecePlan = await loadMeshPlan(url, { upAxis: axis });
        if (!piecePlan?.svg) { failed.push(piece.name); removeTogoMesh(url); continue; }
        let sourceUrl = null;
        if (piece.sourceFile && !/\.(glb|gltf)$/i.test(piece.sourceName || '')) {
          if (!sourceUrls.has(piece.sourceFile)) {
            sourceUrls.set(piece.sourceFile, await uploadTogoMesh(piece.sourceFile).catch(() => null));
          }
          sourceUrl = sourceUrls.get(piece.sourceFile);
        }
        // The row's own fields (prefilled from the library path) win; the
        // «para las filas en blanco» field only fills what the dealer left empty.
        // `productGroup` (not `group` — that word is reserved in SQL) is the
        // level above categoría: Upholstery / Beds / Hypna.
        await db.togoModels.put({
          id: newId(), profileId, name: piece.name, productRoot: null, productReference: null,
          collection: String(piece.collection ?? '').trim() ? normCol(piece.collection) : col,
          category: norm(piece.category),
          productGroup: norm(piece.group),
          widthCm: piecePlan.widthCm, depthCm: piecePlan.depthCm, svg: piecePlan.svg,
          meshUrl: url, meshUpAxis: axis, meshScale: null, meshRotateY: 0,
          meshSourceUrl: sourceUrl, meshSourceName: piece.sourceName || null, ingestedAt: Date.now(),
          // BORRADOR, same rule as the single-piece save above — and it matters
          // MORE here: a pCon scene drops dozens of pieces in one drag, and
          // publishing all of them sight-unseen is how a grey blob reaches the
          // public palette. They land as borradores; the bulk bar publishes the
          // batch in one click once you've looked at it.
          sortOrder: sort++, active: false, createdAt: Date.now(), updatedAt: Date.now(),
        });
        created++;
      } catch (e) {
        console.error('[togo] piece import failed', piece.name, e);
        failed.push(piece.name);
      }
      setProgress((pr) => ({ ...pr, done: pr.done + 1 }));
    }
    setResult({ created, failed });
    setScene(null); setCollection('');
    setStage('done');
  };

  // The drop zone is the entry for every state except while a scene is being
  // reviewed or imported (those own the body).
  const showDrop = stage === 'idle' || stage === 'parsing' || stage === 'single' || stage === 'done';

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Agregar modelo">
      <div className="space-y-4">
        {showDrop && (
          <>
            {/* The copy is the MODULE's, not Ligne Roset's: what a library looks
                like is exactly what differs between manufacturers, and telling
                a brand on the generic module to export from pCon is how a
                dealer concludes the app isn't for him. */}
            <p className="text-micro text-ink-500">
              Arrastra el <b>modelo 3D</b> de una pieza, una <b>escena con varias piezas</b>, <b>o una carpeta completa</b>
              {brandName ? <> de la biblioteca de <b>{brandName}</b></> : ' de la biblioteca'}. Se detecta solo: una pieza
              abre el editor, varias se importan de una vez, y de la ruta se leen el <b>grupo</b>, la <b>categoría</b> y la{' '}
              <b>colección</b>. El plano 2D y la huella se generan del propio modelo.
            </p>
            {modules?.geometry && (
              <p className="text-[11px] text-ink-400">
                Módulo de importación: <b className="text-ink-600">{modules.geometry.label}</b> — {modules.geometry.summary}
              </p>
            )}
            <div
              {...intake.rootProps}
              onClick={intake.open}
              className={`rounded-xl border-2 border-dashed transition-colors px-4 py-8 text-center cursor-pointer ${intake.dragging ? 'border-brand-400 bg-brand-50/40' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50/40'}`}
            >
              <input {...intake.inputProps} />
              <input {...folderIntake.inputProps} />
              {stage === 'parsing' ? (
                <span className="inline-flex items-center gap-2 text-sm text-ink-500"><Loader2 size={16} className="animate-spin" /> Leyendo {progress.total > 1 ? `${progress.done + 1}/${progress.total} · ${progress.current}` : 'el archivo…'}</span>
              ) : (
                <>
                  <span className="block text-sm text-ink-500">
                    Suelta archivos o una <b>carpeta completa</b> aquí ({modelHint})
                    <br />
                    <span className="text-micro text-ink-500">
                      Una pieza, varias o todo un árbol de carpetas — se detecta automáticamente.
                      Si la carpeta trae las texturas del producto (.jpg/.png), se aplican al modelo.
                    </span>
                  </span>
                  {/* Both affordances, because the native dialog can offer only
                      one: files OR a folder (webkitdirectory). Each stops the
                      click so the zone's own picker doesn't open too. The
                      folder button only renders where the browser can actually
                      honour it (iOS/iPadOS Safari never implemented
                      webkitdirectory) — offering a picker that quietly can't
                      pick a folder reads as "the app is broken", not "your
                      browser can't do this"; dragging the folder still works
                      wherever the OS supports dragging one. */}
                  <span className="mt-3 flex items-center justify-center gap-2">
                    <button type="button" onClick={(e) => { e.stopPropagation(); intake.open(); }} className="btn-secondary text-micro">
                      Elegir archivos
                    </button>
                    {CAN_PICK_FOLDER && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); folderIntake.open(); }} className="btn-secondary text-micro" title="Elegir una carpeta completa: la colección sale del nombre del archivo, y el grupo y la categoría de la ruta">
                        <FolderOpen size={13} aria-hidden /> Elegir carpeta
                      </button>
                    )}
                  </span>
                </>
              )}
            </div>
          </>
        )}

        {notice && (
          <div role="status" className="notice notice-sm notice-warn">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {notice}
          </div>
        )}

        {error && (
          <div role="alert" className="notice notice-sm notice-danger">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {error}
          </div>
        )}

        {stage === 'done' && result && (
          <div className="notice notice-sm notice-warn ${result.failed.length ? ' ' : ' '}">
            <Check size={14} className="mt-0.5 shrink-0" />
            <span>
              {result.created} modelo{result.created === 1 ? '' : 's'} creado{result.created === 1 ? '' : 's'}.
              {result.failed.length > 0 && <> No se pudieron importar: {result.failed.join(', ')}.</>}
              {' '}Usa «Auto-vincular» en la colección para proponer SKU y nombre automáticamente, o vincula cada uno a mano.
            </span>
          </div>
        )}

        {/* Single piece → the editor: 3D preview + derived plan, name, collection,
            product binding, save. */}
        {stage === 'single' && plan && (
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="shrink-0 flex gap-2">
              {meshUrl && (
                <div className="w-32 h-32 rounded-lg bg-ink-50 grid place-items-center overflow-hidden" title="Vista 3D del modelo">
                  {pendingThumb
                    ? <img src={pendingThumb} alt="Vista 3D del modelo" draggable={false} className="w-full h-full object-contain select-none" />
                    : <Loader2 size={16} className="animate-spin text-ink-500" />}
                </div>
              )}
              <div className="w-32 h-32 rounded-lg bg-ink-50 text-ink-700 p-2 grid place-items-center" title="Planta" dangerouslySetInnerHTML={{ __html: sanitizeSvg(plan.svg) }} />
            </div>
            <div className="flex-1 space-y-2.5 min-w-0">
              <div className="text-micro text-ink-500 tabular-nums flex items-center gap-2 flex-wrap">
                <span>Huella detectada: <b className="text-ink-700">{plan.widthCm}×{plan.depthCm} cm</b></span>
                {meshUrl && <span className="text-status-good-ink">· del modelo 3D</span>}
                {meshUrl && (
                  <button type="button" onClick={flipAxis} disabled={busy} className="btn-ghost text-micro py-0 h-6 disabled:opacity-50" title="Si el plano se ve girado, cambia el eje vertical">Eje {upAxis === 'z' ? 'Z' : 'Y'}</button>
                )}
              </div>
              <label className="block">
                <span className="label">Nombre</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Sillón Togo" />
              </label>
              <label className="block">
                <span className="label">Colección</span>
                <input
                  className="input"
                  list="togo-collections-add"
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                  placeholder="Togo"
                />
                <datalist id="togo-collections-add">
                  {collections.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <div>
                <label className="label">Producto (precio por grado)</label>
                {/* Opens the quote pane's catalog browser (ProductBindModal) —
                    categories, ranked search, model tiles with photos. */}
                <button
                  type="button"
                  onClick={() => setPickOpen(true)}
                  className="input w-full flex items-center justify-between gap-2 text-left"
                >
                  <span className={`truncate ${root ? '' : 'text-ink-500'}`}>
                    {root
                      ? (rootName || families.find((f) => f.root === root)?.name || root)
                      : 'Sin vincular (precio manual) — toca para elegir del catálogo'}
                  </span>
                  <Link2 size={14} className="text-ink-500 shrink-0" />
                </button>
                {/* Opens on whatever is already picked (the seed is selected, so
                    retyping replaces it) with the colección being typed above as
                    a one-tap search — a manufacturer's family names carry it. */}
                <ProductBindModal
                  open={pickOpen}
                  onClose={() => setPickOpen(false)}
                  brandName={brandName}
                  profileId={profileId}
                  currentRoot={root}
                  currentName={rootName || families.find((f) => f.root === root)?.name || ''}
                  presets={collection.trim() ? [{ label: collection.trim(), q: collection.trim() }] : []}
                  onPick={(m) => { setRoot(m.root); setRootName(m.name || ''); }}
                  onClear={() => { setRoot(''); setRootName(''); }}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={cancelSingle} className="btn-ghost text-sm">Cancelar</button>
                <button type="button" onClick={save} disabled={!name.trim() || saving} className="btn-primary text-sm disabled:opacity-50">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar modelo
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Many pieces → the batch review: name/uncheck each, one collection for all. */}
        {stage === 'review' && scene && (
          <div className="space-y-3">
            <div className="text-micro text-ink-500">
              Se detectaron <b className="text-ink-700">{scene.pieces.length} piezas</b>. Ajusta los nombres y desmarca lo que no quieras importar.
              {' '}(¿Salen piezas pegadas como una sola? Sepáralas más en pCon y vuelve a exportar.)
            </div>
            {(folderSummary.groups > 0 || folderSummary.categories > 0 || folderSummary.collections > 0) && (
              <div className="text-micro text-ink-500">
                Detectado:{' '}
                <b className="text-ink-700">{folderSummary.groups} grupo{folderSummary.groups === 1 ? '' : 's'}</b>
                {' · '}
                <b className="text-ink-700">{folderSummary.categories} categoría{folderSummary.categories === 1 ? '' : 's'}</b>
                {' · '}
                <b className="text-ink-700">{folderSummary.collections} colecci{folderSummary.collections === 1 ? 'ón' : 'ones'}</b>
              </div>
            )}
            <ul className="divide-y divide-ink-100 max-h-[40dvh] overflow-y-auto overscroll-contain">
              {scene.pieces.map((p, i) => (
                <li key={i} className="space-y-1 py-1.5">
                  <div className="flex items-center gap-2.5">
                    <input type="checkbox" checked={p.include} onChange={(e) => setPiece(i, { include: e.target.checked })} className="shrink-0" />
                    <input className="input h-8 py-0 text-sm flex-1 min-w-0" value={p.name} onChange={(e) => setPiece(i, { name: e.target.value })} />
                    {p.variant && (
                      <span className="shrink-0 rounded-full bg-ink-100 px-1.5 py-px text-micro text-ink-500" title="Variante detectada en la ruta">
                        {p.variant}
                      </span>
                    )}
                    {p.sourceName && <span className="hidden sm:block shrink-0 max-w-[10rem] truncate text-micro text-ink-500" title={p.sourceName}>{p.sourceName}</span>}
                    <span className="shrink-0 text-micro text-ink-500 tabular-nums">{p.widthCm}×{p.depthCm} cm</span>
                  </div>
                  {/* Prefilled from where the file sits in the LR library,
                      editable, and INDEPENDENT per row — two models under one
                      folder can still end up in different colecciones if the
                      dealer says so. They WRAP instead of squeezing: three
                      fields at the sheet's width would leave each one too
                      narrow to read what's in it. */}
                  <div className="flex flex-wrap items-center gap-1.5 pl-[1.6rem]">
                    <input
                      className="input h-7 min-w-0 flex-1 basis-28 py-0 text-micro"
                      list="togo-groups-scene"
                      value={p.group ?? ''}
                      onChange={(e) => setPiece(i, { group: e.target.value })}
                      placeholder="Grupo"
                      aria-label={`Grupo de ${p.name}`}
                    />
                    <input
                      className="input h-7 min-w-0 flex-1 basis-28 py-0 text-micro"
                      value={p.category ?? ''}
                      onChange={(e) => setPiece(i, { category: e.target.value })}
                      placeholder="Categoría"
                      aria-label={`Categoría de ${p.name}`}
                    />
                    <input
                      className="input h-7 min-w-0 flex-1 basis-28 py-0 text-micro"
                      list="togo-collections-scene"
                      value={p.collection ?? ''}
                      onChange={(e) => setPiece(i, { collection: e.target.value })}
                      placeholder="Colección"
                      aria-label={`Colección de ${p.name}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
            {/* Ligne Roset's own top-level groups, suggested to every row's
                «Grupo» field. One list for the whole review — a datalist per row
                would be N copies of the same options. */}
            <datalist id="togo-groups-scene">
              {groupOptions.map((g) => <option key={g} value={g} />)}
            </datalist>
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <label className="block flex-1">
                <span className="label">Colección (para las filas en blanco)</span>
                <input className="input" list="togo-collections-scene" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="Togo" />
                <datalist id="togo-collections-scene">
                  {collections.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => { setScene(null); setCollection(''); setStage('idle'); }} className="btn-ghost text-sm">Cancelar</button>
                <button type="button" onClick={runImport} disabled={!scene.pieces.some((p) => p.include)} className="btn-primary text-sm disabled:opacity-50">
                  <Check size={15} /> Crear {scene.pieces.filter((p) => p.include).length} modelos
                </button>
              </div>
            </div>
          </div>
        )}

        {stage === 'importing' && (
          <div className="space-y-2">
            <div className="text-xs text-ink-600 inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Importando {progress.done + 1}/{progress.total} · {progress.current}
            </div>
            <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
