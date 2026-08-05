import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { inferTogoForm, TOGO_HEIGHT_CM } from '../../lib/togo/togoModel.js';
import { mountOf } from '../../lib/togo/meshParts.js';
import { footprintOf, snapPlacementInfo, resolvePlacement } from '../../core/quote/index.js';
import { loadTogoModels, descForPiece } from './togoModelLoader.js';
import { buildTogoGroup, setupTogoStage, disposeGroup, makeFabricMaps, sampleSwatchColor, makeTintedWeave, makeWeaveNormal, imageColorfulness, maskToOutline, buildRoomGroup, disposeRoomGroup, correctScanToSwatch, fabricAnisotropy } from './togoSceneBuilder.js';

const DEFAULT_FINISH = { sheen: 0.7, sheenRoughness: 0.6, roughness: 0.85, repeat: 3, normalScale: 0.45 };
const norm360 = (d) => (((d % 360) + 360) % 360);
const PLAN_W = 760, PLAN_H = 540;
// The biggest island of a multi-loop outline, by screen bbox — the one a single
// anchor point belongs on when the highlight is several disjoint solids.
const widestLoop = (loops) => {
  let best = loops[0], bestA = -1;
  for (const loop of loops) {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of loop) { if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y; }
    const a = (mxx - mnx) * (mxy - mny);
    if (a > bestA) { bestA = a; best = loop; }
  }
  return best;
};
// How far the 3D camera sits back, as a multiple of the radius it frames. The
// LAYOUT keeps the historic pair (the 1.22 footprint margin × the 1.18 of extra
// air the floating material card needs — see poseFor). ONE PIECE is framed
// tighter, because it fills the frame on its own, but still leaves the card its
// room: it is the frame you get for tapping the piece you are about to
// re-upholster, so it has to read as "this one", not as the whole sofa.
const MARGIN_3D_LAYOUT = 1.22 * 1.18;
const MARGIN_3D_PIECE = 1.35;

// Models whose real mesh failed to load and were already reported. A missing
// GLB is a CATALOGUE fault, not a per-render event: the piece keeps drawing as
// procedural geometry on every rebuild, so without this the warning would fire
// on every drag. Module-scoped, so it is said once per session per model.
const reportedFallbacks = new Set();

// Eyedropper cursor over a CONFIGURABLE PART — the universal "this recolors
// what's under you" signal, so a visitor who has never touched a 3D tool knows
// the cushion is clickable. White glyph over a dark halo (reads on any fabric),
// hotspot at the pipette tip; falls back to `pointer` where custom cursors
// aren't supported.
const PIPETTE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  + '<g stroke="#1c1917" stroke-width="4"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></g>'
  + '<g stroke="#ffffff" stroke-width="2"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></g>'
  + '</svg>';
const PIPETTE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(PIPETTE_SVG)}") 2 22, pointer`;

// The 3D pick's screen-space ring of mercy (see `pieceHitNear`): the exact ray
// first, then 8 spokes at r and at 2r. A mouse gets a hair of slack; a finger
// twice that — the contact patch is ~10 mm across and the estructura it has to
// land on can be a 15-px band on screen.
const RING_SPOKES = 8;
const RING_R_MOUSE = 3.5;
const RING_R_TOUCH = 7;
const ringRadiusFor = (pointerType) => (pointerType === 'touch' ? RING_R_TOUCH : RING_R_MOUSE);

/**
 * The reserved `focusPart.role` meaning «everything on this piece the client can
 * DRESS» — every mesh except the estructura. Exported so the parent names the
 * mode instead of re-typing the string: two spellings of it would silently
 * degrade to "no mesh matches" and, through the no-vanish fallback, to the whole
 * piece — a bug that looks exactly like the behaviour it replaced.
 */
export const DRESSABLE_ROLE = 'dressable';

/** The selection outline's gold — the stroke below, exported because the
 *  componentes rail lights its chips in it. A chip and the line it lights are
 *  ONE selection seen twice (rail says which part, stage draws it on the
 *  mesh); two colours for that read as two selections. */
export const OUTLINE_GOLD = '#f5c000';

/**
 * WHICH of a piece's meshes the highlight covers — the pure core of
 * `focusMeshesFor`, and the only place the three focus modes are decided.
 *
 *   `groupKey`            → that MERGED part group (an estructura), by the key
 *                           the builder stamps on every mesh of it.
 *   `role`                → EVERY group of that role — "los cojines" is all of
 *                           them, not the one that was tapped.
 *   `DRESSABLE_ROLE`      → the piece MINUS its estructura (owner, 2026-08-01:
 *                           «only the parts that have editable fabrics … the
 *                           structure should not be part of that highlight. If I
 *                           wanna edit the structure, I click the structure»).
 *                           Legs and frames are a different axis — a finish, not
 *                           cloth — so the gold line that answers a plain tap
 *                           must not hug the metal feet.
 *                           `exclude` (part ROLES, dressable only) drops parts
 *                           carrying their OWN fabric pick: the highlight is a
 *                           PROMISE of what the click edits, and the whole-piece
 *                           pick will not repaint an overridden part (owner,
 *                           2026-08-01: body en CELADON with the cushions on
 *                           their own ANIS still wrapped everything). Absent or
 *                           empty ⇒ exactly today's dressable set.
 *
 * NO-VANISH: a filter matching nothing (an untagged legacy mesh, a stale key, a
 * piece that is ALL estructura, every dressable role excluded) answers null,
 * which every caller reads as "the whole piece" — a selected piece is never left
 * unhighlighted.
 */
export function focusMeshes(meshes, scope) {
  const key = scope?.groupKey ?? null;
  const role = scope?.role ?? null;
  if (key == null && role == null) return null;
  // Overrides narrow the DRESSABLE set only — a role/group focus already names
  // one part, and excluding from it would contradict what was asked for.
  const skip = role === DRESSABLE_ROLE && Array.isArray(scope?.exclude) && scope.exclude.length ? scope.exclude : null;
  const out = [];
  for (const o of meshes || []) {
    const ud = o?.userData || {};
    const r = ud.partRole || 'base';
    const hit = key != null ? ud.partKey === key
      : role === DRESSABLE_ROLE ? r !== 'structure' && !(skip && skip.includes(r))
        : r === role;
    if (hit) out.push(o);
  }
  return out.length ? out : null;
}

/**
 * WHICH piece — and which tagged PART of it — a raycast actually meant: the pure
 * core of `pieceHitAt`, and the one place the invisible grab pad is DEMOTED.
 *
 * Every piece carries a full-footprint invisible pad (built below) so the WHOLE
 * tile stays draggable — a tap in a cushion groove must grab the piece, not the
 * floor. But that pad lies flat 2 cm off the ground, and in 3D the estructura's
 * real metal sits 2–3 cm BEHIND it along the ray: taking the first hit carrying
 * a uid therefore answered "the body, no part" at essentially every visible
 * skid pixel (measured on a Prado settee: 1 of ~640 sampled points resolved to
 * estructura on the centre skid, 0 on the left one — the pipette never appeared
 * on the legs). So the first NON-pad hit wins, and the pad answers only when
 * the ray met no real mesh anywhere — which is exactly the job it was added for.
 *
 * `hits` are three.js intersections (nearest-first). Returns
 * `{ uid, partRole, partKey, pad, distance }`: role/key come from the nearest
 * tagged ancestor of the mesh that was hit, `pad` says the answer is the pad's
 * (role and key null by construction — it is "somewhere on this piece, nothing
 * in particular"), `distance` is the ray distance, which is the ring's last
 * tiebreak. Null when nothing was hit at all.
 */
export function resolvePickHit(hits) {
  let pad = null;
  for (const it of hits || []) {
    const isPad = !!it?.object?.userData?.pad;
    let role = null;
    let key = null;
    let o = it?.object;
    while (o) {
      const ud = o.userData;
      if (role == null && ud?.partRole != null) role = ud.partRole;
      if (key == null && ud?.partKey != null) key = ud.partKey;
      if (ud?.uid != null) {
        const dist = it?.distance ?? null;
        if (!isPad) return { uid: ud.uid, partRole: role, partKey: key, pad: false, distance: dist };
        // Remembered, not returned: a real mesh further along the ray outranks it.
        if (!pad) pad = { uid: ud.uid, partRole: null, partKey: null, pad: true, distance: dist };
        break;
      }
      o = o.parent;
    }
  }
  return pad;
}

/** A candidate that landed on a TAGGED part (cojín/rulo/estructura), not the body. */
const taggedPick = (c) => (c.hit.partRole || 'base') !== 'base';

/**
 * WHICH of the ring's candidates to adopt — the pure core of `pieceHitNear`.
 * Candidates are `{ hit, radius }` (a `resolvePickHit` result and the ring
 * radius in px that found it); the winner's `hit` is returned, null for none.
 *
 * The order is what the pointer MEANT, most specific first:
 *   1. a tagged part beats the body — the ring exists because thin estructura
 *      is hard to hit, and the body under it is already reachable everywhere;
 *   2. the smaller radius beats the larger — nearer to where they actually
 *      pointed;
 *   3. the shorter ray distance — the front of the sofa, not through it.
 * Strictly-better comparison, so the first candidate wins every tie and the
 * answer never depends on the spoke order.
 */
export function preferPick(candidates) {
  let best = null;
  for (const c of candidates || []) {
    if (!c?.hit) continue;
    if (!best) { best = c; continue; }
    const t = taggedPick(c), bt = taggedPick(best);
    if (t !== bt) { if (t) best = c; continue; }
    if (c.radius !== best.radius) { if (c.radius < best.radius) best = c; continue; }
    if ((c.hit.distance ?? Infinity) < (best.hit.distance ?? Infinity)) best = c;
  }
  return best ? best.hit : null;
}

/**
 * THE configurator stage — ONE three.js scene for BOTH "2D" and "3D". The 2D plan
 * is just this scene under a top-down camera with drag-to-arrange; "3D" is the
 * same scene under a perspective orbit camera. Switching modes ANIMATES the camera
 * between the two (the layout pans/tilts into position), so the views literally
 * flow into each other — no second renderer, no separate tile system, and material
 * changes are always live because there's only ever the one real scene.
 *
 * Editing (2D mode): tap a piece to select; drag it on the floor (raycast → ground
 * plane) — the floor is an unbounded sandbox, no walls. Axis-aligned pieces snap
 * gently flush to axis-aligned neighbours; a free-rotated piece moves raw.
 * Rotation is free-angle: the parent's rotate handle delegates its pointerdown
 * here via `gesturesRef` (startRotate spins the piece live around its centre,
 * with soft 15° detents; a plain tap steps to the next 90°). Rotate/delete/fabric
 * live in the contextual strip the parent renders. The placed state stays the
 * single source of truth — a gesture just commits new plan (x, y | rot) on release.
 *
 * 3D mode is look-only, but it still TELLS you what you're looking at:
 * `onHoverPiece({ uid, x, y } | null)` reports the piece under the cursor (or
 * under a tap, for touch) with canvas-relative CSS coordinates, so the parent
 * can float a fabric + price chip beside it. Hidden while orbiting.
 *
 * `focusPart` NARROWS the selection highlight (outline + glow) to one part of the
 * selected piece — `{ uid, role, groupKey, exclude }`: a non-null `groupKey`
 * matches that merged part group, else `role` matches EVERY group of that role
 * (targeting «Cojín» highlights all the cushions, not one of them), and the
 * reserved role `DRESSABLE_ROLE` matches everything EXCEPT the estructura and
 * the roles listed in the optional `exclude` (parts wearing their own fabric
 * pick, which the whole-piece pick would not repaint — see focusMeshes). Parts
 * are a 3D concern — the plan ignores it — and a filter that matches nothing
 * falls back to the whole piece, so a selected piece is never left
 * unhighlighted.
 *
 * `onModelFallback(rows)` reports pieces whose real mesh did NOT load, so they
 * are drawing as the procedural stand-in — `[{ pieceId, url }]`, once per model
 * per session. Silently showing a box where the customer expects their sofa is
 * the failure nobody thinks to report; the parent narrates it.
 *
 * Props: placed, resolvedById, mode ('2d'|'3d'), material (finish), selectedUid,
 * onSelect(uid|null), onMove(uid, x, y), onRotateTo(uid, deg), gesturesRef,
 * onHoverPiece(info|null), onModelFallback(rows), focusPart, className.
 */
