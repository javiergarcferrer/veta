/**
 * THE STUDIO RIG — the lighting a fabric render is judged by.
 *
 * A neutral image-based environment (three's RoomEnvironment — no HDR asset to
 * ship) for soft realistic fabric shading, a LOW RAKING key that casts a soft
 * ground shadow, a rim, a hemisphere fill, and a large floor that only catches
 * shadow. three.js and RoomEnvironment are both INJECTED, same as everywhere
 * else in this package.
 */
import type { ThreeApi, ThreeObject } from './types.ts';
import { fabricAnisotropy } from './sceneBuilder.ts';

/**
 * The stage's default ground — a warm paper. A public configurator overrides it
 * to a neutral near-white (`ground`), because there it is the largest surface on
 * a page whose whole skin is monochrome; a cream floor under white hairline
 * panels is the one thing that reads as "not designed". Internal surfaces pass
 * nothing and keep the warmth.
 */
export const DEFAULT_STAGE_GROUND = 0xf4f1ec;

/** Which caster is live: the 3D vista's raking key, or the plan's overhead. */
export type ShadowMode = '2d' | '3d';

/** Options for `setupStage`. */
export interface StageOptions {
  /** three's RoomEnvironment (an addon) — required for the IBL. */
  RoomEnvironment?: any;
  /** Draw the 50 cm dot lattice (live stage only; thumbnails stay clean). */
  grid?: boolean;
  /** Background/floor colour. */
  ground?: number;
  /** The white-page rig for a piece rendered ALONE (thumbnails, a turntable). */
  presentation?: boolean;
}

/** What `setupStage` hands back — the rig's three levers. */
export interface StageHandle {
  dispose: () => void;
  /** Slide the whole rig to follow the layout. */
  retarget: (center: { x?: number; z?: number } | null | undefined, layoutRadius?: number) => void;
  /** Hand the shadow job between the raking key (3d) and the overhead (2d). */
  setShadow: (mode: ShadowMode) => void;
}

/**
 * Mutate `scene` with the studio rig and return its levers.
 *
 * `retarget(center, radius)` slides the whole rig (key + target + shadow frustum
 * + rim + floor) to follow the layout, because the plan is an UNBOUNDED sandbox:
 * a build dragged far from the world origin would otherwise walk out of the
 * shadow camera's box and lose its ground shadow. The light DIRECTION is held
 * constant (the raking ratio 1.2 : 0.95 : 0.5 relative to a floor distance never
 * below the stage radius), so the fold-carving angle the rig was tuned around
 * never steepens on a small single-piece layout.
 *
 * SHADOWS-DIRTY DISCIPLINE: every mutation here is a shadow-map invalidation.
 * A render-on-demand host must mark its shadows dirty after `retarget` and after
 * `setShadow` — the rig moved, so the cached map is stale, and re-rendering the
 * frame without re-rendering the map draws the old shadow at the new position.
 * (The rig cannot do it itself: it doesn't own the renderer's frame loop, and
 * setting `shadowMap.needsUpdate` here would force a map rebuild on every idle
 * frame — the exact cost the on-demand loop exists to avoid.)
 */
