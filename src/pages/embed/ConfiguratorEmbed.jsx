import { useState, useMemo, useRef, useCallback, useContext, useEffect, useLayoutEffect, createContext } from 'react';
import { createPortal } from 'react-dom';
import { Sofa, RotateCw, Trash2, Loader2, Eraser, ArrowRight, ArrowLeft, Check, AlertCircle, Palette, Layers, X, FileDown, Box, Square, View, Receipt, Undo2, Redo2, CopyPlus, Lightbulb, ZoomIn, ZoomOut, Maximize, Pencil, Pipette, Plus, ChevronRight, ChevronLeft, ChevronDown, Undo, Frame, Share2 } from 'lucide-react';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl, swatchProxyUrl, swatchTileUrl, swatchTextureUrl } from '../../lib/swatchImage.js';
import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { downloadText } from '../../lib/csv.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { buildFabricByCode } from '../../lib/configurator/fabricIndex.js';
import { buildConfiguratorGroup, disposeGroup, STANDARD_CONFIGURATOR_FINISH } from '../../components/configurator/sceneBuilder.js';
import { FINE_POINTER, useToolbarFit, HudIcon, HudMenu } from '../../components/configurator/HudControls.jsx';
import { loadConfiguratorModels } from '../../components/configurator/modelLoader.js';
import { configuratorForPathname } from '../../brands/configurators/index.js';
import { fetchConfiguratorCatalogCached, fetchConfiguratorPlanSvgs, submitConfiguratorRequest, configuratorEmbedModalUrl, configuratorHandoffUrl, reportConfiguratorView } from '../../lib/configuratorEmbed.js';
import { isTeamBrowser } from '../../lib/metaAttribution.js';
import { encodeBuild, decodeBuild, decodeRoomFromBuild } from '../../lib/configurator/buildShare.js';
import { makeRectRoom, roomSize, roomCenter, roomFit, clampRoomDim } from '../../lib/configurator/room.js';
import { t, resolveConfiguratorLocale, piecesLabel } from '../../lib/configurator/i18n.js';
import { useMeshPlans } from '../../components/configurator/useMeshPlans.js';
import { useConfiguratorThumbnails, useConfiguratorFabricThumbs, renderConfiguratorThumb, renderConfiguratorSceneThumb, snapshotFieldFor, bakedThumbUrl, TILE_THUMB, ROW_THUMB } from '../../components/configurator/thumbnails.js';
import { prewarmConfiguratorEngine } from '../../components/configurator/modelLoader.js';
import {
  resolveConfigurator, resolvePlacement, snapPlacement, footprintOf, PX_PER_CM,
  resolveConfiguratorDxf, placementsFromPlaced, resolveConfiguratorScene, scenePlacementsFromPlaced,
  createHistory, historyPush, historyUndo, historyRedo,
  firstWithoutFabric, placementDressed, dressableRoles, duplicatePlacement, cyclePieceUid, SNAP_GRID_CM, RELEASE_DOCK_CM,
  placementMode, componentRoles, planModeSwitch, componentViewOf, sellsByComponentsOnly, isWholePieceRole, effectivePartMaterials,
  placementTotalUsd, placementBreakdown, resolveLaunchHero, resolveCollectionMenu,
} from '../../core/quote/index.js';
import { mountOf, sanitizePartMaterials, sanitizePartFinishes, finishOptionOf, partRoleFor, roleLabelOf, partLabelOf, structureGroupsOf, structureGroupFor, MATERIALIZATION_ROLES, PART_ROLES } from '../../lib/configurator/meshParts.js';
import { collectionKey, distinctCollections } from '../../lib/configurator/collections.js';
import configuratorHeroSvg from '../../assets/ligne-roset/togo_gb.svg?raw';
import Modal from '../../components/Modal.jsx';
import MaterialColorPicker from '../../components/quote-builder/MaterialColorPicker.jsx';
import MaterialsCatalog from '../../components/configurator/MaterialsCatalog.jsx';
import { SwatchPreviewBody } from '../../components/configurator/SwatchPreviewCard.jsx';
import ImageView from '../../components/ImageView.jsx';
import ConfiguratorStage, { DRESSABLE_ROLE, OUTLINE_GOLD } from '../../components/configurator/ConfiguratorStage.jsx';
import ConfiguratorTurntable from '../../components/configurator/ConfiguratorTurntable.jsx';
import ConfiguratorArViewer from '../../components/configurator/ConfiguratorArViewer.jsx';

const SCALE = PX_PER_CM;

// The desktop 3D left cluster, in rem: the MATERIAL pane (`w-80`) and the
// COMPONENTES rail hanging off its right edge. Named once because three readers
// have to agree — the rail's own offset, the pane's width class, and the
// stage's `insetLeft` (it frames the piece against what is actually visible, so
// a width that drifts here parks the sofa under a panel).
const MAT_PANE_REM = 20;
const LEFT_INSET = 'max(0.75rem, env(safe-area-inset-left))';
const GUTTER_REM = 0.5;

/**
 * WHERE THE NEXT SURFACE IN THE LEFT COLUMN STARTS — one expression, read by
 * every surface that stacks there.
 *
 * The picker, the componentes rail and the preview card are one column, and
 * each used to compute its own left offset from the same constants by hand.
 * Two expressions that must agree is one that eventually does not: the card
 * reserved a rail's width while no rail was drawn (a hole in the layout), and
 * with the PICKER closed but the rail open it ignored the rail entirely and
 * landed on top of it. Both are the same bug — a duplicated derivation — so
 * there is now one function and no arithmetic at the call sites.
 *
 * `after` names how much of the column to skip: 'edge' (nothing — the column's
 * own left edge), 'picker', or 'rail' (picker + rail).
 */
function leftColumnOffset(after, { railOpen = false, componentsRailOpen = false } = {}) {
  let rem = 0;
  if (after === 'picker' || after === 'rail') rem += railOpen ? MAT_PANE_REM + GUTTER_REM : 0;
  if (after === 'rail') rem += componentsRailOpen ? COMPONENTS_RAIL_REM + GUTTER_REM : 0;
  return rem > 0 ? `calc(${LEFT_INSET} + ${rem}rem)` : LEFT_INSET;
}
// Wide enough for «COMPONENTES» and a chip label at 9px WITHOUT truncating:
// the rail is a column of names, and a name cut to «Tela de to…» is a label
// that has stopped labelling.
const COMPONENTS_RAIL_REM = 5.5;

// The distributor inbox's one repeated typographic device (DealerInbox.jsx's
// EYEBROW, same values): an 11px uppercase 0.15em label. It carries every
// status, section head and meta line on both public surfaces, which is most of
// why they read as one product. `EYEBROW_INK` is the same label at full ink —
// for the primary action, where it sits on the black.
//
// Set in VERLAG, Ligne Roset's own face — the whole configurator is (see the
// `.configurator-rams` skin), so these inherit it and name no family of their own.
const EYEBROW = 'text-micro uppercase tracking-[0.08em] text-ink-500';
const EYEBROW_INK = 'text-micro uppercase tracking-[0.08em]';

// NO LINE DRAWING STANDS IN FOR A PIECE (owner, 2026-07-31: "I don't want to
// see the svg drawings anymore … the models seem to just appear"). Every picker
// tile used to hold a bundled Togo wireframe until its 3D render arrived — the
// wireframe→render swap is what the owner was seeing, and a drawing of A sofa
// is not the piece you are choosing. The catalogue now loads like the Tienda's:
// the plate holds the cell and the render FADES IN over it (ModelThumb), with
// nothing in between. The wireframe map, its name/footprint matcher and their
// five bundled svgs went with it; `configurator_gb` stays as the launch card's hero.


// A touch of "game juice": a haptic tap on key actions. Guarded — a no-op where
// the device/browser doesn't support vibration (desktop, iOS Safari), so it only
// ever *adds* feel, never errors. Patterns are deliberately tiny (ms).
const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

// Smoothly tween a displayed number toward its target (easeOutCubic) — the live
// estimate ticks up like a score instead of snapping. Interruptible: a new target
// mid-flight re-tweens from wherever it currently is, so rapid edits stay fluid.
// Pure UI sugar over the already-derived total; the real number is unchanged.
function useCountUp(target) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    if (from === to) { setDisplay(to); return undefined; }
    // Reduced motion → the number just changes, no tick-up.
    if (prefersReducedMotion()) { fromRef.current = to; setDisplay(to); return undefined; }
    let raf = 0; let start = null;
    const dur = 520;
    const step = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = from + (to - from) * eased;
      fromRef.current = cur; setDisplay(cur);
      if (p < 1) raf = requestAnimationFrame(step);
      else { fromRef.current = to; setDisplay(to); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return display;
}

// The Done-screen celebration palette — the ONE place the monochrome Rams skin
// earns colour, because a sent request is the reward moment.
const CONFETTI_COLORS = ['#e2725b', '#2f6f6b', '#d9a441', '#3b5f8a', '#b8553f', '#6c8c5a'];

// First-run hints seen flags (bump a suffix to re-show after a big UX change).
const HINTS_KEY = 'togo:hints:v2';
const HINTS3D_KEY = 'togo:hints3d:v1';


/**
 * Copy `text`, resolving to whether it actually landed. The async Clipboard
 * API is the happy path, but it is denied outright in a cross-origin iframe
 * without `clipboard-write` (the widget is DISTRIBUTABLE — some host will embed
 * it) and in any non-secure context, so the hidden-textarea `execCommand` route
 * stays as the fallback. Same two-step the quote's ClientPreview uses.
 *
 * Returns false only when BOTH routes fail — the one case worth telling the
 * visitor about, since a silent no-op looks like a broken button.
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* denied / unavailable → the legacy route below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch { return false; }
}

// Live min-width media query (unlike FINE_POINTER, a window CAN cross this
// mid-session — resize/rotate). Drives WHERE the two workspace panes hang: at
// ≥1280px they dock as persistent side columns; below, the SAME panes hang as
// edge drawers behind the Piezas/Resumen tabs («mobile view is exactly the
// same components as desktop»). JS-gated rather than CSS-hidden so the piece
// list never exists twice in the DOM (screen readers would hear every piece
// twice).
function useMinWidth(px) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(`(min-width: ${px}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(`(min-width: ${px}px)`);
    if (!mq) return undefined;
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [px]);
  return on;
}

const newUid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const norm360 = (deg) => (((deg % 360) + 360) % 360);

/**
 * PUBLIC, no-login Togo configurator — embedded in the dealer's website via an
 * <iframe>, and shown back IN the app (Togo workspace → Configurador tab) as a
 * live preview of exactly what's deployed. This is THE single configurator: a
 * visitor drags Togo pieces into a top-down plan, PICKS FABRICS (the same
 * MaterialColorPicker the internal quote editor uses, fed by public-safe catalog
 * data from `togo-embed`), sees the live retail total (DOP), and requests a
 * quote → a pending togo_request the dealer promotes. Reuses the SAME pure VM as
 * the rest of the app; it just feeds it data from the Edge Function instead of
 * the DB. Renders OUTSIDE the app shell (no AppContext/session) and is pinned
 * light, so it sits cleanly inside any page.
 */

// True when the widget is loaded inside a host fullscreen container (the embed
// snippet's popup overlay or the in-app modal pass `?ctx=modal`) — it then skips
// its own launch card and shows the configurator directly (no card-in-a-card).
function isModalContext() {
  if (typeof window === 'undefined') return false;
  try {
    // ctx=modal can ride the hash (#/embed/configurador?ctx=modal) OR the real query
    // (/configurator?ctx=modal, the clean-path entry).
    if (new URLSearchParams(window.location.search || '').get('ctx') === 'modal') return true;
    const h = window.location.hash || '';
    const qi = h.indexOf('?');
    return qi >= 0 && new URLSearchParams(h.slice(qi + 1)).get('ctx') === 'modal';
  } catch { return false; }
}

// The clean standalone configurator page (/configurador, /configurator) is a
// full-screen, top-level document — NOT a small iframe — so it skips the launch
// card and drops straight into the configurator. The launch card exists only to
// give the IFRAME embed a tap-to-open-fullscreen affordance; main.jsx mounts this
// component at /configurator, while the iframe embed loads #/embed/configurador (where
// the card still shows). Without this, /configurator showed the card and a tap
// bounced the user out to the hash URL #/embed/configurador.
function isStandaloneConfigurator() {
  if (typeof window === 'undefined') return false;
  // MY path, not just "a configurator path". There are several now, one per
  // brand, and this component only owns the plan configurator's — asking the broad question
  // would have this widget claim to be standalone on a page it is not even
  // mounted on, which is the kind of latent wrong answer that surfaces years
  // later as a bug nobody can place.
  return configuratorForPathname(window.location.pathname)?.id === 'configurador';
}

// Read a param that may ride EITHER the real query (/configurator?x=…, the
// clean-path entry) OR the hash query (#/embed/configurador?x=…) — the same dual place
// ctx=modal lives. Used for `dealer` (per-dealer distribution) and `lang`.
function readEmbedParam(name) {
  if (typeof window === 'undefined') return null;
  try {
    const fromSearch = new URLSearchParams(window.location.search || '').get(name);
    if (fromSearch) return fromSearch;
    const h = window.location.hash || '';
    const qi = h.indexOf('?');
    if (qi >= 0) return new URLSearchParams(h.slice(qi + 1)).get(name);
  } catch { /* ignore */ }
  return null;
}

// After a QR handoff restores the plan from ?build=…, drop that param so a later
// reload rebuilds from the visitor's OWN localStorage snapshot (their edits on
// the phone), not the frozen desktop handoff. Covers both the real query
// (/configurator?build=…) and the hash query (#/embed/configurador?build=…).
function stripBuildParam() {
  if (typeof window === 'undefined') return;
  try {
    const { origin, pathname, search, hash } = window.location;
    let nextSearch = search;
    if (search) {
      const sp = new URLSearchParams(search);
      if (sp.has('build')) { sp.delete('build'); const s = sp.toString(); nextSearch = s ? `?${s}` : ''; }
    }
    let nextHash = hash;
    const qi = hash.indexOf('?');
    if (qi >= 0) {
      const hp = new URLSearchParams(hash.slice(qi + 1));
      if (hp.has('build')) { hp.delete('build'); const s = hp.toString(); nextHash = hash.slice(0, qi) + (s ? `?${s}` : ''); }
    }
    if (nextSearch !== search || nextHash !== hash) {
      window.history.replaceState(null, '', `${origin}${pathname}${nextSearch}${nextHash}`);
    }
  } catch { /* history unavailable — harmless */ }
}

// material + color → the { grade, fabric, code } shape a placement carries. Mirrors
// SwatchPicker.toPick; `code` lets us render the LR swatch (swatchUrl) with no DB.
function toPick(material, color) {
  return { grade: material.grade || '', fabric: composeFabricLabel(material, color), code: color?.code || '' };
}

// What each swatch <img> in this widget actually PAINTS at, in CSS px, so
// `swatchTileUrl` can ask for that size instead of the 2000×2000, ~250 KB
// original the LR CDN serves for every one of them (it honours no resize
// param). Measured off the classes at each site. The zoom LIGHTBOX is
// deliberately absent from this table: it exists to study the weave up close,
// so it keeps the full-resolution original.
const SWATCH_PX = {
  row: 16,       // w-4 — the part rows in the pane and the summary
  pill: 20,      // w-5 — the fabric pills on a placed piece
  strip: 96,     // the rail's piece-materials strip (w-13 cell, 2x for dpr)
  plate: 192,    // the preview plate
  preview: 288,  // sm:w-72 — the summary's hover preview
};

// Rehydrate the per-model family JSON the Edge Function sends into the SAME
// CatalogFamily shape productForGrade expects (byGrade as a Map).
function familyFromJson(f) {
  if (!f || !f.root) return null;
  return {
    root: f.root, name: f.name || '', graded: !!f.graded, grades: f.grades || [],
    brand: 'ligne-roset', family: '',
    byGrade: new Map(Object.entries(f.byGrade || {})),
  };
}

/**
 * ── WHAT THE APP IS WAITING ON ────────────────────────────────────────────
 * The material rail is a QUESTION ("which cloth?") and a question needs a
 * visible subject, or the pane reads as a catalog parked beside the design
 * with no stated link to it (owner, 2026-07-31: «HIGHLIGHT STUFF WHENEVER
 * YOU'RE WAITING ON AN ACTION»). This names the subject.
 *
 * ONE derivation, four answers and only these: the whole piece, ONE of its
 * parts, ONE estructura group, or every piece at once — never two at a time. It
 * takes the very inputs that decide the rail (`railOpen` is passed in already
 * resolved), so the pill that lights up and the pane that answers it cannot
 * name different targets; a second source of truth is the entire failure mode
 * here. The finish target wins: it is the one thing the rail can be open on
 * while a piece is also selected.
 *
 * Null = nothing is pending — the rail is stowed, or this is the phone, where
 * the picker is a full-screen sheet and the wait needs no chrome to be read.
 */
function waitingPick({ railOpen, selectedUid, matPart, matMode, finishRail = null }) {
  if (!railOpen) return null;
  if (finishRail) return { kind: 'finish', uid: finishRail.uid, role: 'structure', group: finishRail.partKey };
  if (selectedUid == null) return matMode === 'all' ? { kind: 'all', uid: null, role: null } : null;
  return matPart
    ? { kind: 'part', uid: selectedUid, role: matPart }
    : { kind: 'piece', uid: selectedUid, role: null };
}