export default function TogoStage({
  placed = [], resolvedById = {}, mode = '2d', material, selectedUid = null,
  onSelect, onMove, onRotateTo, gesturesRef, onHoverPiece,
  onSelectedScreenPos, onSelContour, className = '', dims = null,
  hintPieceId = null, onRotateLive, onTapPart, fabricByCode = null,
  chipUid = null, onChipAnchor, chipFollow = false, room = null, ground = null, insetLeft = 0, insetRight = 0,
  focusPart = null, onModelFallback,
}) {
  const mountRef = useRef(null);
  const api = useRef(null);
  // The gold selection outline's SVG, drawn IMPERATIVELY in the same rAF as the
  // canvas paint (reportSelContour). Routing the per-frame path through React
  // state left the stroke 1–3 frames behind the canvas during orbit/dolly — the
  // "outline jumps out of place with movement" bug; setAttribute('d') commits
  // in the SAME paint as renderer.render, so the stroke can never lag the sofa.
  const outlineSvgRef = useRef(null);
  const outlineCasingRef = useRef(null);
  const outlineGoldRef = useRef(null);
  // The on-plan DIMENSION brackets ride the same rail, for the same reason: the
  // geometry is screen-space, so a React round-trip left them a frame behind
  // the sofa and stepping in visible jumps through a pinch-zoom. Lines + both
  // notes are positioned by setAttribute/style in the SAME paint as
  // renderer.render (drawDimensions). React owns only the TEXT, which changes
  // on a layout edit, never per frame.
  const dimSvgRef = useRef(null);
  const dimPathRef = useRef(null);
  const dimTopRef = useRef(null);
  const dimLeftRef = useRef(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);   // first frame rendered → drop the loading veil

  // Latest props the imperative three loop reads without re-subscribing.
  const stateRef = useRef({ placed, resolvedById, mode, material, selectedUid, onSelect, onMove, onRotateTo, onHoverPiece, onSelectedScreenPos, onSelContour, dims, hintPieceId, onRotateLive, onTapPart, fabricByCode, chipUid, onChipAnchor, chipFollow, room, ground, focusPart, onModelFallback });
  stateRef.current = { placed, resolvedById, mode, material, selectedUid, onSelect, onMove, onRotateTo, onHoverPiece, onSelectedScreenPos, onSelContour, dims, hintPieceId, onRotateLive, onTapPart, fabricByCode, chipUid, onChipAnchor, chipFollow, room, ground, insetLeft, insetRight, focusPart, onModelFallback };

  /** The NET covered strip as a SIGNED fraction of the LIVE canvas width:
   *  (left − right) / width. Read at framing time, never cached: the caller
   *  knows its rail is 320 px and its pane 340, only the stage knows what
   *  fraction of the canvas that is right now, and it changes with every
   *  resize. POSITIVE = the left is covered more, so the piece slides toward
   *  screen-right (the rail case); NEGATIVE = the right pane wins and it slides
   *  toward screen-left; the two CANCEL when they match. Clamped BOTH ways so a
   *  narrow window can't push the piece off frame either side, and never NaN —
   *  a NaN would land in the camera position and blank the canvas. */
  const netInsetFrac = useCallback(() => {
    const w = api.current?.renderer?.domElement?.clientWidth || 0;
    const px = (stateRef.current.insetLeft || 0) - (stateRef.current.insetRight || 0);
    if (!(w > 0) || !Number.isFinite(px)) return 0;
    return Math.max(-0.45, Math.min(0.45, px / w));
  }, []);

  // placed + resolved → absolute-world pieces (NOT recentred): plan-x→world-x,
  // plan-y→world-z 1:1, so dragging one piece never shifts the others.
  const buildScene = useCallback(() => {
    const { placed: pl, resolvedById: byId, room: rm } = stateRef.current;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const pieces = (pl || []).map((p) => {
      const r = resolvePlacement(p, byId);
      const rot = norm360(p.rot);
      const w = Number(r.widthCm) || 0, d = Number(r.depthCm) || 0;
      const fp = footprintOf({ widthCm: w, depthCm: d }, rot);
      minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.y);
      maxX = Math.max(maxX, p.x + fp.w); maxZ = Math.max(maxZ, p.y + fp.h);
      return {
        uid: p.uid, pieceId: p.pieceId, widthCm: w, depthCm: d, form: inferTogoForm(r.label || r.name, w, d),
        x: (Number(p.x) || 0) + fp.w / 2, z: (Number(p.y) || 0) + fp.h / 2,
        rotationDeg: rot, fabricCode: p.material?.code || r.code || '', collection: r.collection || null, mesh: r.mesh || null,
        parts: r.parts || null, partMaterials: p.partMaterials || null,
        partFinishes: p.partFinishes || null,
        mountHeightCm: mountOf(r).heightCm,
      };
    });
    // Fold the room boundary into the FRAMING bounds so the camera frames the
    // whole space — critical when the room is set on a near-empty plan (it would
    // otherwise sit off-screen beside the default plan centre).
    //
    // Framing only. The dimension brackets read `bounds`, and those annotate the
    // numbers the deck prints — the assembled FURNITURE's footprint
    // (`resolveConfigurator.overallCm`), which knows nothing about a room. Fold
    // the room into the one the brackets read and they wrap the floor while the
    // notes still say the sofa: a 6 × 5 m room bracketed "310 × 100 cm".
    let fMinX = minX, fMaxX = maxX, fMinZ = minZ, fMaxZ = maxZ;
    if (Array.isArray(rm?.corners)) {
      for (const c of rm.corners) {
        if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
        fMinX = Math.min(fMinX, c.x); fMaxX = Math.max(fMaxX, c.x);
        fMinZ = Math.min(fMinZ, c.y); fMaxZ = Math.max(fMaxZ, c.y);
      }
    }
    const has = Number.isFinite(minX);        // something PLACED
    const framed = Number.isFinite(fMinX);    // …or a room to frame
    return {
      pieces,
      center: framed ? { x: (fMinX + fMaxX) / 2, z: (fMinZ + fMaxZ) / 2 } : { x: PLAN_W / 2, z: PLAN_H / 2 },
      // Bounding-sphere radius of the layout + room (rotation-invariant framing).
      radius: framed ? Math.max(45, Math.hypot(fMaxX - fMinX, fMaxZ - fMinZ) / 2) : 150,
      // Plan footprint AABB (world = plan coords) for the on-plan dimension
      // lines — PIECES ONLY, deliberately (see above).
      bounds: has ? { minX, maxX, minZ, maxZ } : null,
    };
  }, []);

  // The camera pose for a mode. Distance is derived from the FOV *and the canvas
  // aspect* so the layout fits with margin even on a tall portrait phone (where
  // the horizontal field of view is the tight one — the cause of the over-zoom).
  //
  // `netInset` (the poseFor param) is the SIGNED fraction of the canvas width
  // covered by chrome — left MINUS right — the PROPS are in CSS px and
  // `netInsetFrac()` converts, because the stage is the only thing that knows
  // how wide its canvas currently is. (both the material rail and the right
  // «TU DISEÑO» pane are OVERLAYS, not sibling columns — the canvas runs full
  // width under them). Centring on the canvas therefore centres the piece
  // behind whichever one is open: the rail slides out and the sofa is half
  // hidden; on desktop the pane covers the right and the piece reads pushed
  // under it with the visible middle empty. So the frame centres on the
  // VISIBLE strip BETWEEN them instead, by pushing the whole camera+target rig
  // sideways — both move together, so the view direction and the fitted
  // distance are untouched and only the piece's screen position changes.
  // A FRACTION, not pixels, because that is what makes the shift expressible
  // without knowing the canvas size: the visible half-width in world units is
  // `tan(halfFov)·dist·aspect` and it spans half the canvas, so covering a
  // fraction f of the full width means sliding by exactly that half-width × f
  // — the piece toward screen-right when f is positive (the left is covered),
  // toward screen-left when it is negative (the right is), and not at all when
  // the two balance. Reacting to their state is the point — a fixed bias would
  // be wrong the moment either one is stowed.
  //
  // `radius` is whatever this pose frames: the whole layout, or ONE selected
  // piece (see derivedPose) — `margin3d` is how much air to leave around it.
  const poseFor = useCallback((m, center, radius, aspect, netInset = 0, margin3d = MARGIN_3D_LAYOUT) => {
    const halfFov = (33 * Math.PI / 180) / 2;
    const fit = Math.max(0.4, Math.min(1, aspect || 1));     // the tighter axis
    // The distance that fits the FOOTPRINT (floor level) with ~22% margin.
    const fitDist = (radius * 1.22) / (Math.tan(halfFov) * fit);
    // 3D sits back further than the plan does. The public configurator floats
    // its material card (swatch + fabric + price) ABOVE the piece it belongs
    // to, and a frame that fit the piece as tightly as the plan does left the
    // card nowhere to sit — with one small piece selected it filled the
    // viewport and the card had to overlay it to stay on screen. The extra air
    // is the card's room; the zoom envelope below is unchanged, so leaning in
    // close is still a pinch away.
    const fitDist3d = (radius * margin3d) / (Math.tan(halfFov) * fit);
    // The shift is SIGNED and NEGATED, and the negation is measured truth, not
    // a convention: it slides the whole camera+target RIG, and a rig that moves
    // +d along screen-right renders the STATIONARY piece at −d. So centring the
    // piece in the visible strip means pushing the RIG TOWARD the covered side
    // — the left rail opens, the rig goes left, the piece reads right. Shipped
    // inverted once (the magnitude was verified, the direction never projected
    // through a camera), which put the piece further UNDER the chrome that
    // prompted the re-frame.
    // The guard is on there being a net inset AT ALL (`!== 0`), never on it
    // being positive — a `> 0` test silently eats the right pane's negative
    // shift and leaves the piece hiding under the pane.
    // `dist` must be the distance this pose's camera ACTUALLY sits at from what
    // it frames, which is NEITHER branch's fit distance — both lift the camera
    // by the furniture height. Feeding the un-lifted number in under-shifted
    // the plan by ~10% and a piece frame by ~5%, so each branch measures its
    // own before calling this.
    const shiftFor = (dist) => (netInset !== 0 && aspect > 0
      ? -(Math.tan(halfFov) * dist * aspect * netInset)
      : 0);
    return m === '2d'
      // DEAD straight-down. The top-down basis is supplied by camera.up=(0,0,-1).
      // CRITICAL: add the furniture HEIGHT to the camera height. A Togo is ~72 cm
      // tall, and from straight above its cushion TOPS sit that much closer to the
      // lens — perspective magnifies them, so framing the floor footprint alone
      // let the tops blow past the frame on a short (landscape) viewport where the
      // camera is already close. Lifting the camera by the height makes the TOP
      // surface the thing that fits the margin, so nothing clips in any aspect.
      ? (() => {
        const camY = fitDist + TOGO_HEIGHT_CM;               // the height it really flies at
        const dx = shiftFor(camY);
        return { px: center.x + dx, py: camY, pz: center.z, tx: center.x + dx, ty: 0, tz: center.z };
      })()
      // Low front-quarter angle. Pull back by the height too so a tall stack frames.
      : (() => {
        const camY = fitDist3d * 0.46 + TOGO_HEIGHT_CM * 0.5;
        const tY = radius * 0.15;
        // The TRUE camera→target distance, which is NOT fitDist3d: the pose
        // lifts the camera by half the furniture height and aims slightly above
        // the floor, and that fixed lift is a small fraction of a layout
        // pull-back but a big one of a single piece's. Measuring it here is
        // what makes the inset shift land on the visible centre at BOTH scales
        // (it was ~1% short framing the layout, ~5% short framing one piece).
        // The shift itself can't perturb it — it translates the whole rig.
        const dist3d = Math.hypot(fitDist3d * 0.32, camY - tY, fitDist3d * 0.83);
        // Screen-right for this pose: the camera looks from (+0.32, +0.83) in
        // x/z, so its right vector normalizes (0.83, 0, -0.32). Sliding camera
        // AND target along it moves the piece across the screen and nothing
        // else — `d` is signed, and negative slides the rig back along it.
        const d = shiftFor(dist3d);
        const n = Math.hypot(0.83, 0.32) || 1;
        const dx = d * (0.83 / n), dz = d * (-0.32 / n);
        return {
          px: center.x + fitDist3d * 0.32 + dx, py: camY, pz: center.z + fitDist3d * 0.83 + dz,
          tx: center.x + dx, ty: tY, tz: center.z + dz,
        };
      })();
  }, []);

  // ── WHAT THE CAMERA SHOULD BE FRAMING RIGHT NOW ─────────────────────────
  // THE single answer, asked by every re-frame there is (mode toggle,
  // selection, either inset, resize, add/remove, first paint). Selecting a
  // piece in 3D used to leave the camera in a half-state — neither the layout
  // frame nor a piece frame — because the selection opened the material drawer,
  // the drawer's inset re-framed the LAYOUT, and nothing ever framed the PIECE:
  // two glides raced for the one `l.tween` slot and whichever landed last won.
  // Routing every trigger through here is what makes that impossible; they can
  // no longer disagree about the destination.
  //   · 3D + a piece selected → THAT piece's frame (you tapped it to change it,
  //                             so the viewport goes to it).
  //   · 3D + nothing selected → the layout frame. Deselecting glides back.
  //   · 2D                    → always the layout frame. Selection must never
  //                             move the plan camera: it is the dealer's to
  //                             arrange, and it pans by gesture only.
  // Both cases are the SAME `poseFor` — same angle, same inset correction, only
  // the centre/radius/margin differ — so a piece frame is just a tighter layout
  // frame and the two can't drift apart in look or in behaviour.
  const derivedPose = useCallback((l, m, aspect) => {
    const net = netInsetFrac();
    const uid = stateRef.current.selectedUid;
    if (m === '3d' && uid != null && l?.group && l.THREE) {
      const pg = l.group.children.find((g) => g.userData.uid === uid);
      if (pg) {
        const box = new l.THREE.Box3().setFromObject(pg);
        // x/z only: the pose owns the vertical framing, exactly as it does for
        // the layout. The invisible full-footprint grab pad rides inside the
        // group, so this AABB IS the catalogue footprint — the same quantity
        // buildScene measures for the layout radius, hence the same 45 floor.
        if (!box.isEmpty()) {
          const r = Math.max(45, Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2);
          const c = { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 };
          return poseFor('3d', c, r, aspect, net, MARGIN_3D_PIECE);
        }
      }
      // Selected but not in the group yet (a rebuild is mid-flight, or it was
      // just deleted) → the layout frame, never a frame around nothing.
    }
    return poseFor(m, l.scene3d.center, l.scene3d.radius, aspect, net);
  }, [poseFor, netInsetFrac]);

  // Place the camera at a pose for a mode. In 2D we drive the camera DIRECTLY
  // (top-down `up`, lookAt, OrbitControls OFF) so it's a rock-solid plan view with
  // no polar-singularity wobble; in 3D OrbitControls owns it. This is the single
  // path every framing call goes through (mount, rebuild, resize, tween-end).
  const placeCamera = useCallback((l, pose, m) => {
    const { camera, controls } = l;
    // At rest the canvas is a GRABBABLE object in both modes — 2D drags the
    // plan, 3D orbits the scene. An arrow reads as an inert page.
    if (l.renderer?.domElement && !l.pan) l.renderer.domElement.style.cursor = 'grab';
    // Framing the camera takes it BACK from the dealer: whatever they had
    // orbited to is gone now, so the latch that protects a hand-held view from
    // an unasked-for re-snap (see the 'start' listener) starts over here.
    l.camUserMoved = false;
    if (m === '2d') {
      camera.up.set(0, 0, -1);                 // world -z is "up" on the plan
      camera.position.set(pose.px, pose.py, pose.pz);
      controls.target.set(pose.tx, pose.ty, pose.tz);
      controls.enabled = false;                // 2D = orbit off; drag/pan/pinch do the editing
      l.fitHeight = pose.py;                    // the framed camera height = pinch-zoom 1× reference
      camera.lookAt(pose.tx, pose.ty, pose.tz);
    } else {
      camera.up.set(0, 1, 0);
      camera.position.set(pose.px, pose.py, pose.pz);
      controls.target.set(pose.tx, pose.ty, pose.tz);
      // Zoom envelope for the orbit, derived from the LAYOUT's aspect-correct
      // framed distance (poseFor's own formula) — NOT from the pose being
      // applied, so a piece-focus pose doesn't shrink the envelope. Users can
      // lean in close but never clip inside the cushions, and never dolly out
      // until the sofa is a speck with no way to tell where it went.
      const r = l.scene3d?.radius || 150;
      const fit = Math.max(0.4, Math.min(1, camera.aspect || 1));
      const fitDist = (r * 1.22) / (Math.tan((33 * Math.PI / 180) / 2) * fit);
      controls.minDistance = 120;
      controls.maxDistance = fitDist * 2.6 + TOGO_HEIGHT_CM;
      controls.enabled = true;
      controls.enableRotate = true;
      controls.update();
    }
  }, []);

  // ── Glide the camera to a pose — THE shared tween every camera move rides
  // (mode toggle, add/delete re-frame, recenter, 3D piece focus). Owns the
  // l.tween slot, so a new glide cancels the one in flight and retargets from
  // wherever the camera currently is; snaps to the exact end pose via
  // placeCamera (which restores controls in 3D). Tweens the UP basis too, so a
  // 2D⇄3D move rotates smoothly instead of popping at the ends. Under reduced
  // motion (or dur 0) it places instantly — one frame, no motion.
  const tweenCameraTo = useCallback((l, to, m, dur = 700, after) => {
    const { camera, controls } = l;
    l.stopOrbitMomentum?.();              // damped inertia must not fight the glide
    controls.enabled = false;             // we drive the camera by hand mid-tween
    // The selection outline is camera-specific and the glide renders by hand
    // (never through renderNow, so the contour can't recompute mid-glide) —
    // hide it now so a stale silhouette doesn't hang mismatched over the
    // moving view. It recomputes, correct for the new pose, when the glide
    // settles (renderNow → reportSelContour re-derives the mask per frame).
    // Both layers: the imperative stroke AND the parent's anchor state.
    if (outlineSvgRef.current) outlineSvgRef.current.style.display = 'none';
    // The dimension brackets are screen-space too, and the glide renders by hand
    // — so they'd hang over the moving view annotating where the layout USED to
    // be. Same treatment; drawDimensions re-strokes them when the glide settles.
    if (dimSvgRef.current) dimSvgRef.current.style.display = 'none';
    if (dimTopRef.current) dimTopRef.current.style.display = 'none';
    if (dimLeftRef.current) dimLeftRef.current.style.display = 'none';
    stateRef.current.onSelContour?.(null);
    if (l.tween) cancelAnimationFrame(l.tween);
    if (dur <= 0 || prefersReducedMotion()) {
      l.tween = null;
      placeCamera(l, to, m);
      l.requestRender();
      after?.();
      return;
    }
    const from = { px: camera.position.x, py: camera.position.y, pz: camera.position.z, tx: controls.target.x, ty: controls.target.y, tz: controls.target.z };
    const uFrom = { x: camera.up.x, y: camera.up.y, z: camera.up.z };
    const uTo = m === '2d' ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
    let t0 = null;
    const step = (ts) => {
      if (!api.current) return;
      if (t0 == null) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;   // easeInOutQuad
      camera.position.set(from.px + (to.px - from.px) * e, from.py + (to.py - from.py) * e, from.pz + (to.pz - from.pz) * e);
      const ux = uFrom.x + (uTo.x - uFrom.x) * e, uy = uFrom.y + (uTo.y - uFrom.y) * e, uz = uFrom.z + (uTo.z - uFrom.z) * e;
      const ul = Math.hypot(ux, uy, uz) || 1;
      camera.up.set(ux / ul, uy / ul, uz / ul);
      const tx = from.tx + (to.tx - from.tx) * e, ty = from.ty + (to.ty - from.ty) * e, tz = from.tz + (to.tz - from.tz) * e;
      controls.target.set(tx, ty, tz);
      camera.lookAt(tx, ty, tz);
      // The glide renders by hand, so it must consume shadowsDirty itself. The
      // mode toggle just swapped the shadow CASTER (setShadowMode) — and on the
      // first plano→vista of a session the 3D key's shadow map has never been
      // rendered, so it is still null. Every fabric material samples it through
      // a shadow sampler, and drivers REJECT those draws (format/sampler
      // mismatch): the furniture vanished for the whole glide while the floor
      // (no shadow sampling) kept rendering, then popped back when the settle
      // frame's renderNow finally ran the shadow pass. Paying the pass on the
      // first glide frame keeps the piece visible AND shows the right shadow
      // (raking vs contact) through the move instead of the stale one.
      if (l.shadowsDirty) { l.renderer.shadowMap.needsUpdate = true; l.shadowsDirty = false; }
      l.renderer.render(l.scene, camera);
      if (p < 1) { l.tween = requestAnimationFrame(step); }
      else { l.tween = null; placeCamera(l, to, m); l.requestRender(); after?.(); }   // snap to the exact end pose + restore controls
    };
    l.tween = requestAnimationFrame(step);
  }, [placeCamera]);

  // ── Rebuild the furniture group (swatch colours + real meshes), tag each piece
  // group with its uid for raycasting, and apply the selection highlight. Does NOT
  // hard-cut the camera (a count change GLIDES to the new framing; a position-only
  // change never re-frames, so arranging stays stable).
  const rebuild = useCallback(async () => {
    const l = api.current; if (!l) return;
    // THE generation stamp. A rebuild awaits (textures, meshes) before it swaps
    // the group in, and edits do not wait their turn: pick a fabric whose
    // texture is cold, then drag — two runs are in flight, both reach the swap,
    // and the LAST ONE TO FINISH wins. That is whichever load happened to be
    // slower, not whichever edit came second, so the 3D can settle on the
    // pre-drag layout and stay there until the next edit. Every run captures
    // its number here and abandons itself after each await if a newer one has
    // started — it never disposes the live group, never installs a stale one.
    const gen = (l.rebuildGen = (l.rebuildGen || 0) + 1);
    const scene = buildScene();
    l.scene3d = scene;
    const { material: finish, selectedUid: sel } = stateRef.current;
    const codes = [...new Set(scene.pieces.flatMap((p) => [
      p.fabricCode,
      // Per-part picks need their swatch colours sampled too.
      ...Object.values(p.partMaterials || {}).map((m) => m?.code),
    ]).filter(Boolean))];
    // The dealer's pCon library beats the CDN swatch: a linked `rgb` IS the
    // exact fabric tone (no photo sampling, no network), and a `textureUrl`
    // loads the REAL tileable fabric the upholstery maps with.
    const fabrics = stateRef.current.fabricByCode || {};
    l.texCache ??= new Map();
    l.normCache ??= new Map();   // per-code weave-relief normal, derived from the scan
    l.swatchCache ??= new Map(); // per-code LR swatch tone — the customer's reference
    const [, loaded] = await Promise.all([
      Promise.all(codes.map(async (code) => {
        const fab = fabrics[code];
        // The LR SWATCH tone (the colour the customer picks in the card) — sampled
        // once per used code. It's the correction target for a real scan AND the
        // fallback flat/family-tint colour. Only a few codes are ever in a scene,
        // so the extra sample is cheap.
        if (!l.swatchCache.has(code)) {
          let sc = null;
          const url = swatchProxyUrl(code) || swatchUrl(code);
          if (url) {
            try { const t = await new l.THREE.TextureLoader().loadAsync(url); sc = sampleSwatchColor(t.image); t.dispose?.(); } catch { /* no swatch → skip correction */ }
          }
          l.swatchCache.set(code, sc);
        }
        const swInt = l.swatchCache.get(code);
        if (fab?.rgb && !l.colorCache.has(code)) {
          const n = parseInt(String(fab.rgb).replace('#', ''), 16);
          if (Number.isFinite(n)) l.colorCache.set(code, n);
        }
        // No .matz rgb → the swatch tone IS the flat/family colour.
        if (!l.colorCache.has(code) && swInt != null) l.colorCache.set(code, swInt);
        if (fab?.textureUrl && !l.texCache.has(code)) {
          try {
            const tex = await new l.THREE.TextureLoader().loadAsync(fab.textureUrl);
            let keep = tex;
            // Bake a tint when (a) family fallback — the URL is a SIBLING's
            // weave, re-tinted to this colour's tone — or (b) the scan itself
            // is a NEUTRAL grayscale detail map (pCon keeps those colours in
            // material.mat's dif): until the .mat is imported, tinting with
            // the fabric's own tone beats rendering a colourless silver piece
            // ("no color, just a texture map"). A .mat dif, once imported,
            // colours the raw map directly (exactly what pCon computes).
            const col = l.colorCache.get(code);
            const neutral = !fab.tint && !fab.pbr?.dif && col != null
              && (imageColorfulness(tex.image) ?? 999) < 14;
            if (fab.tint || neutral) {
              keep = makeTintedWeave(l.THREE, tex.image, col);
              tex.dispose?.();
            } else if (!fab.tint && fab.rgb && swInt != null) {
              // A REAL scan → anchor it to its LR swatch: the .matz diffuse is a
              // different capture (VIOLINE reads near-black, ROSE washed), so a
              // per-channel gain moves the texture's mean onto the swatch tone,
              // keeping the weave. Null when it already matches (SILVER) → raw scan.
              const matzInt = parseInt(String(fab.rgb).replace('#', ''), 16);
              const corrected = Number.isFinite(matzInt) ? correctScanToSwatch(l.THREE, tex.image, matzInt, swInt) : null;
              if (corrected) { keep = corrected; tex.dispose?.(); }
            }
            if (keep) {
              // The `!l.texCache.has(code)` that got us here was read BEFORE
              // the load: an overlapping rebuild can have finished the SAME
              // code meanwhile. Overwriting it would strand the winner's
              // texture on every material already bound to it, so the loser is
              // freed here and now — it never got the `shared` flag, so
              // disposeGroup would never have collected it either.
              if (l.texCache.has(code)) { keep.dispose?.(); return; }
              // CACHED across rebuilds — flag it shared or disposeGroup kills it
              // on the first group swap (any drag/select) and every later build
              // binds a dead texture (the "textures don't come through" bug).
              keep.userData.shared = true;
              l.texCache.set(code, keep);
              // Weave RELIEF (photorealism): the REAL pCon `bumps` normal map
              // when the .matz shipped one (fab.normalUrl — kept linear, NOT
              // re-tinted), else a normal DERIVED from the (possibly tinted)
              // diffuse. Tiled in lockstep with the albedo by makeFabricMaterial.
              let nrm = null;
              if (fab.normalUrl && !fab.tint) {
                try {
                  nrm = await new l.THREE.TextureLoader().loadAsync(fab.normalUrl);
                  nrm.colorSpace = l.THREE.NoColorSpace;   // normal data is linear, never sRGB
                } catch { nrm = null; }
              }
              if (!nrm) nrm = makeWeaveNormal(l.THREE, keep.image);
              if (nrm) { nrm.userData.shared = true; l.normCache.set(code, nrm); }
            } else l.texCache.set(code, null); // no tone to tint with → colour fallback
          } catch { l.texCache.set(code, null); /* broken texture → colour fallback */ }
        }
      })),
      loadTogoModels({ pieces: scene.pieces }),
    ]);
    // Unmounted, or SUPERSEDED by a newer rebuild — either way this run stops
    // here, before it can dispose the live group or install a stale one.
    // Nothing it built is orphaned: its textures went into the shared caches
    // (or were freed above when it lost that race) and its meshes are the
    // loader's session cache, which every renderer holds.
    if (api.current !== l || l.rebuildGen !== gen) return;

    // A piece whose real mesh never arrived is drawing as the PROCEDURAL
    // stand-in: the plan still works, but it is not the product the customer
    // believes they are looking at. Say so once per model — the console line
    // carries the id + URL (a 404 is findable from it), and the callback lets
    // the parent narrate it. A silent substitution is a bug nobody reports.
    // This surface is otherwise kept console-CLEAN on purpose (see the shadow
    // -map note below); this is the one warning that earns its place, because
    // it names a broken catalogue asset nothing else can see.
    const fallbacks = [];
    for (const p of scene.pieces) {
      const url = descForPiece(p)?.url;
      if (!url || loaded.modelFor(p) || reportedFallbacks.has(url)) continue;
      reportedFallbacks.add(url);
      fallbacks.push({ pieceId: p.pieceId ?? null, url });
      console.warn('[Togo] 3D model did not load — drawing the simplified shape', { pieceId: p.pieceId, url });
    }
    if (fallbacks.length) stateRef.current.onModelFallback?.(fallbacks);

    // Snapshot each OLD piece's upholstery colour before the swap, so a fabric
    // change can CROSSFADE to its new colour instead of hard-cutting — the try-a-
    // fabric moment is the configurator's hero interaction.
    const prevColors = new Map();
    if (l.group) {
      l.group.children.forEach((pg) => {
        const uid = pg.userData.uid; if (uid == null) return;
        const m = firstPieceMaterial(pg);
        if (m?.color) prevColors.set(uid, m.color.clone());
      });
    }
    if (l.group) { l.scene.remove(l.group); disposeGroup(l.group); }
    const group = buildTogoGroup(l.deps, scene, {
      ...DEFAULT_FINISH, ...(finish || {}), normalMap: l.quilt, grainMap: l.grain,
      colorFor: (c) => (l.colorCache.has(c) ? l.colorCache.get(c) : null),
      textureFor: (c) => l.texCache?.get(c) || null,
      // The .mat PBR port riding with each linked texture (fabricByCode.pbr):
      // pCon-fidelity roughness/specular/diffuse + the map's physical size.
      pbrFor: (c) => fabrics[c]?.pbr || null,
      // The scan-derived weave relief (cached per code, shared-flagged).
      normalFor: (c) => l.normCache?.get(c) || null,
      modelFor: loaded.modelFor,
    });
    // Tag every object with its piece uid (raycast → selection/drag), and give
    // each piece an INVISIBLE full-footprint grab pad so the WHOLE tile is
    // draggable — not just where the raycast happens to land on upholstery. The
    // channeled Togo has gaps between cushions; tapping a groove would otherwise
    // miss the mesh, hit the floor, and feel like "the piece won't move". The pad
    // sits flat just above the floor, sized to the catalogue footprint, and rides
    // inside the (already-rotated) piece group so it always matches the tile.
    const { THREE } = l;
    group.children.forEach((pg, i) => {
      const sp = scene.pieces[i];
      const uid = sp?.uid;
      pg.userData.uid = uid;
      pg.userData.pieceId = sp?.pieceId;   // hotbar hover-link answers on the plan
      pg.traverse((o) => { o.userData.uid = uid; });
      const w = Number(sp?.widthCm) || 0, d = Number(sp?.depthCm) || 0;
      if (w > 0 && d > 0) {
        const pad = new THREE.Mesh(
          new THREE.PlaneGeometry(w, d),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
        );
        pad.rotation.x = -Math.PI / 2;     // lie flat on the floor
        // Just above ground, under the cushions — a seat-mounted accessory's
        // pad rides at ITS height so the whole (elevated) tile stays grabbable.
        pad.position.y = 2 + (Number(sp?.mountHeightCm) || 0);
        pad.userData.uid = uid;
        pad.userData.pad = true;
        pg.add(pad);
      }
    });
    l.group = group;
    l.scene.add(group);
    // The sandbox floor is unbounded: slide the light rig + shadow frustum with
    // the layout so a build dragged far from the origin keeps its ground shadow.
    l.retargetStage?.(scene.center, scene.radius);
    l.shadowsDirty = true;
    applyHighlight(l, sel);

    // ── Scene juice (all through addAnim, so reduced-motion snaps to the end
    // state and the motor stops the moment everything is at rest). ──
    const prevUids = l.prevUids;                       // undefined on the very first build
    l.prevUids = new Set(scene.pieces.map((p) => p.uid));
    if (prevUids) {
      group.children.forEach((pg) => {
        const uid = pg.userData.uid;
        if (uid == null) return;
        // A NEW piece drops in and settles (skip when it's already mid-gesture).
        if (!prevUids.has(uid)) {
          l.addAnim?.(`add:${uid}`, 340, (p) => {
            const g = l.group?.children.find((c) => c.userData.uid === uid);
            if (!g || l.drag?.uid === uid) return;
            const e = Math.min(easeOutBack(p), 1.05);      // soft overshoot, capped
            g.scale.setScalar(0.62 + 0.38 * e);
            g.position.y = 14 * (1 - Math.min(1, p * 1.2));
          }, () => {
            const g = l.group?.children.find((c) => c.userData.uid === uid);
            if (g && l.drag?.uid !== uid) { g.scale.setScalar(1); g.position.y = 0; }
          });
          return;
        }
        // A RE-UPHOLSTERED piece crossfades from its old colour to the new one.
        const from = prevColors.get(uid);
        const mat = firstPieceMaterial(pg);
        if (!from || !mat?.color || mat.color.equals(from)) return;
        const to = mat.color.clone();
        mat.color.copy(from);
        mat.sheenColor?.copy(from);                    // sheen is tinted to the base — keep them locked
        l.addAnim?.(`fab:${uid}`, 280, (p) => {
          const g = l.group?.children.find((c) => c.userData.uid === uid);
          const m2 = g ? firstPieceMaterial(g) : null;
          if (!m2?.color) return;
          m2.color.lerpColors(from, to, 1 - (1 - p) ** 3);
          m2.sheenColor?.copy(m2.color);
        }, undefined, false);   // colour-only — no shadow re-render
      });
    }

    // A moved drag committed while its put-down settle is mid-flight: the fresh
    // group starts at y=0 (a hard pop). Re-lift it to the settle height so the
    // live 'drop:' anim (which re-resolves by uid) finishes the descent on the
    // NEW group — the put-down stays one continuous motion across the swap.
    if (l.dropSettle) {
      const { uid, y } = l.dropSettle;
      l.dropSettle = null;
      const g = group.children.find((c) => c.userData.uid === uid);
      if (g && y > 0 && l.hasAnim?.(`drop:${uid}`)) g.position.y = y;
    }

    // Frame the camera on the layout when the piece COUNT changes (add/remove) —
    // so a new piece is always in view — but NOT on a position-only change (a drag
    // commit), and never mid-gesture. First build snaps (no intro tween); after
    // that the camera GLIDES to the new framing (tweenCameraTo cancels any tween
    // already in flight, so rapid add-add retargets from wherever it is).
    if (scene.pieces.length !== l.framedCount && !l.drag && !l.pinch) {
      const first = l.framedCount < 0;
      l.framedCount = scene.pieces.length;
      // The DERIVED pose, not the layout one: with a piece selected the camera
      // is framing THAT piece, and a rebuild must re-assert where the camera
      // already belongs rather than yank it back out to the whole layout.
      const pose = derivedPose(l, stateRef.current.mode, l.camera.aspect);
      if (first) placeCamera(l, pose, stateRef.current.mode);
      else tweenCameraTo(l, pose, stateRef.current.mode, 380);
    }
    l.requestRender();
  }, [buildScene, derivedPose, placeCamera, tweenCameraTo]);

  // The (single) fabric material of a piece group — every mesh in a piece shares
  // one; the invisible grab pad is skipped.
  function firstPieceMaterial(pg) {
    let mat = null;
    pg.traverse((o) => { if (!mat && o.isMesh && !o.userData?.pad && o.material?.emissive) mat = o.material; });
    return mat;
  }

  const easeOutBack = (p) => { const c = 1.70158; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; };

  // Set one piece group's warm emissive glow (0 = off). The single writer every
  // glow state goes through, so they can't half-mix.
  function setEmissive(pg, intensity) {
    if (!pg) return;
    const seen = new Set();
    pg.traverse((o) => {
      if (o.userData?.pad) return;
      const m = o.material; if (!m || !m.emissive || seen.has(m)) return; seen.add(m);
      m.emissive.setHex(intensity > 0 ? 0x3a342b : 0x000000);
      m.emissiveIntensity = intensity;
    });
  }

  // Per-PART glow: brighten ONLY the meshes of `role` inside one piece (the
  // raycast hover cue — "this is what a click will edit"), the rest of the
  // piece staying at its base glow. Tagged roles carry their own material
  // instance, so the boost never leaks to the other parts.
  function setPartEmissive(pg, role, hi, lo) {
    if (!pg) return;
    pg.traverse((o) => {
      if (!o.isMesh || o.userData?.pad) return;
      const m = o.material; if (!m || !m.emissive) return;
      const i = (o.userData?.partRole || 'base') === role ? hi : lo;
      m.emissive.setHex(i > 0 ? 0x3a342b : 0x000000);
      m.emissiveIntensity = i;
    });
  }

  // The meshes `focusPart` narrows the highlight to, or null for "the whole
  // piece" — the ONE resolver BOTH highlight channels read (the outline's mask
  // pass and the glow), so they can never disagree about what is focused. The
  // gating is stateful (this piece, in 3D, and it is the selected one); the
  // FILTER itself is pure and lives in `focusMeshes` below, where it is pinned.
  function focusMeshesFor(pg) {
    const st = stateRef.current;
    const fp = st.focusPart;
    if (!fp || st.mode !== '3d' || st.selectedUid == null) return null;
    if (fp.uid == null || fp.uid !== st.selectedUid || pg?.userData?.uid !== fp.uid) return null;
    // The prop IS the scope — `groupKey`/`role`/`exclude` ride through as one
    // object, so a new focus field never needs a second hop to reach the filter.
    return focusMeshes(pieceMeshes(pg), fp);
  }

  // The highlightable meshes of a piece — pads (drag shadows) and the contour
  // clone are chrome, not upholstery. ONE predicate for every `focusMeshes`
  // caller: a second copy of it drifting would light the contour overlay.
  function pieceMeshes(pg) {
    const all = [];
    pg?.traverse?.((o) => { if (o.isMesh && !o.userData?.pad && !o.userData?.contour) all.push(o); });
    return all;
  }

  // Glow only the FOCUSED meshes of a piece, the rest at `lo`. Sibling of
  // setPartEmissive over an already-resolved set (so it covers both filters).
  // Unmatched first, matched second: fabric materials are per ROLE, not per
  // group, so a material instance straddling the filter's edge ends BRIGHT — a
  // focused mesh never loses its glow, at worst a sibling gains one.
  function setMeshEmissive(pg, meshes, hi, lo) {
    if (!pg) return;
    const set = meshes instanceof Set ? meshes : new Set(meshes || []);
    const apply = (o, i) => {
      const m = o.material; if (!m || !m.emissive) return;
      m.emissive.setHex(i > 0 ? 0x3a342b : 0x000000);
      m.emissiveIntensity = i;
    };
    pg.traverse((o) => { if (o.isMesh && !o.userData?.pad && !set.has(o)) apply(o, lo); });
    pg.traverse((o) => { if (o.isMesh && !o.userData?.pad && set.has(o)) apply(o, hi); });
  }

  // Recompute every piece's glow from the current interaction state: selection
  // (strong), pointer hover on the plan (faint — the "you can grab this" cue),
  // hotbar hover-link (faint — the palette tile's placed siblings answer back).
  function refreshGlow(l) {
    if (!l?.group) return;
    const sel = stateRef.current.selectedUid;
    const hint = stateRef.current.hintPieceId;
    const hp = l.hoverPart;   // { uid, role, partKey } — the raycast part under the pointer
    // 3D selection reads as the gold OUTLINE (like plan view), not a colour
    // glow — so the selected piece carries no base emissive in 3D. The
    // transient hover part-cue below still fires (it names what a click edits).
    const in3d = stateRef.current.mode === '3d';
    // A RESTING focus (the dressable highlight a mere selection wears) is not a
    // commitment — it IS the selection. Only a COMMITTED focus (an open picker:
    // a part role, or an estructura group) outranks the transient hover cue;
    // giving every focus that precedence made the hover branch unreachable on
    // the selected piece, so hovering its legs lit nothing — and the estructura,
    // which the resting highlight excludes by design, read as dead.
    const fp = stateRef.current.focusPart;
    const resting = fp?.role === DRESSABLE_ROLE;
    l.group.children.forEach((pg) => {
      const isSel = sel != null && pg.userData.uid === sel;
      const isHover = !isSel && l.hoverUid != null && pg.userData.uid === l.hoverUid;
      const isHint = !isSel && !isHover && hint != null && pg.userData.pieceId === hint;
      const base = isSel ? (in3d ? 0 : 0.5) : isHover ? 0.2 : isHint ? 0.22 : 0;
      const focus = focusMeshesFor(pg);
      const hovering = !!hp && pg.userData.uid === hp.uid;
      const hi = Math.max(0.5, base + 0.15);
      // A COMMITTED part focus outranks the transient hover cue on the same
      // piece — two lit parts on one piece read as two selections.
      if (focus && !(resting && hovering)) setMeshEmissive(pg, focus, hi, base);
      // The hovered PART outshines the rest of its piece — the cue for "a click
      // edits THIS" (cushion, bolster, arm… or the base upholstery). Scoped to
      // exactly WHAT THE CLICK OPENS: an estructura opens the merged GROUP the
      // ray landed on (its meshes carry the builder's key), every other role
      // opens all of that role. No key (or a stale one) → the role, via
      // focusMeshes' no-vanish null.
      else if (hovering) {
        const g = hp.role === 'structure' ? focusMeshes(pieceMeshes(pg), { groupKey: hp.partKey }) : null;
        if (g) setMeshEmissive(pg, g, hi, base);
        else setPartEmissive(pg, hp.role, hi, base);
      } else setEmissive(pg, base);
    });
    l.requestRender();
  }

  // Selection changed → refresh the glow AND re-snapshot the silhouette geometry
  // (the screen-space contour overlay reprojects it on the next render).
  function applyHighlight(l, _sel) {
    if (!l?.group) return;
    refreshGlow(l);
    l.requestRender();
  }

  // Snap-engage flash: while dragging, the piece's warm selection glow brightens
  // the instant it clicks flush to a neighbour (and relaxes when it unlocks) —
  // visible feedback for the edge snap, paired with a tiny haptic tick. The
  // dragged piece is always the selected one, so releasing back to 0.5 restores
  // the plain selection highlight. Also used by the rotate gesture's detents.
  function setSnapGlow(l, pg, on) {
    if (!pg) return;
    l?.cancelAnim?.('selpulse');           // the pulse must not fight the flash
    setEmissive(pg, on ? 1.0 : 0.5);
  }

  // Re-skin (finish change) without rebuilding geometry.
  const reskin = useCallback(() => {
    const l = api.current; if (!l || !l.group) return;
    const f = { ...DEFAULT_FINISH, ...(stateRef.current.material || {}) };
    const rep = f.repeat || 3, seen = new Set();
    l.group.traverse((o) => {
      const m = o.material; if (!m || seen.has(m)) return; seen.add(m);
      // A real SCAN keeps its source-matte finish (scanFinish, set by
      // makeFabricMaterial): the finish knobs style the procedural velvet
      // only — re-stamping sheen here is how the gloss crept back onto scans.
      // Part-finish materials (metal/lacquer legs, partFinish) are not fabric
      // at all — cloth roughness + a velvet sheen lobe would repaint them.
      // Factory materials (a product's OWN baked bitmap, factoryFinish) even
      // less so: reskin's repeat.set would tile the product photo 3×3 on the
      // first fabric change and cloth knobs would flatten its finish.
      if (m.userData?.scanFinish || m.userData?.partFinish || m.userData?.factoryFinish) return;
      if ('roughness' in m) m.roughness = f.roughness;
      if ('sheen' in m) m.sheen = f.sheen;
      if ('sheenRoughness' in m) m.sheenRoughness = f.sheenRoughness;
      if (m.normalScale) m.normalScale.set(f.normalScale, f.normalScale);
      if (m.map) m.map.repeat.set(rep, rep);
    });
    l.requestRender();
  }, []);

  // ── Mount: renderer / scene / camera / controls / stage, pointer editing. ──
  useEffect(() => {
    let alive = true; let ro = null; let raf = 0; let l_cleanupResize = null;
    (async () => {
      let mods;
      try {
        mods = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/controls/OrbitControls.js')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
          safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        ]);
      } catch { if (alive) setFailed(true); return; }
      const mount = mountRef.current; if (!alive || !mount) return;
      const [THREE, { OrbitControls }, { RoomEnvironment }, { RoundedBoxGeometry }] = mods;
      const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };
      const w = mount.clientWidth || 640, h = mount.clientHeight || 440;

      let renderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
      catch { if (alive) setFailed(true); return; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;
      // PCF, not PCFSoft: three r184 deprecated PCFSoftShadowMap and rewrites it
      // to PCFShadowMap on the first shadow pass anyway — asking for it only buys
      // a console warning on a CUSTOMER-facing surface (the configurator embeds
      // in the dealer's Shopify site). Naming the fallback keeps the pixels
      // identical and the console clean.
      renderer.shadowMap.type = THREE.PCFShadowMap;
      // Shadows render ON DEMAND: camera-only frames (orbit/pan/pinch/tween) skip
      // the whole shadow pass — free headroom on mobile. Anything that MOVES the
      // world sets l.shadowsDirty and renderNow refreshes the map on that frame.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      renderer.toneMapping = THREE.NeutralToneMapping;
      // The canvas ALWAYS fills its container via CSS (width/height:100%); the
      // drawing buffer is reconciled to that displayed size every frame by
      // syncSize() below. This is the robust "resizeRendererToDisplaySize"
      // pattern — it self-corrects no matter what changed the size (rotation,
      // iOS URL-bar show/hide, a missed ResizeObserver tick) so the viewport can
      // never drift off-centre or out of aspect.
      renderer.domElement.style.cssText = 'display:block;outline:none;touch-action:none;width:100%;height:100%';
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(33, w / h, 1, 20000);
      const controls = new OrbitControls(camera, renderer.domElement);
      // Inertia: the orbit keeps a touch of momentum after the finger lifts and
      // eases while held — the single biggest "premium 3D" feel lever. Driven by
      // the motor loop below (render-on-demand stays intact: the loop provably
      // stops once the damped velocity settles). Skipped under reduced motion —
      // then the view moves only exactly as far as the finger did.
      controls.enableDamping = !prefersReducedMotion();
      controls.dampingFactor = 0.085;
      // Wheel/pinch dolly anchors under the POINTER (like the 2D pinch already
      // does) instead of the screen centre — zooming "into" a seam just works.
      controls.zoomToCursor = true;
      // 3D: left-drag orbits, wheel/pinch dollies, RIGHT-drag (or two-finger drag)
      // pans — OrbitControls' default mouseButtons already map RIGHT→PAN, so just
      // enabling pan lights it up. Screen-space panning (the default) keeps the
      // drag 1:1 with the cursor at any orbit angle; a double-click on empty space
      // re-frames the layout if a pan wanders off. In 2D this whole controls
      // object is disabled (placeCamera) — drag/pan/pinch do the editing there.
      controls.enablePan = true;
      controls.maxPolarAngle = Math.PI * 0.495;

      // Reconcile the drawing buffer + camera aspect to the canvas's CURRENT
      // displayed size, and re-frame so the layout stays centred for the new
      // aspect. Returns true if anything changed. Called at the top of every
      // render so a stale size is fixed before it's ever shown.
      const _sz = new THREE.Vector2();
      const syncSize = () => {
        const l = api.current; if (!l) return false;
        const cw = renderer.domElement.clientWidth || mount.clientWidth;
        const ch = renderer.domElement.clientHeight || mount.clientHeight;
        if (!cw || !ch) return false;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.getSize(_sz);
        if (Math.round(_sz.x) === cw && Math.round(_sz.y) === ch && renderer.getPixelRatio() === dpr) return false;
        renderer.setPixelRatio(dpr);
        renderer.setSize(cw, ch, false);              // buffer only — CSS stays 100%
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        // Re-frame for the new aspect — on the DERIVED pose, so a resize with a
        // piece selected keeps framing that piece. Never once the dealer has
        // taken the camera by hand (camUserMoved): the buffer and the aspect
        // still get fixed above, but their view is theirs until they select
        // something, move an overlay, or ask for the recenter rescue.
        if (!l.drag && !l.tween && !l.pinch && !l.camUserMoved) {
          placeCamera(l, derivedPose(l, stateRef.current.mode, camera.aspect), stateRef.current.mode);
        }
        return true;
      };

      // Report the selected piece's on-screen box (centre-x, bottom-y in CSS px)
      // so the parent can float a control beneath it. Only in 2D, not mid-drag,
      // and only when it actually moves — so it never churns React every frame.
      const _selBox = new THREE.Box3(); const _v = new THREE.Vector3();
      let _lastSel = { uid: undefined, x: -1, y: -1 };
      const reportSelPos = () => {
        const cb = stateRef.current.onSelectedScreenPos; if (!cb) return;
        const l = api.current; if (!l) return;
        const uid = stateRef.current.selectedUid;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        let pos = null;
        if (uid != null && l.group && stateRef.current.mode === '2d' && !l.tween && !l.drag) {
          const pg = l.group.children.find((g) => g.userData.uid === uid);
          if (pg) {
            _selBox.setFromObject(pg);
            let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
              _v.set(xi ? _selBox.max.x : _selBox.min.x, yi ? _selBox.max.y : _selBox.min.y, zi ? _selBox.max.z : _selBox.min.z).project(camera);
              const sx = (_v.x * 0.5 + 0.5) * cw, sy = (-_v.y * 0.5 + 0.5) * ch;
              if (sx < minX) minX = sx; if (sx > maxX) maxX = sx; if (sy > maxY) maxY = sy;
            }
            pos = { x: (minX + maxX) / 2, y: maxY };
          }
        }
        const px = pos ? pos.x : -1, py = pos ? pos.y : -1;
        if (_lastSel.uid !== uid || _lastSel.x !== px || _lastSel.y !== py) {
          _lastSel = { uid, x: px, y: py };
          cb(pos ? { x: px, y: py } : null);
        }
      };

      // The 3D hover chip's anchor, recomputed EVERY rendered frame while a chip
      // is up (chipUid) — so it tracks the piece through wheel-zoom, damped
      // orbit settle and auto-rotate, not just on pointer move. The parent
      // positions the chip IMPERATIVELY from this (no React-state lag), so it
      // rides in lockstep with the canvas instead of swimming a frame behind
      // it ("card jitters when moving the view").
      //
      // THE CARD FOLLOWS THE PIPETTE (owner, 2026-08-01: «make the material
      // popup follow the pipette»). While a picker is open on a PART, the card
      // is that part's card — so it anchors over the FOCUS MESHES, the very set
      // the gold outline is tracing, instead of floating at the top of a sofa
      // whose cushions are half a screen lower. Same projection, narrower box:
      // one source for both, so the card can never sit off the line. `dressable`
      // and a bare selection keep the whole-piece anchor — their subject IS the
      // piece — and a chip on a piece OTHER than the focused one resolves to no
      // focus and takes the same untouched path.
      //
      // …AND THE CARD FOLLOWS THE MOUSE (owner, 2026-08-01: «el popup no está
      // siguiendo el mouse»). A HOVER card is a cursor affordance: while the ray
      // is on a piece the parent asks for follow mode (`chipFollow`) and the
      // anchor IS the pointer — no projection, no bbox, so it costs nothing to
      // emit on every pointermove (which is what `onMovePtr` does, because the
      // scene renders ON DEMAND and a mouse crossing a still sofa schedules no
      // frame at all). The cursor point is remembered (`l.chipPtr`) rather than
      // read live, so the card FREEZES where it is the moment the pointer
      // leaves the piece instead of fleeing the hand reaching for its buttons —
      // the same courtesy the parent's 240 ms grace already extends. The
      // ANCHORED paths below are untouched and take over as soon as the parent
      // drops the hover: a pipette target (its focus meshes) or a bare
      // selection (the piece's top-centre).
      const _chipBox = new THREE.Box3();
      let _lastChip = { uid: undefined, key: '', follow: false, x: -1, y: -1 };
      const reportChipAnchor = () => {
        const cb = stateRef.current.onChipAnchor; if (!cb) return;
        const l = api.current; if (!l || !l.group) return;
        const uid = stateRef.current.chipUid;
        if (uid == null || stateRef.current.mode !== '3d') return;
        const ptr = stateRef.current.chipFollow ? l.chipPtr : null;
        if (ptr) {
          const px = Math.round(ptr.x), py = Math.round(ptr.y);
          if (!_lastChip.follow || _lastChip.uid !== uid || _lastChip.x !== px || _lastChip.y !== py) {
            _lastChip = { uid, key: '', follow: true, x: px, y: py };
            cb({ x: px, y: py, follow: true });
          }
          return;
        }
        const pg = l.group.children.find((g) => g.userData.uid === uid);
        if (!pg) return;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        const fp = stateRef.current.focusPart;
        const focus = fp && fp.role !== DRESSABLE_ROLE ? focusMeshesFor(pg) : null;
        // NO-VANISH, same rule as the outline: a subset that boxes to nothing
        // falls back to the piece rather than parking the card at a NaN.
        let scoped = false;
        if (focus) {
          _chipBox.makeEmpty();
          for (const m of focus) _chipBox.expandByObject(m);
          scoped = !_chipBox.isEmpty();
        }
        if (!scoped) _chipBox.setFromObject(pg);
        let minX = Infinity, maxX = -Infinity, minY = Infinity;
        for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
          _v.set(xi ? _chipBox.max.x : _chipBox.min.x, yi ? _chipBox.max.y : _chipBox.min.y, zi ? _chipBox.max.z : _chipBox.min.z).project(camera);
          const sx = (_v.x * 0.5 + 0.5) * cw, sy = (-_v.y * 0.5 + 0.5) * ch;
          if (sx < minX) minX = sx; if (sx > maxX) maxX = sx; if (sy < minY) minY = sy;
        }
        const x = Math.round((minX + maxX) / 2), y = Math.round(minY);
        // The focus rides the dedup KEY: retargeting the pipette moves the card
        // even when the two boxes happen to share a top-centre pixel, which a
        // pure x/y compare would swallow (and the card would stay on the part
        // the visitor just left).
        const key = scoped ? `${fp.role ?? ''}:${fp.groupKey ?? ''}` : '';
        if (_lastChip.follow || _lastChip.uid !== uid || _lastChip.key !== key || _lastChip.x !== x || _lastChip.y !== y) {
          _lastChip = { uid, key, follow: false, x, y };
          cb({ x, y });
        }
      };

      // ── On-plan DIMENSION brackets ──────────────────────────────────────
      // Project the layout's footprint to a screen-space rect and stroke the
      // brackets from it, IN THIS FRAME. This used to hand the rect to React and
      // let the parent render the brackets, which put them a frame behind the
      // canvas — and because the hand-off was gated on the ROUNDED rect, a
      // smooth pinch-zoom moved the sofa continuously while the brackets waited
      // for a whole-pixel change and then jumped. Same fix as the gold outline:
      // no React in the loop, and no rounding.
      const DIM_PAD = 18;    // bracket line's offset from the layout edge
      const DIM_TICK = 5;    // end-tick half-length
      const drawDimensions = () => {
        const svg = dimSvgRef.current, topEl = dimTopRef.current, leftEl = dimLeftRef.current;
        if (!svg || !topEl || !leftEl) return;
        const hide = () => {
          svg.style.display = 'none';
          topEl.style.display = 'none';
          leftEl.style.display = 'none';
        };
        const d = stateRef.current.dims;
        const l = api.current;
        if (!d || !l) return hide();
        const bb = l.scene3d?.bounds;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        // Hidden in 3D, and while a tween or drag is in flight (the readout
        // would annotate a footprint that is still moving).
        if (!bb || stateRef.current.mode !== '2d' || l.tween || l.drag || cw <= 0 || ch <= 0) return hide();

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const x of [bb.minX, bb.maxX]) for (const z of [bb.minZ, bb.maxZ]) {
          _v.set(x, 0, z).project(camera);
          const sx = (_v.x * 0.5 + 0.5) * cw, sy = (-_v.y * 0.5 + 0.5) * ch;
          if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return hide();
        const x1 = minX, x2 = maxX, y1 = minY, y2 = maxY;

        // Each note sits ON its own bracket line, centred at the midpoint —
        // the chip's near-opaque ground is what interrupts the hairline, the
        // way every drafting/planner surface does it. Both notes are the SAME
        // horizontal pill: the depth note used to be a sideways-text capsule
        // (writing-mode: vertical-rl in a px-0.5 shell) and on the owner's
        // phone it rendered as a cramped, misshapen chip that read as a bug
        // (screenshot 2026-07-30) — a rotated tag is drafting-correct but
        // this is a customer surface, not a blueprint. Measured, not assumed:
        // the notes are real DOM, so their own box decides the room they need.
        const topH = topEl.offsetHeight || 20;
        const leftW = leftEl.offsetWidth || 20;
        // `insetLeft` is whatever chrome owns the left edge (the piece rail) —
        // a note tucked under it rendered as "0 c".
        const inset = Number(d.insetLeft) || 0;
        // No room for the straddling chip? Put the bracket on the OPPOSITE
        // side of the layout rather than let the note fall off the viewport
        // (or under the rail).
        const flipY = y1 - DIM_PAD - topH / 2 < 2;
        const flipX = x1 - DIM_PAD - leftW / 2 < inset + 2;
        const yLine = flipY ? y2 + DIM_PAD : y1 - DIM_PAD;
        const xLine = flipX ? x2 + DIM_PAD : x1 - DIM_PAD;

        const seg = (ax, ay, bx, by) => `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`;
        dimPathRef.current?.setAttribute('d', [
          seg(x1, yLine, x2, yLine),                                   // width rule
          seg(x1, yLine - DIM_TICK, x1, yLine + DIM_TICK),             // …its end ticks
          seg(x2, yLine - DIM_TICK, x2, yLine + DIM_TICK),
          seg(xLine, y1, xLine, y2),                                   // depth rule
          seg(xLine - DIM_TICK, y1, xLine + DIM_TICK, y1),
          seg(xLine - DIM_TICK, y2, xLine + DIM_TICK, y2),
        ].join(''));
        svg.style.display = '';

        topEl.style.left = `${((x1 + x2) / 2).toFixed(1)}px`;
        topEl.style.top = `${yLine.toFixed(1)}px`;
        topEl.style.transform = 'translate(-50%, -50%)';
        topEl.style.display = '';

        leftEl.style.left = `${xLine.toFixed(1)}px`;
        leftEl.style.top = `${((y1 + y2) / 2).toFixed(1)}px`;
        leftEl.style.transform = 'translate(-50%, -50%)';
        leftEl.style.display = '';
      };

      // The selected piece's outline — the EXACT outer envelope of its projection,
      // reported to the parent as CSS-pixel points → it strokes a thick highlight
      // that hugs the model. The one authority on which screen points the piece
      // covers is the rasterizer itself, so each frame renders the PIECE ALONE
      // (white, unlit, double-sided) through the LIVE camera's sub-frustum over
      // its screen bbox into a small offscreen target, and `maskToOutline` traces
      // the readback — the true silhouette, every concavity included, robust to
      // any dealer mesh (open surfaces, self-intersecting parts). The sample
      // lattice is FIXED in viewport px (rect snapped to cell multiples), so a
      // translating piece translates its mask rigidly — no re-anchoring jitter;
      // stateless per frame — exact through any zoom.
      const MASK_LAYER = 30;                       // reserved for the mask pass
      const MASK_MAX = 512;                        // offscreen target side (px)
      const MASK_CELL = 2;                         // CSS px per mask cell (min)
      const _mv = new THREE.Vector3();
      const _mbox = new THREE.Box3();
      // `focus` (from focusMeshesFor) narrows the pass to a part's meshes — the
      // outline then hugs every island of it (all the cushions) instead of the
      // piece. Null = the whole piece, byte-for-byte the original pass.
      const maskOutlineFor = (pg, cw, ch, focus = null) => {
        const l = api.current;
        if (!l.maskRT) {
          l.maskRT = new THREE.WebGLRenderTarget(MASK_MAX, MASK_MAX, { depthBuffer: false, stencilBuffer: false });
          l.maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false, fog: false });
          l.maskBuf = new Uint8Array(MASK_MAX * MASK_MAX * 4);
          l.maskClear = new THREE.Color();
        }
        // The piece's screen bbox through the live camera (its world AABB's 8
        // corners projected — conservative, and cheap per frame). It must cover
        // exactly what the pass DRAWS: a focused subset sized off the whole
        // piece would spend its lattice on empty cells and trace the part at a
        // fraction of the resolution.
        if (focus) { _mbox.makeEmpty(); for (const o of focus) _mbox.expandByObject(o); }
        else _mbox.setFromObject(pg);
        if (_mbox.isEmpty()) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < 8; i++) {
          _mv.set(i & 1 ? _mbox.max.x : _mbox.min.x, i & 2 ? _mbox.max.y : _mbox.min.y, i & 4 ? _mbox.max.z : _mbox.min.z).project(camera);
          const x = (_mv.x * 0.5 + 0.5) * cw, y = (-_mv.y * 0.5 + 0.5) * ch;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (!(maxX > minX) || !(maxY > minY)) return null;
        // Cell size (grows past MASK_MAX cells) + lattice-snapped rect, with a
        // margin so the outward bias and smoothing never clip at the mask edge.
        const cell = Math.max(MASK_CELL, (maxX - minX + 12) / (MASK_MAX - 2), (maxY - minY + 12) / (MASK_MAX - 2));
        const rx = Math.floor((minX - 3 * cell) / cell) * cell;
        const ry = Math.floor((minY - 3 * cell) / cell) * cell;
        const gw = Math.min(MASK_MAX, Math.ceil((maxX + 3 * cell - rx) / cell));
        const gh = Math.min(MASK_MAX, Math.ceil((maxY + 3 * cell - ry) / cell));
        if (gw < 2 || gh < 2) return null;
        // Render the piece alone: its meshes (never the invisible grab pad) join
        // the mask layer for this pass only; everything else stays on layer 0.
        const bg = scene.background;
        const override = scene.overrideMaterial;
        const camLayers = camera.layers.mask;
        renderer.getClearColor(l.maskClear);
        const clearA = renderer.getClearAlpha();
        try {
          // Scoped: ONLY the focused meshes join the layer. The restore clears
          // it off the whole piece either way, so neither branch can leak the
          // layer into the main render.
          if (focus) for (const o of focus) o.layers.enable(MASK_LAYER);
          else pg.traverse((o) => { if (o.isMesh && !o.userData.pad && !o.userData.contour) o.layers.enable(MASK_LAYER); });
          scene.background = null;
          scene.overrideMaterial = l.maskMat;
          camera.layers.set(MASK_LAYER);
          camera.setViewOffset(cw, ch, rx, ry, gw * cell, gh * cell);
          renderer.setClearColor(0x000000, 1);
          l.maskRT.viewport.set(0, 0, gw, gh);
          renderer.setRenderTarget(l.maskRT);
          renderer.render(scene, camera);
          renderer.readRenderTargetPixels(l.maskRT, 0, 0, gw, gh, l.maskBuf);
        } catch { return null; } finally {
          renderer.setRenderTarget(null);
          renderer.setClearColor(l.maskClear, clearA);
          camera.clearViewOffset();
          camera.layers.mask = camLayers;
          scene.overrideMaterial = override;
          scene.background = bg;
          pg.traverse((o) => { if (o.isMesh) o.layers.disable(MASK_LAYER); });
        }
        // A focused set is DISJOINT by nature (every cushion, four legs), so it
        // traces ALL its islands — keeping only the largest would say the others
        // aren't selected when they are. A whole piece keeps the single-loop
        // trace (a floating tassel must not steal the outline). Normalised to a
        // list of loops either way.
        const outline = maskToOutline(l.maskBuf, gw, gh, focus ? { x: rx, y: ry, cell, allLoops: true } : { x: rx, y: ry, cell });
        if (!outline || !outline.length) return null;
        return focus ? outline : [outline];
      };
      // Stroke the outline SVG directly — same-frame with the canvas paint, no
      // React round-trip in between (the round-trip is what let the stroke trail
      // the sofa during orbit/dolly). Islands ride ONE path as separate closed
      // subpaths; the strokes are independent, and `fill="none"` means their
      // winding never interacts.
      const drawOutline = (loops) => {
        const svg = outlineSvgRef.current; if (!svg) return;
        let d = '';
        for (const pts of loops || []) {
          if (!pts || pts.length < 3) continue;
          for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + pts[i].x.toFixed(1) + ' ' + pts[i].y.toFixed(1);
          d += 'Z';
        }
        if (d) {
          outlineCasingRef.current?.setAttribute('d', d);
          outlineGoldRef.current?.setAttribute('d', d);
          svg.style.display = '';
        } else {
          svg.style.display = 'none';
        }
      };
      let _lastC = '';
      const reportSelContour = () => {
        const cb = stateRef.current.onSelContour;
        const l = api.current; if (!l) return;
        if (!cb && !outlineSvgRef.current) return;
        const uid = stateRef.current.selectedUid;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        let loops = null;
        // Compute the outline in BOTH modes: plan view strokes the gold selection
        // outline over it, and 3D does too (the outline replaces the warm colour
        // glow as the selection cue). Skipped mid-tween (a fabric crossfade doesn't
        // move the piece).
        if (uid != null && l.group && !l.tween && cw > 0 && ch > 0) {
          const pg = l.group.children.find((g) => g.userData.uid === uid);
          if (pg) {
            let focus = focusMeshesFor(pg);
            // At REST (the dressable mere-selection highlight) the OUTLINE
            // yields to the hovered part exactly like the glow does: the gold
            // trace is the owner's primary cue, and a leg hover whose outline
            // stays wrapped around the body reads as "doesn't highlight the
            // structure" even while the emissive flips correctly underneath.
            // A COMMITTED focus (an open picker) still owns the trace; the
            // body ('base') keeps the dressable promise (its click IS the
            // whole-piece flow). 3D only — the 2D outline doubles as the drag
            // affordance and must not jump under the pointer.
            const hp = l.hoverPart;
            if (stateRef.current.mode === '3d'
                && stateRef.current.focusPart?.role === DRESSABLE_ROLE
                && hp && hp.uid === uid && hp.role && hp.role !== 'base') {
              const scoped = (hp.role === 'structure' && hp.partKey
                ? focusMeshes(pieceMeshes(pg), { groupKey: hp.partKey })
                : null) || focusMeshes(pieceMeshes(pg), { role: hp.role });
              if (scoped) focus = scoped;
            }
            loops = maskOutlineFor(pg, cw, ch, focus);
            // NO-VANISH: a focused trace that comes back empty (the part swung
            // off-frame while the piece did not) falls back to the whole piece —
            // a selected piece is never left unoutlined.
            if (!loops && focus) loops = maskOutlineFor(pg, cw, ch, null);
          }
        }
        drawOutline(loops);
        if (!cb) return;
        // The anchor consumers (the rotate readout, the floating fabric card)
        // take ONE polygon; a focused multi-island outline anchors on its widest.
        const pts = loops && loops.length ? (loops.length === 1 ? loops[0] : widestLoop(loops)) : null;
        // Signature = a few sampled points → notify the parent only when the
        // line shifts (the island count included, so re-scoping always reports).
        const sig = pts && pts.length
          ? `${uid}:${loops.length}:${pts.length}:${Math.round(pts[0].x)},${Math.round(pts[0].y)},${Math.round(pts[pts.length >> 1].x)},${Math.round(pts[pts.length >> 1].y)}`
          : '';
        if (sig !== _lastC) { _lastC = sig; cb(pts); }
      };

      const renderNow = () => {
        syncSize();
        const l2 = api.current;
        if (l2?.shadowsDirty) { renderer.shadowMap.needsUpdate = true; l2.shadowsDirty = false; }
        renderer.render(scene, camera);
        reportSelPos(); drawDimensions(); reportSelContour(); reportChipAnchor();
      };
      let scheduled = false;
      // `inMotor` mutes the controls' change→render echo while the motor loop
      // itself is stepping controls.update() — the motor renders that frame
      // directly, so the echo would double every render while orbiting.
      let inMotor = false;
      const requestRender = () => { if (scheduled || !alive || inMotor) return; scheduled = true; raf = requestAnimationFrame(() => { scheduled = false; if (alive) renderNow(); }); };
      controls.addEventListener('change', requestRender);

      const { dispose: disposeStage, retarget: retargetStage, setShadow: setShadowMode } = setupTogoStage(deps, renderer, scene, 320, { grid: true, ...(stateRef.current.ground ? { ground: stateRef.current.ground } : {}) });
      // The plan grounds the piece with a contact shadow from overhead; the
      // raking key's long shadow is a 3D-vista read (see setupTogoStage.setShadow).
      setShadowMode(stateRef.current.mode);
      const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE, {
        anisotropy: fabricAnisotropy(renderer),
      });

      api.current = {
        THREE, deps, renderer, scene, camera, controls, disposeStage, retargetStage, setShadowMode, quilt, grain,
        group: null, scene3d: { pieces: [], center: { x: PLAN_W / 2, z: PLAN_H / 2 }, radius: 170 },
        framedCount: -1, colorCache: new Map(), requestRender, rebuildGen: 0,
        raycaster: new THREE.Raycaster(), floor: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        drag: null, pan: null, tween: null, camUserMoved: false,
        pointers: new Map(), pinch: null, fitHeight: 0,
        shadowsDirty: true, hoverUid: null, prevUids: undefined, motorRaf: 0, turnTimer: 0, lastSelPulse: null,
        chipPtr: null,   // last cursor point ON a piece (canvas px) — the hover card's anchor
      };

      // ── The motion motor: ONE rAF loop that runs only while something is
      // actually moving — scene micro-tweens (drop-in, fabric crossfade, lift,
      // settle, selection pulse), the orbit's damped inertia, or the short
      // showroom auto-rotate — and provably stops at rest, so render-on-demand
      // stays intact. Scene tweens are KEYED (re-adding a key replaces its
      // predecessor) and complete instantly under reduced motion.
      const l = api.current;
      // The room boundary lives BESIDE l.group (which disposeGroup rebuilds on
      // every edit) so it survives drags. updateRoom swaps it in place; the
      // [room] prop effect drives it. World = plan cm 1:1, so no transform.
      l.updateRoom = (nextRoom) => {
        if (!alive) return;
        if (l.roomGroup) { disposeRoomGroup(l.roomGroup); l.roomGroup = null; }
        // onAsset: the stage renders on demand, so the room's async-loaded oak
        // floor requests its own repaint the moment the texture arrives.
        const g = buildRoomGroup(THREE, nextRoom, {
          onAsset: requestRender,
          anisotropy: fabricAnisotropy(renderer),
        });
        if (g) { l.roomGroup = g; scene.add(g); }
        requestRender();
      };
      const anims = new Map();
      let orbiting = false, settling = false;
      const motor = (ts) => {
        const l2 = api.current; if (!l2) return;
        l2.motorRaf = 0;
        let live = false, dirty = false;
        if (anims.size) {
          for (const [k, a] of [...anims]) {
            if (a.t0 == null) a.t0 = ts;
            const p = a.dur <= 0 ? 1 : Math.min(1, (ts - a.t0) / a.dur);
            a.step(p);
            // Colour-only tweens (fabric crossfade, selection pulse) don't move
            // geometry — only anims flagged `shadow` pay the shadow-map pass.
            if (a.shadow) l2.shadowsDirty = true;
            if (p >= 1) { anims.delete(k); a.done?.(); } else live = true;
          }
          dirty = true;
        }
        if (controls.enabled && (orbiting || controls.autoRotate || settling)) {
          inMotor = true;                            // mute the change→render echo
          const moved = controls.update();
          inMotor = false;
          if (moved) dirty = true;
          if (orbiting || controls.autoRotate) live = true;
          else if (settling) { if (moved) live = true; else settling = false; }
        }
        // Render only frames where something actually changed — a finger held
        // still mid-orbit keeps the loop alive but paints nothing new.
        if (dirty) renderNow();
        if (live && alive) l2.motorRaf = requestAnimationFrame(motor);
      };
      const startMotor = () => { const l2 = api.current; if (!l2 || l2.motorRaf || !alive) return; l2.motorRaf = requestAnimationFrame(motor); };
      l.addAnim = (key, dur, stepFn, done, shadow = true) => {
        if (prefersReducedMotion()) { stepFn(1); done?.(); if (shadow) l.shadowsDirty = true; requestRender(); return; }
        anims.set(key, { t0: null, dur, step: stepFn, done, shadow });
        startMotor();
      };
      l.cancelAnim = (key) => anims.delete(key);
      l.hasAnim = (key) => anims.has(key);
      l.stopOrbitMomentum = () => {
        orbiting = false; settling = false; controls.autoRotate = false; clearTimeout(l.turnTimer);
        // Flush OrbitControls' INTERNAL damped velocity: with damping momentarily
        // off, update() applies-and-zeroes the accumulated delta. Left in place,
        // the residue would kick the camera sideways on the next update() after
        // a tween lands on its exact end pose.
        if (controls.enableDamping) {
          controls.enableDamping = false;
          inMotor = true; controls.update(); inMotor = false;
          controls.enableDamping = true;
        }
      };
      // The 6-second showroom turn on entering 3D: a barely-perceptible drift
      // that presents the sofa and signals "this view orbits". Hard stops: the
      // first grab, the timeout, leaving 3D, unmount. Skipped under reduced motion.
      l.setAutoRotate = (on) => {
        clearTimeout(l.turnTimer);
        const want = !!on && !prefersReducedMotion();
        controls.autoRotate = want;
        if (want) {
          controls.autoRotateSpeed = 0.4;
          l.turnTimer = setTimeout(() => { controls.autoRotate = false; }, 6000);
          startMotor();
        }
      };
      controls.addEventListener('start', () => {
        orbiting = true; settling = false;
        controls.autoRotate = false; clearTimeout(l.turnTimer);   // first grab ends the showroom turn
        // The dealer just took the camera by hand (orbit, dolly or right-drag
        // pan — OrbitControls fires 'start' for all three, and only from a real
        // gesture: it is disabled in 2D and muted mid-tween). Latch it, so an
        // incidental re-frame can't snatch back a view they chose. Only an
        // explicit framing call clears it (placeCamera), which is exactly
        // selection / an overlay moving / the recenter rescue.
        l.camUserMoved = true;
        startMotor();
      });
      controls.addEventListener('end', () => {
        orbiting = false;
        settling = controls.enableDamping;
        if (settling) startMotor();       // let the inertia glide out, then stop
      });

      await rebuild();
      if (!alive) return;
      // Place the camera at whatever the current state says it should frame,
      // immediately (no intro tween on first paint — the toggle tweens
      // thereafter). Derived, so mounting with a piece already selected opens
      // ON that piece instead of gliding to it a beat later.
      placeCamera(l, derivedPose(l, stateRef.current.mode, camera.aspect), stateRef.current.mode);
      if (stateRef.current.room) l.updateRoom(stateRef.current.room);
      requestRender();
      setReady(true);

      // ── Pointer editing (2D only): tap = select, drag = move on the floor. ──
      const ndc = new THREE.Vector2();
      const hit = new THREE.Vector3();
      const ndcFrom = (cx, cy) => { const r = mount.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); };
      const setNdc = (e) => ndcFrom(e.clientX, e.clientY);
      const floorHit = () => { l.raycaster.setFromCamera(ndc, camera); return l.raycaster.ray.intersectPlane(l.floor, hit) ? hit.clone() : null; };
      // Floor point under arbitrary screen coords (for the pinch midpoint anchor).
      const floorAt = (cx, cy) => { ndcFrom(cx, cy); return floorHit(); };
      // The piece under the pointer AND which tagged PART of it was hit (the
      // mesh's partRole, stamped by placeRealModel) — a tap on a cushion can
      // open THAT part's fabric picker. The invisible grab pad carries no role.
      const pieceHitAt = () => {
        l.raycaster.setFromCamera(ndc, camera);
        return resolvePickHit(l.raycaster.intersectObjects(l.group ? l.group.children : [], true));
      };
      // The same pick with a screen-space RING OF MERCY around it. Even with the
      // pad demoted, an estructura reads as a ~15-px band on screen and a
      // fingertip covers ~44: hitting it exactly is a coin flip. So when the
      // exact ray finds nothing — or finds only the pad, i.e. "this piece,
      // nothing in particular" — re-cast on 8 spokes at r and 2r and let
      // `preferPick` adopt the best REAL mesh. Off-axis PAD hits are dropped, so
      // the ring can never make a piece bigger than its own footprint: a tap on
      // empty floor still deselects. 3D only — the 2D drag/pan arithmetic is
      // exact by construction and gets the exact pick (with pad demotion, which
      // is free).
      const pieceHitNear = (clientX, clientY, radiusPx = RING_R_MOUSE) => {
        ndcFrom(clientX, clientY);
        const exact = pieceHitAt();
        if (exact && !exact.pad) return exact;
        const cands = [];
        for (const rad of [radiusPx, radiusPx * 2]) {
          for (let i = 0; i < RING_SPOKES; i++) {
            const a = (i / RING_SPOKES) * Math.PI * 2;
            ndcFrom(clientX + Math.cos(a) * rad, clientY + Math.sin(a) * rad);
            const h = pieceHitAt();
            if (h && !h.pad) cands.push({ hit: h, radius: rad });
          }
        }
        ndcFrom(clientX, clientY);       // leave the ray where the caller pointed
        return preferPick(cands) || exact;
      };
      const pieceUidAt = () => pieceHitAt()?.uid ?? null;

      // ── Camera affordances: dolly the top-down plan (wheel / pinch / buttons),
      // dolly the orbit, glide back to the framed fit, glide onto one piece. ──
      // 2D dolly, anchored so the world point under (cx, cy) stays pinned there —
      // the same trick the pinch uses; centre-anchored when no cursor is given.
      const zoom2dBy = (scale, cx, cy) => {
        const before = cx != null ? floorAt(cx, cy) : null;
        const fit = l.fitHeight || camera.position.y;
        camera.position.y = Math.max(fit * 0.12, Math.min(fit * 6, camera.position.y * scale));
        camera.lookAt(controls.target);
        if (before) {
          const after = floorAt(cx, cy);
          if (after) {
            const dx = before.x - after.x, dz = before.z - after.z;
            camera.position.x += dx; camera.position.z += dz;
            controls.target.x += dx; controls.target.z += dz;
            camera.lookAt(controls.target);
          }
        }
        requestRender();
      };
      // One-tap zoom for the HUD buttons / keyboard (works in both views; each
      // call is one on-demand frame). factor <1 = closer, >1 = farther.
      const zoomBy = (factor) => {
        if (!api.current || l.tween) return;
        if (stateRef.current.mode === '2d') { zoom2dBy(factor); return; }
        const v = camera.position.clone().sub(controls.target);
        const len = Math.max(controls.minDistance || 1, Math.min(controls.maxDistance || Infinity, v.length() * factor));
        camera.position.copy(v.setLength(len).add(controls.target));
        controls.update();
        requestRender();
      };
      // Glide back to the framed layout fit — the "where did my sofa go?"
      // rescue. Deliberately the LAYOUT pose, not the derived one: it is the
      // one command that means "show me everything", so it ignores a selection
      // instead of framing it (inset-aware all the same).
      const recenter = () => {
        if (!api.current || l.drag || l.pinch) return;
        l.pan = null;
        const p = poseFor(stateRef.current.mode, l.scene3d.center, l.scene3d.radius, camera.aspect, netInsetFrac());
        tweenCameraTo(l, p, stateRef.current.mode, 500);
      };
      // 3D: glide onto ONE piece (double-tap / double-click). Keeps the current
      // azimuth so the camera flows in rather than teleporting around the sofa.
      const focusPiece = (uid) => {
        if (!l.group) return;
        const pg = l.group.children.find((g) => g.userData.uid === uid); if (!pg) return;
        const s = new THREE.Box3().setFromObject(pg).getBoundingSphere(new THREE.Sphere());
        const dir = camera.position.clone().sub(controls.target).normalize();
        if (dir.lengthSq() < 1e-6) dir.set(0.32, 0.46, 0.83).normalize();
        const fit = Math.max(0.4, Math.min(1, camera.aspect || 1));
        const dist = Math.max(170, (s.radius * 1.35) / (Math.sin((33 * Math.PI / 180) / 2) * fit));
        tweenCameraTo(l, {
          px: s.center.x + dir.x * dist, py: Math.max(s.center.y + dir.y * dist, 40), pz: s.center.z + dir.z * dist,
          tx: s.center.x, ty: s.center.y * 0.6, tz: s.center.z,
        }, '3d', 550);
      };

      // Desktop wheel zoom on the 2D plan (3D wheel is OrbitControls'). Anchored
      // under the cursor; preventDefault so the HOST page never scroll-hijacks
      // over the canvas — this widget lives in an iframe. Firefox fires
      // line-mode deltas (deltaMode 1) ≈ ±3, so normalize them to pixels.
      const onWheel = (e) => {
        if (stateRef.current.mode !== '2d') return;
        if (l.tween || l.drag || l.pinch) return;
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 24 : e.deltaY;
        zoom2dBy(Math.exp(dy * 0.0012), e.clientX, e.clientY);
      };
      renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
      // ── 3D hover/tap → the fabric + price chip. Reports the piece under the
      // pointer with canvas-relative coords; null clears. Deduped so React only
      // hears about real changes, hidden while a button is held (orbiting).
      let _lastHover = null;
      const reportHover = (info) => {
        const cb = stateRef.current.onHoverPiece; if (!cb) return;
        const key = info ? `${info.uid}:${Math.round(info.x / 4)}:${Math.round(info.y / 4)}` : '';
        if (key === _lastHover) return;
        _lastHover = key;
        cb(info);
      };
      // What the ray is on, with the CURSOR in canvas px — the hover card is a
      // cursor affordance and rides that point (reportChipAnchor's follow
      // branch), so there is no bounding box to project here: the ANCHORED
      // cases (pipette target, bare selection) own their own projection, once
      // per rendered frame, instead of paying for one on every pointermove.
      // `radiusPx` sizes the ring of mercy for the device that asked (mouse vs
      // finger — see ringRadiusFor); the exact ray is always tried first.
      const hoverAt = (clientX, clientY, radiusPx) => {
        if (!l.group) return null;
        const info = pieceHitNear(clientX, clientY, radiusPx);
        if (!info) return null;
        const r = mount.getBoundingClientRect();
        return { uid: info.uid, partRole: info.partRole || 'base', x: clientX - r.left, y: clientY - r.top };
      };
      // Part-hover glow bookkeeping (both views): highlight ONLY the role group
      // the pointer is on — deduped so it costs a refresh only on change.
      const setHoverPart = (info) => {
        const key = info ? `${info.uid}:${info.partRole}` : '';
        if (key === l.hoverPartKey) return;
        l.hoverPartKey = key;
        l.hoverPart = info ? { uid: info.uid, role: info.partRole, partKey: info.partKey || null } : null;
        refreshGlow(l);
      };

      const onDown = (e) => {
        if (stateRef.current.mode !== '2d') {             // 3D → orbit owns the pointer (+ its own pinch zoom)
          // RIGHT is the pan tool. OrbitControls already maps it to PAN, so all
          // this has to do is not ALSO record it as a tap — otherwise releasing
          // a pan without moving acted as a tap and opened a fabric picker.
          if (e.button === 2) { l.tap3d = null; reportHover(null); return; }
          // Remember the touch/click start: a movement-free release is a TAP,
          // which shows the piece chip on devices that can't hover. The pointer
          // KIND rides along so the release can widen its pick to a fingertip's
          // worth of slack (a finger never hovers, so the tap is its only shot).
          l.tap3d = { x: e.clientX, y: e.clientY, moved: false, pointerType: e.pointerType };
          reportHover(null);                              // orbiting → chip away
          return;
        }
        l.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        // Second finger down → switch to PINCH. Abandon any in-flight single-finger
        // gesture first (commit a moved drag so the piece doesn't snap back; drop a
        // pan), then seed the pinch with the current finger spread.
        if (l.pointers.size === 2) {
          if (l.drag) {
            const d = l.drag;
            l.cancelAnim?.(`lift:${d.uid}`);
            if (d.pg) { d.pg.position.y = 0; l.shadowsDirty = true; }   // abandoning the drag drops the lift
            if (d.moved && d.next) stateRef.current.onMove?.(d.uid, d.next.x, d.next.y);
            controls.enabled = false; l.drag = null;
          }
          if (l.pan) { l.pan = null; renderer.domElement.style.cursor = 'grab'; }
          const [a, b] = [...l.pointers.values()];
          l.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
          try { renderer.domElement.setPointerCapture?.(e.pointerId); } catch { /* moves still arrive */ }
          e.preventDefault();
          return;
        }
        if (l.pointers.size > 2) { e.preventDefault(); return; }   // 3+ fingers → ignore extras
        setNdc(e);
        // RIGHT is the PAN tool everywhere, unconditionally — including when the
        // press lands ON a piece, and a SELECTED piece most of all, which is
        // exactly where a stray grab cost the most: you meant to shift the view
        // and instead dragged the thing you had just placed. It never hit-tests,
        // so it can never select, grab or deselect; it only moves the plan.
        const panOnly = e.button === 2;
        const hitInfo = panOnly ? null : pieceHitAt();
        const uid = hitInfo?.uid ?? null;
        if (uid != null) {
          // On a piece → select + start moving it. Whether it was ALREADY the
          // selection (read BEFORE onSelect) decides if a clean release becomes
          // a part-tap (second tap on a piece = edit what you tapped).
          const wasSelected = stateRef.current.selectedUid === uid;
          stateRef.current.onSelect?.(uid);
          const pg = l.group.children.find((g) => g.userData.uid === uid);
          const fp = floorHit();
          if (!pg || !fp) return;
          l.cancelAnim?.(`add:${uid}`);          // a grab interrupts the drop-in cleanly
          if (pg.position.y !== 0 || pg.scale.x !== 1) { pg.position.y = 0; pg.scale.setScalar(1); }
          setHoverPart(null);                    // the part glow + tag yield to the drag
          reportHover(null);
          l.drag = { uid, offX: fp.x - pg.position.x, offZ: fp.z - pg.position.z, pg, moved: false, liftY: 0, wasSelected, partRole: hitInfo?.partRole ?? null };
          // Pick-up: the piece rises a few cm off the floor (its ground shadow
          // detaches — free physicality from the real shadow rig) and settles
          // back on release. Bail if this drag ended before the lift finished.
          const d = l.drag;
          l.addAnim?.(`lift:${uid}`, 130, (p) => {
            if (l.drag !== d) return;
            d.liftY = 5 * (1 - (1 - p) ** 3);
            d.pg.position.y = d.liftY;
          });
          controls.enabled = false;
          try { renderer.domElement.setPointerCapture?.(e.pointerId); } catch { /* iOS can refuse — moves still arrive on the element */ }
          e.preventDefault();
          return;
        }
        if (l.hoverUid != null) { l.hoverUid = null; refreshGlow(l); }   // grabbing the floor clears the hover cue
        // On empty floor → PAN the plan (drag), or DESELECT (tap, settled in onUp).
        // We remember the world point grabbed under the cursor and keep it pinned
        // there each move by translating the (straight-down) camera + target — a
        // rock-solid drag-to-pan that needs no OrbitControls.
        const grab = floorHit();
        // A right press never deselects — it is a view tool, not a selection one.
        if (!grab) { if (!panOnly) stateRef.current.onSelect?.(null); return; }
        l.pan = { gx: grab.x, gz: grab.z, moved: false, panOnly };
        renderer.domElement.style.cursor = 'grabbing';
        try { renderer.domElement.setPointerCapture?.(e.pointerId); } catch { /* moves still arrive */ }
        e.preventDefault();
      };
      const onMovePtr = (e) => {
        if (stateRef.current.mode !== '2d') {
          if (l.tap3d && (Math.abs(e.clientX - l.tap3d.x) > 6 || Math.abs(e.clientY - l.tap3d.y) > 6)) l.tap3d.moved = true;
          // Orbiting/tweening → no chip. A held button IS the orbit, so the
          // cursor closes the grab (a pipette surviving a whole orbit read as a
          // stuck tool); a motionless click never gets here, and the next hover
          // move re-resolves the cursor below.
          if (e.buttons || l.tween) {
            if (e.buttons) renderer.domElement.style.cursor = 'grabbing';
            setHoverPart(null); reportHover(null); return;
          }
          // Hover HIERARCHY: a configurable part (cojín/rulo/brazo) glows alone
          // under a PIPETTE cursor — click recolors it. Anywhere else on a piece
          // glows the WHOLE piece under a pointer — click selects/edits it.
          const info = hoverAt(e.clientX, e.clientY, ringRadiusFor(e.pointerType));
          const isPart = !!info && info.partRole !== 'base';
          renderer.domElement.style.cursor = isPart ? PIPETTE_CURSOR : info ? 'pointer' : 'grab';
          const overUid = info && !isPart ? info.uid : null;
          if (overUid !== l.hoverUid) { l.hoverUid = overUid; refreshGlow(l); }
          setHoverPart(isPart ? info : null);
          reportHover(info);
          // The hover card rides the cursor (see reportChipAnchor). Kept OFF the
          // frame loop on purpose: the scene renders on demand, so a pointer
          // gliding across a motionless sofa never schedules one — and the
          // pointer position is the only thing that moved anyway.
          if (info) {
            l.chipPtr = { x: info.x, y: info.y };
            if (stateRef.current.chipFollow) reportChipAnchor();
          }
          return;
        }
        if (l.pointers.has(e.pointerId)) l.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        // ── Pinch: dolly the straight-down camera so two fingers zoom the plan,
        // keeping the world point under the finger MIDPOINT pinned beneath it (so the
        // zoom feels anchored and the gesture also pans when both fingers translate).
        if (l.pinch) {
          const pts = [...l.pointers.values()];
          if (pts.length < 2) return;
          const [a, b] = pts;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const before = floorAt(mx, my);                       // world point under the midpoint NOW
          const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const scale = l.pinch.dist / dist;                    // fingers spreading (dist↑) → scale<1 → closer camera
          l.pinch.dist = dist;
          const fit = l.fitHeight || camera.position.y;
          // Wide zoom range — sandbox room to lean in on a seam or pull way out.
          camera.position.y = Math.max(fit * 0.12, Math.min(fit * 6, camera.position.y * scale));
          camera.lookAt(controls.target);
          const after = floorAt(mx, my);                        // where that same screen point lands after the dolly
          if (before && after) {                                // translate so `before` snaps back under the midpoint
            const dx = before.x - after.x, dz = before.z - after.z;
            camera.position.x += dx; camera.position.z += dz;
            controls.target.x += dx; controls.target.z += dz;
            camera.lookAt(controls.target);
          }
          requestRender();
          return;
        }
        if (l.drag) {
          setNdc(e);
          const fp = floorHit(); if (!fp) return;
          const { placed: pl, resolvedById: byId } = stateRef.current;
          const me = pl.find((p) => p.uid === l.drag.uid); if (!me) return;
          const r = resolvePlacement(me, byId);
          const box = footprintOf({ widthCm: Number(r.widthCm) || 0, depthCm: Number(r.depthCm) || 0 }, norm360(me.rot));
          const cx = fp.x - l.drag.offX, cz = fp.z - l.drag.offZ;        // new piece CENTRE
          // The floor is a sandbox — no clamp, drop it anywhere. Grid/edge snap is
          // a gentle assist BETWEEN axis-aligned pieces only: a free-rotated piece
          // moves raw (its AABB edges are meaningless to butt flush against).
          const freeRot = norm360(me.rot) % 90 !== 0;
          // A seat-mounted accessory (a loose cushion) rides ABOVE the floor
          // plan, so it STACKS onto the floor pieces instead of colliding with
          // them: it moves raw, and floor pieces never collide against it either
          // (seat pieces drop out of `others`). Mirrors movePiece / nudgeSel in
          // the widget, so the live drag matches the committed drop and a cushion
          // dropped on a sofa never snaps away on release.
          const seat = mountOf(r).seat;
          const cand = { x: cx - box.w / 2, y: cz - box.h / 2, w: box.w, h: box.h, col: r.collection };
          const others = (freeRot || seat) ? [] : pl.filter((p) => p.uid !== l.drag.uid && norm360(p.rot) % 90 === 0 && !mountOf(byId[p.pieceId] || {}).seat).map((p) => {
            const rr = resolvePlacement(p, byId);
            const f = footprintOf({ widthCm: Number(rr.widthCm) || 0, depthCm: Number(rr.depthCm) || 0 }, norm360(p.rot));
            return { x: p.x, y: p.y, w: f.w, h: f.h, col: rr.collection };
          });
          const snapped = (freeRot || seat)
            ? { x: cand.x, y: cand.y, snapped: false }
            : snapPlacementInfo(cand, others);
          l.drag.pg.position.set(snapped.x + box.w / 2, l.drag.liftY || 0, snapped.y + box.h / 2);   // live preview, held at the pick-up lift
          l.drag.next = { x: +snapped.x.toFixed(2), y: +snapped.y.toFixed(2) };
          l.drag.moved = true;
          l.shadowsDirty = true;             // the piece moved → its ground shadow follows
          // Edge-snap feedback on the ENGAGE/RELEASE transition only (not per move).
          if (snapped.snapped !== !!l.drag.snapped) {
            l.drag.snapped = snapped.snapped;
            if (snapped.snapped) { try { navigator.vibrate?.(6); } catch { /* unsupported */ } }
            setSnapGlow(l, l.drag.pg, snapped.snapped);
          }
          requestRender();
          return;
        }
        // Desktop affordance — the same hover HIERARCHY as 3D: any piece under
        // the pointer glows whole (grabbable, move cursor); a CONFIGURABLE PART
        // of the piece glows alone under the PIPETTE cursor — a clean click
        // there recolors exactly that part (dragging still moves the piece).
        // The part hover also reports up (reportHover) so the parent can float
        // its name tag beside the cursor. Deduped: one raycast per move,
        // re-render only on change.
        if (!l.pan && !e.buttons) {
          setNdc(e);
          const hit = pieceHitAt();
          const overUid = hit?.uid ?? null;
          const isPart = hit != null && (hit.partRole || 'base') !== 'base';
          if (overUid !== l.hoverUid) {
            l.hoverUid = overUid;
            refreshGlow(l);
          }
          setHoverPart(isPart ? { uid: hit.uid, partRole: hit.partRole, partKey: hit.partKey || null } : null);
          if (isPart) {
            const rct = mount.getBoundingClientRect();
            reportHover({ uid: hit.uid, partRole: hit.partRole, x: e.clientX - rct.left, y: e.clientY - rct.top });
          } else reportHover(null);
          if (!l.pan) renderer.domElement.style.cursor = isPart ? PIPETTE_CURSOR : overUid != null ? 'move' : 'grab';
          return;
        }
        if (l.pan) {
          // Where does the cursor hit the floor NOW (with the current camera)? Shift
          // the camera + target by (grab − hit) so the grabbed point snaps back under
          // the cursor. Exact for a straight-down camera (translation-invariant).
          setNdc(e);
          const hit = floorHit(); if (!hit) return;
          const dx = l.pan.gx - hit.x, dz = l.pan.gz - hit.z;
          if (dx || dz) {
            camera.position.x += dx; camera.position.z += dz;
            controls.target.x += dx; controls.target.z += dz;
            camera.lookAt(controls.target);
            l.pan.moved = true;
            requestRender();
          }
        }
      };
      const onUp = (e) => {
        if (l.tap3d) {
          const t = l.tap3d; l.tap3d = null;
          if (!t.moved && stateRef.current.mode !== '2d') {
            // Double-tap on EMPTY space still glides back to the framed layout
            // (the "I orbited away" rescue). A single clean tap ON A PIECE now
            // ACTS: it pins the chip AND opens the fabric picker for the exact
            // part the ray hit (cojín/rulo/brazo — the base opens the piece
            // picker), so tapping what you see edits what you see. Empty space
            // clears the chip.
            const info = hoverAt(e.clientX, e.clientY, ringRadiusFor(t.pointerType));
            const now = performance.now();
            const prev = l.lastTap3d;
            l.lastTap3d = { t: now, x: e.clientX, y: e.clientY };
            if (!info && prev && now - prev.t < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 24) {
              l.lastTap3d = null;
              reportHover(null);
              recenter();
              return;
            }
            reportHover(info);
            // The edit HIERARCHY: a configurable part edits on the FIRST tap
            // (the pipette promised it); the piece body selects first, and a
            // second tap on the selected body opens its base fabric — so a 3D
            // novice discovers select → edit without ever being told.
            if (info) {
              const isPart = (info.partRole || 'base') !== 'base';
              // The group key rides along so the embed can open a FINISH picker
              // (metal legs etc.) for the exact part touched — role alone can't
              // name it, since finishes attach to keys, not roles.
              if (isPart) stateRef.current.onTapPart?.(info.uid, info.partRole, info.partKey || null);
              else if (stateRef.current.selectedUid === info.uid) stateRef.current.onTapPart?.(info.uid, 'base', info.partKey || null);
              else stateRef.current.onSelect?.(info.uid);
            } else {
              stateRef.current.onSelect?.(null);   // a clean tap on empty space = deselect (mirrors 2D)
            }
          }
          return;
        }
        l.pointers.delete(e.pointerId);
        // A finger lifted during a pinch → end the pinch. Any finger still down does
        // nothing until it too lifts (re-tapping starts a fresh drag/pan), so the plan
        // never lurches when the second finger leaves.
        if (l.pinch) {
          if (l.pointers.size < 2) l.pinch = null;
          renderer.domElement.releasePointerCapture?.(e.pointerId);
          return;
        }
        if (l.drag) {
          const d = l.drag; l.drag = null;
          controls.enabled = stateRef.current.mode === '3d';   // stays off in 2D
          renderer.domElement.releasePointerCapture?.(e.pointerId);
          if (d.snapped) setSnapGlow(l, d.pg, false);          // back to the plain selection glow
          // Put-down: settle the lifted piece back onto the floor. The tween
          // re-resolves the group by uid every tick, so it survives the group
          // swap the commit below triggers (the fresh group starts at y=0 and
          // simply finishes the remaining settle).
          l.cancelAnim?.(`lift:${d.uid}`);
          const settleFrom = d.liftY || 0;
          if (settleFrom > 0) {
            const uid = d.uid;
            // If the commit below swaps the group mid-settle, rebuild re-lifts
            // the fresh group to this height so the descent stays continuous.
            l.dropSettle = { uid, y: settleFrom };
            l.addAnim?.(`drop:${uid}`, 170, (p) => {
              const g = l.group?.children.find((c) => c.userData.uid === uid);
              if (g && l.drag?.uid !== uid) g.position.y = Math.min(g.position.y, settleFrom * (1 - p) ** 2);
            }, () => {
              const g = l.group?.children.find((c) => c.userData.uid === uid);
              if (g && l.drag?.uid !== uid) g.position.y = 0;
            });
          }
          if (d.moved && d.next) stateRef.current.onMove?.(d.uid, d.next.x, d.next.y, !!d.snapped);
          // A clean tap (no movement) edits what it touched: a configurable
          // PART opens its own fabric picker on the FIRST tap (the pipette
          // cursor promised exactly that); the piece BODY needs the piece to
          // already be selected (first tap selects, second edits its base) so
          // a plain select-tap never surprises with a modal.
          else if (!d.moved && (d.partRole || 'base') !== 'base') stateRef.current.onTapPart?.(d.uid, d.partRole);
          else if (!d.moved && d.wasSelected) stateRef.current.onTapPart?.(d.uid, 'base');
          // ALWAYS render on release: the screen-pos/bounds reports (rotate
          // handle, dimension lines) are suppressed while l.drag is set — the
          // selection tap's highlight render happened mid-press, so without a
          // post-release render a freshly tapped piece never gets its overlays.
          l.requestRender();
          return;
        }
        if (l.pan) {
          // A right press that never moved is an ABANDONED PAN, not a tap on the
          // floor: it must not deselect and must not count toward the
          // double-tap-to-reframe rescue. Right is a view tool, start to finish.
          const panned = l.pan.moved || l.pan.panOnly; l.pan = null;
          renderer.domElement.style.cursor = stateRef.current.mode === '2d' ? 'grab' : '';
          renderer.domElement.releasePointerCapture?.(e.pointerId);
          if (!panned) {
            stateRef.current.onSelect?.(null);   // a tap on empty floor = deselect
            // Double-tap on empty floor → glide back to the framed layout (the
            // "I panned away and lost my sofa" rescue, no button hunt needed).
            const now = performance.now();
            const prev = l.lastTap2d;
            l.lastTap2d = { t: now, x: e.clientX, y: e.clientY };
            if (prev && now - prev.t < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 24) {
              l.lastTap2d = null;
              recenter();
            }
          }
        }
      };
      // Leaving the canvas clears the hover cue — without this a piece keeps
      // its faint "grabbable" glow while the mouse is off in the HUD.
      const onLeave = () => {
        if (l.hoverUid == null && !l.hoverPart) return;
        l.hoverUid = null;
        setHoverPart(null);
        if (!l.pan && !l.drag) renderer.domElement.style.cursor = 'grab';   // back to the at-rest grab, both modes
        refreshGlow(l);
      };
      // RIGHT-drag is the pan tool, so the OS context menu must not open on top
      // of it — on a trackpad the menu appears the instant the button goes down
      // and swallows the drag. Scoped to the canvas: right-click still works
      // normally everywhere else on the page.
      const onContextMenu = (e) => e.preventDefault();
      renderer.domElement.addEventListener('contextmenu', onContextMenu);
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointermove', onMovePtr);
      renderer.domElement.addEventListener('pointerleave', onLeave);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);

      // ── Free rotation — the parent's rotate handle delegates its pointerdown
      // here. Dragging spins the SELECTED piece live around its own centre (any
      // angle, with soft detents every 15° so the useful angles click in); a tap
      // (no real movement) steps to the next 90°, the familiar behaviour. Only
      // the three.js group rotates during the gesture; the placed state commits
      // once on release via onRotateTo(uid, deg) — one gesture, one undo entry.
      const DETENT = 15, DETENT_GRAB = 4;
      const startRotate = (e) => {
        if (stateRef.current.mode !== '2d') return;
        const uid = stateRef.current.selectedUid; if (uid == null) return;
        const pg = l.group?.children.find((g) => g.userData.uid === uid); if (!pg) return;
        const me = stateRef.current.placed.find((p) => p.uid === uid); if (!me) return;
        // The piece's centre on screen — the pivot the pointer angle is read from.
        const r = mount.getBoundingClientRect();
        const c = pg.position.clone().project(camera);
        const cx = r.left + (c.x * 0.5 + 0.5) * r.width;
        const cy = r.top + (-c.y * 0.5 + 0.5) * r.height;
        const startRot = norm360(me.rot);
        const rt = {
          uid, pg, cx, cy, startRot, deg: startRot,
          a0: Math.atan2(e.clientY - cy, e.clientX - cx),
          moved: false, detent: false,
        };
        const onRotMove = (ev) => {
          // Screen y grows downward, so atan2 already turns clockwise — the same
          // sense as the plan's rotation degrees. No sign flip.
          const a = Math.atan2(ev.clientY - rt.cy, ev.clientX - rt.cx);
          let deg = rt.startRot + ((a - rt.a0) * 180) / Math.PI;
          if (!rt.moved && Math.abs(deg - rt.startRot) >= 2) rt.moved = true;
          const near = Math.round(deg / DETENT) * DETENT;
          const onDetent = Math.abs(deg - near) <= DETENT_GRAB;
          if (onDetent) deg = near;
          if (onDetent !== rt.detent) {
            rt.detent = onDetent;
            if (onDetent) { try { navigator.vibrate?.(5); } catch { /* unsupported */ } }
            // Visual tick paired with the haptic one — desktop has no vibration,
            // so the glow brightening IS its detent feedback.
            setSnapGlow(l, rt.pg, onDetent);
          }
          rt.deg = norm360(deg);
          rt.pg.rotation.y = (-rt.deg * Math.PI) / 180;
          l.shadowsDirty = true;             // the piece turned → its shadow follows
          // Live readout for the parent's angle pill, deduped to whole degrees.
          const shown = Math.round(rt.deg) % 360;
          if (rt.moved && shown !== rt.lastShown) { rt.lastShown = shown; stateRef.current.onRotateLive?.(shown); }
          requestRender();
        };
        const onRotUp = () => {
          window.removeEventListener('pointermove', onRotMove);
          window.removeEventListener('pointerup', onRotUp);
          window.removeEventListener('pointercancel', onRotUp);
          l.rotate = null;
          stateRef.current.onRotateLive?.(null);
          if (rt.detent) setSnapGlow(l, rt.pg, false);   // back to the plain selection glow
          const deg = rt.moved
            ? +rt.deg.toFixed(1)
            // Tap → the next 90° step (from a free angle it lands on the next
            // cardinal, so tapping always squares a piece back up).
            : norm360(Math.floor(rt.startRot / 90) * 90 + 90);
          stateRef.current.onRotateTo?.(rt.uid, deg);
        };
        l.rotate = rt;
        window.addEventListener('pointermove', onRotMove);
        window.addEventListener('pointerup', onRotUp);
        window.addEventListener('pointercancel', onRotUp);
        e.preventDefault?.();
      };
      if (gesturesRef) gesturesRef.current = { startRotate, recenter, zoomBy };

      l.cleanupPointer = () => {
        renderer.domElement.removeEventListener('contextmenu', onContextMenu);
        renderer.domElement.removeEventListener('pointerdown', onDown);
        renderer.domElement.removeEventListener('pointermove', onMovePtr);
        renderer.domElement.removeEventListener('pointerleave', onLeave);
        renderer.domElement.removeEventListener('wheel', onWheel);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (gesturesRef) gesturesRef.current = null;
      };

      // Every signal that the displayed size MIGHT have changed just asks for a
      // render; renderNow → syncSize does the actual reconcile + recentre. We
      // listen broadly (ResizeObserver on the container, window resize/orientation,
      // and the iOS visualViewport which fires when the URL bar shows/hides) so no
      // device-specific quirk can leave the canvas stale.
      ro = new ResizeObserver(() => requestRender());
      ro.observe(mount);
      const onWin = () => requestRender();
      window.addEventListener('resize', onWin);
      window.addEventListener('orientationchange', onWin);
      window.visualViewport?.addEventListener('resize', onWin);
      window.visualViewport?.addEventListener('scroll', onWin);
      l_cleanupResize = () => {
        window.removeEventListener('resize', onWin);
        window.removeEventListener('orientationchange', onWin);
        window.visualViewport?.removeEventListener('resize', onWin);
        window.visualViewport?.removeEventListener('scroll', onWin);
      };
    })();

    return () => {
      alive = false; cancelAnimationFrame(raf); ro?.disconnect(); l_cleanupResize?.();
      const l = api.current; api.current = null;
      if (l) {
        l.cleanupPointer?.();
        if (l.tween) cancelAnimationFrame(l.tween);
        if (l.motorRaf) cancelAnimationFrame(l.motorRaf);
        clearTimeout(l.turnTimer);
        l.controls?.dispose?.();
        disposeGroup(l.group);
        disposeRoomGroup(l.roomGroup);
        l.disposeStage?.();
        l.maskRT?.dispose?.();
        l.maskMat?.dispose?.();
        l.quilt?.dispose?.();
        l.grain?.dispose?.();
        // colorCache holds plain hex numbers (sampleSwatchColor) — nothing to
        // dispose; just drop the reference with the rest of `l`.
        // texCache/normCache textures are flagged shared (so per-rebuild
        // disposeGroup spares them) — free them here, at the real end of the
        // stage's life.
        l.texCache?.forEach?.((t) => t?.dispose?.());
        l.normCache?.forEach?.((t) => t?.dispose?.());
        // The parsed models are SHARED across every renderer now (see
        // togoModelLoader's sharedModelCache), so this teardown must not free
        // them — the thumbnail engine and the launch card are still holding
        // them, and the clones this stage actually drew were already disposed
        // above. Freeing here is what would blank a thumbnail after a remount.
        l.renderer?.dispose?.();
        l.renderer?.domElement?.remove?.();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout/selection change → rebuild; finish change → re-skin in place.
  useEffect(() => { if (api.current) rebuild(); }, [placed, resolvedById, rebuild]);
  useEffect(() => { if (api.current) applyHighlightLive(); /* eslint-disable-next-line */ }, [selectedUid]);
  // Room boundary → swap the floor mesh in place (survives group rebuilds) and
  // keep the framing bounds current. A room set on an empty plan is framed so
  // it lands in view; with pieces present the existing framing holds (recenter
  // now folds the room in, so the whole space is one tap away).
  useEffect(() => {
    const l = api.current; if (!l) return;
    l.updateRoom?.(room);
    l.scene3d = buildScene();
    l.retargetStage?.(l.scene3d.center, l.scene3d.radius);
    if (room && !stateRef.current.placed?.length && !l.drag && !l.pinch) {
      tweenCameraTo(l, derivedPose(l, stateRef.current.mode, l.camera.aspect), stateRef.current.mode, 380);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);
  useEffect(() => { const l = api.current; if (l) { l.requestRender && refreshGlow(l); } /* eslint-disable-next-line */ }, [hintPieceId]);
  // Part focus → re-scope the glow AND retrace the outline. The mask pass runs
  // inside the render frame, so without a render request the gold line would
  // keep hugging whatever it hugged until the camera happened to move. Keyed on
  // the FIELDS, not the object: the parent may hand a fresh literal each render.
  // `exclude` joins as a STRING for the same reason — it is a fresh array every
  // render, and keying on the array would refresh on every one of them; keying
  // on nothing would leave the highlight wrapping a part that just took its own
  // fabric (uid/role/groupKey all stay put while only the override set moves).
  useEffect(() => {
    const l = api.current; if (l) refreshGlow(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPart?.uid, focusPart?.role, focusPart?.groupKey, focusPart?.exclude?.join('|')]);
  // A card that stops FOLLOWING the cursor has to be re-anchored, and the
  // anchor is only recomputed inside a rendered frame — so the mode flip itself
  // asks for one. Without it, letting the pointer off a piece would leave the
  // card frozen at the cursor until the visitor happened to move the camera
  // (the hover ends on a React timeout, which schedules no frame of its own).
  useEffect(() => { api.current?.requestRender?.(); }, [chipUid, chipFollow]);
  useEffect(() => { if (api.current) reskin(); }, [material, reskin]);

  // Selection change → highlight + a brief engage PULSE on a newly selected
  // piece (bright, decaying to the resting glow) — selection is the gateway to
  // every per-piece action, so it answers the tap emphatically.
  function applyHighlightLive() {
    const l = api.current; if (!l) return;
    const sel = stateRef.current.selectedUid;
    applyHighlight(l, sel);
    if (sel != null && sel !== l.lastSelPulse) {
      l.lastSelPulse = sel;
      l.addAnim?.('selpulse', 300, (p) => {
        const g = l.group?.children.find((c) => c.userData.uid === sel);
        if (!g || l.drag) return;            // a live drag's snap glow owns the emissive
        const v = 0.95 - 0.45 * (1 - (1 - p) ** 3);
        // The pulse rides the SAME scope as the highlight it announces —
        // unscoped it would relight the whole piece over a focused part and
        // leave it lit (the pulse ends by writing, not by re-deriving).
        const focus = focusMeshesFor(g);
        if (focus) setMeshEmissive(g, focus, v, 0);
        else setEmissive(g, v);
      }, undefined, false);                  // emissive-only — no shadow re-render
    } else if (sel == null) {
      l.lastSelPulse = null;
      l.cancelAnim?.('selpulse');
    }
  }

  // ── THE framing effect: ONE owner for where the camera goes ─────────────
  // Mode, selection and BOTH insets are the only things that may re-aim it, and
  // all four ask `derivedPose` the same question, so they can never send it two
  // places at once. They used to be two effects computing their own destinations
  // — a mode glide and an inset glide — which is how selecting a piece (the
  // selection opens the material drawer, the drawer changes insetLeft) landed
  // the camera in a half-state: one glide re-framed the LAYOUT for the drawer,
  // nothing framed the PIECE, and they traded the single `l.tween` slot.
  //   · mode changed  → the big move between plan and perspective (700 ms), and
  //                     the shadow caster swaps with it.
  //   · selection     → 3D only, ~520 ms onto the piece (or back out to the
  //                     layout on deselect). In 2D a tap never moves the camera.
  //   · an inset      → 420 ms, re-centring on the strip still visible between
  //                     the overlays — around the SELECTED piece if there is
  //                     one, which is the whole point of one derived pose.
  // Gliding, never snapping: the overlays animate too, and a jump would read as
  // the model flinching away from them. Skips: first mount (the mount path
  // places the camera itself), and mid-gesture — `l.pan` means the dealer has
  // the camera in hand, and only an explicit mode change outranks that.
  const framingRef = useRef({ mode, sel: selectedUid, left: insetLeft, right: insetRight });
  useEffect(() => {
    const prev = framingRef.current;
    framingRef.current = { mode, sel: selectedUid, left: insetLeft, right: insetRight };
    const l = api.current;
    if (!l || !l.scene3d) return;
    const modeChanged = prev.mode !== mode;
    const selChanged = prev.sel !== selectedUid;
    const insetChanged = prev.left !== insetLeft || prev.right !== insetRight;
    if (modeChanged) {
      // Swapping the caster changes what the shadow map holds, so it must be
      // re-rendered — otherwise the plan keeps the raking smear until something
      // else happens to dirty it.
      l.setShadowMode?.(mode);
      l.shadowsDirty = true;
    }
    if (!modeChanged && !insetChanged && (mode === '2d' || !selChanged)) return;
    if (l.pan && !modeChanged) return;
    tweenCameraTo(
      l, derivedPose(l, mode, l.camera.aspect), mode,
      modeChanged ? 700 : selChanged ? 520 : 420,
      modeChanged
        // Arriving in 3D starts the short showroom turn; any grab, the timeout,
        // or leaving 3D ends it.
        ? () => { if (mode === '3d' && stateRef.current.mode === '3d') l.setAutoRotate?.(true); }
        : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedUid, insetLeft, insetRight]);

  return (
    // position via INLINE STYLE, not classes: the caller passes `absolute inset-0`
    // but the root ALSO carried a hardcoded `relative`, and in the built CSS
    // `.relative` is emitted after `.absolute` so it WON the tie — the root became
    // `position: relative`, which ignores inset-0 for sizing and collapsed to auto
    // height (its only children are absolutely-positioned → contribute 0). The
    // canvas then never got a viewport-tracking height and the ResizeObserver read
    // H≈0 and bailed, so the stage couldn't respond to screen size. Forcing
    // absolute+inset:0 inline makes the root fill its parent regardless of class
    // order, and it's still a positioning context for the mount/overlay below.
    <div style={{ position: 'absolute', inset: 0 }} className={className} aria-label="Configurador Togo">
      <div ref={mountRef} className="absolute inset-0" />
      {/* The selected piece's silhouette highlight — warm-yellow over a dark ink
          casing (≥3:1 against both the pale floor and any upholstery — SC 1.4.11).
          Path data is written IMPERATIVELY by reportSelContour in the same frame
          as the canvas render; no viewBox, so SVG user units ARE CSS px, 1:1. */}
      <svg
        ref={outlineSvgRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-[6]"
        style={{ overflow: 'visible', display: 'none' }}
        fill="none"
        aria-hidden
      >
        <path ref={outlineCasingRef} stroke="rgb(35 32 26 / 0.8)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
        <path ref={outlineGoldRef} stroke={OUTLINE_GOLD} strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {/* On-plan dimension brackets. Same recipe as the outline above — always
          mounted so there is a node to write into, geometry set imperatively by
          drawDimensions in the render frame, no viewBox so user units are CSS
          px. React supplies only the two labels' TEXT. */}
      {dims && (
        <>
          <svg
            ref={dimSvgRef}
            className="absolute inset-0 w-full h-full pointer-events-none z-[5] text-ink-400"
            style={{ overflow: 'visible', display: 'none' }}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            aria-hidden
          >
            <path ref={dimPathRef} />
          </svg>
          {/* BOTH notes are the same horizontal pill, centred ON their line
              (drawDimensions owns the placement). The depth note's old
              sideways-text capsule rendered cramped and misshapen on a phone
              (owner screenshot 2026-07-30) — horizontal text, always. */}
          <div
            ref={dimTopRef}
            className="absolute z-[5] pointer-events-none whitespace-nowrap rounded-full px-2 py-0.5 bg-white/90 backdrop-blur-sm border border-ink-200/80 text-[11px] font-medium leading-none tabular-nums text-ink-700"
            style={{ display: 'none', left: 0, top: 0 }}
          >
            {dims.widthLabel}
          </div>
          <div
            ref={dimLeftRef}
            className="absolute z-[5] pointer-events-none whitespace-nowrap rounded-full px-2 py-0.5 bg-white/90 backdrop-blur-sm border border-ink-200/80 text-[11px] font-medium leading-none tabular-nums text-ink-700"
            style={{ display: 'none', left: 0, top: 0 }}
          >
            {dims.depthLabel}
          </div>
        </>
      )}
      {!failed && !ready && (
        <div role="status" className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-ink-500">
            <Loader2 size={20} className="animate-spin" aria-hidden />
            <span className="text-xs">Preparando el plano…</span>
          </div>
        </div>
      )}
      {failed && (
        <div role="status" className="absolute inset-0 grid place-items-center text-center px-6 text-xs text-ink-600">
          La vista 3D no está disponible en este dispositivo.
        </div>
      )}
    </div>
  );
}