export function setupStage(
  THREE: ThreeApi,
  renderer: any,
  scene: any,
  radius: number,
  { RoomEnvironment, grid = false, ground = DEFAULT_STAGE_GROUND, presentation = false }: StageOptions = {},
): StageHandle {
  scene.background = new THREE.Color(ground);

  // Showroom floor grid — a quiet 50 cm dot lattice under the build (live stage
  // only; thumbnails stay clean). It turns the empty canvas from a bare void
  // into a floor with SCALE the visitor can read, exactly like graph paper
  // under a plan. Drawn once into a tiled CanvasTexture; sits just below the
  // shadow catcher so contact shadows darken over the dots.
  let gridMesh: ThreeObject | null = null;
  if (grid && typeof document !== 'undefined') {
    const TILE_CM = 50, PX = 64;
    const cv = document.createElement('canvas');
    cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, PX, PX);
      ctx.fillStyle = 'rgba(59, 56, 48, 0.42)';   // warm ink, kept faint by material opacity
      ctx.beginPath();
      ctx.arc(PX / 2, PX / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const size = radius * 12;
    tex.repeat.set(size / TILE_CM, size / TILE_CM);
    tex.anisotropy = fabricAnisotropy(renderer);
    gridMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false }),
    );
    gridMesh.rotation.x = -Math.PI / 2;
    gridMesh.position.y = -0.5;             // under the y=0 shadow catcher (transparent, so dots show through)
    gridMesh.renderOrder = -1;
    scene.add(gridMesh);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  // PRESENTATION rig — for a piece rendered ALONE on a white page (catalogue
  // thumbnails, a launch card's turntable), not for the live plan.
  //
  // On the plan a piece sits on a warm floor, casts its own contact shadow and
  // the visitor can orbit it, so the soft colour-true wash is exactly right. A
  // 200 px tile on WHITE has none of that support, and the same wash flattens
  // every piece into a coloured silhouette — two different sofas become two
  // blobs and the collection index stops telling you what the collections are.
  //
  // What buys the FORM back is contrast, not exposure. The IBL is the fill, and
  // a full-strength one lights the shadow side almost as brightly as the key
  // lights the front, so the gradient that describes a curve is filled straight
  // back in. Dimming it deepens every shaded plane while leaving the KEY — and
  // therefore the lit face's colour, which is what a fabric pick is judged on —
  // exactly where it was tuned. The rim comes up to keep the shadow side from
  // going muddy, and a back light draws the piece's far edge away from the page.
  if (presentation && 'environmentIntensity' in scene) scene.environmentIntensity = 0.62;

  // Colour-accurate AND fold-accentuating product lighting. The IBL still does
  // the fill (so a dark/saturated swatch keeps its TRUE depth — a hot key once
  // washed deep velvets pale), but the KEY comes in at a LOW, RAKING angle so
  // it skims ACROSS the cushion channels and throws a shadow into every fold
  // valley — the contrast that makes the quilting read plush instead of flat. A
  // steep top-down key lit the fold crests and floors equally and flattened them.
  //
  // NEUTRAL WHITE key/rim — this is a MEASUREMENT, not a mood. pCon lights
  // neutral, and the old warm key + cool rim tinted every fabric ~1.5% red/blue
  // (measured on a TONA seat against the scan's own channel ratios): on a page
  // whose job is selling EXACT colours, the raking geometry carves the folds,
  // never a colour cast.
  //
  // INTENSITY 1.2 (was 1.55): a hotter key over-lit the FACING panels well past
  // the fabric's own albedo — a mid-rose scan (PARADE ROSE, diffuse mean
  // #b68a76) washed to pale peach on the lit side while its SHADOW side rendered
  // the true tone. pCon's softer studio light shows the real colour across the
  // whole piece; dropping the key settles the lit faces toward that true tone.
  // The RAKING ANGLE (fold-carving) is unchanged — only the wash comes down, and
  // the rim/hemi/IBL still hold the shadow side, so the quilting keeps its depth.
  //
  // Presentation keeps the LIVE key, 1.2. Raising it to 1.5 was measured moving
  // the median tone by a single unit — the IBL owns the diffuse here — so it
  // bought no form and only lifted the specular lobe. Upholstery is matte
  // (roughness floored at 0.8) but not mirror-free: nearly doubling the total
  // directional light made a scanned leather-ish fabric read as POLISHED, which
  // is the one thing a fabric render must never do.
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(radius * 1.2, radius * 0.95, radius * 0.5);   // low & to the side → grazes the folds
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const d = radius * 2.2;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 6 });
  // An OrthographicCamera computes its projection in the CONSTRUCTOR only, and
  // LightShadow.updateMatrices() reuses camera.projectionMatrix verbatim — so
  // assigning the frustum bounds without this leaves the DEFAULT ±5/far-500 box
  // live: the key sits ~1.6×radius from its target, PAST that stale far plane,
  // and the whole ground shadow silently culls away. This line is what makes
  // the shadow rig actually exist.
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.radius = 3.5;     // a touch crisper → the channel/contact shadows read
  scene.add(key);
  scene.add(key.target);       // in the graph so retarget can move the aim point

  // The PLAN's own shadow caster. The key rakes in from the side to carve the
  // folds — and from straight above that throws the piece's shadow ~90 cm ACROSS
  // the floor: a second, blurry sofa lying beside the real one. It went unseen
  // for as long as the plan's ground was near-white (a 0.1 catcher over #FAFAFA
  // is nothing); the moment a client's room put a WOOD floor under it, it read
  // as a stain. Fading the catcher further can't fix an offset — a fainter ghost
  // is still a ghost — so the plan gets its own caster: straight overhead, at
  // ZERO intensity, so it lights nothing (the key's raking carve, tuned on the
  // upholstery, is untouched) and only writes a shadow map. What lands is a
  // contact shadow UNDER the piece, which is what grounds a plan. `setShadow`
  // hands the job between the two: overhead in 2D, the key in 3D, never both.
  const planKey = new THREE.DirectionalLight(0xffffff, 0);
  planKey.position.set(0, radius * 2, 0);
  planKey.castShadow = false;
  planKey.shadow.mapSize.set(2048, 2048);
  Object.assign(planKey.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 6 });
  planKey.shadow.camera.updateProjectionMatrix();   // same constructor trap as the key's
  planKey.shadow.bias = -0.0004;
  planKey.shadow.radius = 3.5;
  scene.add(planKey);
  scene.add(planKey.target);

  // A dim, low rim from the opposite side carves the shadow-side folds (so they
  // don't go to mush) WITHOUT lifting the body — keeps the deep-crease contrast.
  const rim = new THREE.DirectionalLight(0xffffff, presentation ? 0.42 : 0.34);
  rim.position.set(-radius * 0.95, radius * 0.45, -radius * 0.85);
  scene.add(rim);
  scene.add(rim.target);
  // Lower hemisphere fill so the channel valleys stay genuinely shadowed — drives
  // most of the seat's depth (a high fill is what flattened the quilting).
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 0.1));
  // Presentation only: a high BACK light that runs a bright line along the
  // piece's top-far edge. That edge is the whole of what separates a form from
  // the white behind it — without one a deep velvet reads as a hole punched in
  // the page rather than a sofa. It sits behind and above, so it grazes the
  // silhouette and puts almost nothing on the faces the camera sees (the key
  // still owns those, and with them the colour).
  // Enough to draw the far edge off the white page, and no more: at 0.7 this was
  // a second key raking the tops and it is what put the wet shine on them.
  const back = presentation ? new THREE.DirectionalLight(0xffffff, 0.26) : null;
  if (back) {
    back.position.set(-radius * 0.35, radius * 1.5, -radius * 1.25);
    scene.add(back);
    scene.add(back.target);
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 12, radius * 12),
    // With the frustum fix above the ground shadow renders at full strength —
    // 0.34 (tuned against a mostly-missing shadow) reads heavy now; 0.28 keeps
    // the grounded contact read without going graphic-novel.
    new THREE.ShadowMaterial({ opacity: 0.28 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  scene.add(floor);

  const retarget: StageHandle['retarget'] = (center, layoutRadius = radius) => {
    const cx = Number(center?.x) || 0, cz = Number(center?.z) || 0;
    // Never let the rig distance fall below the stage radius: the DIRECTION
    // ratio stays the shipped raking angle at any layout size.
    const LR = Math.max(radius, Number(layoutRadius) || 0);
    key.position.set(cx + LR * 1.2, LR * 0.95, cz + LR * 0.5);
    key.target.position.set(cx, 0, cz);
    rim.position.set(cx - LR * 0.95, LR * 0.45, cz - LR * 0.85);
    rim.target.position.set(cx, 0, cz);
    if (back) {
      back.position.set(cx - LR * 0.35, LR * 1.5, cz - LR * 1.25);
      back.target.position.set(cx, 0, cz);
    }
    const dd = Math.max(radius * 2.2, LR * 2.2);
    Object.assign(key.shadow.camera, { left: -dd, right: dd, top: dd, bottom: -dd, near: 1, far: LR * 6 });
    key.shadow.camera.updateProjectionMatrix();
    // The plan caster rides along, straight above the same aim point.
    planKey.position.set(cx, LR * 2, cz);
    planKey.target.position.set(cx, 0, cz);
    Object.assign(planKey.shadow.camera, { left: -dd, right: dd, top: dd, bottom: -dd, near: 1, far: LR * 6 });
    planKey.shadow.camera.updateProjectionMatrix();
    floor.position.set(cx, 0, cz);
    if (gridMesh) {
      // Slide the (finite) grid plane with the rig but keep the DOTS anchored to
      // the world by counter-shifting the texture phase — the lattice reads as
      // the floor itself, never as a decal glued to the layout.
      gridMesh.position.x = cx;
      gridMesh.position.z = cz;
      const t = gridMesh.material.map;
      if (t) {
        t.offset.x = ((cx / 50) % 1 + 1) % 1;
        t.offset.y = ((-cz / 50) % 1 + 1) % 1;
      }
    }
  };

  // The ground shadow is a per-VIEW rig, not just a dial. The 3D vista wants the
  // raking key's long directional shadow (it's what makes the piece sit in a
  // room); the plan wants a contact shadow under the piece and nothing beside it
  // — so the caster changes with the view, and the catcher's strength with it.
  // Exactly one light casts at a time: two would print both shadows at once.
  const setShadow = (mode: ShadowMode) => {
    const plan = mode === '2d';
    key.castShadow = !plan;
    planKey.castShadow = plan;
    floor.material.opacity = plan ? 0.16 : 0.28;
  };

  const dispose = () => {
    envRT.texture.dispose();
    pmrem.dispose();
    if (typeof envScene.dispose === 'function') envScene.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
    if (gridMesh) {
      gridMesh.geometry.dispose();
      gridMesh.material.map?.dispose();
      gridMesh.material.dispose();
    }
  };
  return { dispose, retarget, setShadow };
}