export default function ConfiguratorEmbed() {
  const [cat, setCat] = useState({ status: 'loading', data: null, error: null });
  const [placed, setPlaced] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);
  const [step, setStep] = useState('build'); // 'build' | 'form' | 'done'
  // ≥1280px → the desktop workspace: piece catalog + design inspector as side
  // panes; below, the same panes as edge drawers, plus the floating hotbar and
  // estimate deck. Live (resize crosses it), JS-gated (never both).
  // Declared FIRST because the breakpoint decides which chrome each piece of
  // state below belongs to — the floating chip is desktop-only from here on.
  const desktop = useMinWidth(1280);
  const [matOpen, setMatOpen] = useState(false);
  const [arOpen, setArOpen] = useState(false);   // "Ver en tu espacio" (WebAR)
  const [matMode, setMatMode] = useState('one'); // 'one' (selected piece) | 'all'
  const [matPart, setMatPart] = useState(null);  // non-base role ('cushion'…) → the picker fabrics THAT part
  // The ESTRUCTURA target while the DESKTOP rail is picking a finish —
  // { uid, partKey, spec }. Same target the phone answers with the bottom sheet
  // (`finishSheet`, declared with its commit below): one question, two chromes,
  // exactly the rail/modal split the fabric picker already has. Declared up
  // here because `railOpen` has to see it — a finish target must open the rail
  // on a piece whose fabric ladder is irrelevant (or absent).
  const [finishRail, setFinishRail] = useState(null);
  // The uid of the piece whose PARTS LEVEL is unfolded — which, now that
  // selection auto-opens it (the effect further down), is the piece whose
  // personalization panel is showing in FULL.
  //
  // The base fabric is not a peer of the cushions: it IS the whole piece, and
  // they are parts OF it (owner, 2026-07-31: «we need a better hierarchical way
  // to handle the complete element, complete-SKU material, and the per-component
  // material»). So the parts stay SUBORDINATE — indented under the piece's own
  // fabric control, cloth rows gated on the piece being dressed, never a flat
  // row of chips beside it — but they are no longer HIDDEN behind a disclosure
  // the visitor had to find: «Personalizar por partes» survives as the manual
  // way to fold them back. A uid rather than a boolean so the open state belongs
  // to a specific PIECE: a fold on one can never read as a fold on the next.
  const [partsOpenUid, setPartsOpenUid] = useState(null);
  const [view, setView] = useState('2d');        // '2d' plan editor | '3d' preview
  const [activeCollection, setActiveCollection] = useState(null); // which modular collection the palette shows
  const [hoveredPieceId, setHoveredPieceId] = useState(null); // hover-link plan ⇄ hotbar
  const [hover3d, setHover3d] = useState(null); // 3D hover/tap → { uid, x, y } for the fabric+price chip
  const [room, setRoom] = useState(null);        // the client's space boundary ({shape,corners} plan cm) — visual reference
  const [roomOpen, setRoomOpen] = useState(false); // the room dimensions panel
  const [catalogOpen, setCatalogOpen] = useState(false); // mobile piece-catalog drawer (rail → side pane)
  const [selAnchor, setSelAnchor] = useState(null); // selected piece's top-centre on screen (3D) → the same card, on tap
  // Is the ray ON a piece RIGHT NOW? `hover3d` can't answer that — it survives
  // the grace below on purpose — and the card needs the un-delayed truth: while
  // it is CHASING the cursor it must be transparent to the pointer, or it
  // catches the very cursor it follows (it sits down-right of it, which is the
  // direction a hand naturally travels) and the canvas stops seeing the moves
  // that drive it: the card sticks, and the hover under it goes stale. The
  // moment the pointer steps off the piece the card freezes AND takes the
  // Clearing the preview rides a short GRACE delay so a pointer crossing a seam
  // between two meshes of the same piece does not blink the card.
  const hover3dClear = useRef(0);
  const onHover3d = useCallback((info) => {
    clearTimeout(hover3dClear.current);
    if (info) setHover3d(info);
    else hover3dClear.current = setTimeout(() => setHover3d(null), 240);
  }, []);
  useEffect(() => () => clearTimeout(hover3dClear.current), []);
  useEffect(() => { if (view !== '3d') { clearTimeout(hover3dClear.current); setHover3d(null); } }, [view]);   // the preview is a 3D-only affordance
  // The chip rides in LOCKSTEP with the canvas: the stage recomputes its
  // top-centre anchor every rendered frame (onChipAnchor) and we write it to
  // the DOM directly — its left/top are owned IMPERATIVELY, NEVER by React's
  // style prop. That's the whole point: the selection anchor is per-frame
  // React state, so this component re-renders every frame while the view
  // ── THE FLOATING CHIP IS A CURSOR AFFORDANCE — POINTER DEVICES ONLY ───────
  // The chip names the exact part under the RAY, which only a pointer can aim.
  // A touch device has no ray — but the stage cannot tell a finger from a
  // cursor, so the TAP that selects a piece also reports a "hover" (see
  // ConfiguratorStage's 3D tap: reportHover then onSelect); unguarded, every phone tap
  // raised a phantom hover card over the piece it had just selected.
  // FINE_POINTER is the honest test for "this hover is real". The phone's
  // inspector is the Resumen drawer (the SAME DesignPane the desktop docks) —
  // it opens by the edge tab, never by a fake hover.
  //
  // The SELECTION fallback (nothing hovered → keep the card on the selected
  // piece) was touch's stand-in for hover, and is now desktop-only for the same
  // reason: below 1280 the drawer IS the inspector, in both views.
  //
  // Both derived ONCE — the per-frame anchor the stage reports and the card
  // that renders at it must never disagree about whether the chip is up.
  // ON DESKTOP THE CARD IS THE MATERIAL PICKER, AND IT COMES UP ON HOVER —
  // selected or not. Owner, 2026-08-02: «i want material picker and hover
  // picker to be the same in desktop. when i go over a piece the material
  // picker hover comes up. even without products selected». This SUPERSEDES
  // the 2026-08-01 gate («that card shouldnt appear on an unselected
  // object»), which briefly made the card an affordance of the selection
  // only: the card names the piece under the ray and offers its tela, so
  // requiring a selection first made picking a fabric a two-step act
  // (click to select, then hover to pick) where the pointer already says
  // which piece is meant. Hovering IS the pick gesture on a fine pointer.
  // What did NOT change: FOLLOWING the mouse still requires the selection
  // (chipFollow below, owner rule of the same day) — over an unselected
  // piece the card parks above it, which is the anchored path that has
  // always existed.
  // ONE GATE for the hover policy (owner, 2026-08: «when a model is selected
  // hover only works on that selected model»). With a piece selected, pointing
  // at ANOTHER piece answers nothing — no card, no rail retarget, no glow (the
  // stage applies the same rule to its emissives) — because while you are
  // dressing one piece every other cue is noise; a TAP still selects, so the
  // way over is unchanged. With nothing selected, hover previews any piece.
  // Every consumer (card, rail subject, chip anchor) derives from THIS value,
  // so the policy cannot be half-applied.
  const chipHover = FINE_POINTER && hover3d && (selectedUid == null || hover3d.uid === selectedUid)
    ? hover3d : null;
  const chipHoverSel = chipHover;
  // The piece the chip is anchored to (hover wins; else the 3D selection).
  const chipUid = view === '3d' ? (chipHover?.uid ?? null) : null;
  // ── A HOVER CARD FOLLOWS THE MOUSE — ON THE SELECTED PIECE ──────────────
  // Owner, 2026-08-01: «el popup no está siguiendo el mouse», then «like i said
  // popup following mouse should only happen when a product is selected». Both
  // halves are one rule: following is the register of EDITING — the card rides
  // the pointer over the piece you are working on, because there the card and
  // the ray describe the same act. Over a piece you have NOT selected the card
  // is an identification, not an edit, so it parks above that piece exactly as
  // it always did (the stage anchors whatever `chipUid` names — hovered or
  // selected — the moment this flag is false, so the anchored path is the same
  // one, not a restored copy of it).
  // The two other ANCHORED cases are untouched underneath: with no hover, an
  // open pipette keeps the card glued to its target's meshes and a bare
  // selection keeps it above the piece. The stage owns the per-move position
  // (it is the one holding the ray); this flag is the only thing it needs from
  // here — which mode the card is in.
  // …and it is CHASING (so pointer-transparent) only while the ray is still on
  // the piece. Off it, the card is frozen and takes the pointer back. Rides
  // chipFollow, so a TAP-reported "hover" on a touch device — which never gets
  // a following card — can never disarm the selection card's buttons.

  const [quoteOpen, setQuoteOpen] = useState(false);
  // The Resumen is a rail now, not a <Modal>, so Escape-to-close is ours to keep.
  useEffect(() => {
    if (!quoteOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setQuoteOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quoteOpen]); // the quote summary sheet
  const [dlOpen, setDlOpen] = useState(false);   // the download format chooser
  const [dxfBusy, setDxfBusy] = useState(false); // building the DXF (may fetch a plan outline first)
  const [glbBusy, setGlbBusy] = useState(false); // building the textured GLB (loads three + exporter)
  // Undo/redo over `placed` — one entry per user gesture (add, drag commit,
  // rotate, delete, fabric, clear). The stack mechanics are the pure VM helpers.
  const [hist, setHist] = useState(createHistory);
  // The stage's imperative gestures (free-rotate) — populated by ConfiguratorStage; the
  // floating rotate handle forwards its pointerdown here.
  const stageGestures = useRef(null);
  // First-run coach line (how to move/rotate/pick fabric) — shown once a piece is
  // down, dismissed forever via localStorage (guarded: iframe storage may be off).
  const [hintsOpen, setHintsOpen] = useState(() => {
    try { return !localStorage.getItem(HINTS_KEY); } catch { return false; }
  });
  const dismissHints = useCallback(() => {
    setHintsOpen(false);
    try { localStorage.setItem(HINTS_KEY, '1'); } catch { /* blocked */ }
  }, []);
  // Same, for the first visit to the 3D view (orbit + double-tap-to-focus).
  const [hints3dOpen, setHints3dOpen] = useState(() => {
    try { return !localStorage.getItem(HINTS3D_KEY); } catch { return false; }
  });
  const dismissHints3d = useCallback(() => {
    setHints3dOpen(false);
    try { localStorage.setItem(HINTS3D_KEY, '1'); } catch { /* blocked */ }
  }, []);
  // false → show the launch card; the card opens the configurator in a NEW TAB
  // (?ctx=modal → straight to the build), so it always gets the full screen.
  // The clean /configurator page launches straight in (it's already full-screen).
  const launched = isModalContext() || isStandaloneConfigurator();

  // Dieter Rams skin: while the configurator is mounted, flag <body> so the
  // monochrome variable remap (index.css) reaches the portalled modals too.
  useEffect(() => {
    document.body.classList.add('configurator-rams');
    return () => document.body.classList.remove('configurator-rams');
  }, []);
  // ONE standard velvet (terciopelo) for every piece — no per-finish editor. The
  // only customer choice left is the FABRIC (colour) via the swatch picker.
  const material = STANDARD_CONFIGURATOR_FINISH;

  // Per-dealer distribution + locale come from the URL. `dealer` and `lang` ride
  // BOTH the real query (/configurator?dealer=…&lang=…) and the hash query
  // (#/embed/configurador?dealer=…&lang=…), read the same dual way as ctx=modal. The URL
  // never changes during a widget session, so read once.
  const dealerSlug = useMemo(() => readEmbedParam('dealer'), []);
  const queryLang = useMemo(() => readEmbedParam('lang'), []);
  // A build handed off from a desktop QR (?build=…) — restored once the catalog
  // loads, taking precedence over the local resume snapshot. Read once.
  const urlBuild = useMemo(() => readEmbedParam('build'), []);

  // Catalog load, retryable — a flaky hotel-wifi failure gets a "Reintentar"
  // instead of a dead end. The generation counter drops stale responses.
  // Snapshot-first (fetchConfiguratorCatalogCached): a repeat visit paints from the
  // device's stored payload with zero network wait, and the background
  // revalidate swaps the data in place only when it actually changed.
  const catGen = useRef(0);
  const loadCatalog = useCallback(() => {
    const gen = ++catGen.current;
    setCat({ status: 'loading', data: null, error: null });
    fetchConfiguratorCatalogCached(dealerSlug, {
      onRefresh: ({ data, error }) => {
        if (catGen.current !== gen) return;
        if (error) setCat({ status: 'error', data: null, error: error?.message || 'Error', httpStatus: error?.status });
        else setCat({ status: 'ready', data, error: null });
      },
    })
      .then((d) => { if (catGen.current === gen) setCat({ status: 'ready', data: d, error: null }); })
      .catch((e) => { if (catGen.current === gen) setCat({ status: 'error', data: null, error: e?.message || 'Error', httpStatus: e?.status }); });
  }, [dealerSlug]);
  useEffect(() => { loadCatalog(); return () => { catGen.current += 1; }; }, [loadCatalog]);

  // Warm the 3D engine ALONGSIDE that fetch. This screen always ends up needing
  // it, but nothing requested it until a 3D surface mounted — which is after the
  // catalog resolves — so a ~730 KB download and its parse queued up behind a
  // network wait they could have overlapped. Skipped on the launch card, which
  // only boots when it scrolls into view (see prewarmConfiguratorEngine).
  useEffect(() => { if (launched) prewarmConfiguratorEngine(); }, [launched]);

  // ── Screen-reader narration: ONE polite live region; every build action
  // speaks (Spanish, matching the UI). The zero-width toggle re-fires identical
  // consecutive messages.
  const [announcement, setAnnouncement] = useState('');
  const annFlip = useRef(false);
  const announce = useCallback((msg) => {
    annFlip.current = !annFlip.current;
    setAnnouncement(msg + (annFlip.current ? '​' : ''));
  }, []);

  const data = cat.data;
  const rates = data?.rates || { USD: 1, DOP: 60 };
  // Per-dealer distribution: the catalog may carry a `dealer` block (slug, name,
  // locale, currency, usdRate, pricingMode, logoUrl). Absent → Alcover's own
  // embed, i.e. today's behavior verbatim.
  const dealer = data?.dealer || null;
  const locale = resolveConfiguratorLocale({ queryLang, dealerLocale: dealer?.locale });
  const storeName = dealer?.name || data?.storeName || '';
  const dealerLogo = dealer?.logoUrl || null;
  const pricesHidden = dealer?.pricingMode === 'hidden';   // priceUsd all null → show no prices
  const fromMode = dealer?.pricingMode === 'from';         // approximate prices → "Desde …" prefix
  // Live locale for imperative screen-reader narration built inside callbacks —
  // read through a ref so the stable `tr`/`piecesTxt` never capture a stale
  // locale (the catalog, and thus the dealer locale, resolves AFTER those
  // callbacks first mount).
  const localeRef = useRef(locale);
  useEffect(() => { localeRef.current = locale; }, [locale]);
  const tr = useCallback((key, vars) => t(localeRef.current, key, vars), []);
  const piecesTxt = useCallback((n) => piecesLabel(localeRef.current, n), []);
  // Price formatting: NO conversion happens HERE, ever — the number arrives
  // already converted (the server applies retail × the dealer's multiplier ×
  // its FX rate, in dealer.ts), and `currency` only labels it (whole units, no
  // cents). One conversion, server-side, so the widget and the dealer inbox can
  // never disagree. Without a dealer, today's USD display.
  // `from` prepends the localized "Desde/From/…" prefix. Returns null when the
  // amount is hidden (pricingMode 'hidden' → priceUsd null) so callers render
  // nothing at all.
  const fmt = useCallback((usd, { from = false } = {}) => {
    if (usd == null || Number.isNaN(usd)) return null;
    const base = dealer
      ? new Intl.NumberFormat(locale, { style: 'currency', currency: dealer.currency, maximumFractionDigits: 0 }).format(usd)
      : formatMoney(usd, 'USD', rates);
    return from ? `${t(locale, 'price.from')} ${base}` : base;
  }, [dealer, locale, rates]);
  // FBX-only: the configurator is built entirely from the 3D models. We show only
  // pieces that have a mesh (their plan + footprint come from it). The `|| all`
  // guard keeps the widget from going blank if a catalogue has no meshes yet —
  // and it is plain `all` now, not a second `m.svg` drawability test: the payload
  // stopped carrying the outline (togo-embed/payload.ts), and the SERVER still
  // applies that exact gate, so everything that arrives here is drawable by
  // construction. Re-testing it client-side would empty the palette.
  const models = useMemo(() => {
    const all = data?.models || [];
    const withMesh = all.filter((m) => m.mesh?.url);
    return withMesh.length ? withMesh : all;
  }, [data]);
  const materials = useMemo(() => data?.materials || [], [data]);
  // Fabric appearance by color code: the REAL texture (dealer's pCon library,
  // public bucket) and/or the exact RGB — the 3D prefers these over sampling
  // the CDN swatch photo. Every colour of a family shares ONE physical weave
  // (only the dye differs), so a colour with no scan of its own inherits a
  // linked SIBLING's texture marked `tint: true` — the 3D re-tints that weave
  // to the colour's own tone (makeTintedWeave) instead of rendering it flat.
  // Codes without an entry keep today's fallback.
  // ONE builder, shared with the studio's bake pass (lib/configurator/fabricIndex): the
  // descriptor is part of a dressed render's store key, so a second copy here
  // would drift and every baked photo would silently read as stale.
  const fabricByCode = useMemo(() => buildFabricByCode(materials), [materials]);

  // The modular collections on offer, in palette order (first appearance wins) —
  // Togo, Prado, … . Legacy pieces with no collection read as 'Togo'. This is a
  // VIEW facet only: `models` (and everything derived from it — resolvedById,
  // thumbs, mesh plans, placed-piece resolution) always sees the FULL set, so a
  // piece from another collection keeps rendering and pricing after switching.
  //
  // FOLDED, like every other collection surface (lib/configurator/collections). The
  // payload ships `togo_models.collection` RAW — free text typed at import,
  // which drifted: the live catalogue stores «EXCLUSIF» while the index tile
  // this list has to agree with is built by `resolveCollectionMenu`, which
  // folds to «Exclusif». Deduping the raw spellings here put a DIFFERENT name
  // on each side of the same collection, and the piece grid below (which
  // matches the tile's name against these rows) came up EMPTY: Exclusif's one
  // published piece was unreachable in the widget — the tile said 1 pieza and
  // opened on nothing.
  const collections = useMemo(
    () => distinctCollections(models.map((m) => m.collection)),
    [models],
  );
  // NULL is a real state here: it means "step one" — the collection index is
  // showing and nothing has been entered yet. Keep the selection valid as the
  // catalog loads / changes:
  //   • ONE collection → there is nothing to choose, so enter it directly and
  //     the menu never appears;
  //   • several → stay at the index until the visitor picks, and send a
  //     now-invalid selection (a catalogue edit renamed or dropped it) back to
  //     the index rather than silently guessing a different collection.
  useEffect(() => {
    if (!collections.length) return;
    setActiveCollection((cur) => {
      if (collections.length === 1) return collections[0];
      return cur && collections.includes(cur) ? cur : null;
    });
  }, [collections]);
  // What the build palette + empty-plan starter DISPLAY: only the entered
  // collection's pieces; otherwise the full set. At step one this is empty by
  // construction (nothing matches a null collection) — the surfaces render the
  // index instead of a grid.
  // Matched through `collectionKey`, never on the stored string: `activeCollection`
  // is the FOLDED name (it comes from the index tile / this same folded list),
  // and the rows still carry whatever spelling the import typed. The
  // `!!activeCollection` guard is load-bearing — `collectionKey(null)` is 'Togo'
  // by design, so dropping it would fill step one's grid with the Togo pieces
  // instead of leaving it empty for the index.
  const paletteModels = useMemo(
    () => (collections.length > 1
      ? models.filter((m) => !!activeCollection && collectionKey(m.collection) === collectionKey(activeCollection))
      : models),
    [models, collections, activeCollection],
  );
  // Step one's content: one entry per collection, each with the hero piece that
  // stands for it (see resolveCollectionMenu).
  // `data.heroes` is the dealer's own pick of cover piece + cloth per collection
  // (settings.togo_heroes). The VM validates each half against these very models
  // and materials, so a stale pin degrades to the derived cover.
  const collectionMenu = useMemo(
    () => resolveCollectionMenu(models, materials, data?.heroes || null),
    [models, materials, data?.heroes],
  );
  // THE PIECE GRID STAYS IN THE CREAM BODY, deliberately (owner, 2026-08): the
  // collection's own page is what you BUILD from, and there you are reading
  // SHAPES — which arm, which corner, which depth. Dressing every tile in the
  // collection's cloth made the page prettier and the pieces harder to tell
  // apart, which is the wrong trade on the one screen whose whole job is
  // telling them apart. The COVER on the index is dressed (it is a shop
  // window); everything behind it is the neutral body.

  // Each collection's hero rendered in ITS OWN cloth (the VM picks one per
  // collection — see resolveCollectionMenu). Rendered through the SAME studio rig
  // and cache as every other thumbnail, keyed per collection, so the index costs
  // one render per collection for the session and nothing on reopen.
  //
  // Only while the INDEX is the thing on screen. Every thumbnail render in the
  // app serialises through one offscreen renderer, and a render is a GPU
  // read-back plus a PNG encode — the single most expensive thing this app does
  // on the main thread. Left unconditional, stepping into a collection queued
  // that collection's pieces BEHIND however many index heroes were still
  // outstanding: the visitor had already moved on and was waiting on renders for
  // a screen they'd left. Coming back is free — the cache is session-lived.
  // Nothing here any more: each CollectionCard renders its own hero when it
  // scrolls into range. Kept as an empty list so the map the tiles read from
  // still exists (a warm entry wins over a tile's own lazy render).
  const collectionFabricRows = [];
  const collectionFabricThumbs = useConfiguratorFabricThumbs(collectionFabricRows, TILE_THUMB);

  // A mesh-backed piece derives BOTH its plan SVG and its footprint straight from
  // the FBX (`useMeshPlans` → meshToPlan): the 2D tile is literally the model seen
  // from above, so it can never disagree with the 3D. The mesh loads async, so
  // until it resolves we fall back to the stored plan/dims.
  // Load a mesh only once its piece is actually on the plan — the palette uses the
  // light stored thumbnail, so a visitor never pulls FBX bytes for a piece they
  // don't place. The tile shows the stored fallback for the instant it takes the
  // mesh to resolve, then swaps to the exact top-down silhouette.
  const meshEntries = useMemo(() => {
    const used = new Set(placed.map((p) => p.pieceId));
    return models.filter((m) => m.mesh?.url && used.has(m.id)).map((m) => ({ id: m.id, url: m.mesh.url, upAxis: m.mesh.upAxis }));
  }, [models, placed]);
  const meshPlans = useMeshPlans(meshEntries);
  // Plan outlines, MESH-DERIVED ONLY — the catalog payload no longer ships the
  // stored one (togo-embed/payload.ts: 605 outlines, half the payload, for a
  // field nothing on screen reads — the tile and the 3D both come from the FBX).
  // One surface consumes this, the DXF export, and it tops up whatever hasn't
  // resolved from the server on demand. Entries are only ever present when real,
  // so it can be spread over the fetched map without erasing it.
  const svgById = useMemo(
    () => Object.fromEntries(
      Object.entries(meshPlans).filter(([, p]) => p?.svg).map(([id, p]) => [id, p.svg]),
    ),
    [meshPlans],
  );
  // Rendered PERSPECTIVE thumbnails (real FBX, studio rig) keyed by model id —
  // the catalogue image, and the ONLY one: a tile with no render yet shows its
  // bare plate (see ModelThumb), never a drawing standing in for the piece.
  //
  // EAGER renders are now only the pieces ON THE PLAN — the ones the Resumen
  // pane (either shell) and the desktop rail must be able to show the instant
  // they open. Every picker tile renders ITSELF when it comes into range
  // (useLazyThumb), so a collection no longer renders thirteen pieces to fill
  // three visible cards. This started as the whole catalogue (~66 sequential
  // FBX parses, GPU draws and PNG encodes through one offscreen renderer, with
  // the index's own heroes queued behind all of them); it is now the handful
  // that are genuinely already in use.
  const placedModels = useMemo(() => {
    const onPlan = new Set(placed.map((p) => p.pieceId));
    return models.filter((m) => onPlan.has(m.id));
  }, [models, placed]);
  // TILE_THUMB: this map feeds the 4:3 catalogue tile (the biggest box any of it
  // lands in) as well as the 48/56px Resumen and selected-piece chips, so it
  // renders at the tile's frame and the small consumers ride it down.
  const renderThumbById = useConfiguratorThumbnails(placedModels, TILE_THUMB);

  // Per-model family (grades + retail prices) so a fabric pick reprices exactly
  // like the internal configurator (productForGrade), keyed by family root.
  const families = useMemo(() => {
    const map = new Map();
    for (const m of models) {
      const fam = familyFromJson(m.family);
      if (fam) map.set(fam.root, fam);
    }
    return map;
  }, [models]);

  // Resume the in-progress build across reloads/returns — a faster end-to-end flow
  // (a customer doesn't rebuild from scratch). Third-party-iframe storage may be
  // blocked, so everything is guarded; restored rows are filtered to models that
  // still exist. Cleared when the plan is emptied or the request is sent.
  const buildKey = useMemo(() => `togo:build:${data?.storeName || 'default'}`, [data?.storeName]);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !models.length) return;
    restoredRef.current = true;
    const ids = new Set(models.map((m) => m.id));
    // A desktop-QR handoff wins over the local snapshot: rebuild that plan, then
    // strip ?build so a later reload uses the visitor's own edits instead.
    if (urlBuild) {
      try {
        const fromUrl = decodeBuild(urlBuild)
          .filter((p) => ids.has(p.pieceId))
          .map((p) => ({ ...p, uid: newUid() }));
        const roomFromUrl = decodeRoomFromBuild(urlBuild);
        if (fromUrl.length || roomFromUrl) {
          if (fromUrl.length) setPlaced(fromUrl);
          if (roomFromUrl) setRoom(roomFromUrl);
          stripBuildParam();
          return;
        }
      } catch { /* corrupt handoff → fall through to the local snapshot */ }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(buildKey) || 'null');
      const rows = (Array.isArray(saved?.placed) ? saved.placed : []).filter((p) => p && ids.has(p.pieceId));
      if (rows.length) setPlaced(rows);
      if (saved?.room) setRoom(saved.room);
    } catch { /* blocked / corrupt → start fresh */ }
  }, [models, buildKey, urlBuild]);
  useEffect(() => {
    if (!restoredRef.current) return;   // never write before the first restore attempt
    try {
      if (placed.length || room) localStorage.setItem(buildKey, JSON.stringify({ placed, room, at: Date.now() }));
      else localStorage.removeItem(buildKey);
    } catch { /* ignore */ }
  }, [placed, room, buildKey]);

  // "Plano vaciado · Deshacer" toast — the one-tap clear stays one tap (no
  // modal, the Rams skin wants no ceremony), but recovery becomes explicit.
  // Any mutation dismisses it (the clear itself re-raises it right after).
  const [clearToast, setClearToast] = useState(false);
  const clearTimer = useRef(0);
  useEffect(() => () => clearTimeout(clearTimer.current), []);

  // ── History plumbing: every user mutation goes through commitPlaced, which
  // snapshots the previous state (one undo entry per gesture). The restore-from-
  // localStorage path above deliberately bypasses it (nothing to undo TO).
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);
  // Arrow-nudge coalescing window (uid + wall clock). Any OTHER commit closes
  // the window, so a nudge after a drag/undo/redo always opens its own undo
  // entry — a coalesced write bypasses historyPush and must never swallow one.
  const nudgeState = useRef({ t: 0, uid: null, timer: 0 });
  useEffect(() => () => clearTimeout(nudgeState.current.timer), []);
  const commitPlaced = useCallback((next) => {
    const prev = placedRef.current;
    const value = typeof next === 'function' ? next(prev) : next;
    if (value === prev) return;
    setClearToast(false);
    nudgeState.current.t = 0;
    setHist((h) => historyPush(h, prev));
    setPlaced(value);
    placedRef.current = value;
  }, []);
  const undo = useCallback(() => {
    const u = historyUndo(hist, placedRef.current);
    if (!u) return;
    buzz(7);
    setClearToast(false);
    nudgeState.current.t = 0;
    setHist(u.hist); setPlaced(u.present); placedRef.current = u.present;
    announce(tr('announce.undone'));
  }, [hist, announce, tr]);
  const redo = useCallback(() => {
    const r = historyRedo(hist, placedRef.current);
    if (!r) return;
    buzz(7);
    setClearToast(false);
    nudgeState.current.t = 0;
    setHist(r.hist); setPlaced(r.present); placedRef.current = r.present;
    announce(tr('announce.redone'));
  }, [hist, announce, tr]);
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  const resolvedById = useMemo(() => {
    const o = {};
    for (const m of models) {
      const mp = meshPlans[m.id];        // mesh owns the tile OUTLINE (svgById); NOT the size
      o[m.id] = {
        id: m.id, label: m.name,
        // CATALOGUE dims are authoritative. The FBX footprint over-reads the soft
        // cushion overhang (a real 100 cm ottoman AABB-measures ~117, a 120x100
        // rectangular reads ~117x121), so the dealer's catalogue size wins — the
        // mesh footprint is only a fallback when the catalogue carries none (0).
        widthCm: Number(m.widthCm) > 0 ? m.widthCm : (mp?.widthCm ?? m.widthCm),
        depthCm: Number(m.depthCm) > 0 ? m.depthCm : (mp?.depthCm ?? m.depthCm),
        unitPrice: m.priceUsd, root: m.family?.root || m.root || null,
        offeredKeys: m.offeredFabricKeys || [],
        mesh: m.mesh || null,
        // The collection drives the 3D seam fit (Togo squishes +4%; structured
        // collections fill their tile exactly). This map is the ONLY resolver
        // the public widget uses — dropping the field here is what kept Prado
        // on the Togo overfill (“magnetizing too close”) despite the
        // collection-aware Model.
        collection: m.collection || 'Togo',
        // Default spawn rotation (deg, clockwise) — a corner piece drops
        // pre-turned so its open face meets the run, not its backrest.
        defaultRot: Number(m.defaultRot) || 0,
        // Per-part editing: the dealer's tagging + each non-base role's own
        // retail-priced family (shared cushion/bolster SKUs).
        parts: m.parts || null,
        partFamilies: m.partFamilies
          ? Object.fromEntries(Object.entries(m.partFamilies).map(([role, f]) => [role, familyFromJson(f)]))
          : null,
        // The model's OWN graded family — materialization zones (ottoman
        // interior/exterior) re-grade this same SKU (materializedBase).
        baseFamily: familyFromJson(m.family),
        mount: m.mount || null,
        mountHeightCm: m.mountHeightCm ?? null,
      };
    }
    return o;
  }, [models, meshPlans]);


  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: SCALE }), [placed, resolvedById]);
  const scene3d = useMemo(() => resolveConfiguratorScene(scenePlacementsFromPlaced(placed, resolvedById)), [placed, resolvedById]);
  // THE DESIGN LINK — the current build encoded into a URL that reopens it
  // exactly (lib/configurator/buildShare + lib/configuratorEmbed). ONE url, two exits:
  //   • the desktop AR QR (`handoffUrl`) — the phone restores the plan and
  //     places it life-size, since WebAR needs a camera a laptop hasn't got;
  //   • "Compartir mi diseño" (`shareDesign`) — on EVERY device, because the
  //     person who builds the sofa is rarely the only person who decides. A
  //     design that can only be rebuilt from scratch dies in the tab it was
  //     made in.
  // Carries `locale` so the recipient lands in the sender's language instead of
  // the dealer's default. '' (→ null) while the plan is empty.
  const designUrl = useMemo(
    () => configuratorHandoffUrl(dealerSlug, encodeBuild(placed, room), { lang: locale }) || null,
    [placed, room, dealerSlug, locale],
  );
  const handoffUrl = FINE_POINTER ? designUrl : null;

  // The two top clusters share one row; `useToolbarFit` measures whether the
  // right one can afford its words (see the hook).
  const leftBarRef = useRef(null);
  const toolsBarRef = useRef(null);

  // Share/copy the design link. `navigator.share` where the OS offers it (the
  // phone's own sheet — WhatsApp is one tap in), clipboard everywhere else. A
  // dismissed share sheet (AbortError) is a non-event, never an error toast.
  const [shareToast, setShareToast] = useState('');
  const shareTimer = useRef(0);
  useEffect(() => () => clearTimeout(shareTimer.current), []);
  const flashShare = useCallback((msg) => {
    clearTimeout(shareTimer.current);
    setShareToast(msg);
    shareTimer.current = setTimeout(() => setShareToast(''), 3200);
  }, []);
  const shareDesign = useCallback(async () => {
    if (!designUrl) return;
    const text = tr('share.text', {
      pieces: piecesTxt(vm.count),
      size: `${vm.overallCm.widthCm}×${vm.overallCm.depthCm}`,
    });
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: tr('share.title'), text, url: designUrl });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return; // the visitor closed the sheet
        // Any other share failure falls through to the clipboard below.
      }
    }
    if (await copyToClipboard(designUrl)) {
      flashShare(tr('share.copied'));
      announce(tr('share.copied'));
    } else {
      flashShare(tr('share.failed'));
    }
  }, [designUrl, tr, piecesTxt, vm.count, vm.overallCm, flashShare, announce]);
  // Fit readout (visual reference): how far the assembled design pokes past the
  // room, if a room is drawn. Never blocks — just tells the customer/dealer.
  const roomFitInfo = useMemo(() => roomFit(room, vm.boundsCm), [room, vm.boundsCm]);
  // Apply W×D (cm) as a centred rectangle: keep the current room's centre on a
  // resize; otherwise centre on the design (so it wraps existing furniture),
  // falling back to the plan's default centre when the plan is empty.
  const applyRoom = useCallback((widthCm, depthCm) => {
    const c = room
      ? roomCenter(room)
      : (vm.boundsCm
        ? { x: (vm.boundsCm.minX + vm.boundsCm.maxX) / 2, y: (vm.boundsCm.minY + vm.boundsCm.maxY) / 2 }
        // Empty plan → put the room's top-left near the origin, where the first
        // piece spawns (~40,40 in addPiece), so furniture lands INSIDE it.
        : { x: widthCm / 2, y: depthCm / 2 });
    setRoom(makeRectRoom(widthCm, depthCm, { cx: c.x, cy: c.y }));
  }, [room, vm.boundsCm]);
  const clearRoom = useCallback(() => { setRoom(null); setRoomOpen(false); }, []);
  /**
   * THE ROOM YOU ARE STILL TYPING, drawn on the plan.
   *
   * «Espacio» used to commit or show nothing: you set 400 × 300 and the canvas
   * stayed empty until CREAR — so the one question the tool exists to answer
   * («¿cabe?») could only be asked by committing first and undoing after. The
   * panel now reports its live figures and the plan draws that rectangle
   * straight away, at the SAME centre `applyRoom` will use, so pressing CREAR
   * changes nothing on screen: it only stops the preview from being a preview.
   *
   * Built through `makeRectRoom` — the very function that builds the real one —
   * so the outline you judge and the room you get cannot differ.
   */
  const [roomDraft, setRoomDraft] = useState(null);   // { widthCm, depthCm } | null
  const roomPreview = useMemo(() => {
    if (!roomDraft || room) return null;   // an existing room is already drawn
    const c = vm.boundsCm
      ? { x: (vm.boundsCm.minX + vm.boundsCm.maxX) / 2, y: (vm.boundsCm.minY + vm.boundsCm.maxY) / 2 }
      : { x: roomDraft.widthCm / 2, y: roomDraft.depthCm / 2 };
    return makeRectRoom(roomDraft.widthCm, roomDraft.depthCm, { cx: c.x, cy: c.y });
  }, [roomDraft, room, vm.boundsCm]);
  // The panel is a floating tool: closing it must take its preview with it.
  useEffect(() => { if (!roomOpen) setRoomDraft(null); }, [roomOpen]);
  const selected = placed.find((p) => p.uid === selectedUid) || null;
  const selectedFamily = selected ? (families.get(resolvedById[selected.pieceId]?.root) || null) : null;
  // THE MATERIAL RAIL IS A DRAWER, and these two decide it. `railFamily` is the
  // ladder the pane would dress — the tapped PART's own family (a zone re-grades
  // the piece's SKU, so it dresses from the piece's ladder), else the piece's.
  // `railOpen` is "is there anything to pick": a target with a real ladder, or
  // an explicit «aplicar a todas». Derived ONCE so what the pane renders and
  // what decides to open it can never disagree — a rail that opens onto an
  // empty catalog is exactly the noise this removes.
  // The ladder a PART pick prices against: the model's OWN family for a
  // materialization zone (a zone re-grades that SKU), the part's bound family
  // for a billed componente. Named on its own because two things need it — the
  // rail below, and the OFFER (`pickableMaterials`) — and those two must never
  // disagree about which ladder is in play.
  const partFamily = selected && matPart
    ? (MATERIALIZATION_ROLES.includes(matPart)
      ? selectedFamily
      : (resolvedById[selected.pieceId]?.partFamilies?.[matPart] || null))
    : null;
  const railFamily = selected && matPart ? partFamily : (selected ? selectedFamily : null);
  // ── AN UNPRICEABLE FABRIC IS NOT A CHOICE ─────────────────────────────────
  // A module's ladders are DIFFERENT SKUs: the settee's own, and its cushion
  // family's — 11370012 offers A,B,D,E,U,F,G,J,K,O,Q,X,R and no I. Dressing the
  // cojines in ARDA/FR (Grade I) therefore stored a pick nothing could price,
  // and the money silently shrank: the Cojín line left the Resumen, its
  // component left the quote seed, and a BY-PARTS build quoted cheaper than the
  // monocolor one it is supposed to be dearer than.
  //
  // The Model closes it downstream (`unresolvedPartRoles` → the line stays, the
  // piece reads «sin precio», the worker files the lead as `unresolved`), and
  // this closes it at the door: a material the TARGET cannot be priced in never
  // renders as a swatch to tap. The same question `partPricesFor` asks at
  // render time, asked one gesture earlier. Filtered at the `materials` prop
  // because BOTH pickers take it — the desktop rail and the phone sheet — so
  // one derivation covers the two of them, and neither picker had to learn
  // anything about grades. Only for a graded ladder: an ungraded (or unbound)
  // family prices any pick by construction, so a catalogue with no ladder data
  // keeps its whole wall.
  //
  // …AND THE WHOLE PIECE TOO (2026-08). The part fix stopped at the componente
  // ladders and left the model's OWN open, which is the same hole and the
  // bigger one: the Prado settee's family 11370700 sells C, D, L, M, S and V,
  // yet the wall offered all 55 telas the model is linked to, so 32 of them
  // stored a grade that SKU has never been priced in — and `onPickMaterial`
  // stamps the model's CHEAPEST grade when `productForGrade` comes back empty,
  // so it never even looked broken. Owner: «solo deberían salir para un modelo
  // las telas que sí le corresponden».
  //
  // WHICH ladders must agree depends on where the pick is about to land, and
  // that is read off the very dispatch that will receive it (`onPanePick` on
  // desktop, the modal's own `onSelect` on the phone) rather than guessed at a
  // second time: one piece ⇒ that model's ladder; «aplicar a todas» ⇒ EVERY
  // placed piece's at once, so the wall is their INTERSECTION (a cloth that
  // prices on four models and not the fifth would leave the fifth silently at
  // its cheapest grade — the same lie, spread thinner).
  const pickLadders = useMemo(() => {
    const gradedOnly = (fam) => (fam?.graded ? [fam] : []);   // no ladder ⇒ no constraint
    if (matPart) return gradedOnly(partFamily);
    // Desktop dresses ALL only with nothing selected (openMaterial clears it);
    // the phone keeps its selection and switches on `matMode`.
    const one = desktop ? selectedUid != null : matMode !== 'all';
    if (one) return gradedOnly(selectedFamily);
    return placed.flatMap((row) => gradedOnly(families.get(resolvedById[row.pieceId]?.root)));
  }, [matPart, partFamily, desktop, selectedUid, matMode, selectedFamily, placed, resolvedById, families]);
  const pickableMaterials = useMemo(() => {
    if (!pickLadders.length) return materials;
    const offer = (materials || []).filter((m) => pickLadders.every((fam) => {
      const prod = productForGrade(fam, String(m?.grade || ''));
      return !!prod && prod.priceUsd != null;
    }));
    // NO-VANISH at the door as well: a wall with nothing on it answers no
    // question at all, and disjoint ladders across an «aplicar a todas» can
    // reach that. Ship the catalogue whole and let the pricing gates downstream
    // («sin precio», the worker's `unresolved`) do what they already do.
    return offer.length ? offer : materials;
  }, [materials, pickLadders]);
  // A FINISH target opens it on its own account: the acabado ladder is the
  // group's fixed palette, not a fabric family, so `railFamily` has nothing to
  // say about it (owner: «QUIERO QUE ELEGIR LA ESTRUCTURA SEA IGUAL QUE LOS
  // COMPONENTES CON EL PIPETTE» — same rail, same pipette, different ladder).
  const railOpen = desktop && view === '3d' && vm.count > 0
    && (finishRail ? true : (selected ? !!railFamily : matMode === 'all'));
  // The RIGHT-hand twin of `railOpen`: «Tu diseño» is an overlay too, so the
  // stage has to frame against the width it leaves. Derived here — once — and
  // used BOTH to mount the pane and to size the stage's inset, so the canvas can
  // never be told a pane is there when it isn't (that disagreement is exactly
  // what the left side learned with the material rail). Unlike the rail it is
  // view-agnostic: the pane renders in 2D and 3D alike.
  const designPaneOpen = desktop && vm.count > 0;
  // …and WHO the open rail is waiting on, from those same inputs (waitingPick).
  // The design pane lights that one target's pill; the rail wears the right-edge
  // line — the two halves of one link, never derived apart.
  const waiting = waitingPick({ railOpen, selectedUid, matPart, matMode, finishRail });
  const selResolved = selected ? resolvePlacement(selected, resolvedById) : null;

  // Togo's price depends on the fabric GRADE, so a piece has no real price until
  // its cloth is chosen: the estimate sums ONLY dressed pieces (the rest read
  // "Elige una tela"), and the palette shows no price at all. USD throughout.
  // A piece bills once it is DRESSED — `placementDressed`, which is either the
  // whole-piece cloth OR every componente picked (the money rule: la suma de
  // los componentes una vez elegidos todos) — at base + its tagged parts at
  // THEIR grades (unpicked parts default to the cheapest, the module physically
  // ships with them, so the estimate reflects the real price, exactly like the
  // dealer-side quote line will).
  const dressed = useCallback((p) => placementDressed(p, resolvedById), [resolvedById]);
  const pricedUsd = useMemo(
    () => placed.reduce((s, p) => s + (dressed(p) ? (placementTotalUsd(p, resolvedById) ?? 0) : 0), 0),
    [placed, resolvedById, dressed],
  );
  const pendingFabric = useMemo(() => placed.filter((p) => !dressed(p)).length, [placed, dressed]);
  // Pieces that ARE dressed and still have no price — the piece itself, or one
  // of its parts, is wearing cloth that ladder doesn't sell (placementTotalUsd
  // → null; the whole-piece case is the quieter one, since the pick stamped the
  // model's cheapest grade and the figure looked fine). They are NOT
  // «sin tela»: that counter names a fabric nobody chose, and these have one.
  // What they cost the BUILD is the point: `pricedUsd` folds them in as 0, so
  // any total stated over them is a real-looking number that is simply missing
  // a piece — the same silently-cheaper shape, one level up. So wherever a
  // total is stated to somebody, this says it can't be.
  const unpricedPieces = useMemo(
    () => placed.filter((p) => dressed(p) && placementTotalUsd(p, resolvedById) == null).length,
    [placed, resolvedById, dressed],
  );
  // "Aplicar a todas" stays LIMITED to what the linked catalog products offer:
  // the INTERSECTION of every placed piece's offering (a piece without a
  // linked restriction is a wildcard). Disjoint offerings fall back to their
  // UNION — still catalog-bounded, never the whole materials list.
  const allNameFilter = useMemo(() => {
    const lists = placed
      .map((p) => resolvedById[p.pieceId]?.offeredKeys)
      .filter((k) => Array.isArray(k) && k.length);
    if (!lists.length) return undefined;
    const inter = lists.reduce((acc, keys) => acc.filter((k) => keys.includes(k)));
    return new Set(inter.length ? inter : [...new Set(lists.flat())]);
  }, [placed, resolvedById]);
  // The estimate ticks up like a score; the CTA "breathes" once there's a real,
  // priced quote to send (a piece down AND a fabric chosen).
  const animatedUsd = useCountUp(pricedUsd);
  const quoteReady = vm.count > 0 && pricedUsd > 0;
  // The moment the build becomes REAL — a piece down and a fabric chosen, so
  // there is a price on screen. Reported once per visit as Meta `ViewContent`:
  // the audience of people who configured something and didn't ask for a quote,
  // which is the one worth retargeting and was previously invisible.
  useEffect(() => {
    if (quoteReady) reportConfiguratorView({ estimateUsd: pricedUsd, pieces: vm.count, dealerSlug });
  }, [quoteReady, pricedUsd, vm.count, dealerSlug]);

  // The hotbar tile that just landed a piece flashes once — tap → confirmation,
  // even before the eye finds the new piece dropping onto the plan.
  const [flashId, setFlashId] = useState(null);
  const flashTimer = useRef(0);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const addPiece = useCallback((modelId) => {
    const r = resolvedById[modelId]; if (!r) return;
    // Spawn at the model's DEFAULT rotation — a corner piece comes in already
    // turned so its open face meets the run (dropped flush to the right), not
    // its backrest. The user can still free-rotate afterwards.
    const spawnRot = norm360(r.defaultRot || 0);
    const fp = footprintOf(r, spawnRot);
    // Seat-mounted accessories (loose cushions/bolsters) float ABOVE the plan:
    // they neither appear as collision neighbours nor snap themselves — a
    // cushion drops ONTO the last module (centred on its tile), ready to slide.
    const seat = mountOf(r).seat;
    const floorPieces = placed.filter((p) => !mountOf(resolvedById[p.pieceId] || {}).seat);
    const others = floorPieces.map((p) => { const rp = resolvePlacement(p, resolvedById); const f = footprintOf(rp, p.rot); return { x: p.x, y: p.y, w: f.w, h: f.h, col: rp.collection }; });
    // Drop the new piece FLUSH against the RIGHTMOST piece, top-aligned to THAT
    // piece — so a sectional builds out as a connected row that always touches,
    // never floats (aligning to the global top could leave it clear of every
    // neighbour in an L-shape) and never stacks. The floor is unbounded — the row
    // just keeps growing. First piece → default spot.
    let x = 40, y = 40;
    if (others.length) {
      const right = others.reduce((a, o) => (o.x + o.w > a.x + a.w ? o : a));
      x = right.x + right.w; y = right.y;
    }
    if (seat && others.length) {
      const last = others[others.length - 1];
      x = last.x + (last.w - fp.w) / 2; y = last.y + (last.h - fp.h) / 2;
    }
    // Firm dock range (not the gentle 12 cm live magnet) so a collection's NEST
    // (which can exceed 12 cm) engages when the piece drops next to the run.
    const snapped = seat ? { x, y } : snapPlacement({ x, y, w: fp.w, h: fp.h, col: r.collection }, others, { edgeCm: RELEASE_DOCK_CM });
    const uid = newUid();
    // CUERPO VACÍO ⇒ derecho a componentes (owner, 2026-08-05: «if it's an
    // empty body we can go straight into components»). Un modelo sin SKU propio
    // no puede cotizar en modo pieza, así que nacer ahí es nacer «sin precio»
    // con el interruptor como único camino — y nadie lo busca. El Model decide
    // (sellsByComponentsOnly); esto solo siembra el modo con su respuesta.
    const bodyless = sellsByComponentsOnly(r);
    commitPlaced([...placed, {
      uid, pieceId: modelId, x: snapped.x, y: snapped.y, rot: spawnRot,
      ...(bodyless ? { partsMode: true } : {}),
    }]);
    suppressSelNarration.current = true;   // the add message is the one that must be heard
    setSelectedUid(uid);
    buzz(11);
    announce(tr('announce.added', { name: r.label || tr('piece.generic'), pieces: piecesTxt(placed.length + 1) }));
    setFlashId(modelId);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 450);
  }, [resolvedById, placed, commitPlaced, announce, tr, piecesTxt]);

  // Set a piece's rotation to ANY angle (the stage's free-rotate gesture commits
  // here; a tap steps +90°). The piece pivots around its own CENTRE: the stored
  // (x,y) is the footprint-AABB top-left, so it's recomputed from the centre for
  // the new angle's AABB — the piece spins in place, it never walks.
  const rotateTo = useCallback((uid, deg) => {
    if (uid == null) return;
    buzz(7);
    commitPlaced((prev) => (prev.some((p) => p.uid === uid)
      ? prev.map((p) => {
        if (p.uid !== uid) return p;
        const r = resolvePlacement(p, resolvedById);
        const rot = norm360(deg);
        const fpOld = footprintOf(r, norm360(p.rot));
        const fpNew = footprintOf(r, rot);
        const cx = p.x + fpOld.w / 2, cy = p.y + fpOld.h / 2;
        return { ...p, rot, x: +(cx - fpNew.w / 2).toFixed(2), y: +(cy - fpNew.h / 2).toFixed(2) };
      })
      : prev));
    announce(tr('announce.rotated', { deg: Math.round(norm360(deg)) }));
  }, [resolvedById, commitPlaced, announce, tr]);
  const deletePiece = useCallback((uid) => {
    if (uid == null) return;
    buzz([4, 26, 7]);
    const me = placedRef.current.find((p) => p.uid === uid);
    const label = me ? (resolvedById[me.pieceId]?.label || tr('piece.generic')) : tr('piece.generic');
    const remaining = placedRef.current.length - (me ? 1 : 0);
    commitPlaced((prev) => (prev.some((p) => p.uid === uid) ? prev.filter((p) => p.uid !== uid) : prev));
    setSelectedUid((s) => (s === uid ? null : s));
    if (me) announce(remaining ? tr('announce.removed', { name: label, count: remaining }) : tr('announce.removedEmpty', { name: label }));
  }, [commitPlaced, resolvedById, announce, tr]);
  const deleteSel = useCallback(() => deletePiece(selectedUid), [deletePiece, selectedUid]);
  // Duplicate the selected piece (same rotation + fabric), dropped flush beside it.
  const duplicateSel = useCallback(() => {
    if (!selectedUid) return;
    const r = duplicatePlacement(placedRef.current, selectedUid, resolvedById, newUid());
    if (!r) return;
    buzz(11);
    commitPlaced(r.placed);
    suppressSelNarration.current = true;   // "duplicada" must not be clobbered
    setSelectedUid(r.uid);
    announce(tr('announce.duplicated'));
  }, [selectedUid, resolvedById, commitPlaced, announce, tr]);

  // Empty the whole plan (one tap; recovery rides the "Deshacer" toast). Shared
  // by the desktop eraser icon and the mobile tools menu, so the two can't drift.
  const clearPlan = useCallback(() => {
    buzz([4, 26, 7]);
    commitPlaced([]);
    setSelectedUid(null);
    announce(tr('announce.cleared'));
    setClearToast(true);
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setClearToast(false), 6000);
  }, [commitPlaced, announce, tr]);

  // ── Keyboard editing (the plan is fully operable without a pointer) ──
  // Arrow-key nudges move the selected piece on the fine snap grid (Shift = big
  // steps). Consecutive nudges inside a short window COALESCE into one undo
  // entry, so holding an arrow doesn't flood the history stack.
  const selUidRef = useRef(selectedUid);
  useEffect(() => { selUidRef.current = selectedUid; }, [selectedUid]);
  const nudgeSel = useCallback((dx, dy) => {
    const uid = selUidRef.current; if (!uid) return false;
    const now = Date.now();
    // Coalesce ONLY consecutive nudges of the SAME piece inside the window —
    // and any other commit/undo/redo zeroes `t`, so a coalesced (history-less)
    // write can never merge across pieces or swallow an undo boundary.
    const coalesce = now - nudgeState.current.t < 700 && nudgeState.current.uid === uid;
    nudgeState.current.uid = uid;
    // A nudge collides exactly like a drag: the moved box rides through
    // snapPlacement against the other pieces, so arrow-stepping INTO a
    // neighbour stops at flush contact instead of embedding 2 cm per press.
    const apply = (prev) => prev.map((p) => {
      if (p.uid !== uid) return p;
      const rp = resolvePlacement(p, resolvedById);
      const fp = footprintOf(rp, norm360(p.rot));
      // Seat-mounted accessories float above the plan: they nudge freely and
      // never collide; floor pieces also never collide AGAINST them.
      const seat = mountOf(resolvedById[p.pieceId] || {}).seat;
      const others = prev.filter((o) =>
        o.uid !== uid && norm360(o.rot) % 90 === 0 && !mountOf(resolvedById[o.pieceId] || {}).seat,
      ).map((o) => {
        const ro = resolvePlacement(o, resolvedById);
        const f = footprintOf(ro, norm360(o.rot));
        return { x: o.x, y: o.y, w: f.w, h: f.h, col: ro.collection };
      });
      // edgeCm 0: no magnet on a nudge (it would yank a piece BACK to a flush
      // neighbour, locking it in place) — only the collision resolve runs.
      const moved = seat || norm360(p.rot) % 90 !== 0
        ? { x: +(p.x + dx).toFixed(2), y: +(p.y + dy).toFixed(2) }
        : snapPlacement({ x: p.x + dx, y: p.y + dy, w: fp.w, h: fp.h, col: rp.collection }, others, { edgeCm: 0 });
      return { ...p, x: moved.x, y: moved.y };
    });
    if (coalesce) {
      const next = apply(placedRef.current);
      setClearToast(false);
      setPlaced(next);
      placedRef.current = next;
    } else {
      commitPlaced(apply);   // zeroes the window; re-arm it below
    }
    nudgeState.current.t = now;
    // One debounced announcement per nudge burst, with the final resting spot.
    clearTimeout(nudgeState.current.timer);
    nudgeState.current.timer = setTimeout(() => {
      const me = placedRef.current.find((p) => p.uid === uid);
      if (me) announce(tr('announce.moved', { x: Math.round(me.x), y: Math.round(me.y) }));
    }, 650);
    return true;
  }, [commitPlaced, announce, tr, resolvedById]);
  const rotateSelBy = useCallback((delta) => {
    const uid = selUidRef.current; if (!uid) return false;
    const me = placedRef.current.find((p) => p.uid === uid); if (!me) return false;
    rotateTo(uid, norm360(norm360(me.rot) + delta));
    return true;
  }, [rotateTo]);

  // Material pick for the selected piece → reprice by grade + stamp swatch/subtype.
  const onPickMaterial = useCallback((pick) => {
    if (!selected) return;
    buzz(9);
    const p = selectedFamily ? productForGrade(selectedFamily, pick.grade) : null;
    commitPlaced((prev) => prev.map((row) => (row.uid === selected.uid ? {
      ...row,
      material: {
        grade: pick.grade, fabric: pick.fabric, code: pick.code || '', swatchImageId: null,
        subtype: composeSubtype(pick.grade, pick.fabric),
        reference: p?.reference || '',
        unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[row.pieceId]?.unitPrice ?? null),
      },
    } : row)));
    announce(tr('announce.fabricApplied', { name: pick.fabric }));
  }, [selected, selectedFamily, resolvedById, commitPlaced, announce, tr]);

  // FINISH sheet — { uid, partKey, spec } while open. Price-neutral by design
  // (v1): choosing acero vs acero negro re-materializes the part in 3D and rides
  // the lead payload; it never touches pricing.
  const [finishSheet, setFinishSheet] = useState(null);
  // ONE commit for both chromes (desktop rail, phone sheet): the state write is
  // the thing that must not fork — a second copy of it is how the two surfaces
  // would start applying subtly different acabados. What DOES differ is the
  // DISMISSAL, and it is decided by the CHROME, never by the material kind and
  // never by the target level: a sheet is a modal question, so answering it
  // dismisses; the rail IS the desktop workspace, so the target it holds
  // survives its own pick — chip, plates, highlight and scroll all stay put,
  // exactly like a piece or part cloth pick (onPanePick). A target is a
  // question that stays asked until something else answers it: the chip's ✕, a
  // cloth retarget (openMaterial), or deselecting the piece.
  const onPickFinish = useCallback((optionId) => {
    const sheet = finishSheet || finishRail;
    if (!sheet) return;
    buzz(9);
    commitPlaced((prev) => prev.map((row) => (row.uid === sheet.uid ? {
      ...row,
      partFinishes: { ...(row.partFinishes || {}), [sheet.partKey]: optionId },
    } : row)));
    const opt = finishOptionOf(sheet.spec, optionId);
    if (opt) announce(tr('announce.fabricApplied', { name: opt.label }));
    setFinishSheet(null);   // the phone's sheet dismisses; the desktop rail does NOT (see above)
  }, [finishSheet, finishRail, commitPlaced, announce, tr]);

  // Escape closes the finish SHEET — the ✕ and the backdrop already do, and the
  // keyboard must agree. The global key handler is gated on `!finishSheet`, so
  // Escape with the sheet open closes the SHEET and leaves the piece behind it
  // selected: one exit per Escape, topmost chrome first.
  useEffect(() => {
    if (!finishSheet) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFinishSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishSheet]);

  // The way BACK from a picked acabado — the estructura sibling of
  // `clearPartMaterial`, and the same shape for the same reason: the pick is
  // DROPPED, never overwritten with the default's id. `finishOptionOf` already
  // resolves an absent pick to the palette's default, so "no pick" is what
  // "wearing the colección's acabado" MEANS everywhere downstream — the scene
  // materializes it, the lead payload omits it (`sanitizePartFinishes`), and a
  // dealer reading the request sees a piece nobody re-specified. Writing the
  // default id instead would ship a piece that merely happens to match today's
  // colección and silently stops following it tomorrow.
  const clearPartFinish = useCallback((uid, group) => {
    if (!uid || !group) return;
    buzz(7);
    commitPlaced((prev) => prev.map((row) => {
      if (row.uid !== uid || !row.partFinishes || !(group in row.partFinishes)) return row;
      const next = { ...row.partFinishes };
      delete next[group];
      return { ...row, partFinishes: Object.keys(next).length ? next : undefined };
    }));
    // Announced as the acabado it LANDS on, in the very words the pick uses —
    // to the visitor this is the same act ("it now wears X"), and the reset is
    // just how they got there.
    const me = placedRef.current.find((row) => row.uid === uid);
    const r = me ? resolvedById[me.pieceId] : null;
    const opt = finishOptionOf(structureGroupFor(r?.parts, group)?.spec, null);
    if (opt) announce(tr('announce.fabricApplied', { name: opt.label }));
  }, [commitPlaced, resolvedById, announce, tr]);

  // ── WHAT THE VIEWPORT MUST SHOW, AT EVERY MOMENT ──────────────────────────
  // The stage's half of `waitingPick` (owner, 2026-07-31: «WHEN I SELECT
  // CUSHIONS I WANT YOU TO HIGHLIGHT ONLY THE CUSHIONS ON THE VIEWPORT»). Same
  // inputs, same lifecycle, one derivation: the pill that lights up in the
  // panel and the mesh that lights up in the scene name the SAME part, so a
  // second source of truth can't point the two halves at different things.
  //
  // MOST SPECIFIC FIRST, and there is always an answer for a selected piece
  // (owner, 2026-08-01: «the highlight needs to be responsive to all our current
  // selections or actions»):
  //   1. an ESTRUCTURA target open  → that finish group (the legs alone);
  //   2. a fabric PART target open  → that role (all the cushions);
  //   3. a piece merely SELECTED    → everything it can be DRESSED in, i.e. the
  //      piece MINUS its estructura. This is «when I first click the piece …
  //      only the parts that have editable fabrics … the structure should not be
  //      part of that highlight»: the gold line used to hug the metal feet, and
  //      a highlight that includes what this gesture cannot change is a promise
  //      the panel then breaks. Tapping «Estructura» is how you ask for those,
  //      and case 1 answers it — closing back drops to here.
  //   4. «aplicar a todas» (or nothing selected) → null, the whole layout: its
  //      subject is every piece at once, so narrowing would misstate it.
  // The 2D plan ignores all of it (the stage gates parts on 3D), which is why no
  // case tests `view` — the one place that rule lives is `focusMeshesFor`.
  // Declared here rather than beside `waiting` because the finish sheet is
  // state declared above this line; the fabric half reads the same picker
  // state on both chromes (desktop rail `railOpen`, phone sheet `matOpen`).
  // ── …MINUS WHAT THIS CLOTH WILL NOT REPAINT ────────────────────────────────
  // Owner, 2026-08-01 (with a shot of a FR CELADON body and ACATE·ANIS
  // cushions): «telas diferentes pero el highlight de base no se ajusta» — the
  // whole-piece outline still wrapped the cushions. It is the estructura rule
  // one axis over: a part carrying its OWN pick is not repainted by the piece's
  // fabric, so including it in the dressable highlight promises something the
  // pick then refuses. Emitted for the DRESSABLE case alone — which is also the
  // whole-piece PICKER (no `matPart` ⇒ the role below resolves to DRESSABLE),
  // so the open rail and the resting selection make the identical promise. Any
  // stored pick counts, even one in the very same cloth: the question is not
  // "does it look different?" but "will this gesture change it?", and it will
  // not. Derived inline off `placed`, so clearing a pick re-grows the outline
  // and making one shrinks it on the very next render.
  // ── THE STRIP'S SUBJECT — hovered piece wins, else the selected one, so the
  // rail answers "what is under my pointer" without losing the piece you are
  // actually working on the moment the pointer leaves it.
  const stripPiece = useMemo(() => {
    const byUid = (uid) => (uid == null ? null : placed.find((row) => row.uid === uid) || null);
    // Falls back to the SELECTION when the hovered uid resolves to nothing (it
    // survives a 240 ms grace, so it can outlive the piece it named). Without
    // the fallback the rail would empty itself for those frames — and an empty
    // rail is an absent rail, which is exactly the flicker the note below is
    // about.
    return byUid(chipHoverSel?.uid) || byUid(selectedUid);
  }, [chipHoverSel?.uid, selectedUid, placed]);
  const stripResolved = stripPiece ? resolvePlacement(stripPiece, resolvedById) : null;
  const stripEntries = useMemo(
    () => pieceSwatchEntries(
      stripPiece, stripResolved, locale,
      // Component view = THE MODE, full stop (owner, 2026-08-05: «when this O
      // mode is selected it should only show the base SKU and structure
      // selections»). Pointing at, or opening the picker on, a componente no
      // longer re-dresses the rail behind the pointer — landing the pick is
      // what enters modo componentes, and then the chips are simply there.
      stripPiece && stripResolved ? componentViewOf(stripPiece) : false,
    ),
    [stripPiece, stripResolved, locale, matPart],
  );
  // WHAT THE POINTER IS ON, as a strip key — the 3D hover's own part, mapped
  // through the same role/group pair the entries are keyed by, so the highlight
  // in the rail and the mesh under the ray can never disagree.
  const stripHoverKey = useMemo(() => {
    if (!chipHoverSel || !stripPiece || chipHoverSel.uid !== stripPiece.uid) return null;
    if (chipHoverSel.partRole === 'structure') {
      const g = structureGroupFor(stripResolved?.parts, chipHoverSel.partKey || null);
      return g ? `structure:${g.group}` : null;
    }
    if (isWholePieceRole(stripPiece, stripResolved, chipHoverSel.partRole)) return 'base';
    return chipHoverSel.partRole && dressableRoles(stripResolved).includes(chipHoverSel.partRole)
      ? chipHoverSel.partRole : 'base';
  }, [chipHoverSel, stripPiece, stripResolved]);
  // ENTRADA DEL RAIL → VOCABULARIO DE FOCO, una sola vez. El chip de la tela de
  // la pieza apunta a lo que el clic en ella: todo lo vestible (o la pieza
  // entera en modo pieza, vía restingRole). Un componente apunta a SU rol —
  // incluido uno que se llame 'base', que es un componente de verdad y no el
  // sentinela (isWholePieceRole decide, y es la misma pregunta que responde la
  // tarjeta, para que el contorno y lo que se lee no puedan discrepar).
  const railWholePiece = (e) => e.role !== 'structure'
    && isWholePieceRole(stripPiece, stripResolved, e.role);
  const railFocusOf = (e) => (railWholePiece(e)
    ? { role: DRESSABLE_ROLE, groupKey: null }
    : { role: e.role, groupKey: e.groupKey || null });
  // …and which swatch is the SELECTED one: the picker's live target. Read off
  // the very state that drives `focusPart`, so «picker and outline are subject
  // to the swatch selected» holds by construction rather than by syncing.
  const stripActiveKey = finishRail
    ? `structure:${finishRail.partKey}`
    : (matPart || (selectedUid != null ? 'base' : null));
  // Is the componentes rail up?
  //
  // ⚠️ THIS MAY NEVER DEPEND ON THE HOVER. The rail occupies canvas, so its
  // presence feeds the stage's `insetLeft`, and an inset change re-aims the
  // camera (ConfiguratorStage's framing effect, a 420 ms glide). Derived from
  // `stripEntries` — which follows `chipHover` — that closed a loop that ran
  // forever: point at the sofa ⇒ rail opens ⇒ inset grows ⇒ the camera glides
  // ⇒ the model slides out from under the cursor ⇒ the hover drops ⇒ rail
  // closes ⇒ inset shrinks ⇒ the model slides back under the cursor ⇒ point at
  // the sofa. The widget sat there opening and closing it at the tween's own
  // cadence, with nobody touching the mouse.
  //
  // So presence comes from the SELECTION, a committed fact a mouse-move cannot
  // change; only the rail's CONTENT follows the pointer (`stripPiece`), and
  // content moves no camera. Anything else that costs canvas has the same
  // obligation.
  // …and it must agree with what the rail ACTUALLY renders: `ComponentsRail`
  // bails on an empty entry list, so a presence flag that ignored the entries
  // reserved 5.5rem of canvas for a panel nobody drew. Hover-safe BY the gate
  // on `chipHover` above: with a selection, hover never names another piece,
  // so `stripPiece` (and these entries) can only change by SELECTING — and
  // presence that only moves on selection cannot feed the camera loop.
  const componentsRailOpen = desktop && view === '3d' && selectedUid != null
    && !!stripPiece && stripEntries.length > 0;
  // Off the EFFECTIVE picks: a dormant pick repaints with the piece in modo
  // pieza, so excluding it would shrink the promise the gold line makes.
  const dressableExclude = Object.keys(effectivePartMaterials(selected) || {})
    .filter((role) => PART_ROLES.includes(role) && role !== 'base' && role !== 'structure');
  // ── POINTING AT A CHIP IS POINTING AT THE PART ──────────────────────────
  // The componentes rail's half of the 3D hover. The mesh has always answered a
  // hover with the gold outline and the preview card; the rail names those same
  // parts as a column of swatches and answered nothing, so the one surface that
  // LISTS them was the one place you couldn't point at them.
  //
  // TRANSIENT BY CONSTRUCTION: it is a preview of the selection a click would
  // make, so it only ever overrides the FOCUS (outline + glow + card) and never
  // touches `matPart`/`finishRail` — the committed target is exactly where the
  // pointer left it, and leaving the chip puts the gold line straight back on
  // it. Stored already mapped to the focus vocabulary (`base` IS the dressable
  // piece, an estructura carries its group) so there is one translation, here,
  // rather than one per reader.
  const [railHover, setRailHover] = useState(null);   // { role, groupKey } | null
  // A chip hover is TRANSIENT and must not outlive what it pointed at: leaving
  // 3D, or changing piece, strands the gold line on a part nobody is pointing
  // at any more (and the rail is unmounted, so no pointer-leave is coming).
  useEffect(() => { setRailHover(null); }, [selectedUid, view]);
  // ── EL ALCANCE EN REPOSO: LO QUE LA TELA REPINTA, NUNCA LA ESTRUCTURA ──────
  // Owner, 2026-08-06: «pieza should only highlight the components that are
  // affected — all of them except structure». El oro es una PROMESA: dice qué
  // va a cambiar de color si eliges una tela aquí. La estructura no se viste de
  // tela (se elige su acabado, y eso es otro gesto, otro rail), así que
  // incluirla en el trazo prometía un repintado que no llega — se veía en las
  // patas, abrazadas por el mismo oro que el cuerpo.
  //
  // Así que LOS DOS MODOS descansan en el conjunto vestible. `DRESSABLE_ROLE`
  // es el vocabulario que el stage ya habla para eso (focusMeshes → todo menos
  // `structure`), y en MODO PIEZA `dressableExclude` sale vacío por
  // construcción —un pick dormido no viste, así que no hay tela propia que
  // descontar— con lo que el alcance ahí es exactamente «la pieza entera menos
  // su estructura». En MODO COMPONENTES la regla de 2026-08-01 sigue intacta:
  // además se descuentan las partes que ya llevan tela propia.
  const restingRole = selected ? DRESSABLE_ROLE : null;
  // ── UN VISTAZO: EL PUNTERO, SEA CUAL SEA SU PUERTA ────────────────────────
  // Las dos maneras de mirar una parte sin elegirla — el chip del rail y la
  // malla en 3D — componen el MISMO foco aquí, y de aquí salen las tres cosas
  // que tienen que decir lo mismo: el trazo suave, el glow y el anillo de la
  // tarjeta. El stage ya no vuelve a deducir el alcance por su cuenta (leía
  // `hoverPart` y decidía otra vez), que es de donde salía el anillo mintiendo:
  // prometía un trazo suave que allá abajo no se dibujaba.
  //
  // Requiere SELECCIÓN — sin ella no hay pieza trazada y un vistazo no tendría
  // dónde pintarse (la regla del dueño: con algo seleccionado el hover solo
  // contesta sobre ESO; sin nada, la tarjeta sigue saliendo por su cuenta, ya
  // sin anillo, porque no hay trazo que prometer).
  const chipHoverPart = chipHover && selectedUid != null && chipHover.uid === selectedUid
    && chipHover.partRole && chipHover.partRole !== 'base'
    ? { role: chipHover.partRole, groupKey: chipHover.partRole === 'structure' ? (chipHover.partKey || null) : null }
    : null;
  const railFocus = railHover && selectedUid != null
    ? {
      // El chip de la tela de la pieza apunta a lo mismo que el clic en ella.
      role: railHover.role === DRESSABLE_ROLE ? restingRole : railHover.role,
      groupKey: railHover.groupKey || null,
    }
    : null;
  const finishTarget = finishSheet || finishRail;
  const committedPart = (railOpen || matOpen) && matPart ? matPart : null;
  // Apuntar la parte que el picker YA tiene abierta no la degrada a vistazo: se
  // queda firme. Si no, el trazo parpadearía entre pesos cada vez que el
  // puntero cruza justo lo que estás vistiendo.
  const peek = railFocus || chipHoverPart;
  const peekIsCommitted = !!peek && !!committedPart
    && peek.role === committedPart && !peek.groupKey;
  const hoverFocus = peek && !peekIsCommitted && selectedUid != null
    ? {
      uid: selectedUid,
      role: peek.role,
      groupKey: peek.groupKey || null,
      ...(peek.role === DRESSABLE_ROLE && restingRole && dressableExclude.length ? { exclude: dressableExclude } : {}),
    }
    : null;
  const focusPart = hoverFocus || (finishTarget
    ? { uid: finishTarget.uid, role: 'structure', groupKey: finishTarget.partKey }
    : (selectedUid == null || matMode === 'all'
      ? null
      : {
        uid: selectedUid,
        role: committedPart || restingRole,
        groupKey: null,
        ...(!committedPart && restingRole && dressableExclude.length ? { exclude: dressableExclude } : {}),
      }));
  // The same target, narrowed to the cases that NAME a part — what the floating
  // card retargets onto (and, stage-side, what the anchor boxes over). Derived
  // from `focusPart` rather than re-read off the picker state, so the card, the
  // outline and the glow are three readings of ONE fact: the gold line and the
  // card it belongs to cannot end up on different parts.
  // `role: null` (modo pieza en reposo) NAMES no part — it is the whole piece —
  // so it belongs on this side of the line exactly like DRESSABLE_ROLE does.
  const chipFocus = focusPart && focusPart.role && focusPart.role !== DRESSABLE_ROLE ? focusPart : null;
  // WHAT the one preview card says, derived once. WHERE it goes is the render's
  // call: the picker's footer while it is open, a floating card at the bottom
  // of that same column while it is shut.
  const hoverPreview = view === '3d'
    ? hoverPreviewFor({ railHover, selectedUid, chipHover, chipFocus, placed, resolvedById, locale })
    : null;
  // What the pointer is on INSIDE the swatch wall, reported up by the picker
  // rather than floated by it. It OUTRANKS the piece/chip preview: the pointer
  // is literally on that swatch, while the other describes something it left.
  const [swatchPreview, setSwatchPreviewRaw] = useState(null);
  // EL CIERRE SE RETRASA, LA APERTURA NO (dueño, 2026-08-05: «the swatch is now
  // flashing quickly whenever i hover over the cards»). Barrer el muro cruza
  // los HUECOS entre fichas, y cada hueco mandaba un null: la tarjeta se
  // desmontaba y volvía a montarse ficha tras ficha — y acoplada al pie de la
  // hoja eso además reajustaba el alto del muro debajo del puntero. Un null
  // espera; si antes llega otra muestra, la sustituye y no ha pasado nada.
  // Salir del muro de verdad sí la cierra, solo que un pelo más tarde. El SET
  // es inmediato a propósito: retrasar la aparición se sentiría como lag.
  const swatchClearRef = useRef(null);
  const setSwatchPreview = useCallback((p) => {
    clearTimeout(swatchClearRef.current);
    if (p) { setSwatchPreviewRaw(p); return; }
    swatchClearRef.current = setTimeout(() => setSwatchPreviewRaw(null), 140);
  }, []);
  useEffect(() => () => clearTimeout(swatchClearRef.current), []);
  // …y CON UN OBJETIVO COMPROMETIDO la tarjeta se queda, aunque el puntero se
  // haya ido (dueño, 2026-08-05: «están seleccionados los cojines y debería
  // salir el swatch de material sin outline pintado y no está»). La regla de
  // «una sola tarjeta, y es del puntero» (2026-08-02) dejaba la pregunta
  // «¿qué llevan puestos los cojines?» sin responder justo mientras los estás
  // vistiendo: el contorno firme decía CUÁLES, y nada decía QUÉ. Ahora lo dice
  // la misma tarjeta, construida por la misma función y por eso incapaz de
  // discrepar del hover que la sustituye un segundo después.
  //
  // SIN ANILLO, y eso es el punto: el oro tenue marca lo que se MIRA. Una
  // tarjeta comprometida que lo llevara prometería un trazo suave que no
  // existe — el de esa parte es firme.
  const committedPreview = view === '3d' && chipFocus && !hoverPreview
    ? hoverPreviewFor({
      railHover: { role: chipFocus.role, groupKey: chipFocus.groupKey || null },
      selectedUid, chipHover: null, chipFocus: null, placed, resolvedById, locale,
    })
    : null;
  const onePreview = swatchPreview || hoverPreview || committedPreview;
  // EL MISMO ORO TENUE EN LA TARJETA (dueño, 2026-08-05: «cuando sale en el
  // swatch preview también se le pone el mismo soft outline a la tarjeta»). La
  // pieza trazada y la tarjeta que la describe son UNA cosa vista dos veces; el
  // anillo es lo que las cose. Solo cuando lo que enseña es un hover de la
  // escena: sobre un swatch del muro la tarjeta describe lo que el dedo toca,
  // no una pieza trazada, y un anillo ahí prometería un contorno que no existe.
  // …y el anillo es EXACTAMENTE «hay un trazo suave ahora mismo», que es una
  // sola cosa y ya está derivada. Antes decía «hay tarjeta de hover», que no es
  // lo mismo: sin pieza seleccionada la tarjeta sale igual y no hay nada
  // trazado, y ahí el anillo prometía un contorno inexistente.
  const previewSoft = !swatchPreview && !!hoverFocus;

  // Fabric pick for ONE PART of the selected piece (cushion/bolster/arm) — the
  // pick stores {grade, fabric, code} only; prices re-derive from the part's
  // family at render time, so they can never go stale against the catalog.
  const onPickPartMaterial = useCallback((role, pick) => {
    if (!selected) return;
    buzz(9);
    commitPlaced((prev) => prev.map((row) => {
      if (row.uid !== selected.uid) return row;
      // DRESSING A COMPONENTE IS ENTERING THE MODE (owner, 2026-08: «si hay un
      // material aplicado en base y cambio un componente, se aplica el material
      // base a los otros componentes excepto el que cambie»). So the switch is
      // the pick itself: the rest are seeded from the piece's cloth first, then
      // this one diverges. Wanting a componente in its own tela and wanting to
      // be quoted by componentes are the same wish — asking for the toggle
      // first would be asking twice.
      const next = placementMode(row) === 'parts'
        ? row
        : planModeSwitch(row, resolvePlacement(row, resolvedById), 'parts');
      return {
        ...next,
        partMaterials: {
          ...(next.partMaterials || {}),
          [role]: { grade: pick.grade, fabric: pick.fabric, code: pick.code || '' },
        },
      };
    }));
    // An override that landed from the 3D raycast must not stay invisible: the
    // parts level is where the divergence — and its price consequence — is
    // stated, so the pick opens it.
    setPartsOpenUid(selected.uid);
    announce(tr('announce.fabricApplied', { name: pick.fabric }));
  }, [selected, commitPlaced, announce, tr, resolvedById]);

  /**
   * Switch one placement between the two ways it can be sold.
   *
   * The seeding lives in the Model (`planModeSwitch`): entering «por
   * componentes» copies the piece's own cloth onto every componente that has
   * none, so the mode is never entered half-empty — it has a price straight
   * away and the piece looks IDENTICAL the instant it flips, which is what
   * makes the switch read as a pricing choice rather than as an edit. Going
   * back keeps the componente picks, so flipping to and fro never costs the
   * visitor their build.
   */
  const switchMode = useCallback((uid, mode) => {
    buzz(9);
    commitPlaced((prev) => prev.map((row) => (row.uid === uid
      ? planModeSwitch(row, resolvePlacement(row, resolvedById), mode)
      : row)));
    setPartsOpenUid(mode === 'parts' ? uid : null);
  }, [commitPlaced, resolvedById]);

  // The way BACK from a per-part fabric: the part returns to riding the piece's
  // own cloth (its `partMaterials` entry is dropped, not overwritten with the
  // base pick — "no pick" is what "igual que la pieza" MEANS everywhere
  // downstream: the lead payload omits it and the price folds back into the
  // elemento completo). Clearing the last one puts the piece back to reading,
  // and billing, as one element.
  const clearPartMaterial = useCallback((uid, role) => {
    if (!uid || !role) return;
    buzz(7);
    commitPlaced((prev) => prev.map((row) => {
      if (row.uid !== uid || !row.partMaterials || !(role in row.partMaterials)) return row;
      const next = { ...row.partMaterials };
      delete next[role];
      return { ...row, partMaterials: Object.keys(next).length ? next : undefined };
    }));
    const me = placedRef.current.find((row) => row.uid === uid);
    const r = me ? resolvedById[me.pieceId] : null;
    announce(tr('announce.partReset', { name: roleLabelOf(r?.parts, role, tr(`part.${role}`)) }));
  }, [commitPlaced, resolvedById, announce, tr]);

  // Apply ONE fabric to EVERY piece, repricing each by its OWN bound model.
  /**
   * «UNA SOLA TELA PARA TODAS» — and that is a statement about the whole build,
   * so it puts every piece in MODO PIEZA wearing it.
   *
   * It used to write `material` and leave the mode alone, which made the action
   * lie on any piece being sold by componentes: those render and price from
   * their own `partMaterials`, so the piece the visitor just told to change
   * did not change — the one thing an "apply to all" may never do. One cloth
   * everywhere IS the elemento completo everywhere; that is the same sentence.
   */
  const applyFabricToAll = useCallback((pick) => {
    buzz([7, 18, 11]);
    commitPlaced((prev) => prev.map((raw) => {
      const row = planModeSwitch(raw, resolvePlacement(raw, resolvedById), 'complete');
      const fam = families.get(resolvedById[row.pieceId]?.root);
      const p = fam ? productForGrade(fam, pick.grade) : null;
      return {
        ...row,
        material: {
          grade: pick.grade, fabric: pick.fabric, code: pick.code || '', swatchImageId: null,
          subtype: composeSubtype(pick.grade, pick.fabric),
          reference: p?.reference || '',
          unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[row.pieceId]?.unitPrice ?? null),
        },
      };
    }));
    announce(tr('announce.fabricAppliedAll', { name: pick.fabric }));
  }, [families, resolvedById, commitPlaced, announce, tr]);

  const clearFabric = useCallback(() => {
    if (!selectedUid) return;
    commitPlaced((prev) => prev.map((row) => (row.uid === selectedUid ? { ...row, material: undefined } : row)));
  }, [selectedUid, commitPlaced]);

  // "N sin tela" → jump to the first piece missing a fabric and open the picker
  // for it — the warning becomes ONE tap to fix instead of a hunt.
  const fixPendingFabric = useCallback(() => {
    const uid = firstWithoutFabric(placedRef.current, resolvedById);
    if (!uid) return;
    setSelectedUid(uid);
    setMatMode('one');
    setMatPart(null);   // STEP 1: this door always means the WHOLE piece
    setFinishRail(null);   // …and a cloth retarget answers the finish question (openMaterial)
    if (desktop) { setView('3d'); return; }   // the 3D workspace pane takes the target
    setMatOpen(true);
  }, [desktop, resolvedById]);
  // Same jump from the Resumen sheet's per-row "Elige una tela".
  const pickFabricFor = useCallback((uid) => {
    if (!uid) return;
    setQuoteOpen(false);
    setSelectedUid(uid);
    setMatMode('one');
    // Re-targeting the SAME piece never reaches the selection effect that
    // clears `matPart`, so say it here: this is the piece's own fabric.
    setMatPart(null);
    setFinishRail(null);   // a cloth retarget answers the finish question (openMaterial)
    if (desktop) { setView('3d'); return; }
    setMatOpen(true);
  }, [desktop]);

  // Download the plan as CAD (DXF) — opens in AutoCAD and every plan tool. A
  // genuine differentiator: consumer sofa configurators stop at PDF/image, so a
  // designer-grade, real-cm layout handed straight to the customer's architect.
  const downloadDxf = useCallback(async () => {
    if (!placed.length || dxfBusy) return;
    setDxfBusy(true);
    try {
      // The outline no longer rides the catalog, so it is fetched HERE — for the
      // placed pieces only, and only those whose mesh plan hasn't resolved
      // (usually none: a placed piece loads its mesh immediately). Mesh-derived
      // WINS on merge — it is the same silhouette the visitor has been looking
      // at — and the fetched outline fills the gaps. A failed fetch is not fatal:
      // planToDxf falls back to the footprint rectangle, so every piece still
      // exports at its true size and position.
      const gaps = [...new Set(placed.map((p) => p.pieceId))].filter((id) => id && !svgById[id]);
      const fetched = gaps.length ? await fetchConfiguratorPlanSvgs(gaps) : {};
      const placements = placementsFromPlaced(placed, resolvedById, { ...fetched, ...svgById });
      const { dxf, filename } = resolveConfiguratorDxf(placements, { name: data?.storeName || 'Togo' });
      downloadText(filename, dxf);
      setDlOpen(false);
    } catch { /* export unavailable on this device */ }
    setDxfBusy(false);
  }, [placed, resolvedById, svgById, data?.storeName, dxfBusy]);

  // Textured 3D download: the SAME fabric-baked GLB the AR viewer builds —
  // real meshes, real pCon textures (base AND parts), sheen included — as a
  // portable single file (Twinmotion / Blender / SketchUp / the Windows &
  // macOS 3D viewers / any AR pipeline). Everything loads on demand. This is
  // the ONE 3D export (the geometry-only cm OBJ it replaced imported into
  // Twinmotion as an empty scene, 2026-08 — dealer report); the exporter
  // dequantizes to core glTF and metres, so it opens everywhere.
  const downloadGlb = useCallback(async () => {
    if (!placed.length || glbBusy) return;
    setGlbBusy(true);
    try {
      const [THREE, rbg, glbx, mod] = await Promise.all([
        safeDynamicImport(() => import('three')),
        safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        safeDynamicImport(() => import('three/examples/jsm/exporters/GLTFExporter.js')),
        safeDynamicImport(() => import('../../components/configurator/glbExport.js')),
      ]);
      // A PRIVATE model cache (the second arg): this path disposes what it
      // loads once the file is written; the session-shared cache belongs to
      // the live stage and the thumbnail engine rendering behind this dialog.
      const { cache, modelFor } = await loadConfiguratorModels(scene3d, new Map());
      const { fabricTextures, colors, pbr, normals, extras } = await mod.loadSceneFabrics(THREE, scene3d, fabricByCode, (c) => swatchProxyUrl(c) || swatchUrl(c));
      const built = mod.buildArGroup({ THREE, RoundedBoxGeometry: rbg.RoundedBoxGeometry }, scene3d, {
        ...(material || {}), fabricTextures, colors, pbr, normals, extras, modelFor,
      });
      const blob = await mod.exportGlbBlob({ GLTFExporter: glbx.GLTFExporter, THREE }, built.root);
      built.dispose();
      cache.forEach((m) => disposeGroup(m.object || m));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(data?.storeName || 'Togo').replace(/\s+/g, '-')}-3d.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      setDlOpen(false);
    } catch { /* export unavailable on this device */ }
    setGlbBusy(false);
  }, [placed, scene3d, fabricByCode, material, data?.storeName, glbBusy]);

  // DESKTOP routing: material selection lives in the 3D view (the MaterialsPane
  // left workspace pane, always open there) — 2D composes the models, 3D dresses
  // them. So on desktop every "choose fabric" action JUMPS to 3D and lets the
  // pane target the selection instead of opening the modal; the modal stays the
  // phone/tablet flow. The pane derives its target from the live selection
  // (piece → its ladder; a tapped part → that part; nothing → dress ALL pieces).
  const openMaterial = useCallback((mode) => {
    if (mode === 'one' && !selectedUid) return;
    if (mode === 'all' && !placed.length) return;
    setMatPart(null);
    // A CLOTH retarget ANSWERS the finish question — the vice-versa of
    // openPartMaterial's estructura branch clearing `matPart`. Without it the
    // rail stayed on the FinishPlates and «Cambiar tela» on the same piece was a
    // dead end: the target never changed, so neither did the wall.
    setFinishRail(null);
    setMatMode(mode);
    if (desktop) {
      if (mode === 'all') setSelectedUid(null);   // the pane dresses ALL only with no selection
      setView('3d');
      return;
    }
    setMatOpen(true);
  }, [selectedUid, placed.length, desktop]);

  // Open the fabric picker for ONE PART of a piece (a chip tap, or the stage's
  // raycast: a second tap on a selected piece reports which part it landed on).
  // Untagged/base hits — or roles with no bound family — open the piece picker.
  // Materialization ZONES (ottoman interior/exterior) have no family of their
  // own by design (they re-grade the base SKU), so they gate on the tagging.
  // `immediate` = the stage saw a DOUBLE-tap on this piece: the gesture already
  // said "open the picker", so the first-click-selects gate below stands aside
  // (selection still happens — in this same call, atomically).
  const openPartMaterial = useCallback((uid, role, partKey = null, immediate = false) => {
    const p = placedRef.current.find((row) => row.uid === uid);
    if (!p) return;
    const r = resolvedById[p.pieceId];
    // A part group with FINISH OPTIONS (metal legs: acero vs acero negro) picks
    // from its fixed palette, never from the fabric library — the sheet replaces
    // the picker for exactly that tap. Finishes attach to group KEYS, which is
    // why the stage sends the key alongside the role.
    //
    // But only an ESTRUCTURA offers its palette: that role IS "el cliente elige
    // el acabado" (patas, marcos — price-neutral, chosen). A Base group's
    // acabados belong to the dealer: the piece still RENDERS in them (the
    // scene materializes the palette's default, keyed by group — see
    // sceneBuilder), they are simply never offered here.
    //
    // WHICH group is the Model's call (`structureGroupFor`), not this tap's:
    // half the callers can't send a key at all — the 2D drag-end reports the
    // role alone, and so does the hover card — and a key that IS sent can be a
    // split cluster with no palette of its own. Routing those to the fabric
    // library was the tap silently doing the wrong thing on the legs; the Model
    // answers with a real group or with nothing, and nothing falls through to
    // the ordinary piece flow below.
    const hit = (role === 'structure' || (partKey && partRoleFor(r?.parts, partKey, 0, partKey) === 'structure'))
      ? structureGroupFor(r?.parts, partKey)
      : null;
    if (hit) {
      // The sheet's title prefers the dealer's own group name from the Estudio
      // (labels, read off the resolved group) over the palette's label, so it
      // reads «Patas», never a mesh key.
      const named = typeof r?.parts?.labels?.[hit.group] === 'string' ? r.parts.labels[hit.group].trim() : '';
      const target = { uid, partKey: hit.group, spec: named ? { ...hit.spec, label: named } : hit.spec };
      setSelectedUid(uid);
      setPartsOpenUid(uid);          // the parts level is where this choice lives — reveal it behind the picker
      // WHICH CHROME answers is the same call the fabric picker makes below:
      // the desktop workspace has a rail and uses it (a floating card over the
      // canvas for a choice the rail was built to hold read as a different kind
      // of decision — owner: estructura «IGUAL QUE LOS COMPONENTES»), the phone
      // keeps its bottom sheet. Clear the other one so a resize can't leave two
      // pickers open on the same group.
      if (desktop) {
        paneUidRef.current = uid;   // same retarget the cloth path does — the uid-change effect must not wipe this target
        setMatPart(null);
        setFinishSheet(null);
        setFinishRail(target);
        setView('3d');
        return;
      }
      setFinishRail(null);
      setFinishSheet(target);
      return;
    }
    const zone = MATERIALIZATION_ROLES.includes(role)
      && Object.values(r?.parts?.mats || {}).includes(role);
    // ── NO STEP-1 GATE ────────────────────────────────────────────────────
    // A tap on a part opens THAT part, dressed piece or not (owner,
    // 2026-08-01: «QUIERO QUE SE DESPLIEGUE DE UNA VEZ QUE NO ME FORCE A
    // ELEGIR COMPLETO»). It used to redirect an undressed piece's cushion to
    // the PIECE's fabric — the hierarchy argument (a part has nothing to
    // differ FROM yet) is real but it is the MONEY's argument, not the
    // visitor's: the estimate already states it («se cotiza por partes») and
    // the piece stays «pendiente» for its own cloth until that is picked. What
    // the redirect actually did was answer a different question than the one
    // asked, on the tap that asked it.
    const part = role && role !== 'base' && (zone || r?.partFamilies?.[role]) ? role : null;
    // ── EL PRIMER CLIC ES LA PIEZA ────────────────────────────────────────
    // Owner, 2026-08-06: «first click should just select the whole SKU base
    // part; only after that do individual components make soft highlights».
    // Un clic sobre un COMPONENTE de una pieza que todavía NO está
    // seleccionada contesta lo mismo que un clic en su cuerpo: selecciona la
    // pieza, deja «Pieza» (el SKU base) como objetivo y para ahí. Con la pieza
    // ya seleccionada, el mismo clic entra en el componente.
    //
    // Por qué el gesto necesita dos tiempos: el primer clic es cómo se ELIGE
    // la pieza, y hasta que ocurre no hay nada trazado — los vistazos suaves
    // del rail y de la malla exigen selección (`selectedUid != null`), así que
    // antes del primer clic no hay ningún componente que resaltar. Entrar en un
    // componente en ese mismo gesto se saltaba el paso que da contexto.
    //
    // NO es la puerta de 2026-08-01 que se quitó: aquella exigía VESTIR la
    // pieza entera antes de tocar una parte (una regla del dinero). Ésta no
    // pide elegir nada — sólo que la pieza esté seleccionada, que es el estado
    // que el propio clic acaba de crear.
    if (part && selectedUid !== uid && !immediate) {
      paneUidRef.current = uid;
      setSelectedUid(uid);
      setMatMode('one');
      setMatPart(null);         // «Pieza» — el SKU base
      setFinishRail(null);
      if (desktop) setView('3d');
      return;
    }
    paneUidRef.current = uid;   // a part-tap RETARGETS the pane — don't let the uid-change effect wipe the part
    setSelectedUid(uid);
    setMatMode('one');
    setMatPart(part);
    setFinishRail(null);        // a cloth target replaces a finish target — never two rails at once
    if (part) setPartsOpenUid(uid);
    if (desktop) { setView('3d'); return; }
    setMatOpen(true);
  }, [resolvedById, desktop, selectedUid]);

  // The pane's part target follows the SELECTION: picking a different piece by
  // any other path clears a lingering part role (its family lookup would run
  // against the new piece). The ref lets openPartMaterial retarget atomically.
  const paneUidRef = useRef(selectedUid);
  useEffect(() => {
    if (paneUidRef.current !== selectedUid) {
      paneUidRef.current = selectedUid;
      setMatPart(null);
      setFinishRail(null);   // …and an estructura target belongs to ONE piece just as much
    }
  }, [selectedUid]);

  // ── SELECTING A PIECE *IS* ASKING TO PERSONALIZE IT ───────────────────────
  // (owner, 2026-07-31: «when I select a model on the 3D configurator, I want
  // the full personalization thing to open up on the right that shows me what
  // things can be customized … this needs to be intuitive».) The parts level
  // used to sit behind a collapsed «Personalizar por partes» the visitor had to
  // NOTICE and open — a second step between choosing a piece and seeing what it
  // can wear. So the selection opens it: the piece's own cloth on top, its
  // parts already unfolded underneath, and the disclosure survives only as a
  // manual COLLAPSE.
  //
  // ONE place, keyed on the selection itself — every path into a piece (3D tap,
  // pane row, add, duplicate, «N sin tela», the Resumen's per-row jump) ends at
  // `setSelectedUid`, so none of them has to remember to do this. It is also
  // why a collapse can't leak forward: whatever the visitor closed on THIS
  // piece, the next one opens full. Deselecting closes it — there is nothing
  // left to personalize.
  useEffect(() => { setPartsOpenUid(selectedUid ?? null); }, [selectedUid]);

  // Entering the desktop 3D workspace closes the modal (the pane takes over) so
  // a modal opened in 2D can never linger as a ghost behind the pane.
  useEffect(() => {
    if (desktop && view === '3d') { setMatOpen(false); }
  }, [desktop, view]);

  // What the pane applies a pick to — part → piece → everything — mirroring the
  // modal's dispatch. The rail's PART target survives its own pick, same law as
  // the estructura rail (onPickFinish): dressing a cushion is not a request to
  // stop looking at cushions. Falling back to the piece re-keyed the picker, so
  // the wall remounted onto the piece's own ladder and auto-drilled away from
  // the swatch just chosen — the chip vanished under the visitor's cursor.
  const onPanePick = useCallback((pick) => {
    const sel = placedRef.current.find((row) => row.uid === selectedUid) || null;
    if (matPart && sel) { onPickPartMaterial(matPart, pick); return; }
    if (sel) { onPickMaterial(pick); return; }
    applyFabricToAll(pick);
  }, [matPart, selectedUid, onPickPartMaterial, onPickMaterial, applyFabricToAll]);

  // The 3D stage commits a piece's new plan position on drop (the snap/clamp ran
  // inside the stage against the live layout). One drag = one undo entry; a drop
  // back on the exact same spot records nothing. `snapped` = the drag ended
  // clicked flush to a neighbour (the SR parity of the haptic tick).
  const movePiece = useCallback((uid, x, y, snapped = false) => {
    let docked = false;
    commitPlaced((prev) => {
      const me = prev.find((p) => p.uid === uid);
      if (!me) return prev;
      // RELEASE DOCK — this fires ONCE, on drop (never mid-drag, so it can't
      // teleport a piece you're positioning). The gentle 12 cm live magnet is
      // easy to just-miss on a phone, ending a module a hand's-width short of
      // its neighbour; here we re-snap the dropped piece with a GENEROUS
      // ~half-module range so a piece let go "next to" the run settles
      // outline-flush. Axis-aligned floor pieces only (a free-rotated piece and
      // a seat-mounted cushion move raw, exactly like the live drag).
      const seat = mountOf(resolvedById[me.pieceId] || {}).seat;
      let nx = x, ny = y;
      if (!seat && norm360(me.rot) % 90 === 0) {
        const rMe = resolvePlacement(me, resolvedById);
        const fp = footprintOf(rMe, norm360(me.rot));
        const others = prev
          .filter((o) => o.uid !== uid && norm360(o.rot) % 90 === 0 && !mountOf(resolvedById[o.pieceId] || {}).seat)
          .map((o) => { const ro = resolvePlacement(o, resolvedById); const f = footprintOf(ro, norm360(o.rot)); return { x: o.x, y: o.y, w: f.w, h: f.h, col: ro.collection }; });
        const d = snapPlacement({ x, y, w: fp.w, h: fp.h, col: rMe.collection }, others, { edgeCm: RELEASE_DOCK_CM });
        nx = d.x; ny = d.y;
      }
      if (me.x === nx && me.y === ny) return prev;
      docked = (nx !== x || ny !== y);
      return prev.map((p) => (p.uid === uid ? { ...p, x: nx, y: ny } : p));
    });
    if (snapped || docked) announce(tr('announce.snapped'));
  }, [commitPlaced, resolvedById, announce, tr]);

  // The stage reports a piece whose real 3D mesh didn't load — it is drawing as
  // the simplified shape. Not a failure the visitor can act on, so it gets no
  // chrome: the live region names the piece (a sighted visitor sees the box; a
  // screen-reader one would otherwise get nothing at all), and the stage's
  // console line carries the model URL for whoever fixes the catalogue.
  // Reported once per model per session, so this never chatters.
  const onModelFallback = useCallback((rows) => {
    for (const row of rows || []) {
      const name = resolvedById[row?.pieceId]?.label || tr('piece.generic');
      announce(tr('model.simplified', { name }));
    }
  }, [resolvedById, announce, tr]);

  // Keyboard editing (2D build): ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z / Ctrl+Y redo,
  // Delete removes, ARROWS nudge the selected piece (Shift = pasos grandes),
  // R rotates ±90°, Escape deselects, +/− zoom the view. Ignored while typing
  // or while a modal is open. Piece-cycling (Tab) lives on the focused canvas.
  const keysRef = useRef({});
  keysRef.current = {
    undo, redo, deleteSel, nudgeSel, rotateSelBy,
    deselect: () => setSelectedUid(null),
    hasSel: selectedUid != null,
    zoom: (f) => stageGestures.current?.zoomBy?.(f),
    edit2d: view === '2d',
    // The finish sheet is a picker ON TOP of the selection: Escape there closes
    // the SHEET (its own effect), never the piece underneath it.
    active: step === 'build' && !matOpen && !quoteOpen && !arOpen && !dlOpen && !finishSheet,
  };
  useEffect(() => {
    const onKey = (e) => {
      const k = keysRef.current;
      if (!k.active) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo(); }
        else if (key === 'y') { e.preventDefault(); k.redo(); }
        return;
      }
      const step10 = e.shiftKey ? 10 : SNAP_GRID_CM;
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); k.deleteSel(); break;
        case 'ArrowUp':    if (k.edit2d && k.nudgeSel(0, -step10)) e.preventDefault(); break;
        case 'ArrowDown':  if (k.edit2d && k.nudgeSel(0, step10)) e.preventDefault(); break;
        case 'ArrowLeft':  if (k.edit2d && k.nudgeSel(-step10, 0)) e.preventDefault(); break;
        case 'ArrowRight': if (k.edit2d && k.nudgeSel(step10, 0)) e.preventDefault(); break;
        case 'r': case 'R': if (k.edit2d && k.rotateSelBy(e.shiftKey ? -90 : 90)) e.preventDefault(); break;
        case 'Escape': if (k.hasSel) { e.preventDefault(); k.deselect(); } break;
        case '+': case '=': e.preventDefault(); k.zoom(0.8); break;
        case '-': case '_': e.preventDefault(); k.zoom(1.25); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Narrate selection for screen readers: which piece, its fabric, its price.
  // Suppressed for one turn when the selection change rides an add/duplicate —
  // with ONE polite live region, this message would otherwise CLOBBER the
  // "agregada/duplicada" confirmation before the SR ever voices it.
  const suppressSelNarration = useRef(false);
  useEffect(() => {
    if (suppressSelNarration.current) { suppressSelNarration.current = false; return; }
    if (!selectedUid) return;
    const me = placedRef.current.find((p) => p.uid === selectedUid);
    if (!me) return;
    const r = resolvePlacement(me, resolvedById);
    const priceStr = me.material && r.unitPrice != null ? fmt(r.unitPrice) : null;
    announce(tr('announce.selected', {
      name: r.label || tr('piece.generic'),
      fabric: me.material?.fabric || tr('fabric.none'),
      price: priceStr ? `, ${priceStr}` : '',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid]);

  // The launch card — what the embed shows FIRST. Tapping it opens the
  // configurator in a NEW TAB (full screen, no iframe limits). Skipped when this
  // IS that new tab (?ctx=modal) — then we render the configurator directly.
  //
  // Its hero (the iconic Togo, in Festa Bleu Paon) is a projection off the same
  // public catalog the configurator loads — so it resolves to null on the first
  // paint and fills in a moment later, which is exactly the crossfade the card
  // is built around. Resolved unconditionally: this sits above the only early
  // return, so the hook order can't shift between the card and the build.
  const launchHero = useMemo(() => resolveLaunchHero(models, materials), [models, materials]);
  // Re-measure the top row whenever anything that changes either cluster's WIDTH
  // changes: the locale (label lengths), the collection name, the piece count
  // (the whole chrome appears at 1), the undo cluster coming and going, the room
  // chip gaining its cm readout, and the 2D/3D switch. Not on every drag — those
  // move nothing in the bar.
  useToolbarFit(leftBarRef, toolsBarRef, [locale, activeCollection, vm.count, canUndo, canRedo, !!room, view]);
  if (!launched) {
    return (
      <EmbedLaunchCard
        locale={locale}
        href={configuratorEmbedModalUrl(dealerSlug)}
        hero={launchHero}
        fabricByCode={fabricByCode}
      />
    );
  }

  if (cat.status === 'loading') {
    return <Centered><Loader2 size={20} className="animate-spin text-ink-500" /></Centered>;
  }
  if (cat.status === 'error' || !data?.configured) {
    // An unknown dealer slug 404s → a minimal, friendly "not available" (no
    // retry loop; retrying an unknown dealer never resolves).
    const dealerUnavailable = cat.status === 'error' && cat.httpStatus === 404 && !!dealerSlug;
    const msg = dealerUnavailable
      ? t(locale, 'error.dealerUnavailable')
      : cat.status === 'error' ? t(locale, 'error.load') : t(locale, 'error.unavailable');
    return (
      <Centered>
        <div role="status" className="text-center text-ink-600 text-sm flex flex-col items-center gap-2">
          <Sofa size={24} className="text-ink-400" aria-hidden />
          {msg}
          {cat.status === 'error' && !dealerUnavailable && (
            <button type="button" onClick={loadCatalog} className="btn-secondary text-xs mt-1">{t(locale, 'action.retry')}</button>
          )}
        </div>
      </Centered>
    );
  }

  if (step === 'done') return <DoneScreen storeName={storeName} logoUrl={dealerLogo} locale={locale} onReset={() => { setPlaced([]); setSelectedUid(null); setStep('build'); }} />;
  if (step === 'form') {
    const requestItems = placed.map((p) => {
      const partMaterials = sanitizePartMaterials(p.partMaterials);
      const partFinishes = sanitizePartFinishes(p.partFinishes);
      return {
        modelId: p.pieceId, x: p.x, y: p.y, rot: p.rot,
        ...(p.material ? { material: { grade: p.material.grade, fabric: p.material.fabric, code: p.material.code } } : {}),
        ...(partMaterials ? { partMaterials } : {}),
        ...(partFinishes ? { partFinishes } : {}),
        // WHICH MODE the visitor built in — without it the worker replays a
        // by-componentes build as modo pieza and quotes the OTHER price. Only
        // an explicit true rides; absent = modo pieza, like every stored lead.
        ...(p.partsMode === true ? { partsMode: true } : {}),
      };
    });
    return (
      <RequestForm
        storeName={storeName}
        logoUrl={dealerLogo}
        locale={locale}
        dealerSlug={dealerSlug}
        scene3d={scene3d}
        items={requestItems}
        droppedItems={droppedRequestItems(requestItems, resolvedById)}
        // Hidden pricing → no estimate travels in the payload or shows on
        // screen. An unpriceable piece does the same, for the opposite reason:
        // there IS a number and it is WRONG (short by whatever that piece is
        // worth). No estimate is honest; a cheaper one is not. The lead still
        // travels — losing the lead is the one unacceptable outcome — and the
        // worker files it `unresolved` and refuses to auto-send.
        estimateUsd={pricesHidden || unpricedPieces > 0 ? null : pricedUsd}
        total={pricesHidden || unpricedPieces > 0 ? null : fmt(pricedUsd, { from: fromMode })}
        onBack={() => setStep('build')}
        onDone={() => setStep('done')}
      />
    );
  }

  // The configurator is ONE full-bleed window into the build. The canvas fills
  // the frame edge-to-edge; every tool floats over it as a glass HUD cluster —
  // no header bar, no sidebar, no dropdown. Top corners hold view + tools; a
  // single bottom "control deck" holds the piece hotbar, the contextual
  // selected-piece controls, and the live estimate + quote CTA.
  return (
    <div className="no-select-ui fixed inset-0 overflow-hidden bg-surface text-ink-900">
      {/* Screen-reader narration of every build action (SC 4.1.3). */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

      {/* The stage — a window into the Togo. */}
      <CanvasArea
        fill
        /* The material rail COVERS this much of the canvas (CSS px) — it is an
           overlay, so the stage must frame against the visible strip, not the
           full canvas. Owned here because `railOpen` is this component's state;
           CanvasArea only forwards it. */
        /* 2D's own left overlay is the PIECES pane (w-64 + 12px inset) — it
           must be declared the moment the right pane is, or 2D nets a full
           -332px and the plan slides under the piece catalog. Same render
           condition as the pane itself, three lines above. */
        /* How much of the canvas the left column covers, in px — the same
           widths the column itself is laid out from (12px = the 0.75rem inset,
           8px = the 0.5rem gutter). 2D has no material pane; its own left
           overlay is the PIECES pane. */
        insetLeft={(railOpen ? MAT_PANE_REM * 16 + 12 : (desktop && view === '2d' && vm.count > 0 ? 16 * 16 + 12 : 0))
          + (componentsRailOpen ? COMPONENTS_RAIL_REM * 16 + 8 : 0)}
        /* …and the design pane covers this much of the RIGHT edge, by the same
           arithmetic off its own classes: `w-80` (20rem = 320px) hung on a
           `right-[max(0.75rem,…)]` inset (12px). The stage nets the two and
           shifts the piece into what is actually visible. */
        insetRight={designPaneOpen ? 20 * 16 + 12 : 0}
        /* The phone's material sheet stopped splitting the screen (it rises to
           the toolbar line now — see MATERIALS_SHEET_SHELL), so it no longer
           asks the camera for anything: lifting the platform under a sheet
           that covers the view bought nothing but a visible camera bounce on
           every close. The piece stays framed where it was and closing the
           sheet simply uncovers it. */
        view={view} placed={placed} resolvedById={resolvedById} material={material}
        selectedUid={selectedUid} onSelect={setSelectedUid} onMove={movePiece}
        onRotateTo={rotateTo} gesturesRef={stageGestures} onHoverPiece={onHover3d}
        models={paletteModels} onAddPiece={addPiece} renderThumbById={renderThumbById}
        collections={collections} collectionMenu={collectionMenu} collectionThumbs={collectionFabricThumbs} activeCollection={activeCollection} onCollection={setActiveCollection}
        overallCm={vm.overallCm} hintPieceId={hoveredPieceId} rates={rates} locale={locale} fmt={fmt}
        pricesHidden={pricesHidden} fromMode={fromMode}
        onTapPart={openPartMaterial} fabricByCode={fabricByCode}
        onSelAnchor={setSelAnchor}
        /* The part the open picker is dressing — the scene lights that mesh
           group ALONE while the question is on screen. Owned here (it is this
           component's picker state); CanvasArea only forwards it. */
        focusPart={focusPart}
        /* …and WHETHER that focus is a mere PREVIEW: pointing at a chip in the
           componentes rail is not picking it, so the stage strokes the shape in
           soft gold (the weight the chip itself lights in) instead of the full
           selection line. Owned here for the same reason focusPart is — it is
           this component's hover state; CanvasArea only forwards it. */
        focusSoft={!!hoverFocus}
        /* …and the room, real or still being typed — one prop, so the plan
           cannot draw a committed room and a draft at the same time. */
        room={room || roomPreview}
        /* A piece drawing as the simplified shape because its mesh 404'd —
           narrated, never silent (see onModelFallback). */
        onModelFallback={onModelFallback}
      />

      {/* El RÓTULO DE PIPETA del plano se retiró con la pipeta misma: en 2D se
           compone (mover, girar), no se viste, así que el stage ya no reporta
           parte alguna bajo el puntero y esta etiqueta se quedaba sin datos.
           Dejarla habría sido dejar puesta la promesa — un icono de pipeta —
           de un gesto que esta vista ya no ofrece. Vestir un componente vive
           en el 3D, que es donde se ve cuál es. ── */}

      {/* ── THE ONE PREVIEW ──────────────────────────────────────────────
           One card, one home, whatever the pointer is on — a swatch in the
           wall, a part in the 3D, a chip in the componentes rail.
           WHERE it sits is the whole point (owner, 2026-08): OUTBOARD of the
           material picker, on the free canvas beside it. Floating over the wall
           it covered the very swatches it was describing, and two cards at once
           — the wall's own plus the workspace's — is what «we have only one
           preview modal» forbids. With the picker closed it takes that column's
           own left edge, so the card always arrives where the eye learned it.
           Pointer-transparent: it appears where the pointer is going, and a card
           that could swallow a move would fight the thing it describes. ── */}
      {desktop && view === '3d' && onePreview && (
        <div
          /* ANCHORED TO THE BOTTOM of that column (owner, 2026-08). At the top
             it sat in the eye's path between the toolbar and the piece, over
             the part of the canvas the build actually occupies; down here it
             is out of the way of both and still in the one place the eye has
             learned to find it. */
          className="absolute z-30 pointer-events-none bottom-[max(0.75rem,env(safe-area-inset-bottom))]"
          style={{
            // NEXT TO THE PICKER, one gutter out (owner, 2026-08: «next to the
            // material picker», not beyond the componentes rail — the rail is
            // top-anchored and usually short, so 'after rail' read as a card
            // adrift in empty canvas). The rail shares this x at the TOP; the
            // card is bottom-anchored at z-30 over its z-20, so on the rare
            // build whose rail runs the full column the transient hover card
            // wins, which is the right trade for a cue that follows the
            // pointer.
            left: leftColumnOffset('picker', { railOpen }),
          }}
        >
          <div
            className="hud-panel w-64 p-2 animate-in fade-in zoom-in-95 duration-150 transition-shadow"
            style={previewSoft
              ? { boxShadow: `0 0 0 2px ${OUTLINE_GOLD}59, 0 0 0 1px ${OUTLINE_GOLD}b3` }
              : undefined}
          >
            <SwatchPreviewBody preview={onePreview} />
          </div>
        </div>
      )}

      {/* ── Top-left: brand + 2D/3D toggle + undo/redo ── */}
      <div ref={leftBarRef} className="absolute top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] z-30 flex items-center gap-2">
        {/* Where you are in the catalogue. The BRAND MARK belongs on the splash
            masthead (EmptyPlanStart), not here — putting it here left the splash
            still reading "Colecciones" and spent the toolbar on a second logo. */}
        {vm.count > 0 && (
          <div className="hud-panel hidden sm:flex items-center gap-1.5 px-2.5 py-1.5">
            <Sofa size={15} className="text-ink-500" aria-hidden />
            <span className="font-display font-semibold text-sm leading-none">
              {activeCollection || t(locale, 'collection.heading')}
            </span>
          </div>
        )}
        {vm.count > 0 && (
        <div className="hud-panel inline-flex items-center gap-0.5 p-1">
          {/* Labels hide on phones so the toggle, undo cluster and the (wrapping)
              tool icons all fit one 390px top bar without overlapping. */}
          <button type="button" onClick={() => setView('2d')} aria-pressed={view === '2d'} aria-label={t(locale, 'toolbar.plan')} className={`rounded-full px-3 py-1.5 text-xs inline-flex items-center gap-1.5 transition-colors ${view === '2d' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-900/5'}`}><Square size={13} /><span className="hidden sm:inline">{t(locale, 'toolbar.plan')}</span></button>
          <button type="button" onClick={() => setView('3d')} aria-pressed={view === '3d'} aria-label={t(locale, 'toolbar.viewAria')} className={`rounded-full px-3 py-1.5 text-xs inline-flex items-center gap-1.5 transition-colors ${view === '3d' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-900/5'}`}><Box size={13} /><span className="hidden sm:inline">{t(locale, 'toolbar.view')}</span></button>
        </div>
        )}
        {vm.count > 0 && view === '2d' && (canUndo || canRedo) && (
          <div className="hud-panel inline-flex items-center gap-0.5 p-1">
            <button type="button" onClick={undo} disabled={!canUndo} aria-label={t(locale, 'action.undo')} className="rounded-full px-2.5 py-1.5 text-ink-700 transition-colors hover:bg-ink-900/5 active:scale-90 disabled:opacity-25 disabled:active:scale-100"><Undo2 size={15} /></button>
            <button type="button" onClick={redo} disabled={!canRedo} aria-label={t(locale, 'action.redo')} className="rounded-full px-2.5 py-1.5 text-ink-700 transition-colors hover:bg-ink-900/5 active:scale-90 disabled:opacity-25 disabled:active:scale-100"><Redo2 size={15} /></button>
          </div>
        )}
        {/* The space/room tool. It used to stay visible on an empty plan (the
            argument being that a client's boundary is often the first thing
            set) — but it then sat alone on the splash screen as the one stray
            control, which is exactly what the owner asked to be rid of. It now
            appears with the rest of the chrome, once there is a build. */}
        {/* `data-room-tool` is what the panel's light-dismiss looks for: this
            button owns the toggle, so an outside-tap close here would fight it. */}
        {vm.count > 0 && (
        <button
          type="button"
          data-room-tool
          onClick={() => setRoomOpen((o) => !o)}
          aria-pressed={roomOpen}
          aria-label={t(locale, 'room.tool')}
          className={`hud-panel inline-flex items-center gap-1 px-2.5 py-2 transition active:scale-90 ${room ? 'text-brand-600' : 'text-ink-700 hover:bg-ink-100/60'}`}
        >
          <Frame size={15} />
          {room && (() => { const s = roomSize(room); return s ? <span className="hidden sm:inline text-micro font-medium tabular-nums leading-none">{s.widthCm}×{s.depthCm}</span> : null; })()}
        </button>
        )}
      </div>

      {/* ── Right edge: RESUMEN rail — the mirror of the Piezas tab on the left.
           Hidden while the sheet itself is open (the sheet takes its place), and
           on the desktop workspace, whose right pane already IS the resumen. ── */}
      {!desktop && vm.count > 0 && !quoteOpen && (
        <button
          type="button"
          onClick={() => setQuoteOpen(true)}
          aria-label={t(locale, 'panel.summary')}
          className="pointer-events-auto absolute z-20 right-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 py-3 pr-1.5 pl-2 rounded-l-2xl bg-surface/95 backdrop-blur border border-r-0 border-ink-200 text-ink-700 shadow-md active:scale-95 transition"
        >
          <Receipt size={18} className="text-ink-500" />
          <span className="text-micro font-medium tracking-wide [writing-mode:vertical-rl] rotate-180">{t(locale, 'panel.summary')}</span>
          <ChevronLeft size={14} className="text-ink-500" />
        </button>
      )}

      {/* Room dimensions panel — type the client's space (or tap a preset) and a
          rectangular floor appears, framed in view. Visual reference only. */}
      {vm.count > 0 && roomOpen && (
        <RoomPanel
          room={room}
          onDraft={setRoomDraft}
          fitInfo={roomFitInfo}
          locale={locale}
          onApply={applyRoom}
          onClear={clearRoom}
          onClose={() => setRoomOpen(false)}
        />
      )}

      {/* ── Top-right: tools. On desktop each is its own floating button (room +
           hover tooltips). On mobile they COLLAPSE into one labelled dropdown —
           five look-alike glass squares that used to wrap onto two rows became a
           single tidy menu where every action reads as words, not a mystery
           glyph. ── */}
      {vm.count > 0 && (
        <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-30 flex items-center justify-end gap-1.5">
          {/* Each tool wears its word while the row has room for it (the fold is
              measured — useToolbarFit), and answers a real tooltip either way.
              The hairline before "Vaciar" is the same separation the phone menu
              makes with its divider: the one destructive control in the row
              should never sit flush against Descargar. */}
          <div ref={toolsBarRef} className="hidden sm:flex items-center gap-1.5">
            <HudIcon
              title={t(locale, 'tools.oneFabricAll')}
              label={t(locale, 'tools.oneFabricAllShort')} onClick={() => openMaterial('all')}
            ><Layers size={15} /></HudIcon>
            <HudIcon
              title={t(locale, 'tools.ar')}
              label={t(locale, 'tools.arShort')} onClick={() => setArOpen(true)}
            ><View size={15} /></HudIcon>
            <HudIcon
              title={t(locale, 'tools.share')}
              label={t(locale, 'tools.shareShort')} onClick={shareDesign}
            ><Share2 size={15} /></HudIcon>
            <HudIcon
              title={t(locale, 'tools.download')}
              label={t(locale, 'tools.downloadShort')} onClick={() => setDlOpen(true)}
            ><FileDown size={15} /></HudIcon>
            <span className="hud-tool-sep" aria-hidden />
            <HudIcon
              title={t(locale, 'tools.clear')}
              label={t(locale, 'tools.clearShort')} danger onClick={clearPlan}
            ><Eraser size={15} /></HudIcon>
          </div>
          <div className="sm:hidden">
            <HudMenu
              label={t(locale, 'tools.menu')}
              items={[
                { icon: <Layers size={17} />, label: t(locale, 'tools.oneFabricAll'), hint: t(locale, 'tools.oneFabricAllHint'), onClick: () => openMaterial('all') },
                { icon: <View size={17} />, label: t(locale, 'tools.ar'), hint: t(locale, 'tools.arHint'), onClick: () => setArOpen(true) },
                { icon: <Share2 size={17} />, label: t(locale, 'tools.share'), hint: t(locale, 'tools.shareHint'), onClick: shareDesign },
                { icon: <FileDown size={17} />, label: t(locale, 'tools.downloadMenu'), hint: t(locale, 'tools.downloadHint'), onClick: () => setDlOpen(true) },
                { divider: true },
                { icon: <Eraser size={17} />, label: t(locale, 'tools.clear'), hint: t(locale, 'tools.clearHint'), danger: true, onClick: clearPlan },
              ]}
            />
          </div>
        </div>
      )}

      {/* ── Desktop workspace panes (≥1280px). Left: the piece catalog with big
           rendered images (2D only, like the hotbar it replaces — 3D is a
           look-only preview that deserves the width). Right: "your design" —
           the SAME DesignPane the phone hangs in its Resumen drawer, docked as
           a column (it replaces the phone's bottom estimate deck up here).
           Hidden while the plan is empty: the starter overlay is THE one
           picker. ── */}
      {desktop && view === '2d' && vm.count > 0 && (
        <PiecesPane
          models={paletteModels} renderThumbById={renderThumbById}
          onAdd={addPiece} hoveredPieceId={hoveredPieceId} onHover={setHoveredPieceId} flashId={flashId}
          collections={collections} collectionMenu={collectionMenu} collectionThumbs={collectionFabricThumbs} fabricByCode={fabricByCode} activeCollection={activeCollection} onCollection={setActiveCollection}
          locale={locale} fmt={fmt}
        />
      )}
      {/* Desktop 3D LEFT pane — the MATERIAL catalog, a DRAWER. The workspace
          splits by intent: 2D composes the models (PiecesPane), 3D dresses them.
          It used to sit open for the whole of 3D, which meant a third of the
          canvas was spent on a catalog nobody had asked for — with nothing
          selected there is no target to dress, and a piece whose family isn't
          bound has nothing to offer either. So it slides open only when there
          IS something to pick, and is stowed otherwise, and it follows the live
          target while open: the selected piece's fabric ladder, a tapped PART's
          ladder (chip shows it, ✕ returns to the piece), or an explicit
          "aplicar a todas". */}
      {railOpen && (
        <MaterialsPane
          locale={locale}
          targetLabel={selected ? (selResolved?.label || t(locale, 'piece.generic')) : null}
          /* An estructura target wears the SAME header chip a cloth part does —
             «Large Square Settee · Patas», ✕ back to the piece — because to the
             visitor it is the same act on the same rail. */
          partRole={finishRail ? 'structure' : (selected && matPart ? matPart : null)}
          partLabel={finishRail
            ? (finishRail.spec?.label || t(locale, 'part.structure'))
            : (selected && matPart ? roleLabelOf(selResolved?.parts, matPart, t(locale, `part.${matPart}`)) : null)}
          onClearPart={() => { setFinishRail(null); setMatPart(null); }}
          pickerKey={finishRail
            ? `${finishRail.uid}:finish:${finishRail.partKey}`
            : `${selectedUid ?? 'all'}:${(selected && matPart) || 'base'}`}
          finishSpec={finishRail?.spec || null}
          finishCurrent={finishRail ? (placed.find((row) => row.uid === finishRail.uid)?.partFinishes?.[finishRail.partKey] ?? null) : null}
          onPickFinish={onPickFinish}
          onSwatchPreview={setSwatchPreview}
          /* The OFFER, not the catalog: a grade this target can't be priced in
             is never shown as a tile (see `pickableMaterials`). */
          materials={pickableMaterials}
          family={railFamily}
          nameFilter={selected ? nameFilterOf(resolvedById[selected.pieceId]?.offeredKeys) : allNameFilter}
          currentGrade={selected && matPart ? effectivePartMaterials(selected)?.[matPart]?.grade : (selected ? selected?.material?.grade : undefined)}
          currentFabric={selected && matPart ? effectivePartMaterials(selected)?.[matPart]?.fabric : (selected ? selected?.material?.fabric : undefined)}
          pricesHidden={pricesHidden}
          fmt={fmt}
          onPick={onPanePick}
        />
      )}
      {/* Mobile/tablet piece catalog — an edge RAIL that opens a roomy side
          DRAWER, replacing the old cramped bottom chips + hotbar. 2D editing
          only, once the plan has its first piece (the empty-plan starter is the
          picker before that). */}
      {!desktop && view === '2d' && vm.count > 0 && (
        <CatalogDrawer
          open={catalogOpen} onOpen={() => setCatalogOpen(true)} onClose={() => setCatalogOpen(false)}
          models={paletteModels} renderThumbById={renderThumbById}
          onAdd={(id) => { addPiece(id); setCatalogOpen(false); }}
          hoveredPieceId={hoveredPieceId} onHover={setHoveredPieceId} flashId={flashId}
          collections={collections} collectionMenu={collectionMenu} collectionThumbs={collectionFabricThumbs} fabricByCode={fabricByCode} activeCollection={activeCollection} onCollection={setActiveCollection}
          locale={locale} fmt={fmt}
        />
      )}
      {/* ── TU DISEÑO, on the phone: the SAME right pane the desktop runs,
           in the Resumen drawer's shell («mobile view is exactly the same
           components as desktop» — owner, 2026-08). It replaced QuoteSheet, a
           phone-only re-implementation of this very surface that had to be
           kept in step by hand. Mounted only while open, like the picker
           drawer; every action that OPENS the picker closes this first — two
           88vw drawers at once is a curtain, not a workspace. ── */}
      {quoteOpen && !desktop && (
        <>
          <button
            type="button"
            aria-label={t(locale, 'common.close')}
            onClick={() => setQuoteOpen(false)}
            className="absolute inset-0 z-30 bg-ink-900/20 animate-in fade-in duration-200"
          />
          <DesignPane
            shellClassName={DESIGN_DRAWER_SHELL}
            onClose={() => setQuoteOpen(false)}
            placed={placed} resolvedById={resolvedById} models={models}
            selectedUid={selectedUid} onSelectRow={setSelectedUid}
            renderThumbById={renderThumbById}
            locale={locale} fmt={fmt} fromMode={fromMode} pricesHidden={pricesHidden}
            pricedUsd={pricedUsd} animatedUsd={animatedUsd} pendingFabric={pendingFabric} unpriced={unpricedPieces}
            overallCm={vm.overallCm} selectedFamily={selectedFamily}
            waiting={waiting}
            onFixPending={() => { setQuoteOpen(false); fixPendingFabric(); }}
            onFabricAll={() => { setQuoteOpen(false); openMaterial('all'); }}
            onQuote={() => { buzz(9); setQuoteOpen(false); setStep('form'); }}
            onPickFabricFor={(uid) => { setQuoteOpen(false); pickFabricFor(uid); }}
            onClearFabric={clearFabric}
            onPickPartFor={(uid, role) => { setQuoteOpen(false); openPartMaterial(uid, role); }}
            onClearPartFor={clearPartMaterial}
            onPickFinishFor={(uid, groupKey) => { setQuoteOpen(false); openPartMaterial(uid, 'structure', groupKey); }}
            onClearFinishFor={clearPartFinish}
            partsOpenUid={partsOpenUid}
            onTogglePartsFor={(uid) => setPartsOpenUid((cur) => (cur === uid ? null : uid))}
            onSwitchMode={switchMode}
            onDuplicate={duplicateSel} onDelete={deleteSel}
          />
        </>
      )}
      {/* ── COMPONENTES — the piece's own parts as a rail DOWN THE RIGHT SIDE
           OF THE MATERIAL PANE. It used to be a wrapped grid inside that pane,
           which tied it to the picker being open and buried the part SELECTOR
           inside the thing it selects for. Standing beside it, it is available
           the whole time a piece is selected and it is interactive on both
           gestures: CLICK targets that part (the picker retargets, exactly as
           before) and HOVER previews it — the same gold outline and the same
           preview card the mesh itself answers with.
           It belongs to the PICKER's cluster, not to the design pane: the two
           are one gesture (choose the part, then its cloth), so the rail hangs
           off the picker's right edge and the far right stays the design pane's
           alone. Picker closed ⇒ it takes the picker's own left inset, which is
           where that column lives either way. ── */}
      {componentsRailOpen && (
        <ComponentsRail
          entries={stripEntries}
          activeKey={stripActiveKey}
          hoverKey={stripHoverKey}
          locale={locale}
          offsetLeft={leftColumnOffset('picker', { railOpen })}
          /* Entry → focus vocabulary, translated HERE so the rail stays a plain
             list of chips and the stage keeps one language: the piece's own
             cloth chip IS the dressable piece (never a part named "base"). */
          onHover={(e) => setRailHover(e ? railFocusOf(e) : null)}
          modeSwitch={stripPiece ? (
            <ModeSwitch
              compact
              piece={stripPiece} r={resolvePlacement(stripPiece, resolvedById)} resolvedById={resolvedById}
              locale={locale} fmt={fmt} fromMode={fromMode} pricesHidden={pricesHidden}
              onSwitch={(mode) => switchMode(stripPiece.uid, mode)}
            />
          ) : null}
          onPick={(e) => {
            if (!stripPiece) return;
            setRailHover(null);   // the target is COMMITTED now — the preview has nothing left to preview
            if (e.role === 'structure') openPartMaterial(stripPiece.uid, 'structure', e.groupKey);
            // El chip de la pieza abre SU tela (sin parte); un componente
            // llamado 'base' abre la suya — la misma desambiguación de siempre.
            else openPartMaterial(stripPiece.uid, railWholePiece(e) ? null : e.role);
          }}
        />
      )}
      {designPaneOpen && (
        <DesignPane
          placed={placed} resolvedById={resolvedById} models={models}
          selectedUid={selectedUid} onSelectRow={setSelectedUid}
          renderThumbById={renderThumbById}
          locale={locale} fmt={fmt} fromMode={fromMode} pricesHidden={pricesHidden}
          pricedUsd={pricedUsd} animatedUsd={animatedUsd} pendingFabric={pendingFabric} unpriced={unpricedPieces}
          overallCm={vm.overallCm} selectedFamily={selectedFamily}
          /* The pending pick, so the pane can light the pill the rail is
             waiting on — piece, part, or every piece at once. */
          waiting={waiting}
          onFixPending={fixPendingFabric} onFabricAll={() => openMaterial('all')}
          onQuote={() => { buzz(9); setStep('form'); }}
          onPickFabricFor={pickFabricFor} onClearFabric={clearFabric}
          onPickPartFor={openPartMaterial} onClearPartFor={clearPartMaterial}
          /* The estructura rows open the SAME finish sheet the 3D tap does —
             openPartMaterial's structure branch, reached by naming the role. */
          onPickFinishFor={(uid, groupKey) => openPartMaterial(uid, 'structure', groupKey)}
          onClearFinishFor={clearPartFinish}
          partsOpenUid={partsOpenUid}
          onTogglePartsFor={(uid) => setPartsOpenUid((cur) => (cur === uid ? null : uid))}
          onSwitchMode={switchMode}
          /* The rail carries the switch whenever it is up (3D, a piece
             selected). The pane keeps it for the cases the rail is NOT there —
             2D, or nothing selected — so there is EXACTLY ONE on screen and it
             never disappears entirely. */
          /* …y la hoja del teléfono lo lleva en su fila de componentes, así que
             tampoco ahí puede haber dos. */
          showModeSwitch={!componentsRailOpen && !(matOpen && !desktop)}
          onDuplicate={duplicateSel} onDelete={deleteSel}
        />
      )}

      {/* ── Bottom control deck — the build hotbar and the live estimate + quote
           CTA. The wrapper is click-through (pointer-events-none); only the glass
           panels catch input, so the canvas stays draggable in the gaps. On the
           desktop workspace the hotbar + estimate live in the side panes, so the
           deck (toast, hints, camera) margins in BETWEEN them: 17.5rem clears
           the 2D left pane (pieces, 16rem + edge + gap), 21.5rem the 3D left
           pane (materials, 20rem) and the right pane (20rem + edge + gap). ── */}
      <div className="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
        <div className={desktop && vm.count > 0
          ? `${view === '2d' ? 'ml-[17.5rem]' : 'ml-[21.5rem]'} mr-[21.5rem] flex flex-col items-stretch gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]`
          : 'mx-auto w-full max-w-5xl flex flex-col items-stretch gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]'}>

          {/* "Plano vaciado" recovery toast — the eraser stays one tap, but the
              way back is right there. Shown in both views (undo works anywhere). */}
          {clearToast && (
            <div role="status" className="hud-panel pointer-events-auto self-center flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 configurator-rise">
              <span className="text-xs text-ink-700">{t(locale, 'toast.cleared')}</span>
              <button type="button" onClick={() => { setClearToast(false); undo(); }} className="text-xs font-semibold text-ink-900 underline decoration-ink-300 underline-offset-2 hover:decoration-ink-700 px-2 py-1.5 transition">
                {t(locale, 'action.undo')}
              </button>
            </div>
          )}

          {/* Design-link confirmation — the clipboard is silent, so say it. */}
          {shareToast && (
            <div role="status" className="hud-panel pointer-events-auto self-center flex items-center gap-2 px-3 py-1.5 configurator-rise">
              <Share2 size={13} className="shrink-0 text-ink-500" aria-hidden />
              <span className="text-xs text-ink-700">{shareToast}</span>
            </div>
          )}

          {/* First-run coach line — how to work the plan, one dismiss, remembered.
              Desktop (fine pointer) also learns the keyboard verbs. */}
          {view === '2d' && hintsOpen && vm.count > 0 && (
            <div className="hud-panel pointer-events-auto self-center flex items-center gap-2 pl-2 pr-1.5 py-1.5 max-w-md configurator-rise">
              <span className="shrink-0 w-7 h-7 rounded-full bg-brand-50 grid place-items-center" aria-hidden><Lightbulb size={14} className="text-brand-600" /></span>
              <span className="text-micro text-ink-600 leading-snug">
                {t(locale, 'hint.build')}
                {FINE_POINTER && ` ${t(locale, 'hint.buildKeyboard')}`}
              </span>
              <button type="button" onClick={dismissHints} aria-label={t(locale, 'hint.dismiss')} className="shrink-0 w-8 h-8 grid place-items-center rounded-lg text-ink-500 hover:bg-ink-100/60 hover:text-ink-700 transition"><X size={14} /></button>
            </div>
          )}

          {/* First 3D visit — how to work the view, one dismiss, remembered. */}
          {view === '3d' && hints3dOpen && vm.count > 0 && (
            <div className="hud-panel pointer-events-auto self-center flex items-center gap-2 pl-2 pr-1.5 py-1.5 max-w-md configurator-rise">
              <span className="shrink-0 w-7 h-7 rounded-full bg-brand-50 grid place-items-center" aria-hidden><Lightbulb size={14} className="text-brand-600" /></span>
              <span className="text-micro text-ink-600 leading-snug">{t(locale, 'hint.view3d')}</span>
              <button type="button" onClick={dismissHints3d} aria-label={t(locale, 'hint.dismiss')} className="shrink-0 w-8 h-8 grid place-items-center rounded-lg text-ink-500 hover:bg-ink-100/60 hover:text-ink-700 transition"><X size={14} /></button>
            </div>
          )}

          {/* ── Camera controls — parked just above the model bar, on the
               right, so they clear whatever the deck holds (the hotbar in 2D,
               nothing in 3D) and ride up/down WITH it instead of floating over
               the middle of the model. Zoom in/out is a FINE-pointer affordance
               only — on touch you pinch — so the phone shows just the re-frame
               button (double-tapping the floor does the same). ── */}
          {vm.count > 0 && (
            <div className="self-end pointer-events-auto flex items-center gap-1.5">
              <div className="hidden fine:flex items-center gap-1.5">
                <HudIcon title={t(locale, 'camera.zoomIn')} onClick={() => stageGestures.current?.zoomBy?.(0.8)}><ZoomIn size={15} /></HudIcon>
                <HudIcon title={t(locale, 'camera.zoomOut')} onClick={() => stageGestures.current?.zoomBy?.(1.25)}><ZoomOut size={15} /></HudIcon>
              </div>
              <HudIcon title={t(locale, 'camera.recenter')} onClick={() => stageGestures.current?.recenter?.()}><Maximize size={15} /></HudIcon>
            </div>
          )}

          {/* The piece catalog is no longer a cramped bottom strip on phones — it's
              a side DRAWER opened from an edge rail (CatalogDrawer, rendered as an
              absolute overlay below). The desktop workspace keeps its LEFT PANE. */}

          {/* Live estimate + the single primary CTA. Hidden while the plan is
              empty — a dead "Cotizar" next to a message the starter card already
              carries is noise, not chrome; the deck rises once there's a build.
              On the desktop workspace the RIGHT PANE carries all of this. */}
          {!desktop && vm.count > 0 && (
            <div className="hud-panel pointer-events-auto flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="text-micro text-ink-500 flex items-center gap-1.5 flex-wrap">
                  {/* Hidden pricing → no "Estimado" register, just the piece count. */}
                  <span>{pricesHidden ? piecesLabel(locale, vm.count) : `${t(locale, 'estimate.label')} · ${piecesLabel(locale, vm.count)}`}</span>
                  {!pricesHidden && pendingFabric > 0 && pricedUsd > 0 && (
                    <button type="button" onClick={fixPendingFabric} className="inline-flex items-center gap-0.5 border border-ink-900 text-ink-900 px-1.5 py-0.5 text-micro tracking-wide hover:bg-ink-900 hover:text-white transition-colors">
                      {t(locale, 'estimate.pendingFabric', { count: pendingFabric })} <ArrowRight size={10} aria-hidden />
                    </button>
                  )}
                </div>
                {/* Prices only render when the dealer exposes them (not 'hidden'). */}
                {/* A build carrying an unpriceable piece has no total to state
                    — the figure would be short by whatever that piece is worth,
                    and a confident number is exactly the wrong thing to show. */}
                {!pricesHidden && unpricedPieces > 0 && (
                  <div className="text-xl sm:text-2xl font-display font-semibold tracking-tight leading-none mt-0.5 text-ink-500">{t(locale, 'summary.noPrice')}</div>
                )}
                {!pricesHidden && unpricedPieces === 0 && (pricedUsd > 0
                  // Keyed by the TARGET price: a reprice remounts the figure and
                  // replays the score-pop — the deck physically reacts when a
                  // fabric lands, not just the digits ticking.
                  ? <div key={Math.round(pricedUsd)} className="configurator-score text-xl sm:text-2xl font-display font-semibold tabular-nums tracking-tight leading-none mt-0.5">{fmt(Math.round(animatedUsd), { from: fromMode })}</div>
                  : (
                    // Nothing priced yet → the fastest path to a real quote: pick
                    // ONE fabric and it lands on EVERY piece at once (each
                    // repriced by its own model). Per-piece changes live in the
                    // Resumen drawer and on the 3D chip's pencil.
                    <button type="button" onClick={() => openMaterial('all')} className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-brand-50 border border-brand-200 text-brand-700 px-3 py-1 text-sm font-medium hover:bg-brand-100 hover:border-brand-300 active:scale-95 transition">
                      <Palette size={13} className="shrink-0" aria-hidden /> {t(locale, 'estimate.chooseFabricAll')}
                    </button>
                  ))}
                {vm.overallCm.widthCm > 0 && <div className="text-micro text-ink-500 tabular-nums mt-0.5">{t(locale, 'dims.set', { w: vm.overallCm.widthCm, d: vm.overallCm.depthCm })}</div>}
              </div>
              <button type="button" onClick={() => { buzz(9); setStep('form'); }} className="btn-brand text-sm shrink-0">
                {t(locale, 'estimate.cta')} <ArrowRight size={15} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── THE PHONE'S MATERIAL PICKER ──────────────────────────────────
           The SAME component the desktop rail renders (MaterialsPane) — one
           component, two shells, so «idéntica a la versión desktop» holds by
           construction and there is never a second picker to keep in step by
           hand. What differs is only WHERE it is stowed, and on a portrait
           screen that is the BOTTOM: it slides up to the toolbar's line and
           the wall of fabrics gets the full height (MATERIALS_SHEET_SHELL).
           It used to pull out of the LEFT edge at 88vw, which spent the
           phone's scarce axis on a drawer.
           Mounted only while open: the swatch wall is the heaviest surface in
           the widget and a phone should not carry it stowed. ── */}
      {matOpen && !desktop && (
        <>
          {/* Tocar el plano detrás la guarda — el mismo gesto que cierra todo lo
              guardable aquí. INVISIBLE a propósito: el tinte oscuro apagaba la
              mitad de arriba justo cuando esa mitad existe PARA mirar la pieza
              (dueño, 2026-08-05: «don't opaque the screen with that dark hue»).
              La hoja ya se separa sola — es una tarjeta con sombra sobre el
              plano —, así que el velo solo cobraba contraste sin dar nada. */}
          <button
            type="button"
            aria-label={t(locale, 'common.close')}
            onClick={() => { setMatOpen(false); setMatPart(null); }}
            className="absolute inset-0 z-30"
          />
          <MaterialsPane
            shellClassName={MATERIALS_SHEET_SHELL}
            /* LOS COMPONENTES, A LA DERECHA DEL MURO. Misma lista que la
               columna de escritorio y mismo vocabulario de foco — solo cambia
               la concha. Sube con la hoja porque ahí se elige QUÉ vestir antes
               de CON QUÉ, y no le quita altura a las telas: ocupa el hueco que
               quedaba a su derecha. */
            sideSlot={stripPiece && stripEntries.length > 0 ? (
              <ComponentsRail
                docked
                entries={stripEntries}
                activeKey={stripActiveKey}
                hoverKey={stripHoverKey}
                locale={locale}
                onHover={(e) => setRailHover(e ? railFocusOf(e) : null)}
                /* Idéntico al de escritorio: el mismo chip abre la misma
                   puerta, aquí y allá. */
                onPick={(e) => {
                  if (!stripPiece) return;
                  setRailHover(null);   // the target is COMMITTED now — the preview has nothing left to preview
                  if (e.role === 'structure') openPartMaterial(stripPiece.uid, 'structure', e.groupKey);
                  else openPartMaterial(stripPiece.uid, railWholePiece(e) ? null : e.role);
                }}
                modeSwitch={(
                  <ModeSwitch
                    compact
                    piece={stripPiece} r={resolvePlacement(stripPiece, resolvedById)} resolvedById={resolvedById}
                    locale={locale} fmt={fmt} fromMode={fromMode} pricesHidden={pricesHidden}
                    onSwitch={(mode) => switchMode(stripPiece.uid, mode)}
                  />
                )}
              />
            ) : null}
            onClose={() => { setMatOpen(false); setMatPart(null); }}
            locale={locale}
            targetLabel={selected ? (selResolved?.label || t(locale, 'piece.generic')) : null}
            partRole={selected && matPart ? matPart : null}
            partLabel={selected && matPart ? roleLabelOf(selResolved?.parts, matPart, t(locale, `part.${matPart}`)) : null}
            onClearPart={() => setMatPart(null)}
            pickerKey={`${selectedUid ?? 'all'}:${(selected && matPart) || 'base'}`}
            /* Same OFFER the desktop rail gets — the phone can't be allowed to
               store a pick the rail refuses (see `pickableMaterials`). */
            materials={pickableMaterials}
            /* A materialization ZONE (ottoman interior/exterior) reprices the
               BASE SKU by grade — its picker shows the base family's ladder; a
               billed part shows its own SKU's. Read off the ONE derivation the
               rail and the offer share (`partFamily`). */
            family={matPart ? partFamily : (matMode === 'all' ? null : selectedFamily)}
            nameFilter={matMode === 'all' && !matPart ? allNameFilter : nameFilterOf(resolvedById[selected?.pieceId]?.offeredKeys)}
            currentGrade={matPart ? effectivePartMaterials(selected)?.[matPart]?.grade : (matMode === 'all' ? undefined : selected?.material?.grade)}
            currentFabric={matPart ? effectivePartMaterials(selected)?.[matPart]?.fabric : (matMode === 'all' ? undefined : selected?.material?.fabric)}
            pricesHidden={pricesHidden}
            fmt={fmt}
            /* The PHONE docks it in the drawer's own footer: at 88vw there is
               no canvas beside the drawer to hang a card on, and floating it
               would cover the wall exactly as it did on desktop. */
            onSwatchPreview={setSwatchPreview}
            preview={onePreview}
            onPick={matPart
              ? (pick) => onPickPartMaterial(matPart, pick)
              : (matMode === 'all' ? applyFabricToAll : onPickMaterial)}
          />
        </>
      )}

      <ConfiguratorArViewer open={arOpen} onClose={() => setArOpen(false)} scene3d={scene3d} material={material} storeName={storeName} phoneUrl={handoffUrl} fabricByCode={fabricByCode} />

      <DownloadSheet
        open={dlOpen} onClose={() => setDlOpen(false)} locale={locale}
        onDxf={downloadDxf} dxfBusy={dxfBusy}
        onGlb={downloadGlb} glbBusy={glbBusy}
      />

          </div>
  );
}

/** A floating glass tool button — the top-right HUD cluster. Icon-only with a
 *  native tooltip; no dropdown, every action is one tap. */
/** A model's catalogue image: the rendered perspective PNG, and nothing until
 *  it is ready. One component so the picker, hotbar and selected header all
 *  show the same modern representation — and all wait the same way. */
function ModelThumb({ id, render = {}, className = '', alt = '', waveIndex = null }) {
  const url = render[id];
  // A rendered URL can go stale: the thumbnail cache is LRU-bounded and REVOKES
  // the object URL it evicts, so a long session can hand us a src the browser
  // will refuse. That must degrade to the empty plate, never to a broken image
  // icon in a Ligne Roset catalogue. Tracks WHICH url failed, so a later
  // re-render for the same piece is free to try again.
  const [failedUrl, setFailedUrl] = useState(null);
  // THE PIECE JUST APPEARS — the Tienda's reveal, in this surface's own terms.
  // A thumbnail here is an FBX parse, a GPU draw and a PNG encode arriving
  // whenever the offscreen renderer gets to it, so until it does the tile holds
  // its own plate (the caller's `bg-white` / `bg-ink-50`) and nothing else: no
  // stand-in, no shape change, no swap to watch. The render then fades up over
  // the plate on the same 500ms as every photo on the storefront.
  const [ready, setReady] = useState(false);
  const imgRef = useRef(null);
  const showRender = !!url && url !== failedUrl;
  // A cached (or already-decoded) src never fires onLoad, so seed from the
  // element — the same trap ImageView's fade guards against: without it a
  // re-mount would sit at opacity 0 on a blank plate.
  useLayoutEffect(() => {
    setReady(showRender ? Boolean(imgRef.current?.complete) : false);
  }, [url, showRender]);
  // In a grid, DECODED is not SHOWN: the tile takes its slot in the wave and
  // waits for its turn (see ThumbWaveProvider). Ungated everywhere else — the
  // hotbar chip and the selected header are single thumbs with nothing to
  // queue behind.
  const wave = useContext(ThumbWave);
  const gated = !!wave && waveIndex != null;
  // A tile with no piece behind it, or one whose url the browser refused, has
  // nothing coming — it settles its slot at once so the wave steps over it on
  // the beat instead of stalling on it for WAVE_PATIENCE. Settled is not shown:
  // it stays a bare plate.
  const settled = !id || (!!url && url === failedUrl);
  useEffect(() => {
    if (gated && (ready || settled)) wave.report(waveIndex);
  }, [gated, ready, settled, waveIndex, wave]);
  const shown = ready && (!gated || waveIndex < wave.released);
  // The box stays mounted whether or not a render exists, so the caller's
  // sizing/padding/hover-scale keep working and an unrendered tile holds its
  // place in the grid instead of collapsing.
  return (
    <span className={`${className} block`}>
      {showRender && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setReady(true)}
          onError={() => setFailedUrl(url)}
          className={`block h-full w-full object-contain select-none transition-opacity duration-500 ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </span>
  );
}

// Common room sizes (metres) offered as one-tap presets — the fast path for a
// client's stated space ("una sala de 5 × 4"). Applied as centimetres.
const ROOM_PRESETS_M = [[3, 3], [4, 3], [5, 4], [6, 5]];

/** The room dimensions panel: type width × depth (cm) or tap a preset to drop a
 *  centred rectangular floor. A visual reference — it reports fit, never blocks.
 *  Anchored under the top-left toolbar; owns its own W/D draft, reseeded when
 *  the room changes from outside (undo, a restored link). */
function RoomPanel({ room, fitInfo, locale, onApply, onClear, onClose, onDraft }) {
  const size = roomSize(room);
  const [w, setW] = useState(size?.widthCm ?? 400);
  const [d, setD] = useState(size?.depthCm ?? 300);
  const ref = useRef(null);
  useEffect(() => {
    const s = roomSize(room);
    if (s) { setW(s.widthCm); setD(s.depthCm); }
  }, [room]);
  // LIGHT DISMISS — a floating tool over the plan gets out of the way when you
  // go back to the plan. It used to sit there until you found its ✕, so every
  // tap meant for the sofa underneath hit the panel instead. Same recipe as
  // HudMenu: pointerdown outside, or Escape.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      // …except its own tool button, which owns the toggle: closing here too
      // would re-open the panel on the click that follows the pointerdown.
      if (e.target?.closest?.('[data-room-tool]')) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  // What a click would ACTUALLY draw — clamped, so the button judges the 50 cm
  // floor the room will land on rather than the raw text. Nothing to do when a
  // field is blank, or when the drawn room already IS the typed size (which is
  // precisely the state a click leaves behind).
  const wantW = clampRoomDim(Math.round(Number(w) || 0));
  const wantD = clampRoomDim(Math.round(Number(d) || 0));
  const blank = String(w).trim() === '' || String(d).trim() === '';
  const applied = !!size && size.widthCm === wantW && size.depthCm === wantD;
  const nothingToDo = blank || applied;
  // Report the live figures up so the plan can draw them. Blank fields report
  // NOTHING rather than the 50 cm floor `clampRoomDim` would hand back — a room
  // flashing to its minimum while you clear a field to retype it is the preview
  // arguing with you. Through a ref so an inline parent callback can't re-fire
  // this on every render.
  const draftRef = useRef(onDraft);
  draftRef.current = onDraft;
  useEffect(() => {
    draftRef.current?.(blank ? null : { widthCm: wantW, depthCm: wantD });
  }, [blank, wantW, wantD]);
  useEffect(() => () => draftRef.current?.(null), []);
  const submit = (e) => {
    e?.preventDefault?.();
    if (nothingToDo) return;   // Enter in a field reaches here too
    onApply(wantW, wantD);
  };
  return (
    <form
      ref={ref}
      onSubmit={submit}
      className="hud-panel configurator-rise absolute z-40 pointer-events-auto w-64 p-3 flex flex-col gap-3 left-[max(0.75rem,env(safe-area-inset-left))] top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)]"
    >
      <div className="flex items-center gap-2">
        <Frame size={15} className="text-brand-500 shrink-0" aria-hidden />
        <span className="font-display font-semibold text-sm leading-none flex-1">{t(locale, 'room.title')}</span>
        <button type="button" onClick={onClose} aria-label={t(locale, 'common.close')} className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-ink-500 hover:bg-ink-100/60 hover:text-ink-700 transition"><X size={14} /></button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-ink-600">{t(locale, 'room.width')}</span>
          <div className="relative">
            <input type="number" inputMode="numeric" min="50" max="3000" value={w} onChange={(e) => setW(e.target.value)}
              className="w-full rounded-lg border border-ink-200 bg-surface pl-2 pr-7 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-micro text-ink-500 pointer-events-none">cm</span>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-ink-600">{t(locale, 'room.depth')}</span>
          <div className="relative">
            <input type="number" inputMode="numeric" min="50" max="3000" value={d} onChange={(e) => setD(e.target.value)}
              className="w-full rounded-lg border border-ink-200 bg-surface pl-2 pr-7 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-micro text-ink-500 pointer-events-none">cm</span>
          </div>
        </label>
      </div>
      <div className="flex flex-wrap gap-1">
        {ROOM_PRESETS_M.map(([pw, pd]) => (
          <button key={`${pw}x${pd}`} type="button"
            onClick={() => { setW(pw * 100); setD(pd * 100); onApply(pw * 100, pd * 100); }}
            className="px-2 py-1 rounded-full border border-ink-200 text-micro text-ink-600 tabular-nums hover:bg-ink-100/60 active:scale-95 transition">
            {pw}×{pd} m
          </button>
        ))}
      </div>
      {room && fitInfo && (
        <div className={`flex items-center gap-1.5 text-micro font-medium ${fitInfo.fits ? 'text-ink-500' : 'text-ink-900'}`}>
          {fitInfo.fits
            ? <><Check size={13} aria-hidden />{t(locale, 'room.fits')}</>
            : <><AlertCircle size={13} aria-hidden />{t(locale, 'room.overflow', { cm: fitInfo.overflowCm })}</>}
        </div>
      )}
      <div className="flex items-center gap-2">
        {/* The one primary on this panel, so it must READ pressable at rest.
            `bg-brand-500` didn't: the configurator's monochrome skin remaps the
            brand ramp to neutrals, so the terracotta CTA rendered mid-grey —
            greyed out BEFORE the click, which is the universal sign for "you
            can't press this". `btn-brand` is the skin's own primary (solid ink,
            the COTIZAR button), and `.btn`'s disabled:opacity-50 supplies the
            grey for the state that has actually earned it: AFTER the click,
            when the drawn room already is what the fields say. */}
        <button type="submit" disabled={nothingToDo} className="btn-brand flex-1 justify-center">
          {room ? t(locale, 'room.update') : t(locale, 'room.apply')}
        </button>
        {room && (
          <button type="button" onClick={onClear} aria-label={t(locale, 'room.clear')} title={t(locale, 'room.clear')}
            className="shrink-0 w-9 grid place-items-center rounded-lg border border-ink-200 text-red-600 hover:bg-red-50 active:scale-95 transition">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </form>
  );
}


/**
 * THE CASCADE every picker surface enters with — the configurator's half of the
 * Tienda's landing rule. Tiles arrive in catalogue order, one beat apart, so a
 * grid assembles in the order it means something (collections by the VM's
 * ranking, pieces by the catalogue's) instead of blinking on all at once.
 *
 * The beat stops counting past the cap: past a dozen tiles a stagger stops
 * reading as rhythm and starts reading as a surface that is slow to load — and
 * `configurator-rise` fills backwards, so an uncapped delay is a tile held BLANK.
 */
// The beat BOTH cascades share — the plates here and the wave below — so one
// rhythm crosses the grid rather than two.
const TILE_RISE_STEP = 45;
const TILE_RISE_CAP = 10;
/** The splash reads top-down: the lockup lands, then the tiles it introduces. */
const SPLASH_TILES_IN = 120;
const tileRiseIn = (i, base = 60) => `${base + Math.min(i, TILE_RISE_CAP) * TILE_RISE_STEP}ms`;
/** Whatever follows a cascading grid waits for the last tile that still counts. */
const afterTileRise = (n, base = 60) => `${base + (Math.min(n, TILE_RISE_CAP) + 1) * TILE_RISE_STEP}ms`;

/**
 * THE WAVE (owner, 2026-07-31: "como una ola de izquierda a derecha … en el
 * configurador they pop out at a random order").
 *
 * The stagger below only paces the PLATES. What the visitor actually watches
 * appear is the 3D render inside each one, and those do not arrive in reading
 * order: one offscreen renderer serialises whatever the tiles' intersection
 * observers hand it, over an LRU cache that answers some tiles in a frame and
 * makes others wait a whole GPU draw. Left alone the grid speckles in — tile
 * seven, then two, then nine.
 *
 * So READY and SHOWN are separated. A tile reports the moment its render has
 * decoded; the wave releases slots strictly in reading order, one beat apart,
 * and a tile that finished early simply waits its turn.
 *
 * Three guards keep the order from becoming a stall. The wave does not begin
 * until something has actually arrived (an off-screen grid — a closed drawer, a
 * pane below the fold — must not march its wave away while nobody is watching).
 * A tile that can never produce a render (no hero, or a url the browser
 * refused) settles its own slot immediately, so the common dead slot costs the
 * wave nothing. And only after that does WAVE_PATIENCE apply, as the last
 * resort against a render that never resolves at all: it is deliberately long,
 * because it is the one thing that can BREAK the order — set it near a real
 * render's cost and a slow device (where every render is a GPU draw away)
 * would march the wave straight past its own tiles, which is the speckle this
 * whole mechanism exists to remove.
 *
 * Same beat as the plates, so the two read as ONE gesture crossing the grid —
 * and a render can never outrun its own plate, which is still holding at
 * opacity 0 until its turn.
 */
const WAVE_PATIENCE = 2500;
const ThumbWave = createContext(null);

function ThumbWaveProvider({ children }) {
  const [released, setReleased] = useState(0);
  const [pulse, setPulse] = useState(0);
  const ready = useRef(new Set());
  // A mirror of the crest, readable from the (stable) report callback.
  const crest = useRef(0);
  crest.current = released;
  useEffect(() => {
    if (!ready.current.size) return undefined; // the wave has not begun
    const id = setTimeout(
      () => setReleased((n) => n + 1),
      ready.current.has(released) ? TILE_RISE_STEP : WAVE_PATIENCE,
    );
    return () => clearTimeout(id);
  }, [released, pulse]);
  const report = useCallback((i) => {
    if (ready.current.has(i)) return;
    ready.current.add(i);
    // Only the crest re-pumps: a tile further down the grid reporting must not
    // restart the patience timer the current crest is waiting on.
    if (i === crest.current || ready.current.size === 1) setPulse((p) => p + 1);
  }, []);
  const value = useMemo(() => ({ released, report }), [released, report]);
  return <ThumbWave.Provider value={value}>{children}</ThumbWave.Provider>;
}

/** STEP ONE of the catalogue's two-step browse: the COLLECTION INDEX, each
 *  collection standing for itself with its hero piece as the only visual (the
 *  VM picks it — `resolveCollectionMenu`). Tapping one enters it; the piece grid
 *  that replaces this is step two, with `CollectionBack` to come out again.
 *
 *  It replaced a flat wall of text chips. With ten collections those read as
 *  debug chrome — "Togo" beside "Saparella" beside "Prado 2" tells a customer
 *  nothing they can shop on, and no arrangement of the names fixes it, because
 *  the names were never the information. A page of furniture is.
 *
 *  Scoping stays a pure VIEW facet: a placed piece from any collection keeps
 *  rendering and pricing, and mixed builds are welcome. Shown only when the
 *  catalog offers more than one collection — with one there is nothing to
 *  choose, so the menu is skipped and its pieces show directly. */
function CollectionMenu({ entries = [], renderThumbById = {}, fabricThumbs = {}, fabricByCode = {}, onSelect, locale, fmt, className = '', cols = 1, rise = 60, waveKey = '' }) {
  const grid = cols === 3 ? 'grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1';
  return (
    <ThumbWaveProvider key={waveKey}>
    <ul className={`pointer-events-auto grid gap-x-4 gap-y-6 list-none m-0 p-0 ${grid} ${className}`}>
      {entries.map((e, i) => (
        /* `snap-start` is INERT unless the scroller opts in with a
           scroll-snap-type (the phone surfaces do, so a slide lands one
           collection square in the panel) — so it costs the multi-column
           desktop grids nothing. */
        <li key={e.collection} className="configurator-rise min-w-0 snap-start" style={{ animationDelay: tileRiseIn(i, rise) }}>
          <CollectionCard
            entry={e} renderThumbById={renderThumbById} waveIndex={i}
            fabricThumbs={fabricThumbs} fabricByCode={fabricByCode}
            onSelect={onSelect} locale={locale} fmt={fmt}
          />
        </li>
      ))}
    </ul>
    </ThumbWaveProvider>
  );
}

/**
 * Render a tile's 3D thumbnail only once that tile is near the viewport.
 *
 * Every thumbnail is an FBX parse, a normals rebuild, a GPU draw and a PNG
 * encode, and they all serialise through one offscreen renderer. Rendering a
 * whole collection up front therefore spends that on pieces the visitor cannot
 * see: opening Noka on a phone that shows three cards queued thirteen. The work
 * is not wasted in the long run — the cache keeps it — but it lands in the worst
 * possible seconds, competing with the first paint and the visitor's first taps.
 *
 * The margin is deliberately a screenful: the render begins while the tile is
 * still below the fold, so by the time it scrolls in the image is usually there
 * and the card never visibly pops. One-shot — once observed, the observer is
 * dropped and the cache answers any re-mount instantly.
 */
function useLazyThumb(model, opts = null) {
  const ref = useRef(null);
  // A BAKED picture needs no observer and no engine: the back-office already
  // rendered this exact tile (piece, frame and cloth all pinned by the stamp),
  // so the cell paints on the first render from a plain URL. Only what is NOT
  // baked — a piece dressed in the cloth a customer just picked — goes through
  // the lazy render below.
  const baked = bakedThumbUrl(model, { ...TILE_THUMB, ...(opts || {}) });
  const [url, setUrl] = useState(baked);
  const id = model?.id;
  const code = opts?.code || '';
  // The appearance descriptor is an object rebuilt each render; key on the CODE.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (baked) { setUrl(baked); return undefined; }
    const el = ref.current;
    if (!el || !id) return undefined;
    let alive = true;
    setUrl(null);
    const render = () => {
      // TILE_THUMB, unconditionally: this hook exists for the 4:3 catalogue tile
      // and nothing else, so the frame belongs here rather than repeated at both
      // tile components. Measured, the boxes it fills are 358×263 CSS px at
      // widest (phone splash) down to ~208 (desktop pane).
      renderConfiguratorThumb(model, { ...TILE_THUMB, ...(optsRef.current || {}) })
        .then((u) => { if (alive && u) setUrl(u); })
        .catch(() => { /* the tile keeps its bare plate */ });
    };
    if (typeof IntersectionObserver === 'undefined') { render(); return () => { alive = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      render();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, code, model?.widthCm, model?.depthCm, model?.mesh?.url, baked]);
  return [ref, url];
}

/** ONE piece card for every picker surface — the empty-plan gallery, the desktop
 *  Piezas pane and the mobile Piezas drawer. It is the CollectionMenu tile (a 4:3
 *  render on a white plate) plus a persistent "+" badge, with the NAME on its own
 *  line beneath it.
 *
 *  The name owning a full line is the point. Sharing a baseline row with a price
 *  or a dimension meant `truncate`, and truncation on the one screen whose whole
 *  job is telling pieces apart is exactly the wrong place to save space — it
 *  produced "Right-Arm Loves…" and "Left-Arm Lovese…", two different modules
 *  rendered as the same string. Here it wraps instead, and price · dims share the
 *  meta line the way a collection's count · desde does.
 *
 *  The whole card is the add button; the badge is decoration (aria-hidden, no
 *  handler of its own), so there is one tap target, not two. */
function PieceCard({ model: m, index = null, renderThumbById = {}, onAdd, onHover, flash = false, locale, fmt, waveIndex = null }) {
  // Renders itself when it comes into range. `renderThumbById` still wins when it
  // already holds this piece (it is filled for whatever is on the plan), so a
  // piece already in the build shows instantly instead of waiting on an observer.
  // Always the CREAM BODY — see the note where the collection page is built.
  const [thumbRef, lazyUrl] = useLazyThumb(m);
  const price = m.priceUsd != null ? fmt?.(m.priceUsd, { from: true })?.replace(/\.\d\d$/, '') : null;
  const dims = m.widthCm > 0 && m.depthCm > 0 ? `${Math.round(m.widthCm)} × ${Math.round(m.depthCm)} cm` : null;
  return (
    <button
      type="button"
      onClick={() => onAdd?.(m.id)}
      onMouseEnter={() => onHover?.(m.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(m.id)}
      onBlur={() => onHover?.(null)}
      title={t(locale, 'piece.add', { name: m.name })}
      className="group block w-full text-left"
    >
      {/* No hover ring. It drew a hard outline around the tile, and on a touch
          screen `hoveredPieceId` sticks after the tap that placed a piece — so
          the box stayed drawn around a card nobody was pointing at. The card
          already answers a pointer without it: the render scales and the badge
          inverts. `onHover` still fires, because it also highlights the matching
          piece out on the plan. */}
      {/* Same short-viewport cap as the collection tile (see CollectionCard):
          height must never be purely width-driven or short viewports slice
          the caption at the fold. */}
      <span ref={thumbRef} className={`relative block aspect-[4/3] max-h-[38svh] rounded-2xl bg-white overflow-hidden transition-colors${flash ? ' configurator-added' : ''}`}>
        {index != null && (
          <span className="absolute top-2.5 left-3 z-[1] text-micro tabular-nums tracking-[0.08em] text-ink-500 group-hover:text-ink-900 transition-colors">
            {String(index + 1).padStart(2, '0')}
          </span>
        )}
        <ModelThumb id={m.id} waveIndex={waveIndex} render={renderThumbById[m.id] ? renderThumbById : { [m.id]: lazyUrl }} alt="" className="absolute inset-0 w-full h-full p-4 transition-transform duration-300 group-hover:scale-[1.05]" />
        <span className="absolute bottom-2.5 right-2.5 w-9 h-9 rounded-full grid place-items-center bg-white/85 backdrop-blur-sm border border-ink-200/70 text-ink-700 shadow-sm transition-colors group-hover:bg-ink-900 group-hover:border-ink-900 group-hover:text-white" aria-hidden>
          <Plus size={16} className="transition-transform group-hover:rotate-90" />
        </span>
      </span>
      <span className="mt-3 block px-0.5 text-base font-light tracking-tight text-ink-900 leading-tight">{m.name}</span>
      {(price || dims) && (
        <span className={`block px-0.5 ${EYEBROW} text-ink-500 mt-1 tabular-nums`}>
          {[price, dims].filter(Boolean).join(' · ')}
        </span>
      )}
    </button>
  );
}

/** The picker LIST: one column of PieceCards, spaced like the collection index. */
function PieceGrid({ models = [], className = '', rise = 60, waveKey = '', ...card }) {
  return (
    <ThumbWaveProvider key={waveKey}>
    <ul className={`grid grid-cols-1 gap-x-4 gap-y-6 list-none m-0 p-0 ${className}`}>
      {models.map((m, i) => (
        <li key={m.id} className="configurator-rise min-w-0" style={{ animationDelay: tileRiseIn(i, rise) }}>
          <PieceCard model={m} waveIndex={i} {...card} flash={card.flashId === m.id} />
        </li>
      ))}
    </ul>
    </ThumbWaveProvider>
  );
}

/** One collection tile. Its own component so it can own a hook: the hero render
 *  is the single most expensive thing on the opening screen and it waits until
 *  the tile is in range (see useLazyThumb). A phone shows about three of these,
 *  and the index used to render all ten before the visitor had touched anything. */
function CollectionCard({ entry: e, renderThumbById = {}, fabricThumbs = {}, fabricByCode = {}, onSelect, locale, fmt, waveIndex = null }) {
  const heroCode = e.fabric?.code || '';
  const [thumbRef, lazyUrl] = useLazyThumb(
    e.hero,
    heroCode ? { code: heroCode, fab: fabricByCode[heroCode] || null } : null,
  );
  // Precedence: whatever the eager pass already produced, then this tile's own
  // lazy render, then the plain body render.
  const ready = fabricThumbs[e.collection] || lazyUrl;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(e.collection)}
      title={e.collection}
      className="group block w-full text-left"
    >
      {/* The collection IS its hero piece. Same hairline tile as a piece
          card, so stepping in doesn't change the visual language.
          `max-h-[38svh]`: the tile's height is otherwise WIDTH-driven
          (aspect-[4/3] of the column) — the launch card's old disease — so a
          short viewport (landscape phone, host iframe, half-height window)
          opened the splash with the first card's caption guillotined at the
          fold ("Togo" over a half-sliced "8 PIEZAS · DESDE…"). Capping by
          svh letterboxes the render (ModelThumb is object-contain) and the
          caption always fits the first viewport. svh not dvh: stable under
          collapsing browser chrome. */}
      <span ref={thumbRef} className="relative block aspect-[4/3] max-h-[38svh] rounded-2xl bg-white overflow-hidden transition-colors">
        <ModelThumb
          id={e.hero?.id}
          waveIndex={waveIndex}
          render={ready ? { [e.hero?.id]: ready } : renderThumbById}
          alt=""
          className="absolute inset-0 w-full h-full p-3 transition-transform duration-300 group-hover:scale-[1.05]"
        />
      </span>
      {/* The NAME gets the whole cell width — sharing the line with the price
          truncated it to "Kash…" / "Sapa…" / "Prad…" in a phone column, and the
          one thing a collection tile has to do is say which collection it is
          (Prado vs Prado 2). The price joins the count on the meta line. */}
      <span className="mt-3 flex items-center gap-1 px-0.5 text-base font-light tracking-tight text-ink-900 leading-tight">
        <span className="min-w-0 truncate">{e.collection}</span>
        <ChevronRight size={15} className="shrink-0 text-ink-500 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
      {/* WRAPS, never truncates: at two columns on a 375px phone
          "2 piezas · Desde $2,600" overruns its cell, and clipping it drops the
          price — the half a shopper cares about. */}
      <span className={`block px-0.5 ${EYEBROW} text-ink-500 mt-1`}>
        {piecesLabel(locale, e.count)}
        {e.fromUsd != null ? ` · ${fmt?.(e.fromUsd, { from: true })?.replace(/\.\d\d$/, '') || ''}` : ''}
      </span>
    </button>
  );
}

/** The step-two header: back to the collection index. */
function CollectionBack({ locale, onBack, className = '' }) {
  return (
    <button
      type="button"
      onClick={() => onBack?.(null)}
      className={`${EYEBROW} inline-flex items-center gap-1.5 hover:text-ink-900 transition-colors ${className}`}
    >
      <ArrowLeft size={13} aria-hidden /> {t(locale, 'collection.heading')}
    </button>
  );
}

/** Mobile/tablet piece catalog — a slim edge RAIL that pulls in a roomy side
 *  DRAWER. Replaces the old cramped bottom hotbar (a one-row strip fighting the
 *  estimate deck for the bottom of a phone): the pieces now live in a proper
 *  panel with a two-column card grid + the collection chips, opened from a tab on
 *  the left edge and dismissed with a tap on the backdrop or a placed piece. The
 *  panel is always mounted so the slide can animate; pointer-events + the rail
 *  gate on `open`. Desktop keeps its always-open LEFT PANE (PiecesPane); this is
 *  the small-screen tool. Adding a piece closes the drawer so the plan is visible
 *  again (the caller's onAdd does that). Hover linkage is kept for parity but is a
 *  near no-op on touch. */
function CatalogDrawer({ open, onOpen, onClose, models, renderThumbById = {}, onAdd, hoveredPieceId, onHover, flashId = null, collections = [], collectionMenu = [], collectionThumbs = {}, fabricByCode = {}, activeCollection, onCollection, locale, fmt }) {
  // Step one: a real choice exists and none has been made yet.
  const atIndex = collections.length > 1 && !activeCollection;
  return (
    <>
      {/* Closed-state RAIL — a slim tab on the left edge; tap to open. Hidden
          while the drawer is open (the panel takes its place). */}
      {!open && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t(locale, 'panel.pieces')}
          className="pointer-events-auto absolute z-20 left-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 py-3 pl-1.5 pr-2 rounded-r-2xl bg-surface/95 backdrop-blur border border-l-0 border-ink-200 text-ink-700 shadow-md active:scale-95 transition"
        >
          <Sofa size={18} className="text-brand-500" />
          <span className="text-micro font-medium tracking-wide [writing-mode:vertical-rl] rotate-180">{t(locale, 'panel.pieces')}</span>
          <ChevronRight size={14} className="text-ink-500" />
        </button>
      )}

      {/* Open-state overlay — backdrop (tap to close) + slide-in panel. Always
          mounted so the transform can animate; pointer-events gated on `open`. */}
      {/* `inert` as well as aria-hidden: both rails stay MOUNTED while closed so
          their slide has something to animate, which leaves a screenful of
          buttons in the DOM off-screen. aria-hidden alone hides them from a
          screen reader while leaving them TAB-REACHABLE — a container that is
          aria-hidden with focusable children is an outright violation, and in
          practice it means tabbing off the canvas walks into a panel nobody can
          see. `inert` takes the subtree out of focus AND the a11y tree. React 18
          doesn't map the boolean, so it goes through as the empty-string
          attribute the HTML spec defines; `undefined` removes it when open. */}
      <div
        className={`absolute inset-0 z-30 ${open ? '' : 'pointer-events-none'}`}
        aria-hidden={!open}
        inert={open ? undefined : ''}
      >
        <div
          onClick={onClose}
          className={`absolute inset-0 bg-ink-900/25 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
        />
        <aside
          aria-label={t(locale, 'panel.pieces')}
          /* The SAME floating card the wide-screen panes are (hud-panel, inset
             from every edge) — it just SLIDES instead of fading, and keeps the
             edge tab. Closed it clears its inset AND its shadow, so nothing
             peeks at the viewport edge. */
          className={`hud-panel absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] w-[min(19rem,84vw)] flex flex-col overflow-hidden transition-transform duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-[calc(100%+2rem)]'}`}
        >
          <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between gap-2 border-b border-ink-100">
            {/* Say which step you're on. It read "PIEZAS" over a wall of
                COLLECTION tiles — the one word on the panel, naming the wrong
                thing. */}
            <span className="eyebrow">{t(locale, atIndex ? 'collection.heading' : 'panel.pieces')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t(locale, 'common.close')}
              className="grid place-items-center w-8 h-8 -mr-1 rounded-full text-ink-500 hover:bg-ink-100/70 active:scale-95 transition"
            >
              <X size={18} />
            </button>
          </div>
          {/* Step two's header: which collection you're inside, and the way out. */}
          {collections.length > 1 && !atIndex && (
            <div className="shrink-0 px-3 py-2 border-b border-ink-100 flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-base font-light tracking-tight text-ink-900">{activeCollection}</span>
              <CollectionBack locale={locale} onBack={onCollection} className="shrink-0" />
            </div>
          )}
          {atIndex ? (
            /* ONE COLUMN on a phone, and it slides. Two columns inside a 304px
               drawer left each collection a 132px cell — a 108×75px sofa render
               with the piece count wrapping under it, which is not enough of a
               picture to choose a collection FROM (the whole point of step one:
               the tile is the only thing standing for the collection). Full
               width triples it. Gentle `proximity` snapping, so a flick still
               flicks but a slide settles with one collection framed. */
            <div className="flex-1 overflow-y-auto snap-y snap-proximity scroll-thin p-3">
              <CollectionMenu
                entries={collectionMenu} renderThumbById={renderThumbById} fabricThumbs={collectionThumbs} fabricByCode={fabricByCode}
                onSelect={onCollection} locale={locale} fmt={fmt} cols={1}
                waveKey={open ? 'open' : 'shut'}
              />
            </div>
          ) : (
            /* ONE COLUMN of the SAME card the collection index uses: a big 4:3
               render with its name beneath. The row this replaces (photo left,
               label right) gave the name only the remainder of a 304px rail, so
               it truncated exactly the words that distinguish the modules —
               "Right-Arm Loves…" beside "Left-Arm Lovese…". The card gives the
               render the full width and the name its own line. */
          <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin px-3 py-2 pb-3">
            <PieceGrid
              models={models} renderThumbById={renderThumbById}
              onAdd={onAdd} onHover={onHover} hoveredPieceId={hoveredPieceId} flashId={flashId}
              locale={locale} fmt={fmt} waveKey={open ? 'open' : 'shut'}
            />
          </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** Desktop-only (≥1280px, via useMinWidth) LEFT workspace pane — the piece
 *  catalog as a real sidebar: every model a card with a BIG rendered image,
 *  name, dims and "desde" price; one click places it. Replaces the compact
 *  bottom hotbar on large screens (the hotbar stays the phone/tablet tool),
 *  keeping its two behaviors: the hover linkage (card ⇄ placed instances ring
 *  together) and the added-flash confirmation. 2D only, like the hotbar — in
 *  3D the left pane is the MATERIAL catalog (MaterialsPane). */
function PiecesPane({ models, renderThumbById = {}, onAdd, hoveredPieceId, onHover, flashId = null, collections = [], collectionMenu = [], collectionThumbs = {}, fabricByCode = {}, activeCollection, onCollection, locale, fmt }) {
  return (
    <aside
      aria-label={t(locale, 'panel.pieces')}
      className="hud-panel hud-panel-solid configurator-rise absolute z-20 left-[max(0.75rem,env(safe-area-inset-left))] top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] bottom-[max(0.75rem,env(safe-area-inset-bottom))] w-64 flex flex-col overflow-hidden"
    >
      {/* Step one when nothing has been entered yet: the collection index takes
          the whole pane, so the visitor is choosing a collection, not filtering
          a list that is already on screen. */}
      {collections.length > 1 && !activeCollection ? (
        <>
          <div className="shrink-0 px-3 pt-3 pb-2">
            <span className="eyebrow">{t(locale, 'collection.heading')}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3">
            <CollectionMenu
              entries={collectionMenu} renderThumbById={renderThumbById} fabricThumbs={collectionThumbs} fabricByCode={fabricByCode}
              onSelect={onCollection} locale={locale} fmt={fmt} cols={1}
            />
          </div>
        </>
      ) : (
        <>
      <div className="shrink-0 px-3 pt-3 pb-2 flex flex-col gap-1.5">
        {collections.length > 1
          ? <CollectionBack locale={locale} onBack={onCollection} />
          : <span className="eyebrow">{t(locale, 'panel.pieces')}</span>}
        {collections.length > 1 && (
          <span className="block text-base font-light tracking-tight text-ink-900 leading-tight">{activeCollection}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <PieceGrid
          models={models} renderThumbById={renderThumbById}
          onAdd={onAdd} onHover={onHover} hoveredPieceId={hoveredPieceId} flashId={flashId}
          locale={locale} fmt={fmt}
        />
      </div>
        </>
      )}
    </aside>
  );
}

/** Desktop-only (≥1280px) LEFT workspace pane for the 3D VIEW — the MATERIAL
 *  catalog as a real sidebar, the 3D counterpart of PiecesPane (2D composes the
 *  models, 3D dresses them). The body is MaterialsCatalog: ONE material
 *  dropdown over that material's swatch wall (3-up photos, search) — the pane's
 *  only scroller is the wall, and it owns it. The header
 *  names the live TARGET: the selected piece (a tapped part shows as a chip
 *  whose ✕ returns to the piece); with nothing selected a pick dresses every
 *  piece at once. Picking never closes anything — the pane persists, so fabric
 *  exploration is one continuous flow over the live 3D model. */
// The desktop rail's own shell — a fixed-width column stowed against the left
// edge. Named because the PHONE reuses the very same component with a different
// shell (see MATERIALS_SHEET_SHELL): «que sea una copia del material picker en
// desktop» is only true by CONSTRUCTION if it is the same component, not a
// second implementation that has to be kept in step.
const MATERIALS_PANE_SHELL = 'hud-panel hud-panel-solid animate-in fade-in slide-in-from-left-4 duration-200 absolute z-20 left-[max(0.75rem,env(safe-area-inset-left))] top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] bottom-[max(0.75rem,env(safe-area-inset-bottom))] w-80 flex flex-col overflow-hidden';

// TU DISEÑO's two anchorings, same recipe as the material pane's pair below:
// the desktop right column, and the phone's right-edge drawer. «Mobile view is
// exactly the same components as desktop» (owner, 2026-08) — the phone used to
// render a DIFFERENT summary (QuoteSheet) plus a floating selected-piece card,
// three implementations of one surface; now there is ONE DesignPane and only
// where it hangs changes.
const DESIGN_PANE_SHELL = 'hud-panel hud-panel-solid configurator-rise absolute z-20 right-[max(0.75rem,env(safe-area-inset-right))] top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] bottom-[max(0.75rem,env(safe-area-inset-bottom))] w-80 flex flex-col overflow-hidden';
const DESIGN_DRAWER_SHELL = 'hud-panel hud-panel-solid animate-in slide-in-from-right duration-200 absolute z-40 right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] w-[min(21rem,88vw)] flex flex-col overflow-hidden';

/**
 * LA HOJA SUBE HASTA LA BARRA (owner, 2026-08-14: «make this slide up», con la
 * línea del destino dibujada justo debajo de la barra de herramientas).
 * Supersede el reparto a MEDIA pantalla de 2026-08-05: el muro de telas es la
 * superficie que se estaba quedando corta, así que la hoja entra deslizándose
 * desde el borde de abajo y descansa con su tope en la línea de la barra — el
 * MISMO anclaje del que cuelgan los paneles de escritorio
 * (`top-[calc(max(0.75rem,…)+3.25rem)]`), dicho aquí como altura porque la
 * hoja ancla por abajo. La pieza se lee ANTES y DESPUÉS, no durante: cerrar
 * (✕, el plano de atrás, o elegir una tela) la destapa exactamente donde
 * estaba — por eso ya no hay `insetBottomFrac` que levante la plataforma
 * mientras la hoja está abierta (ver el comentario en ConfiguratorStage): con la vista
 * cubierta no hay franja donde centrar nada, y el levantón solo compraba un
 * rebote de cámara visible en cada cierre. El ancho completo sigue siendo lo
 * que da sitio a los componentes DE PIE a la derecha del muro.
 */
const MATERIALS_SHEET_SHELL = 'hud-panel hud-panel-solid animate-in slide-in-from-bottom duration-200 absolute z-40 left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] h-[calc(100%-max(0.75rem,env(safe-area-inset-top))-3.25rem-max(0.75rem,env(safe-area-inset-bottom)))] flex flex-col overflow-hidden';

function MaterialsPane({ locale, targetLabel, partRole, partLabel = null, onClearPart, pickerKey, materials, family, nameFilter, currentGrade, currentFabric, pricesHidden, fmt, onPick, finishSpec = null, finishCurrent = null, onPickFinish, preview = null, onSwatchPreview = null, shellClassName = MATERIALS_PANE_SHELL, onClose = null, sideSlot = null }) {
  return (
    <aside
      aria-label={t(locale, 'fabric.pickerTitle')}
      /* Slides in from the edge it is stowed against — the drawer reads as
         coming OUT rather than appearing, which is what makes "stored" legible
         as a state instead of just absent. */
      className={shellClassName}
    >
      {/* No edge line here: the 2px `bg-brand-600` "answering" line this pane
           once carried renders DARK SLATE under the embed's `configurator-rams` ramp
           remap — the hard dark rail the owner retired (2026-08-01). The
           pane's presence is the signal; the header names the target. */}
      {/* UNA SOLA FILA DE CABECERA. Eran dos: el rótulo «ELEGIR MATERIAL» y,
          debajo, a quién se le está eligiendo. En una hoja de media pantalla ese
          renglón de rótulo es muro de telas que no se ve — y no dice nada que la
          pared de telas no diga sola. El SUJETO sube a su sitio (es lo único que
          de verdad hay que leer: qué pieza y qué parte) y la ✕ se queda a su
          derecha. El nombre del panel sobrevive donde importa: el aria-label del
          <aside>, que es lo que anuncia un lector de pantalla. */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {targetLabel ? (
            <>
              <span className="min-w-0 truncate text-xs font-medium text-ink-800">{targetLabel}</span>
              {/* SCOPE, stated. With no part in play a pick dresses the COMPLETE
                  piece — that is step 1 and the cheaper answer, so the pane says
                  so rather than leaving the visitor to infer it from a bare name. */}
              {!partRole && (
                <span className="shrink-0 text-micro text-ink-500">· {t(locale, 'parts.wholePiece')}</span>
              )}
              {partRole && (
                <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-brand-50 border border-brand-200 text-brand-700 pl-2 pr-1 py-0.5 text-micro font-semibold">
                  {partLabel || t(locale, `part.${partRole}`)}
                  <button
                    type="button"
                    onClick={onClearPart}
                    aria-label={t(locale, 'common.close')}
                    className="grid place-items-center w-4 h-4 rounded-full hover:bg-brand-100 transition"
                  >
                    <X size={10} />
                  </button>
                </span>
              )}
            </>
          ) : (
            <span className="min-w-0 truncate text-xs text-ink-500">{t(locale, 'estimate.chooseFabricAll')}</span>
          )}
          {/* Only the phone sheet gets a close: the desktop rail IS the
              workspace and has nothing to close back to. */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t(locale, 'common.close')}
              className="ml-auto shrink-0 grid place-items-center w-8 h-8 -mr-1 rounded-full text-ink-500 hover:bg-ink-100/70 active:scale-95 transition"
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {/* LOS COMPONENTES, A LA DERECHA DEL MURO. La otra opción que el dueño
          dio («either across the top or to the VERY RIGHT of the material») y
          la que gana en una hoja de media pantalla: acostados arriba cobraban
          una fila entera de alto —~90 px de 332— al eje que aquí es el escaso,
          mientras la derecha del muro se quedaba vacía. De pie no cuestan
          altura ninguna y ocupan ese hueco. En escritorio va vacío: allí la
          lista ya tiene su propia columna flotante. */}
      <div className="flex-1 min-h-0 flex flex-row">
        <div className="flex-1 min-w-0 flex flex-col">
        {finishSpec ? (
          <FinishPlates key={pickerKey} locale={locale} spec={finishSpec} current={finishCurrent} onPick={onPickFinish} />
        ) : (
        <MaterialsCatalog
          key={pickerKey}
          locale={locale}
          materials={materials}
          family={family}
          nameFilter={nameFilter}
          currentGrade={currentGrade}
          currentFabric={currentFabric}
          pricesHidden={pricesHidden}
          fmt={fmt}
          /* The colour AND the size the cell paints at — the pane's wall is
             the heaviest swatch surface in the widget, so it asks for tiles,
             never the 2000-px originals (lib/swatchImage `swatchTileUrl`).
             That route is the LIGNE ROSET photo at every size; the fallback is
             the colour's own scan, for the rare code LR no longer publishes. */
          swatchSrc={swatchTileUrl}
          swatchFallbackSrc={swatchTextureUrl}
          /* THE PICK ITSELF. An earlier edit dropped this line while rewiring
             the preview dock, and every material pick in the widget died with
             a TypeError — desktop rail and phone drawer alike («no me deja
             cambiar el material», three reports). Caught by the Playwright
             harness (scripts/e2e-togo-pick.mjs); keep that green. */
          onPick={(material, color) => onPick(toPick(material, color))}
          /* The wall reports what the pointer is on instead of floating its
             own card; the WORKSPACE paints it, in the one home it owns. */
          onDockPreview={onSwatchPreview}
        />
        )}
        </div>
        {sideSlot}
      </div>
      {/* THE PREVIEW, DOCKED. A real footer, not an overlay: the wall above
          SHRINKS to make room, so the card never covers the swatches it is
          explaining (owner, 2026-08: «al fondo del selector de materiales, para
          ahorrar espacio»). Pointer-transparent — it explains, the wall acts. */}
      {/* THE DOCKED PREVIEW — phones only, where there is no canvas beside the
          drawer to put it on. On desktop it lives OUTBOARD of this column (see
          the workspace's one card) so it can never cover the wall it is
          describing. */}
      {preview && (
        <div className="shrink-0 border-t border-ink-200/70 p-2 pointer-events-none animate-in fade-in duration-150">
          {/* ACOSTADA: al pie de una hoja de ancho completo, el cuadrado a todo
              lo ancho era más alto que la hoja y se comía el muro. */}
          <SwatchPreviewBody preview={preview} row />
        </div>
      )}
    </aside>
  );
}

/** The rail in FINISH mode — an estructura's fixed palette (acero, lacado…) as
 *  plates. Same swatch-card idiom as the fabric wall it replaces in place (the
 *  photo is the COLOUR itself, the name under it, a check on the current one),
 *  because to the visitor this is the same gesture on the same rail; what
 *  differs is the ladder — and that a finish is price-NEUTRAL, which the note
 *  states once rather than repeating an identical price on every plate. */
function FinishPlates({ locale, spec, current, onPick }) {
  const options = spec?.options || [];
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-thin px-2 pb-2">
        <div className="grid grid-cols-2 gap-1.5 px-0.5 pt-1 pb-2">
          {options.map((o) => {
            // A palette ALWAYS reads as something: the pick, else the spec's
            // default — the same answer the row and the 3D material take.
            const active = current ? current === o.id : (spec?.default ? spec.default === o.id : false);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onPick?.(o.id)}
                aria-pressed={active}
                title={o.label}
                className={`relative block w-full overflow-hidden rounded-lg border text-left transition active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  active
                    ? 'border-brand-400 ring-2 ring-brand-400'
                    : 'border-ink-100 hover:border-brand-300 hover:shadow-sm'
                }`}
              >
                <span className="block aspect-[4/3] w-full bg-ink-50" style={{ background: o.rgb || undefined }} aria-hidden />
                <span className="block truncate px-1.5 pt-1 pb-1.5 text-micro font-medium leading-tight text-ink-800">{o.label}</span>
                {active && (
                  <span className="absolute right-1 top-1 grid place-items-center w-[18px] h-[18px] rounded-full bg-brand-600 text-white shadow-sm pointer-events-none">
                    <Check size={11} strokeWidth={3} aria-hidden />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <p className="shrink-0 px-3 pb-3 pt-1 text-micro leading-snug text-ink-500">{t(locale, 'parts.finishNeutral')}</p>
    </div>
  );
}

/** THE "TU DISEÑO" pane — the ONE inspector, worn in two shells (see the shell
 *  constants above): the desktop right column, and the phone's Resumen drawer.
 *  Every placed piece as a row (thumbnail rendered in ITS chosen fabric, name,
 *  fabric line, price); a row click selects the piece on the plan and expands
 *  into the per-piece controls (fabric chip, per-part picks, mode switch,
 *  duplicate/delete); the footer is the live estimate + the quote CTA. One calm
 *  place instead of chrome appearing and vanishing over the canvas — shown in
 *  both views; the fabric-pick chips work from 3D exactly like the 3D hover
 *  chip does. `onClose` (phone shell only) adds the drawer's ✕. */
function DesignPane({
  placed, resolvedById, models = [], selectedUid, onSelectRow, renderThumbById = {},
  locale, fmt, fromMode = false, pricesHidden = false, pricedUsd = 0, animatedUsd = 0, pendingFabric = 0,
  unpriced = 0,
  overallCm, selectedFamily = null, partsOpenUid = null, waiting = null,
  onFixPending, onFabricAll, onQuote, onPickFabricFor, onClearFabric,
  onPickPartFor, onClearPartFor, onPickFinishFor, onClearFinishFor, onTogglePartsFor, onSwitchMode, showModeSwitch = true, onDuplicate, onDelete,
  shellClassName = DESIGN_PANE_SHELL, onClose = null,
}) {
  const modelById = useMemo(() => Object.fromEntries(models.map((m) => [m.id, m])), [models]);
  const rows = placed.map((p) => ({ p, r: resolvePlacement(p, resolvedById) }));
  // Each fabricked row renders in its CHOSEN fabric (same session-cached
  // offscreen rig the Resumen sheet uses), so the pane mirrors the plan.
  const fabricRows = rows.filter(({ p }) => p.material?.code).map(({ p, r }) => ({
    key: p.uid, code: p.material.code,
    model: modelById[p.pieceId] || { id: p.pieceId, widthCm: r.widthCm, depthCm: r.depthCm, name: r.label },
  }));
  // ROW_THUMB: these land in a 48px square. The row re-renders on every fabric
  // change — the one thing a customer does over and over — so it is the last
  // place to be spending a full-frame render.
  const fabricThumbs = useConfiguratorFabricThumbs(fabricRows, ROW_THUMB);
  // A selection now UNFOLDS its row into the whole personalization panel, which
  // only helps if the row is on screen: a piece tapped in the 3D stage lands
  // wherever it happens to sit in this list, and on a long build that is below
  // the fold — the panel would open where nobody is looking. `nearest` moves the
  // list the minimum (an already-visible row doesn't budge). It re-runs on the
  // OPEN state too, because unfolding is itself what can push the row past the
  // bottom edge, and the parent's auto-open lands one commit after the
  // selection (parent effects run after this child's).
  const selRowRef = useRef(null);
  useEffect(() => {
    if (selectedUid == null) return;
    selRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedUid, partsOpenUid]);
  return (
    <aside
      aria-label={t(locale, 'panel.design')}
      className={shellClassName}
    >
      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <span className="eyebrow">{t(locale, 'panel.design')}</span>
        <div className="flex items-center gap-2">
          <span className="text-micro text-ink-500 tabular-nums">{piecesLabel(locale, rows.length)}</span>
          {/* Only the phone drawer gets a close: on desktop this pane IS the
              workspace's right column and has nothing to close back to. */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t(locale, 'common.close')}
              className="grid place-items-center w-8 h-8 -mr-1 rounded-full text-ink-500 hover:bg-ink-100/70 active:scale-95 transition"
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin px-2 pb-2 flex flex-col gap-1.5">
        {rows.map(({ p, r }) => {
          const sel = p.uid === selectedUid;
          // Base + its tagged parts at their grades — the same roll-up the
          // quote line carries, so both shells of this pane price alike.
          const rowUsd = placementTotalUsd(p, resolvedById);
          // DRESSED, either way — one cloth over the whole piece, or every
          // componente carrying its own. The row used to read `p.material`
          // alone, so a build dressed componente by componente printed «Elegir
          // tela» over a piece that had no undressed surface left, and its
          // price stayed the grey «Desde» sticker while the estimate counted
          // it as zero.
          const rowDressed = placementDressed(p, resolvedById);
          // The rail is open on THIS row's piece (or on one of its parts): its
          // pill wears the active treatment for as long as the pick is pending,
          // so "what am I dressing" and "where do I pick" read as one gesture.
          const waitPiece = waiting?.kind === 'piece' && waiting.uid === p.uid;
          const waitRole = waiting?.kind === 'part' && waiting.uid === p.uid ? waiting.role : null;
          // …and the estructura's own half of the same link (the rail is open
          // on THIS group's palette).
          const waitGroup = waiting?.kind === 'finish' && waiting.uid === p.uid ? waiting.group : null;
          const priceTxt = pricesHidden ? null : (rowDressed && rowUsd != null
            ? fmt(rowUsd, { from: fromMode })
            : (rowUsd != null ? fmt(rowUsd, { from: true })?.replace(/\.\d\d$/, '') : null));
          return (
            <div key={p.uid} ref={sel ? selRowRef : null} className={`shrink-0 rounded-xl border transition ${sel ? 'border-brand-300 bg-brand-50/50 ring-1 ring-brand-200' : 'border-ink-100 hover:bg-ink-50 hover:border-ink-200'}`}>
              <button type="button" onClick={() => onSelectRow?.(p.uid)} className="w-full flex items-center gap-2.5 p-2 text-left">
                <ModelThumb id={p.uid} render={{ [p.uid]: fabricThumbs[p.uid] || renderThumbById[p.pieceId] }} alt="" className="shrink-0 w-12 h-12 rounded-lg bg-ink-50/60" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink-800 leading-tight">{r.label}</span>
                  <span className={`block truncate text-micro mt-0.5 ${rowDressed ? 'text-ink-600' : 'text-ink-900'}`}>
                    {p.material?.fabric
                      || (rowDressed ? t(locale, 'fabric.byComponents') : t(locale, 'fabric.choose'))}
                  </span>
                </span>
                {priceTxt && (
                  <span className={`shrink-0 tabular-nums ${rowDressed ? 'text-sm text-ink-900' : 'text-micro text-ink-500'}`}>{priceTxt}</span>
                )}
                {/* Dressed but unpriceable — a part is wearing cloth its own SKU
                    ladder doesn't sell (placementTotalUsd → null). The row used
                    to render NOTHING there, which reads as a piece still waiting
                    for a fabric it already has; it says so instead. */}
                {!pricesHidden && !priceTxt && rowDressed && rowUsd == null && (
                  <span className="shrink-0 text-micro text-ink-500">{t(locale, 'summary.noPrice')}</span>
                )}
              </button>
              {sel && (
                /* ── THE PANEL, WHOLE, ON SELECTION ─────────────────────────
                   Two levels in one breath, in the order the money rule reads
                   them: FIRST the piece dressed as one thing (the elemento
                   completo — the cheaper answer and the default), THEN what it
                   is made of. Both were here before; what changed is that the
                   second level no longer waits behind a disclosure the visitor
                   had to find. The two used to be sibling `sel` blocks — one
                   block now, so the level order is structural. */
                <div className="px-2 pb-2 flex flex-col gap-1.5 configurator-rise">
                  {/* SKU BASE — present ONLY in modo pieza. Switched to
                      componentes, the piece's own tela is not what is being
                      bought, so it leaves the screen rather than sitting there
                      as a control that changes no money. */}
                  {componentViewOf(p) && (
                  <div className="flex items-center justify-end">
                    <button type="button" onClick={onDelete} className="btn-icon-danger" title={t(locale, 'piece.remove')} aria-label={t(locale, 'piece.remove')}><Trash2 size={15} /></button>
                  </div>
                  )}
                  {!componentViewOf(p) && (
                  <div className="flex flex-col gap-1">
                    {/* SCOPE FIRST. The swatch alone reads as "a fabric,
                        somewhere on this piece"; named, it reads as "dress the
                        COMPLETE piece" — which is precisely what it does, and
                        what separates it from the part rows below. Same words
                        the material rail's header and the phone's picker title
                        use for this exact target. */}
                    <span className="eyebrow">{t(locale, 'parts.wholePiece')}</span>
                    <div className="flex items-center gap-1">
                      {p.material ? (
                        /* Waiting on this piece ⇒ the SAME element goes active
                           (tinted + a firmer border and ring) — the treatment
                           the pane already uses for its selected row, one step
                           up so it still reads on top of it. */
                        <div className={`min-w-0 inline-flex items-stretch rounded-full border overflow-hidden transition ${waitPiece ? 'border-brand-400 bg-brand-50 ring-1 ring-brand-300' : 'border-ink-200/80 bg-surface/70'}`}>
                          <button type="button" onClick={() => onPickFabricFor?.(p.uid)} title={t(locale, 'fabric.change')} className="min-w-0 inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 hover:bg-ink-100/60 active:bg-ink-100 transition">
                            {p.material.code
                              ? <ImageView id={null} fallbackUrl={swatchTileUrl(p.material.code, SWATCH_PX.pill)} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                              : <span className="w-5 h-5 rounded-full bg-ink-100 grid place-items-center shrink-0"><Palette size={11} className="text-ink-500" aria-hidden /></span>}
                            <span className="min-w-0 truncate text-micro font-medium text-ink-700">{p.material.fabric || t(locale, 'fabric.generic')}</span>
                            <Pencil size={11} className="shrink-0 text-ink-500" aria-hidden />
                          </button>
                          <button type="button" onClick={onClearFabric} title={t(locale, 'fabric.remove')} aria-label={t(locale, 'fabric.remove')} className="shrink-0 inline-flex items-center px-1.5 border-l border-ink-200/70 text-ink-500 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition">
                            <X size={11} aria-hidden />
                          </button>
                        </div>
                      ) : selectedFamily ? (
                        <button type="button" onClick={() => onPickFabricFor?.(p.uid)} className={`inline-flex items-center gap-1.5 rounded-full border text-brand-700 pl-2 pr-2.5 py-1 text-micro font-medium hover:bg-brand-100 hover:border-brand-300 active:scale-95 transition ${waitPiece ? 'bg-brand-100 border-brand-400 ring-1 ring-brand-300' : 'bg-brand-50 border-brand-200'}`}>
                          <Palette size={12} aria-hidden /> {t(locale, 'fabric.choose')}
                        </button>
                      ) : (
                        <span className="text-micro text-ink-500 px-1">{t(locale, 'fabric.noOptions')}</span>
                      )}
                      <div className="flex-1" />
                      <button type="button" onClick={onDuplicate} className="btn-icon" title={t(locale, 'piece.duplicate')} aria-label={t(locale, 'piece.duplicate')}><CopyPlus size={15} /></button>
                      <button type="button" onClick={onDelete} className="btn-icon-danger" title={t(locale, 'piece.remove')} aria-label={t(locale, 'piece.remove')}><Trash2 size={15} /></button>
                    </div>
                  </div>
                  )}
                  {/* The per-part hierarchy (see PartsSection's own doc). In
                      modo pieza the componentes are «Incluido» and there is
                      nothing to choose, so the section is off — the switch
                      above is the way to them. */}
                  <PartsSection
                    piece={p} r={r} locale={locale}
                    open={partsOpenUid === p.uid} onToggle={() => onTogglePartsFor?.(p.uid)}
                    waitingRole={waitRole}
                    waitingGroup={waitGroup}
                    onPickPart={(role) => onPickPartFor?.(p.uid, role)}
                    onClearPart={(role) => onClearPartFor?.(p.uid, role)}
                    onPickFinish={(groupKey) => onPickFinishFor?.(p.uid, groupKey)}
                    onClearFinish={(groupKey) => onClearFinishFor?.(p.uid, groupKey)}
                  />
                  {/* WHICH OF THE TWO WAYS this piece is sold — BELOW the list
                      it governs (owner: «debajo del material list»): the list
                      is what you came to read, the switch is how you change
                      what it is made of. Suppressed while the componentes rail
                      is up, because the rail is carrying it there. */}
                  {showModeSwitch && (
                  <ModeSwitch
                    piece={p} r={r} resolvedById={resolvedById}
                    locale={locale} fmt={fmt} fromMode={fromMode} pricesHidden={pricesHidden}
                    onSwitch={(mode) => onSwitchMode?.(p.uid, mode)}
                  />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-ink-200/70 px-3 py-3 flex flex-col gap-2">
        {!pricesHidden && pendingFabric > 0 && pricedUsd > 0 && (
          <button type="button" onClick={onFixPending} className="self-start inline-flex items-center gap-0.5 border border-ink-900 text-ink-900 px-1.5 py-0.5 text-micro tracking-wide hover:bg-ink-900 hover:text-white transition-colors">
            {t(locale, 'estimate.pendingFabric', { count: pendingFabric })} <ArrowRight size={10} aria-hidden />
          </button>
        )}
        {/* No total to state: a piece is dressed in cloth its own SKU ladder
            doesn't sell, so the figure would be short by whatever it is worth.
            The row above names which piece. */}
        {!pricesHidden && unpriced > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-micro text-ink-500">{t(locale, 'estimate.label')}</span>
            <span className="text-xl font-display font-semibold tracking-tight leading-none text-ink-500">{t(locale, 'summary.noPrice')}</span>
          </div>
        )}
        {!pricesHidden && unpriced === 0 && (pricedUsd > 0 ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-micro text-ink-500">{t(locale, 'estimate.label')}</span>
            {/* Keyed by the TARGET price: a reprice replays the score-pop, same as the deck. */}
            <span key={Math.round(pricedUsd)} className="configurator-score text-xl font-display font-semibold tabular-nums tracking-tight leading-none">{fmt(Math.round(animatedUsd), { from: fromMode })}</span>
          </div>
        ) : (
          /* The third target the rail can wait on: no piece selected, one
             cloth for the whole design. Same active treatment as the per-piece
             pills — one visual language for "we're waiting on you here". */
          <button type="button" onClick={onFabricAll} className={`self-start inline-flex items-center gap-1.5 rounded-full border text-brand-700 px-3 py-1 text-sm font-medium hover:bg-brand-100 hover:border-brand-300 active:scale-95 transition ${waiting?.kind === 'all' ? 'bg-brand-100 border-brand-400 ring-1 ring-brand-300' : 'bg-brand-50 border-brand-200'}`}>
            <Palette size={13} className="shrink-0" aria-hidden /> {t(locale, 'estimate.chooseFabricAll')}
          </button>
        ))}
        {overallCm?.widthCm > 0 && (
          <span className="text-micro text-ink-500 tabular-nums">{t(locale, 'dims.set', { w: overallCm.widthCm, d: overallCm.depthCm })}</span>
        )}
        <button type="button" onClick={onQuote} className="btn-brand text-sm w-full justify-center">
          {t(locale, 'estimate.cta')} <ArrowRight size={15} />
        </button>
      </div>
    </aside>
  );
}

/**
 * The parts a piece ACTUALLY has, in display order — the step-3 list.
 *
 * TWO kinds and only these: a bound COMPONENTE (its own shared SKU — cushions,
 * bolsters, arm cushions) and a materialization ZONE the model is tagged with
 * (the ottomans' exterior/interior, which re-grade the base SKU rather than
 * billing). A piece with neither never reaches step 2 through this list, which
 * is the whole ottoman complaint: the flat chip row it replaces offered parts
 * that piece does not have.
 *
 * These are the same two tests `openPartMaterial` gates a raycast tap on, so
 * the list and the tap can never disagree about what is editable.
 */
/**
 * EVERYTHING ONE PIECE WEARS, as one flat list — the left rail's swatch strip.
 *
 * Owner, 2026-08-02: «left rail shows swatches of all materials shown on the
 * piece being hovered or selected … when that material is hovered, the swatch
 * shows that with some feedback, and when selected gets selected as well with
 * the same type of highlight», and «material picker and outline are subject to
 * the swatch selected at any given moment». So the strip is not decoration: it
 * is the PART SELECTOR. Picking a swatch is what sets the picker's target and
 * therefore the gold outline, because both already read `focusPart`, which is
 * derived from that target — one fact, three renderings.
 *
 * One entry per thing that can be dressed, in the order the piece reads:
 * its own cloth, then each componente, then each estructura. A componente with
 * no pick of its own INHERITS the piece's cloth (`inherited`), which the strip
 * says rather than implying by showing the same swatch twice with no
 * explanation. An estructura wears a COLOUR, never a photo.
 *
 * Keys are `role` for cloth and `structure:<group>` for an acabado — the same
 * pair `openPartMaterial` takes, so a click needs no translation table.
 */
function pieceSwatchEntries(piece, r, locale, componentView = false) {
  if (!piece || !r) return [];
  // THE SAME EXCLUSION the panel keeps: componentes ON ⇒ no «tela de toda la
  // pieza» chip (that SKU is not being sold), componentes OFF ⇒ no componente
  // chips (that one SKU bought them). A rail offering both would be offering a
  // build the money rule has no price for. WHICH side is on is the caller's
  // question, answered by the Model (`componentViewOf`) — mode, or a live
  // componente target — never re-derived here.
  const byParts = componentView;
  const out = byParts ? [] : [{
    key: 'base',
    role: 'base',
    groupKey: null,
    label: t(locale, 'parts.wholePiece'),
    // The rail is 5.5rem of column: it shows the short name and keeps the long
    // one as the chip's title/aria. Every other entry is already short (a
    // dealer's own «Cojín», «Rulo», «Estructura»), so only this one needs it.
    shortLabel: t(locale, 'parts.wholePieceShort'),
    code: piece.material?.code || '',
    fabric: piece.material?.fabric || t(locale, 'fabric.none'),
    inherited: false,
    color: null,
  }];
  for (const role of (byParts ? dressableRoles(r) : [])) {
    const pick = effectivePartMaterials(piece)?.[role] || null;
    out.push({
      key: role,
      role,
      groupKey: null,
      label: roleLabelOf(r?.parts, role, t(locale, `part.${role}`)),
      code: pick?.code || piece.material?.code || '',
      fabric: pick?.fabric || piece.material?.fabric || t(locale, 'fabric.none'),
      inherited: !pick,
      color: null,
    });
  }
  for (const g of structureGroupsOf(r?.parts)) {
    const opt = finishOptionOf(g.spec, piece.partFinishes?.[g.group]);
    out.push({
      key: `structure:${g.group}`,
      role: 'structure',
      groupKey: g.group,
      label: partLabelOf(r?.parts, g.group, g.spec?.label || t(locale, 'part.structure')),
      code: '',
      fabric: opt?.label || t(locale, 'part.finish'),
      inherited: false,
      color: opt?.rgb || null,
    });
  }
  return out;
}

/**
 * THE HOVER PREVIEW's CONTENT — what the one card says about whatever the
 * pointer is on. Pure: the caller decides WHERE it goes (docked in the picker's
 * footer, or floating at the bottom of that same column with the picker shut),
 * this decides only WHAT it says. Null ⇒ nothing is being pointed at.
 *
 * ONE preview, and it belongs to the POINTER: no selection fallback (owner,
 * 2026-08-02 «we have only one preview modal») — the card pops out while you
 * are pointing at something and is gone otherwise.
 *
 * A COMPONENTES CHIP IS A POINTER TOO, and a deliberate one — it names the part
 * it points at — so it outranks the ray and, unlike the ray, it answers with
 * the picker open: that is the whole point of the rail, and it is still ONE
 * card, because the pointer cannot be on a chip and on a swatch at once.
 * `base` is the piece itself, which is what the card's own role vocabulary
 * already calls it.
 *
 * THE CARD FOLLOWS THE PIPETTE (owner, 2026-08-01): a COMMITTED picker target
 * outranks a transient hover on ITS OWN piece — the precedence the glow already
 * states — so while the picker is open on the cojines the card IS the cojines'
 * card. `dressable` is not a part, so it keeps the piece-level card, and a
 * hover on a DIFFERENT piece is still that piece's own card.
 */
function hoverPreviewFor({ railHover, selectedUid, chipHover, chipFocus, placed, resolvedById, locale }) {
  const hovered = railHover && selectedUid != null
    ? {
      uid: selectedUid,
      partRole: railHover.role === DRESSABLE_ROLE ? 'base' : railHover.role,
      partKey: railHover.groupKey || null,
    }
    : chipHover;
  if (!hovered) return null;
  const p = (placed || []).find((row) => row.uid === hovered.uid);
  if (!p) return null;
  const r = resolvePlacement(p, resolvedById);
  // DENTRO DE LA PIEZA, EL PUNTERO MANDA (dueño, 2026-08-05: «within a selected
  // product exhibit this behavior»). Un hover que NOMBRA una parte — el cojín,
  // un rulo, una estructura — gana al objetivo comprometido del picker: la
  // tarjeta habla de lo que estás mirando, que es su único trabajo. La
  // precedencia contraria (2026-08-01) se escribió cuando el hover se pintaba
  // igual que la selección y dos partes encendidas se leían como dos
  // selecciones; el trazo SUAVE ya las distingue por peso, así que el objetivo
  // comprometido no necesita silenciar al puntero para seguir siendo legible.
  // Barrer el CUERPO con el picker abierto sí cede a lo comprometido: ahí el
  // puntero no nombra nada más preciso que la pieza entera.
  const namesPart = !!hovered.partRole && !isWholePieceRole(p, r, hovered.partRole);
  const target = chipFocus && hovered.uid === chipFocus.uid && !namesPart
    ? { ...hovered, partRole: chipFocus.role, partKey: chipFocus.groupKey || null }
    : hovered;
  // ESTRUCTURA FIRST — the ray (or the open finish rail) is on metal, not on
  // cloth. The card used to collapse a structure hover to the whole PIECE (its
  // role has no `partFamilies` entry, by design — a finish binds no SKU), so
  // hovering the legs offered «Cambiar tela». Resolved through the Model, so
  // the card, the mesh tap and the pipette all name the very same group.
  const finish = target.partRole === 'structure'
    ? structureGroupFor(r?.parts, target.partKey || null)
    : null;
  // The card names the part under the ray whether or not the piece is dressed —
  // the same un-gating `openPartMaterial` applies to the tap it fires (they must
  // agree, or the card offers one thing and its button opens another). Which is
  // why the test is `dressableRoles`, the very list both of them read: gating on
  // `partFamilies` alone dropped the materialization ZONES (an ottoman's
  // interior/exterior bind no family BY DESIGN — they re-grade the base SKU), so
  // the card collapsed to the piece for a part the tap happily opens.
  // ¿La tarjeta habla de la PIEZA o de un componente? `'base'` puede ser
  // cualquiera de las dos (isWholePieceRole), así que se decide una vez aquí y
  // todo lo de abajo lee ESE booleano — comparar contra el string otra vez es
  // justo como el componente Base acabó enseñando la tela de la pieza.
  const asPiece = !finish && (
    isWholePieceRole(p, r, target.partRole)
    || !target.partRole
    || !dressableRoles(r).includes(target.partRole)
  );
  const role = asPiece || finish ? 'base' : target.partRole;
  if (finish) {
    const opt = finishOptionOf(finish.spec, p.partFinishes?.[finish.group]);
    return {
      color: opt?.rgb || 'transparent',
      title: partLabelOf(r?.parts, finish.group, finish.spec.label || t(locale, 'part.structure')),
      meta: opt?.label || t(locale, 'part.finish'),
    };
  }
  const pick = asPiece ? (p.material || null) : (effectivePartMaterials(p)?.[role] || null);
  const code = pick?.code || (!asPiece ? p.material?.code : '') || '';
  return {
    base: code ? swatchTileUrl(code, SWATCH_PX.plate) : null,
    src: code ? swatchTileUrl(code, SWATCH_PX.preview) : null,
    fallback: code ? swatchTextureUrl(code, SWATCH_PX.preview) : null,
    title: !asPiece
      ? roleLabelOf(r?.parts, role, t(locale, `part.${role}`))
      : (r.label || t(locale, 'piece.generic')),
    // What it wears, and — when it wears it by INHERITANCE — that it does: a
    // fabric name alone is indistinguishable from a part that chose exactly
    // that cloth, so the card would read as a divergence the price is not
    // charging for.
    meta: [
      pick?.fabric || (!asPiece && p.material?.fabric) || t(locale, 'fabric.none'),
      !asPiece && !pick ? t(locale, 'parts.samePiece') : null,
    ].filter(Boolean).join(' \u00b7 '),
  };
}

/**
 * COMPONENTES — the piece's parts as a right-edge RAIL, and the part SELECTOR
 * the picker reads its target from.
 *
 * `activeKey` is the picker's committed target (the SELECTED chip) and
 * `hoverKey` is what the pointer is on IN THE 3D — the same treatment at two
 * strengths, so a hover reads as a preview of the selection it would become
 * rather than as a different kind of thing.
 *
 * THE OUTLINE IS THE 3D'S OWN GOLD, not a brand tint (owner, 2026-08). A chip
 * and the line it lights are ONE selection seen twice — the rail says which
 * part, the stage draws it on the mesh — and two different colours for that is
 * two selections on screen. `OUTLINE_GOLD` is literally ConfiguratorStage's stroke.
 *
 * BOTH GESTURES ANSWER, which is the whole reason the rail moved out of the
 * material pane: `onHover` previews a part (the stage's gold line follows, and
 * the preview card names it) and `onPick` commits it. The hover is released on
 * pointer-leave of the LIST, not of each chip, so sliding down the column is
 * one continuous read instead of a flicker between neighbours.
 */
/**
 * `docked` no cambia el componente, cambia su CONCHA (owner, 2026-08-05: «not
 * change the UIs, but change their layouts»). Los chips, sus estados y su
 * vocabulario de foco son los mismos; lo que cambia es dónde vive la columna:
 * FLOTANTE en escritorio (su propia tarjeta junto al picker) o ACOPLADA a la
 * derecha del muro de telas dentro de la hoja del teléfono. Vertical las dos —
 * probamos acostarla en la cabecera y cobraba una fila entera de alto en una
 * hoja de media pantalla, que es el eje escaso ahí. Una sola lista de
 * componentes en todo el widget: la alternativa era una segunda que mantener a
 * mano, y así es justo como el picker del teléfono se desincronizó del de
 * escritorio la vez pasada.
 */
function ComponentsRail({ entries, activeKey, hoverKey, onPick, onHover, locale, offsetLeft, modeSwitch = null, docked = false }) {
  if (!entries.length) return null;
  const Shell = docked ? 'div' : 'aside';
  return (
    <Shell
      aria-label={t(locale, 'parts.components')}
      /* Width from the SAME constant the stage's insetLeft and the rail's own
         offset read — a literal class here is a second copy that drifts.
         Acoplada conserva el ancho (los chips son los mismos) y no posiciona:
         la fila flex del cuerpo la coloca. */
      style={docked ? { width: `${COMPONENTS_RAIL_REM}rem` } : { left: offsetLeft, width: `${COMPONENTS_RAIL_REM}rem` }}
      className={docked
        ? 'shrink-0 border-l border-ink-200/70 flex flex-col overflow-hidden'
        : 'hud-panel hud-panel-solid configurator-rise absolute z-20 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] max-h-[calc(100%-max(0.75rem,env(safe-area-inset-top))-max(0.75rem,env(safe-area-inset-bottom))-3.25rem)] flex flex-col overflow-hidden'}
    >
      {/* No letter-spacing here: 0.08em is what pushed «COMPONENTES» past the
          edge. The eyebrow treatment survives in the case and the weight.
          Acoplada el título sobra: la columna vive bajo una cabecera que ya
          nombra la pieza, y ese renglón es alto de swatch en media pantalla. */}
      {!docked && (
        <span className="shrink-0 px-1 pt-2 pb-1.5 text-center text-micro uppercase leading-tight text-ink-500">
          {t(locale, 'parts.components')}
        </span>
      )}
      {/* EL CAMBIO DE MODO SE FUNDE, NO SALTA (dueño, 2026-08-05: «make the base
          SKU to component toggle smoother, right now it's too abrupt»). La
          `key` es el JUEGO de entradas, así que la lista se vuelve a montar
          — y se funde — exactamente cuando cambia LO QUE OFRECE: al girar el
          interruptor, o al pasar a una pieza de otro modelo. Elegir una tela no
          la toca (las claves son los roles, no lo que visten), que es lo que
          impide que el muro parpadee con cada pick. */}
      <div
        key={entries.map((e) => e.key).join('|')}
        className={`flex-1 min-h-0 overflow-y-auto scroll-thin px-1.5 flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-1 duration-200 ${docked ? 'pt-2 pb-2' : 'pb-2'}`}
        onMouseLeave={() => onHover?.(null)}
      >
        {entries.map((e) => {
          const active = e.key === activeKey;
          const hot = !active && e.key === hoverKey;
          return (
            <button
              key={e.key}
              type="button"
              onClick={() => onPick(e)}
              onMouseEnter={() => onHover?.(e)}
              onFocus={() => onHover?.(e)}
              aria-pressed={active}
              title={`${e.label} · ${e.fabric}`}
              className={`relative w-full shrink-0 rounded-lg border p-0.5 text-left transition active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active || hot ? '' : 'border-ink-100'
              }`}
              /* Inline, off the imported constant, rather than a Tailwind
                 arbitrary value: the hex then exists ONCE, in the stage that
                 strokes it, instead of being retyped here where a drift would
                 be invisible until the two are seen side by side. */
              style={active
                ? { borderColor: OUTLINE_GOLD, boxShadow: `0 0 0 2px ${OUTLINE_GOLD}` }
                : hot
                  ? { borderColor: `${OUTLINE_GOLD}b3`, boxShadow: `0 0 0 2px ${OUTLINE_GOLD}59` }
                  : undefined}
            >
              <span className="relative block aspect-square w-full overflow-hidden rounded-md bg-ink-50">
                {e.color
                  ? <span className="absolute inset-0 block" style={{ background: e.color }} aria-hidden />
                  : e.code
                    ? <img src={swatchTileUrl(e.code, SWATCH_PX.strip)} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                    : <span className="absolute inset-0 grid place-items-center" aria-hidden><Palette size={14} className="text-ink-400" /></span>}
              </span>
              <span className="mt-0.5 block truncate text-center text-micro leading-tight text-ink-600">{e.shortLabel || e.label}</span>
            </button>
          );
        })}
      </div>
      {/* THE MODE, under the list it decides the contents of (owner pointed the
          arrow here): these chips ARE the componentes, so the switch that turns
          them on and off belongs at their foot, not across the workspace in the
          design pane. Acostada la fila, «al pie» es el extremo derecho — mismo
          sitio relativo, eje girado. */}
      {modeSwitch && (
        <div className="shrink-0 border-t border-ink-200/70 px-1.5 py-2 grid place-items-center">
          {modeSwitch}
        </div>
      )}
    </Shell>
  );
}

/**
 * What a part is WEARING, or null when it rides the piece's own cloth.
 *
 * An explicit pick of the very SAME fabric is not a divergence: the money rule
 * compares fabric CODES (`resolveCompleteSku`), so one cloth is one element
 * however it was arrived at — and a row that reads "different" while the price
 * says "same" is the kind of disagreement this whole screen exists to remove.
 * Which also makes it self-healing: re-dressing the PIECE turns that stored
 * pick into a real divergence, and the row lights up with its own fabric and a
 * way back on the very next render.
 */
function partDivergence(piece, role) {
  const pick = effectivePartMaterials(piece)?.[role] || null;
  if (!pick) return null;
  const own = String(pick.code || '').trim();
  const base = String(piece?.material?.code || '').trim();
  return own && base && own === base ? null : pick;
}

/**
 * ── THE PIECE → PARTES HIERARCHY, the one component both surfaces render ──
 *
 * The base fabric was being offered as a SIBLING of the cushions: a flat row of
 * equal chips beside the piece's own fabric control (owner, 2026-07-31 — «it
 * doesn't make sense for me to be able to choose a base and the cushions and the
 * arm cushions … we need a better hierarchical way»). But the base is not a peer
 * of the cushions, it is the WHOLE PIECE, and they are parts of it. That is not
 * a new idea to invent either: it is the shipped money rule made visible
 * (`resolveCompleteSku`) — one material for everything bills on the model's own
 * SKU alone (the CHEAPER answer, and the default), any part in a different
 * material bills base + each componente (dearer).
 *
 * So the ladder reads:
 *   1. the piece's own fabric — the control above this one, and until it is
 *      picked this component renders NOTHING for cloth (see the guard);
 *   2. one subordinate «Personalizar por partes» line, small and muted, only on
 *      a piece that HAS parts or structure groups — OPEN on selection (the
 *      panel presents itself), so it is the manual COLLAPSE, not the door;
 *   3. the parts themselves, one row each, each saying what it wears — «Igual
 *      que la pieza» until it diverges — with a pipette in and a way back out.
 *
 * Rendered by DesignPane in BOTH its shells (desktop pane + phone drawer) from
 * this one definition, so the two anchorings cannot drift into different shapes
 * of the same idea.
 */
/**
 * ── EL TOGGLE: SKU base ⇄ componentes ──────────────────────────────────────
 *
 * Owner, 2026-08: «cuando componentes está encendido, el SKU base está apagado,
 * y viceversa» — so the thing it switches is which half of the panel EXISTS,
 * not a preference. Showing both at once was the bug: it read as two things you
 * could have together, which is exactly what the money rule forbids.
 *
 * TWO ICONS, not words (owner: «un icono O y otro I|I»): the choice is about
 * SHAPE — one solid thing, or that thing split into its parts — and a glyph
 * says that faster than a label in four languages. `O` is the whole piece,
 * `I|I` the componentes. Drawn inline rather than pulled from the icon set so
 * the pair reads as ONE idea at 14px, which no two stock icons do.
 *
 * It sits BELOW the list it governs: the list is what you came to read, the
 * switch is how you change what it is made of.
 *
 * The other mode's price rides alongside — flipping is an informed choice, not
 * a leap. It comes from the SAME engine the quote will use (the switch asks it
 * the other mode's question, never a second formula).
 *
 * Only rendered when the model HAS componentes: with none there is one way to
 * sell the piece and a switch would be a question with one answer.
 */
const WHOLE_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <circle cx="12" cy="12" r="7.5" />
  </svg>
);
const PARTS_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M6 4.5v15M12 4.5v15M18 4.5v15" />
  </svg>
);

function ModeSwitch({ piece, r, resolvedById, locale, fmt, fromMode = false, pricesHidden = false, onSwitch, compact = false }) {
  if (!componentRoles(r).length) return null;
  const on = placementMode(piece) === 'parts';
  const otherUsd = pricesHidden
    ? null
    : placementTotalUsd({ ...piece, partsMode: !on }, resolvedById);
  const opt = (active, label, icon, mode) => (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => { if (!active) onSwitch?.(mode); }}
      className={`grid place-items-center w-7 h-6 rounded-full transition ${
        active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:text-ink-700 hover:bg-ink-100/70'
      }`}
    >
      {icon}
    </button>
  );
  const pair = (
    <div className="shrink-0 inline-flex items-center rounded-full border border-ink-200/80 bg-surface/70 p-0.5 gap-0.5">
      {opt(!on, t(locale, 'mode.whole'), WHOLE_ICON, 'complete')}
      {opt(on, t(locale, 'mode.parts'), PARTS_ICON, 'parts')}
    </div>
  );
  // COMPACT — the componentes rail is 4.5rem wide, so the caption cannot ride
  // along. The pair alone still says everything the switch is for; the mode
  // names live on as aria-label + tooltip, and the OTHER mode's price is the
  // one thing that has to go, because a truncated number is worse than none.
  if (compact) return pair;
  return (
    <div className="flex items-center gap-2">
      {pair}
      {/* What you are in, and what the other one costs — the whole reason the
          switch is worth looking at. */}
      <span className="min-w-0 flex-1 truncate text-micro leading-tight text-ink-500">
        <span className="text-ink-600">{on ? t(locale, 'mode.parts') : t(locale, 'mode.whole')}</span>
        {!pricesHidden && (
          <>
            {' · '}
            {on ? t(locale, 'mode.whole') : t(locale, 'mode.parts')}:{' '}
            {otherUsd != null ? fmt(otherUsd, { from: fromMode }) : t(locale, 'mode.pending')}
          </>
        )}
      </span>
    </div>
  );
}

function PartsSection({ piece, r, locale, open, onToggle, waitingRole = null, waitingGroup = null, onPickPart, onClearPart, onPickFinish, onClearFinish }) {
  const roles = dressableRoles(r);
  const structures = structureGroupsOf(r?.parts);
  // EVERYTHING THE PIECE CAN WEAR, AT ONCE (owner, 2026-08-01: «QUIERO QUE SE
  // DESPLIEGUE DE UNA VEZ QUE NO ME FORCE A ELEGIR COMPLETO»). The cloth rows
  // used to appear only once the piece had its own fabric — step 1 owning the
  // screen — which read as the panel being broken on the piece you had just
  // placed. The hierarchy it was protecting is real but it is the MONEY's rule,
  // not a sequencing one: it is already stated by the consequence line below
  // and by the piece staying «pendiente» for its own cloth. So the rows are
  // live from the start, and «Igual que la pieza» simply names a cloth that
  // hasn't been chosen yet.
  // ON ⇒ the componentes are what is being bought and each one is choosable;
  // OFF ⇒ the piece's own SKU bought them, so there is nothing to choose here
  // and the rows are gone. «ON» is the Model's call (`componentViewOf`), and it
  // is the MODE alone — pointing at a componente no longer opens these rows
  // behind the pointer (owner, 2026-08-05). The ESTRUCTURA is not part of that
  // switch: it wears a FINISH, price-neutral in either mode, so it stays on
  // screen throughout.
  const fabricRoles = componentViewOf(piece) ? roles : [];
  // A piece with neither parts nor structure never shows step 2 at all — by
  // construction, not by copy.
  if (!fabricRoles.length && !structures.length) return null;
  // Only BILLED componentes can push the piece onto the dearer path; a zone
  // re-grades the piece's own SKU and a finish is price-neutral, so neither
  // counts here.
  const diverged = fabricRoles.filter((role) => r?.partFamilies?.[role] && partDivergence(piece, role));
  const rowBtn = 'min-w-0 w-full inline-flex items-center gap-1.5 rounded-lg pl-1 pr-1.5 py-1 text-left hover:bg-ink-100/60 active:bg-ink-100 transition group';
  const rowName = 'min-w-0 shrink-0 max-w-[7rem] truncate text-micro font-medium text-ink-700';
  // ── THE WAY BACK, AS A CONTROL ────────────────────────────────────────────
  // Owner, 2026-08-01: «I need the ability to delete the components so that they
  // go back to being a part of the base». It EXISTED — but as a bare 24-px glyph
  // in the row's dimmest ink, which reads as decoration next to a lit pipette,
  // and on touch there is no hover to reveal what it does. So it wears a control
  // at rest (its own bordered chip, on its own plate) and turns RED on
  // hover/press — the same "this removes something" register as the piece
  // fabric's × tail above it. Never hover-ONLY: the row's pick is the whole
  // reason the button is there, so it is visible from the moment there is one.
  const undoBtn = 'shrink-0 grid place-items-center w-7 h-7 rounded-full border border-ink-200/80 bg-surface/70 text-ink-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 active:scale-95 transition';
  return (
    /* Indented under a hairline: the level is a CHILD of the piece's fabric
       control, and it has to look like one before it is read. */
    <div className="mt-1 ml-0.5 pl-2 border-l border-ink-200/70 flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!!open}
        className="self-start inline-flex items-center gap-1 py-0.5 text-micro text-ink-500 hover:text-ink-900 transition-colors"
      >
        <Pipette size={11} className="shrink-0" aria-hidden />
        <span>{t(locale, 'parts.customize')}</span>
        {/* Collapsing must never HIDE a divergence — it is what makes the piece
            dearer — so the count rides the closed disclosure, and the
            consequence line below stays out here with it. */}
        {diverged.length > 0 && <span className="tabular-nums font-semibold text-ink-900">· {diverged.length}</span>}
        <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && fabricRoles.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {/* COMPONENTES — the cloth parts, named as a kind. The estructura
              block below has carried its own eyebrow from the start, so the
              fabric rows above it read as the unnamed default rather than as
              the other half of a pair. Two kinds, two headings: what wears
              cloth, and what wears an acabado. */}
          <span className="eyebrow">{t(locale, 'parts.components')}</span>
          <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
            {fabricRoles.map((role) => {
              const pick = partDivergence(piece, role);
              const name = roleLabelOf(r?.parts, role, t(locale, `part.${role}`));
              // Inheriting ⇒ show the PIECE's own swatch, dimmed: "igual que la
              // pieza" is a statement about cloth, and the cloth is right there —
              // or not yet there at all, on a piece nobody has dressed, which is
              // the palette glyph below rather than a crash.
              const code = pick?.code || piece.material?.code || '';
              // The rail is open on THIS part (a mesh tap or this very row put it
              // there) — the row stays lit until the pick lands, so the catalog on
              // the left and the thing it is dressing are visibly the same act.
              // Null on the phone, where the picker is a full-screen sheet.
              const waiting = role === waitingRole;
              return (
                <li key={role} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onPickPart?.(role)}
                    title={t(locale, 'chip.pickFabricFor', { name })}
                    aria-label={t(locale, 'chip.pickFabricFor', { name })}
                    className={`${rowBtn}${waiting ? ' bg-brand-50 ring-1 ring-brand-300' : ''}`}
                  >
                    {code
                      ? <ImageView id={null} fallbackUrl={swatchTileUrl(code, SWATCH_PX.row)} alt="" className={`w-4 h-4 rounded-full object-cover shrink-0${pick ? '' : ' opacity-50'}`} />
                      : <span className="w-4 h-4 rounded-full bg-ink-100 grid place-items-center shrink-0"><Palette size={9} className="text-ink-500" aria-hidden /></span>}
                    <span className={rowName}>{name}</span>
                    <span className={`min-w-0 flex-1 truncate text-micro ${pick ? 'text-ink-600' : 'text-ink-500'}`}>
                      {pick?.fabric || t(locale, 'parts.samePiece')}
                    </span>
                    {/* The pipette IS the "pick one" verb — lit while that pick
                        is the one outstanding. */}
                    <Pipette size={11} className={`shrink-0 transition-colors ${waiting ? 'text-brand-700' : 'text-ink-400 group-hover:text-ink-600'}`} aria-hidden />
                  </button>
                  {pick && (
                    <button
                      type="button"
                      onClick={() => onClearPart?.(role)}
                      title={t(locale, 'parts.useSamePiece')}
                      aria-label={t(locale, 'parts.useSamePiece')}
                      className={undoBtn}
                    >
                      <Undo size={12} aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── ESTRUCTURA — its own group, on purpose ──────────────────────────
           Metal and lacquer are not upholstery: same piece, same SKU, same
           price whichever the client picks. Keeping it visually apart from the
           fabric rows is how that difference gets read — a finish never enters
           `diverged` and never earns the "por partes" line. Until now the only
           door to it was tapping the legs in 3D, which a customer has to guess
           (owner: «make sure that in the configurator, I can choose the
           structure material as well»); the rows open the SAME picker that tap
           does. Apart in MEANING, identical in SHAPE: same row, same pipette,
           same lit-while-waiting treatment as the cloth rows above (owner,
           2026-08-01: «QUIERO QUE ELEGIR LA ESTRUCTURA SEA IGUAL QUE LOS
           COMPONENTES CON EL PIPETTE») — a chevron said "drills into a list"
           for what is the very same "pick one" verb. */}
      {open && structures.length > 0 && (
        <div className={`flex flex-col gap-0.5${fabricRoles.length ? ' mt-1 pt-1.5 border-t border-dashed border-ink-200/70' : ''}`}>
          <span className="eyebrow">{t(locale, 'part.structure')}</span>
          {structures.map(({ group, spec }) => {
            const name = partLabelOf(r?.parts, group, spec.label || t(locale, 'part.structure'));
            // A palette ALWAYS answers with something (the pick, else the
            // default, else the first): a leg with no named finish would read
            // as a broken model, not as "no pick".
            const opt = finishOptionOf(spec, piece.partFinishes?.[group]);
            // …which is exactly what makes the way back well-defined here:
            // dropping `partFinishes[group]` re-resolves through that same
            // ladder to the COLECCIÓN's own acabado, so a reset restores what
            // the piece shipped wearing rather than blanking it. Offered only
            // on a pick that actually DIFFERS from it — an explicit choice of
            // the default is not a divergence (the `partDivergence` rule, one
            // axis over), and a row whose reset would change nothing on screen
            // is a button that reads as broken.
            const fallback = finishOptionOf(spec, null);
            const picked = piece.partFinishes?.[group] != null && !!opt && !!fallback && opt.id !== fallback.id;
            const waiting = group === waitingGroup;
            return (
              <div key={group} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPickFinish?.(group)}
                  title={t(locale, 'parts.pickFinish', { name })}
                  aria-label={t(locale, 'parts.pickFinish', { name })}
                  className={`${rowBtn}${waiting ? ' bg-brand-50 ring-1 ring-brand-300' : ''}`}
                >
                  <span className="w-4 h-4 rounded-full border border-ink-200/70 shrink-0" style={{ background: opt?.rgb || 'transparent' }} aria-hidden />
                  <span className={rowName}>{name}</span>
                  <span className="min-w-0 flex-1 truncate text-micro text-ink-600">{opt?.label || ''}</span>
                  <Pipette size={11} className={`shrink-0 transition-colors ${waiting ? 'text-brand-700' : 'text-ink-400 group-hover:text-ink-600'}`} aria-hidden />
                </button>
                {picked && (
                  <button
                    type="button"
                    onClick={() => onClearFinish?.(group)}
                    title={t(locale, 'parts.useDefaultFinish')}
                    aria-label={t(locale, 'parts.useDefaultFinish')}
                    className={undoBtn}
                  >
                    <Undo size={12} aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* THE CONSEQUENCE, stated once where the decision is made — and never a
          number: the live estimate above already recomputes. Only a piece with
          billable componentes has this trade-off to make. */}
      {fabricRoles.length > 0 && (diverged.length > 0 || open) && (
        <p className="text-micro leading-snug text-ink-500">
          {t(locale, diverged.length > 0 ? 'parts.byParts' : 'parts.oneElement')}
        </p>
      )}
    </div>
  );
}


// Empty-plan starter — the configurator's OPENING PAGE, not a card in a box: an
// editorial, full-bleed composition on the warm canvas (the register of a Ligne
// Roset lookbook — the Togo is a 1973 icon and the opening should read like it).
// The collection name is an oversized masthead in the brand's wordmark face; the
// pieces are a LOOKBOOK GALLERY GRID — each piece a LARGE rendered image on a
// soft plate (the mono index keeps the editorial numbering; a persistent "+"
// badge makes "tap to place" read without instructions, even on touch, and
// inverts to terracotta on hover), name + specs in tabular micro-type beneath.
// Each card is one tap to place. While it's up it is THE one piece picker (the
// bottom deck / side panes stay hidden, so the list never appears twice); the
// overlay itself scrolls with the `my-auto` centering trick (justify-center
// would clip the top once the grid outgrows the screen), safe-area padded —
// every piece stays reachable at any height, nothing sits buried under a
// floating panel.
function EmptyPlanStart({ models = [], renderThumbById = {}, onAddPiece, collections = [], collectionMenu = [], collectionThumbs = {}, fabricByCode = {}, activeCollection, onCollection, locale, fmt, pricesHidden = false, fromMode = false }) {
  // Step one: a real choice exists and none has been made yet.
  const atIndex = collections.length > 1 && !activeCollection;
  // Stepping into a collection has to start you at its first piece. This screen
  // keeps ONE scroller wrapping both steps — the collection index and the piece
  // grid swap INSIDE it — so the offset built up scrolling the index survived
  // the switch and dropped you into the middle of Kashima. (The drawer and the
  // desktop pane swap different scroller elements, so those remount at zero on
  // their own; this is the surface that does not.)
  const scrollRef = useRef(null);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = 0; }, [activeCollection]);
  return (
    /* OPAQUE white — the same white as the card plates, on purpose. This used
       to be `bg-canvas/90 backdrop-blur-sm`, and the 10% of the 3D stage that
       bled through (floor shadows, wall corners, all blurred) mottled the
       gaps between the pure-white tiles into irregular grey patches. The
       stage behind this splash is an empty room, so the see-through bought
       nothing; one flat #fff makes tile and page a single surface. */
    <div ref={scrollRef} className="absolute inset-0 z-10 overflow-y-auto overscroll-contain scroll-thin bg-white">
      {/* The top inset is a MARGIN now, not a reservation. It used to add a flat
          4rem on top of the safe area to clear the floating toolbar — but the
          splash hides every top control until the first piece is placed, so that
          band cleared nothing and just opened a hole above the lockup. And the
          block is top-aligned rather than `my-auto`: a masthead belongs at the
          top of its page, and centring it made the gap depend on how many
          collections the dealer happens to sell. */}
      <div className="min-h-full w-full max-w-5xl mx-auto flex flex-col px-6 pt-[max(2rem,calc(env(safe-area-inset-top)+0.75rem))] short:pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="w-full">
          {/* The splash masthead IS the Ligne Roset lockup — the owner's call.
              A word ("Colecciones") in the largest type on the opening screen of
              a Ligne Roset surface was spending the brand's own real estate on a
              label; the subtitle underneath already says to pick a collection.
              Step TWO keeps its back-link and collection name: inside a
              collection the heading carries information the logo cannot. */}
          {/* The INDEX masthead is centred — a lockup is a symmetrical mark and
              hanging it off the left edge reads as a stray asset rather than a
              masthead. Step TWO stays left-aligned: it opens with a back link,
              and a centred back arrow is nobody's idea of a working header. */}
          {/* `short:` trims (with the tiles' max-h-[38svh]): in a viewport
              under 600px — landscape phone, host iframe, half-height window —
              the full-size masthead plus a width-driven tile pushed the first
              card's caption past the fold, so the splash OPENED with "Togo"
              over a half-sliced "8 PIEZAS · DESDE…" and no visible cue that
              anything scrolls. Trimmed, masthead + first card + caption fit
              the first viewport and the next card's top edge peeks as the
              scroll cue. Tall viewports are pixel-identical. */}
          <header className={`configurator-rise border-b border-ink-200 pb-6 short:pb-4${atIndex ? ' text-center' : ''}`}>
            {atIndex ? (
              <img
                src="/ligne-roset-depuis-1860.png"
                alt="Ligne Roset — depuis 1860"
                // The masthead of the opening screen: it must be THERE when the
                // header rises, not arrive after it. Lazy/low priority would
                // queue the brand's own lockup behind the thumbnails it
                // introduces. Lowercase `fetchpriority` on a raw element —
                // React 18 renders the camelCase spelling but warns about it
                // (ImageView, being typed, keeps the React name).
                decoding="async"
                fetchpriority="high"
                className="w-56 sm:w-72 short:!w-40 h-auto select-none mx-auto"
                draggable={false}
              />
            ) : (
              <>
                <CollectionBack locale={locale} onBack={onCollection} />
                <h2 className="font-wordmark text-ink-900 text-[clamp(3rem,16vw,4.5rem)] sm:text-7xl short:!text-4xl leading-[0.95] tracking-tight mt-3">
                  {activeCollection || 'Togo'}
                </h2>
              </>
            )}
            <p className={`text-sm text-ink-500 mt-4 short:mt-2 max-w-xs leading-relaxed${atIndex ? ' mx-auto' : ''}`}>
              {t(locale, atIndex ? 'collection.subtitle' : 'start.subtitle')}
            </p>
          </header>
          {/* TWO up on a phone, three from md. `cols` and the responsive class
              can't both emit a grid-cols-* or the later one in Tailwind's sheet
              wins at every width — so `cols` sets the base and the className
              only adds the breakpoint. */}
          {atIndex ? (
            /* The INDEX goes one-up on a phone — same reason as the drawer's:
               at two columns the tile that IS the collection was ~160px, too
               small to read as furniture, and this is the first screen a phone
               visitor gets. Pieces (step two, below) stay two-up: there you
               already know the collection and you're scanning a known set. */
            <CollectionMenu
              entries={collectionMenu} renderThumbById={renderThumbById} fabricThumbs={collectionThumbs} fabricByCode={fabricByCode}
              onSelect={onCollection} locale={locale} fmt={fmt} cols={1}
              rise={SPLASH_TILES_IN}
              className="mt-8 short:mt-5 sm:grid-cols-2 md:grid-cols-3"
            />
          ) : (
          <ThumbWaveProvider>
          <ul className="mt-8 short:mt-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-5 gap-y-8 list-none m-0 p-0">
            {models.map((m, i) => (
              <li key={m.id} className="configurator-rise min-w-0" style={{ animationDelay: tileRiseIn(i, SPLASH_TILES_IN) }}>
                <PieceCard
                  model={m} index={i} waveIndex={i} renderThumbById={renderThumbById}
                  onAdd={onAddPiece} locale={locale} fmt={fmt}
                />
              </li>
            ))}
          </ul>
          </ThumbWaveProvider>
          )}
          {!pricesHidden && !fromMode && (
            <p
              className="configurator-rise text-micro text-ink-500 mt-6"
              style={{ animationDelay: afterTileRise(atIndex ? collectionMenu.length : models.length, SPLASH_TILES_IN) }}
            >
              {t(locale, 'start.priceNote')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CanvasArea({
  view, placed, resolvedById, material, selectedUid, onSelect, onMove, onRotateTo, gesturesRef, onHoverPiece,
  models = [], onAddPiece, renderThumbById = {}, overallCm, fill = false,
  collections = [], collectionMenu = [], collectionThumbs = {}, activeCollection, onCollection, hintPieceId = null, rates, locale, fmt, pricesHidden = false, fromMode = false,
  onTapPart, fabricByCode, onSelAnchor, chipUid = null, onChipAnchor, chipFollow = false, focusPart = null, focusSoft = false, room = null, insetLeft = 0, insetRight = 0,
  insetBottomFrac = 0, insetTop = 0,
  onModelFallback,
}) {
  const boxedH = 'h-[56vh] min-h-[320px] lg:h-[58vh] lg:min-h-[440px]';
  const [contour, setContour] = useState(null);
  const [rotDeg, setRotDeg] = useState(null);   // live free-rotate readout (null at rest)
  // ── The ROTATE HANDLE rides the same rail as the gold outline and the
  // dimension brackets: the stage reports the selected piece's bottom-centre
  // every rendered frame and we write left/top STRAIGHT TO THE DOM. Routing it
  // through React state (what it did) cost a frame and re-rendered this whole
  // subtree on every frame of a drag, so the handle trailed the piece it is
  // attached to — the one control that must look welded to the sofa. Only its
  // PRESENCE is React state, and that flips twice per selection, not per frame.
  const rotateRef = useRef(null);
  const lastRotatePos = useRef(null);
  const applyRotatePos = (pos) => {
    const el = rotateRef.current;
    if (el && pos) { el.style.left = `${pos.x}px`; el.style.top = `${pos.y + 12}px`; }
  };
  const [hasSelPos, setHasSelPos] = useState(false);
  const onSelPos = useCallback((pos) => {
    lastRotatePos.current = pos || null;
    applyRotatePos(pos);
    setHasSelPos(!!pos);          // same value ⇒ React bails; no per-frame render
  }, []);
  // Re-assert after EVERY render: React reconciliation must never leave a
  // frame-stale position on screen (the chip above learned this the hard way).
  useLayoutEffect(() => { applyRotatePos(lastRotatePos.current); });
  const showRotate = view === '2d' && selectedUid != null && hasSelPos;
  // The selected piece's top-centre on screen, from its live silhouette — the
  // anchor for anything that floats ABOVE the piece (the rotate readout in 2D,
  // the palette edit button in 3D), where no finger covers it.
  const selTop = useMemo(() => {
    if (!contour?.length) return null;
    let sx = 0, minY = Infinity;
    for (const p of contour) { sx += p.x; if (p.y < minY) minY = p.y; }
    return { x: sx / contour.length, y: minY };
  }, [contour]);
  const contourTop = rotDeg != null ? selTop : null;
  // Report the selected piece's top-centre UP so the SAME fabric card can pin
  // above it on tap (touch has no hover, so selection is how that card opens
  // there). Null unless a piece is selected in 3D.
  useEffect(() => {
    onSelAnchor?.(view === '3d' && selectedUid != null ? selTop : null);
  }, [selTop, view, selectedUid, onSelAnchor]);
  // Keyboard piece-cycling lives on the canvas itself: Tab/Shift+Tab walk the
  // pieces in reading order; Escape first releases the selection, then the
  // canvas (so Tab is never trapped — SC 2.1.2). Arrows/R/Delete are global.
  // Only when the CANVAS itself holds focus — keydowns bubbling up from child
  // buttons (rotate handle, empty-plan grid) must keep their normal tab order.
  const onCanvasKey = useCallback((e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Tab') {
      if (view !== '2d' || !placed.length) return;
      e.preventDefault();
      onSelect?.(cyclePieceUid(placed, selectedUid, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      if (selectedUid != null) onSelect?.(null);
      else e.currentTarget.blur();
    }
  }, [view, placed, selectedUid, onSelect]);
  return (
    <div
      tabIndex={0}
      role="application"
      aria-roledescription={t(locale, 'canvas.roledescription')}
      aria-label={t(locale, 'canvas.label', { pieces: piecesLabel(locale, placed.length) })}
      aria-describedby="togo-canvas-keys"
      onKeyDown={onCanvasKey}
      className={`${fill ? 'absolute inset-0 overflow-hidden bg-ink-50/40' : `relative overflow-hidden rounded-xl border border-ink-200 bg-ink-50/40 ${boxedH}`} focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600`}
    >
      <p id="togo-canvas-keys" className="sr-only">
        {t(locale, 'canvas.keysHelp')}
      </p>
      {/* `ground`: a neutral near-white floor. On the public configurator the
          stage is the biggest surface on a monochrome page (the .configurator-rams
          skin), and the app's warm default reads as cream under it. */}
      <ConfiguratorStage
        ground={0xFAFAFA}
        /* How much of the canvas the side panes COVER, in CSS px — they are
           overlays, so without this the piece frames centred on the canvas and
           ends up half behind them. Each is w-80 (20rem) + its 0.75rem inset;
           the stage nets left against right and turns the difference into a
           fraction of its own live width. Zero the moment a pane stows, and the
           stage glides back. Both are computed by the owner (their open state is
           its state); CanvasArea only forwards them. */
        insetLeft={insetLeft}
        insetRight={insetRight}
        insetBottomFrac={insetBottomFrac}
        insetTop={insetTop}
        mode={view} placed={placed} resolvedById={resolvedById} material={material}
        selectedUid={selectedUid} onSelect={onSelect} onMove={onMove}
        onRotateTo={onRotateTo} gesturesRef={gesturesRef} onHoverPiece={onHoverPiece}
        onSelectedScreenPos={onSelPos} onSelContour={setContour}
        hintPieceId={hintPieceId} onRotateLive={setRotDeg} onTapPart={onTapPart} fabricByCode={fabricByCode}
        chipUid={chipUid} onChipAnchor={onChipAnchor} chipFollow={chipFollow} focusPart={focusPart}
        focusSoft={focusSoft} room={room}
        onModelFallback={onModelFallback}
        dims={overallCm?.widthCm > 0
          ? {
            widthLabel: `${overallCm.widthCm} cm`,
            depthLabel: `${overallCm.depthCm} cm`,
            // The piece rail is glued to the left edge on phones and tablets,
            // and the depth note has to start clear of it — tucked under it, it
            // rendered as "0 c". Reserved at every size: it costs nothing where
            // there is no rail. The desktop material rail is a separate matter
            // and is now handled at the source — the stage frames against the
            // VISIBLE strip (ConfiguratorStage's insetLeft), so the bracket has nothing
            // to correct for there.
            insetLeft: 30,
          }
          : null}
        className="absolute inset-0"
      />
      {/* The gold selection outline AND the dimension brackets are both drawn
          INSIDE ConfiguratorStage, imperatively in the same frame as each render (a
          React-state stroke lagged the canvas during orbit — the "outline jumps
          out of place" bug; the brackets had the same disease). `contour` here
          only feeds the anchors (rotate readout, floating fabric card). */}
      {/* Live angle readout while free-rotating — the visual twin of the 15°
          detent haptic (desktop has no vibration). Bolder ON a detent. */}
      {view === '2d' && rotDeg != null && contourTop && (
        <div
          className="absolute z-10 -translate-x-1/2 -translate-y-full pointer-events-none"
          style={{ left: `${contourTop.x}px`, top: `${contourTop.y - 8}px` }}
          aria-hidden
        >
          <span className={`hud-panel inline-block px-2 py-1 text-micro tabular-nums text-ink-800 ${rotDeg % 15 === 0 ? 'font-semibold' : ''}`}>
            {rotDeg}°
          </span>
        </div>
      )}
      {/* Rotate handle floating just beneath the tapped piece: DRAG it to spin
          the piece to any angle (soft 15° detents); a plain tap steps 90°. The
          gesture itself lives in the stage (it spins the real mesh live). */}
      {showRotate && (
        <button
          type="button"
          onPointerDown={(e) => gesturesRef?.current?.startRotate?.(e)}
          title={t(locale, 'rotate.title')}
          aria-label={t(locale, 'rotate.aria')}
          ref={rotateRef}
          style={{ touchAction: 'none' }}
          className="absolute z-10 -translate-x-1/2 grid place-items-center w-10 h-10 coarse:w-11 coarse:h-11 rounded-full bg-surface/95 backdrop-blur border border-ink-200 text-ink-700 shadow-pop active:scale-90 transition hover:bg-ink-50 cursor-grab"
        >
          <RotateCw size={17} />
        </button>
      )}
      {!placed.length && (
        <EmptyPlanStart
          models={models} renderThumbById={renderThumbById} onAddPiece={onAddPiece}
          collections={collections} collectionMenu={collectionMenu} collectionThumbs={collectionThumbs} activeCollection={activeCollection} onCollection={onCollection}
         
          locale={locale} fmt={fmt} pricesHidden={pricesHidden} fromMode={fromMode}
        />
      )}
    </div>
  );
}



function nameFilterOf(keys) {
  return Array.isArray(keys) && keys.length ? new Set(keys) : undefined;
}

/** The download chooser — EXACTLY two options (owner ask 2026-08): the 3D
 *  model (GLB — one file, real fabrics embedded, opens in Twinmotion/Blender/
 *  SketchUp/AR) and the 2D plan (DXF, for CAD). The geometry-only OBJ that
 *  used to sit third is gone: it carried no textures and cm units, and
 *  imported into Twinmotion as an empty scene. */
function DownloadSheet({ open, onClose, onDxf, dxfBusy, onGlb, glbBusy, locale }) {
  return (
    <Modal open={open} onClose={onClose} title={t(locale, 'download.title')} size="sm">
      {open && (
        <div className="space-y-2.5">
          {/* The textured export leads — a single portable file with the real
              fabrics embedded (the same GLB the AR viewer builds). */}
          <button type="button" onClick={onGlb} disabled={glbBusy} className="w-full flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-left hover:bg-brand-50 active:bg-brand-100 transition disabled:opacity-60">
            <span className="shrink-0 w-10 h-10 rounded-lg bg-brand-600 text-white grid place-items-center"><View size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink-900">{t(locale, 'download.glbTitle')}</span>
              <span className="block text-micro text-ink-500">{t(locale, 'download.glbDesc')}</span>
            </span>
            {glbBusy && <Loader2 size={16} className="animate-spin text-ink-500 shrink-0" />}
          </button>
          <button type="button" onClick={onDxf} disabled={dxfBusy} className="w-full flex items-center gap-3 rounded-xl border border-ink-200 p-3 text-left hover:bg-ink-50 active:bg-ink-100 transition disabled:opacity-60">
            <span className="shrink-0 w-10 h-10 rounded-lg bg-ink-900 text-white grid place-items-center"><FileDown size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink-900">{t(locale, 'download.dxfTitle')}</span>
              <span className="block text-micro text-ink-500">{t(locale, 'download.dxfDesc')}</span>
            </span>
            {dxfBusy && <Loader2 size={16} className="animate-spin text-ink-500 shrink-0" />}
          </button>
        </div>
      )}
    </Modal>
  );
}


function Centered({ children }) {
  return <div className="min-h-full bg-surface grid place-items-center p-6">{children}</div>;
}

/** The embed's first screen: a live Togo, slowly turning in Festa Bleu Paon,
 *  under the "Ligne Roset" wordmark in Rauschen. The BRAND is the headline —
 *  the card sells the house, and the Togo is what it's showing today.
 *
 *  It is the ONE surface of ours that renders inside alcover.do's own pages, so
 *  it is dressed in the storefront's language rather than the configurator's:
 *  the lookbook's WHITE ground, a product photo sitting on the neutral `ink-50`
 *  tile wash, quiet name/detail captions under it, and the owner's violet used
 *  EXACTLY ONCE — on the CTA (PublicStore.jsx holds the same rule for the
 *  storefront's own pages). The card reads as one more tile in the shop, not as
 *  a widget bolted onto it.
 *
 *  The turntable is progressive: the drawn silhouette paints instantly and the
 *  real 3D crossfades in over it when (and only when) it's ready — a visitor on
 *  a locked-down browser, a dead GPU or a catalog that hasn't landed yet still
 *  gets the card that shipped before. Tapping anywhere opens the configurator in
 *  a NEW TAB (`?ctx=modal` → straight to the build, full screen). */
function EmbedLaunchCard({ href, locale, hero, fabricByCode }) {
  const innerRef = useRef(null);
  // 'idle' → the silhouette only; 'ready' → the live turntable has its first
  // frame up and takes over; 'failed' → stay on the silhouette forever.
  const [hero3d, setHero3d] = useState('idle');
  const live = hero3d === 'ready';
  // The card fills its frame (warm, centered) so there's never a WHITE band. When
  // inside a host iframe it ALSO reports its CONTENT height so the self-sizing
  // snippet shrink-wraps the iframe to exactly the card — no dead space at all.
  // (Measuring the inner block, padding included, makes that fixed-point stable.)
  // Let a scroll PASS THROUGH the card to the page hosting it. The app shell
  // pins html/body to the viewport with `overscroll-behavior: none` (index.css),
  // which is right for the configurator and wrong for a guest iframe: it stops
  // the scroll chaining out, so a visitor who wheels or swipes over the card
  // finds the dealer's page has stopped moving. Scoped to the card's lifetime;
  // the configurator opens in its own tab and keeps the lock.
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add('is-embed-card');
    return () => el.classList.remove('is-embed-card');
  }, []);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    let inIframe = false;
    try { inIframe = window.self !== window.top; } catch { inIframe = true; }
    if (!inIframe) return undefined;
    const post = () => {
      try { window.parent?.postMessage({ type: 'togo-embed-height', height: Math.ceil(el.offsetHeight) }, '*'); } catch { /* no listener */ }
    };
    post();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(post) : null;
    ro?.observe(el);
    const t = setTimeout(post, 400);   // re-post once fonts/SVG settle
    return () => { ro?.disconnect(); clearTimeout(t); };
  }, []);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      onClick={() => buzz(12)}
      className="configurator-card-type no-select-ui group no-underline text-center bg-white text-ink-900 min-h-screen flex flex-col items-center justify-center overflow-hidden"
    >
      {/* One card, two proportions.

          NARROW (a phone, and the 480 px column the embed snippet ships) — the
          stacked card: lockup, then the piece edge to edge under a hairline,
          then the line and the way in. No horizontal padding on the column, so
          the PIECE runs full bleed and only the type is inset.

          WIDE — the same parts, side by side. Stacked, they can't stay stacked:
          the piece is sized off the column's WIDTH, so a 1400 px slot rendered a
          933 px-tall sofa and a card over 1200 px deep. Any host that pins the
          frame (a theme with a fixed-height container, or a CMS that drops the
          resize script) then shows the top of it and cuts the rest off. Turning
          the card at `sm` puts the piece beside the type instead of under it, so
          a wider slot makes the card WIDER rather than taller — it fills the
          space it was given and its height stays inside the snippet's seed. */}
      <span
        ref={innerRef}
        className="configurator-rise w-full max-w-[1080px] grid grid-cols-1 gap-y-7 py-10
                   sm:grid-cols-[minmax(0,0.72fr)_minmax(0,1.48fr)] sm:grid-rows-[1fr_auto_auto_auto_1fr]
                   sm:gap-x-12 sm:gap-y-6 sm:px-12 sm:py-12 sm:text-left"
      >
        {/* The official "depuis 1860" lockup is the hero — the SAME asset the
            dealer inbox leads with, so the two public surfaces open the same
            way. A white-ground asset on a white page: seamless, no plate. */}
        <img
          src="/ligne-roset-depuis-1860.png"
          alt="Ligne Roset — depuis 1860"
          decoding="async"
          fetchpriority="high"
          className="w-44 sm:w-52 h-auto select-none justify-self-center sm:justify-self-start sm:col-start-1 sm:row-start-2 sm:self-end"
          draggable={false}
        />
        {/* The piece. FULL BLEED under a hairline when stacked; the right-hand
            column, spanning the type, when the card turns. 3:2 rather than 4:3 —
            the hero is a long, low sofa and the turntable frames it on its
            WIDTH, so a squarer tile just banks dead air above and below it. The
            aspect is fixed and the height capped, so the iframe's reported
            height never moves as the 3D swaps in and never runs away with the
            slot; the host page must not reflow under the visitor. */}
        <span className="relative block w-full aspect-[4/3] sm:aspect-[3/2] max-h-[380px] sm:max-h-[460px] overflow-hidden border-t border-ink-200 sm:border-t-0 sm:col-start-2 sm:row-start-1 sm:row-span-5 sm:self-center">
          <span
            className={`absolute inset-0 grid place-items-center text-ink-800 transition-opacity duration-700 [&>svg]:w-full [&>svg]:h-auto [&>svg]:max-h-full ${live ? 'opacity-0' : 'opacity-100'}`}
            aria-hidden
            dangerouslySetInnerHTML={{ __html: configuratorHeroSvg }}
          />
          {hero && (
            <ConfiguratorTurntable
              scene3d={hero.scene}
              fabricByCode={fabricByCode}
              onStatus={setHero3d}
              className={`absolute inset-0 transition-opacity duration-700 ${live ? 'opacity-100' : 'opacity-0'}`}
            />
          )}
        </span>
        <span className="block px-6 sm:px-0 max-w-sm mx-auto sm:mx-0 text-sm text-ink-500 leading-relaxed sm:col-start-1 sm:row-start-3">{t(locale, 'launch.tagline')}</span>
        {/* The inbox's primary action, verbatim: square, ink, inverting. */}
        <span className="justify-self-center sm:justify-self-start sm:col-start-1 sm:row-start-4 sm:self-start">
          <span className={`inline-flex items-center gap-2 border border-ink-900 bg-ink-900 text-white px-5 py-2.5 ${EYEBROW_INK} group-hover:bg-white group-hover:text-ink-900 transition-colors`}>
            {t(locale, 'launch.cta')} <span aria-hidden>→</span>
          </span>
        </span>
      </span>
    </a>
  );
}

// How many placements the Edge Function keeps (togo-embed MAX_ITEMS). Mirrored
// here — data, not code, so the wall is intact — purely so the visitor's build
// can be COUNTED against it before it is sent. It is not a client-side limit:
// the plan stays unbounded, the server still decides.
const MAX_REQUEST_ITEMS = 40;
// …and the note column's cut (togo-embed `str(body.note, 1000)`).
const NOTE_MAX_CHARS = 1000;

/** The stored note: the visitor's own words, plus a line telling the dealer what
 *  did NOT travel with them. The server truncates the note, so the notice is
 *  appended and the VISITOR's text is what gives way if the pair overflows — a
 *  warning that falls off the end is not a warning. `dropped` 0 → untouched. */
function noteWithDropped(note, dropped) {
  const text = String(note || '').trim();
  if (!dropped) return text;
  const notice = `Aviso del configurador: ${dropped} pieza${dropped === 1 ? '' : 's'} del diseño no viajaron en esta solicitud `
    + `(límite de ${MAX_REQUEST_ITEMS} piezas, o pieza retirada del catálogo). Confírmalo con el cliente.`;
  const room = NOTE_MAX_CHARS - notice.length - 1;
  const head = room > 0 ? text.slice(0, room).trim() : '';
  return head ? `${head}\n${notice}` : notice;
}

/** What the server will drop from this payload, counted the way it drops:
 *  truncate to MAX_REQUEST_ITEMS FIRST, then keep only models the catalog still
 *  carries. The visitor composed all of them, so the gap belongs on the dealer's
 *  card rather than nowhere. */
function droppedRequestItems(items, resolvedById) {
  const kept = (items || [])
    .slice(0, MAX_REQUEST_ITEMS)
    .filter((it) => !!resolvedById?.[it.modelId]);
  return Math.max(0, (items || []).length - kept.length);
}

function RequestForm({ storeName, items, estimateUsd, total, onBack, onDone, locale, dealerSlug, logoUrl, scene3d, droppedItems = 0 }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // A typo'd email means the dealer can never reply — validate the shape when one
  // is given (it stays optional as long as there's a phone).
  const emailOk = !form.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim());
  const valid = form.name.trim() && (form.phone.trim() || form.email.trim()) && emailOk;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      // Hidden pricing → no estimateUsd travels in the payload.
      const payload = {
        contact: { name: form.name, phone: form.phone, email: form.email },
        items,
        // Anything the server will drop rides along as a line the dealer READS
        // (there is no other channel — the request stores what it stores).
        note: noteWithDropped(form.note, droppedItems),
      };
      if (estimateUsd != null) payload.estimateUsd = estimateUsd;
      // The composition RENDER rides the request: an offscreen 3D snapshot of
      // exactly what the visitor built (every piece in its fabric), so the
      // dealer's card AND the eventual quote show this same picture. Encoded as
      // a DATA URL — the bytes travel, not a `blob:` handle into this tab — and
      // gated on the SAME shape the server decodes, so a snapshot that ships is
      // one that lands. Strictly best-effort: a WebGL failure or an oversized
      // frame never blocks the lead.
      try {
        const snapshot = await renderConfiguratorSceneThumb(scene3d, { width: 960, height: 600, encode: 'dataUrl' });
        const field = snapshotFieldFor(snapshot);
        if (field) payload.snapshot = field;
      } catch { /* sin foto — el lead viaja igual */ }
      await submitConfiguratorRequest(payload, dealerSlug);
      buzz([12, 40, 16, 40, 22]); // a little celebratory rumble on send
      onDone();
    } catch (err) {
      setError(err?.message || t(locale, 'form.errorSend'));
      setBusy(false);
    }
  };

  // THE TEAM DOOR — a signed-in member turns this exact build into a FROZEN
  // quote in one tap, instead of posing as their own customer (submit a
  // "lead" to yourself, walk to Solicitudes, freeze it). Detection is the same
  // isTeamBrowser() the Meta guard already uses; the transport (the app's
  // supabase client) is imported ON TAP, so the public visitor's bundle never
  // carries it. Name-only validity: the server's compose door asks who the
  // document is FOR, not how to reach them — the composer is standing next to
  // the customer. Spanish on purpose: this control belongs to the back-office,
  // not to the visitor's i18n surface.
  const team = useMemo(() => isTeamBrowser(), []);
  const composeQuote = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const payload = {
        contact: { name: form.name, phone: form.phone, email: form.email },
        items,
        note: noteWithDropped(form.note, droppedItems),
      };
      if (dealerSlug) payload.dealerSlug = dealerSlug;
      try {
        const snapshot = await renderConfiguratorSceneThumb(scene3d, { width: 960, height: 600, encode: 'dataUrl' });
        const field = snapshotFieldFor(snapshot);
        if (field) payload.snapshot = field;
      } catch { /* sin foto — la cotización viaja igual */ }
      const { createQuoteFromBuild } = await import('../quoting/api.js');
      const { quote } = await createQuoteFromBuild(payload);
      buzz([12, 40, 16, 40, 22]);
      // The document IS the destination: leave the widget for its detail page.
      location.assign(`/#/cotizaciones/${quote.id}`);
    } catch (err) {
      setError(err?.message || t(locale, 'form.errorSend'));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-white text-ink-900 p-6 grid place-items-center">
      {/* No card — the inbox never uses one. The form is a plain white column
          under a hairline-ruled head, exactly like a lead detail. */}
      <form onSubmit={submit} className="configurator-rise w-full max-w-md space-y-4">
        <button type="button" onClick={onBack} className={`${EYEBROW} inline-flex items-center gap-1.5 hover:text-ink-900 transition-colors`}>
          <ArrowLeft size={13} /> {t(locale, 'form.back')}
        </button>
        <div className="border-b border-ink-200 pb-5">
          {logoUrl && <img src={logoUrl} alt={storeName || ''} className="max-h-8 w-auto object-contain mb-3" />}
          <h2 className="text-2xl font-light tracking-tight leading-tight">{t(locale, 'form.title')}</h2>
          <p className="text-sm text-ink-500 mt-2 leading-relaxed">
            {t(locale, 'form.subtitle', { store: storeName })}
          </p>
          {/* The estimate reads as the inbox's total: an eyebrow label with the
              figure in light tabular type opposite it. Only once something is
              actually PRICED — a visitor can reach this form having placed
              pieces but chosen no fabric, and `fmt(0)` is a perfectly valid
              "$0.00" that this treatment would set in 24px light type. */}
          {total != null && estimateUsd > 0 && (
            <div className="flex items-baseline justify-between mt-4">
              <span className={EYEBROW}>{t(locale, 'estimate.label')}</span>
              <span className="text-2xl font-light tracking-tight tabular-nums text-ink-900">{total}</span>
            </div>
          )}
        </div>
        <label className="block">
          <span className="label">{t(locale, 'form.name')} *</span>
          <input className="input" value={form.name} onChange={set('name')} placeholder={t(locale, 'form.namePlaceholder')} autoComplete="name" autoFocus />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="label">{t(locale, 'form.phone')}</span>
            <input className="input" value={form.phone} onChange={set('phone')} placeholder={t(locale, 'form.phonePlaceholder')} inputMode="tel" autoComplete="tel" />
          </label>
          <label className="block">
            <span className="label">{t(locale, 'form.email')}</span>
            <input className="input" value={form.email} onChange={set('email')} placeholder={t(locale, 'form.emailPlaceholder')} inputMode="email" autoComplete="email" />
            {!emailOk && <p className="mt-1 text-micro text-status-warning-ink">{t(locale, 'form.emailInvalid')}</p>}
          </label>
        </div>
        <label className="block">
          <span className="label">{t(locale, 'form.note')}</span>
          <textarea className="input min-h-[72px]" value={form.note} onChange={set('note')} placeholder={t(locale, 'form.notePlaceholder')} />
        </label>
        {/* The one place colour survives the monochrome rule: an error must not
            be a shade of grey among greys. Kept to the ink border + red text,
            no filled panel. */}
        {error && <div role="alert" className="border border-red-300 px-3 py-2 text-xs text-status-critical-ink flex items-start gap-2"><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {error}</div>}
        <p className={`${EYEBROW} normal-case tracking-normal leading-relaxed`}>{t(locale, 'form.contactHint')}</p>
        <button type="submit" disabled={!valid || busy} className="btn-primary w-full justify-center disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t(locale, 'form.submit')}
        </button>
        {team && (
          <div className="pt-4 border-t border-ink-200 space-y-2">
            <button
              type="button"
              onClick={composeQuote}
              disabled={!form.name.trim() || busy}
              className="btn-secondary w-full justify-center disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Receipt size={15} />} Crear cotización
            </button>
            <p className={`${EYEBROW} normal-case tracking-normal leading-relaxed`}>
              Sesión del equipo: congela este diseño como cotización con sus precios de hoy y su
              enlace para el cliente — sin pasar por solicitudes. Basta el nombre.
            </p>
          </div>
        )}
      </form>
    </div>
  );
}

/** The confirmation screen. It used to burst confetti and spring a green check —
 *  "clearing a level". On the surface that sells Togo to Ligne Roset that reads
 *  as a consumer app, so the reward is now the RESTRAINT the rest of the skin
 *  keeps: the mark, the message set in light display type, and a hairline. The
 *  `Confetti` component is deliberately kept (below) — it's one line to put
 *  back if the owner wants the celebration on a non-brand deployment. */
function DoneScreen({ storeName, onReset, locale, logoUrl }) {
  return (
    <div className="relative min-h-full overflow-hidden bg-white text-ink-900 p-6 grid place-items-center">
      <div className="configurator-rise relative z-10 text-center max-w-sm">
        {logoUrl
          ? <img src={logoUrl} alt={storeName || ''} className="max-h-8 w-auto object-contain mx-auto mb-6" />
          : (
            <img
              src="/ligne-roset-depuis-1860.png"
              alt="Ligne Roset — depuis 1860"
              className="w-40 h-auto mx-auto mb-6 select-none"
              draggable={false}
            />
          )}
        <div className="w-10 h-10 mx-auto border border-ink-900 grid place-items-center"><Check size={18} strokeWidth={1.5} /></div>
        <h2 className="mt-6 text-2xl font-light tracking-tight leading-tight">{t(locale, 'done.title')}</h2>
        <p className="mt-3 text-sm text-ink-500 leading-relaxed">{t(locale, 'done.subtitle', { store: storeName })}</p>
        <div className="mt-7 pt-5 border-t border-ink-200">
          <button
            type="button"
            onClick={onReset}
            className={`${EYEBROW} text-ink-900 underline underline-offset-4 decoration-1 hover:decoration-2`}
          >
            {t(locale, 'done.reset')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A pure-CSS confetti burst — each bit reads its own randomized trajectory from
 *  inline custom properties (no animation library, no canvas). Memoized so it's
 *  cut once per mount; honors reduced-motion via the .configurator-confetti CSS guard. */
function Confetti({ count = 28 }) {
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => ({
    left: Math.round((i / count) * 100 + (Math.random() * 6 - 3)),
    w: 6 + Math.round(Math.random() * 6),
    h: 9 + Math.round(Math.random() * 8),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    dx: `${Math.round(Math.random() * 160 - 80)}px`,
    rot: `${Math.round(Math.random() * 900 - 360)}deg`,
    dur: `${(2.2 + Math.random() * 1.7).toFixed(2)}s`,
    delay: `${(Math.random() * 0.5).toFixed(2)}s`,
  })), [count]);
  return (
    <div className="configurator-confetti absolute inset-0 pointer-events-none" aria-hidden>
      {bits.map((b, i) => (
        <i key={i} style={{
          left: `${b.left}%`, width: b.w, height: b.h, background: b.color,
          '--dx': b.dx, '--rot': b.rot, '--dur': b.dur, '--delay': b.delay,
        }} />
      ))}
    </div>
  );
}
