/**
 * A slowly turning Togo — the embed launch card's hero.
 *
 * The card that lands on the dealer's site used to advertise the configurator
 * with a drawing of a Togo. This renders the REAL one: the same FBX, the same
 * scene builder, the same lighting rig and the same fabric pipeline the live
 * configurator uses, on its own little turntable. What the visitor sees on the
 * card is literally what they get when they tap it.
 *
 * It is built to be a GUEST on someone else's home page, so everything is
 * conditional and nothing is load-bearing:
 *   • three.js is code-split behind `safeDynamicImport` (Traps) — a visitor who
 *     never scrolls to the card downloads none of it;
 *   • it boots only once the card is actually ON SCREEN, and the render loop
 *     stops the moment it leaves or the tab is hidden — no rAF burning battery
 *     behind a background tab;
 *   • reduced-motion gets ONE still frame at the same flattering angle, never a
 *     spin;
 *   • no WebGL, a failed mesh, a lost context — every one of them reports
 *     `failed` and the card keeps its drawn silhouette. It never renders a
 *     broken or empty box.
 *
 * `onStatus` fires once per outcome ('ready' | 'failed') so the card can
 * crossfade rather than pop.
 */
import { useEffect, useRef } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { loadConfiguratorModels } from './modelLoader.js';
import {
  buildConfiguratorGroup, setupConfiguratorStage, disposeGroup, makeFabricMaps, fabricAnisotropy, STANDARD_CONFIGURATOR_FINISH,
} from './sceneBuilder.js';
import { loadFabricAppearance, makeAppearanceCache, disposeAppearanceCache } from './fabricAppearance.js';

// One full turn in 32s — slow enough to read as "presented", never as a spinner.
const DEG_PER_SEC = 360 / 32;
// ...and a turn that slow does not need 60 fps. At 11.25°/s a frame at 30 fps
// advances the piece by 0.375° — under half a degree, which is invisible on a
// card-sized render, while halving the GPU and CPU this thing costs. That matters
// more here than anywhere else in the app: the card is a GUEST on a dealer's home
// page, animating next to content it doesn't own, on whatever phone the visitor
// happens to have. The rAF keeps running at the display's rate (so the loop stays
// in step with the compositor and stops instantly when the tab hides); only the
// RENDER is rate-limited.
const FRAME_MS = 1000 / 30;
// The angle the piece is framed at: a low 3/4 that shows the seat and the
// channel quilting at once (the same read as the rendered catalogue thumbnails).
const ELEVATION = 0.34;      // camera height as a fraction of the framing distance
const FOV = 30;
const STILL_ANGLE = 22;      // where a reduced-motion visitor sees it parked

export default function ConfiguratorTurntable({ scene3d, fabricByCode, className = '', onStatus }) {
  const hostRef = useRef(null);
  const statusRef = useRef(null);
  // The live engine, kept off React state — none of it drives a re-render, and
  // the animation loop must never be a render trigger.
  const engineRef = useRef(null);
  // The boot effect owns every engine closure; a later scene change reaches the
  // rebuild through here rather than re-creating the renderer.
  const rebuildRef = useRef(null);
  // Read the latest props inside the (long-lived) boot effect without making it
  // re-run: the scene is rebuilt explicitly when its key changes, below.
  const propsRef = useRef({ scene3d, fabricByCode, onStatus });
  propsRef.current = { scene3d, fabricByCode, onStatus };

  // The scene's identity: rebuild only when the piece or its fabric actually
  // changes (the catalog arriving flips this from empty to real exactly once).
  const sceneKey = (scene3d?.pieces || [])
    .map((p) => `${p.mesh?.url || p.form || ''}:${p.widthCm}x${p.depthCm}:${p.fabricCode || ''}`)
    .join('|');
  const hasScene = !!sceneKey;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasScene) return undefined;

    let alive = true;
    let started = false;
    // Whether the card is on screen RIGHT NOW. The boot is async, so the engine
    // doesn't exist to carry this while it runs — a visitor who scrolls past
    // mid-boot must not end up with a turntable spinning out of view.
    let onScreen = false;
    const report = (s) => {
      if (statusRef.current === s) return;
      statusRef.current = s;
      propsRef.current.onStatus?.(s);
    };

    const stopLoop = (eng) => {
      if (!eng?.raf) return;
      cancelAnimationFrame(eng.raf);
      eng.raf = 0;
      eng.last = 0;
    };

    const renderFrame = (eng) => {
      if (!eng?.group) return;
      eng.turntable.rotation.y = (eng.angle * Math.PI) / 180;
      // The PIECE turns, not the camera, so its baked ground shadow has to turn
      // with it — re-bake after the rotation is applied and before the draw, or
      // the piece rotates out of its own shadow. Cheap: the presentation rig
      // bakes at 256.
      eng.updateShadow?.();
      eng.renderer.render(eng.scene, eng.camera);
    };

    const startLoop = (eng) => {
      if (!eng || eng.raf || !eng.group || prefersReducedMotion()) return;
      eng.last = 0;
      const step = (t) => {
        if (engineRef.current !== eng) return;
        eng.raf = requestAnimationFrame(step);
        // Rate-limit the RENDER, not the loop. `last` is the last frame actually
        // drawn, so a skipped frame's time is not lost — it just lands in the
        // next dt and the piece turns at exactly the same speed.
        if (eng.last && (t - eng.last) < FRAME_MS) return;
        // The first frame after any pause only seeds the clock — coming back to
        // the tab never advances the piece by the whole time it spent hidden.
        const dt = eng.last ? Math.min(0.05, (t - eng.last) / 1000) : 0;
        eng.last = t;
        eng.angle = (eng.angle + dt * DEG_PER_SEC) % 360;
        renderFrame(eng);
      };
      eng.raf = requestAnimationFrame(step);
    };

    const frameCamera = (eng) => {
      const { camera } = eng;
      const r = eng.radius || 100;
      const hgt = eng.height || r;
      const vFov = (FOV * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, camera.aspect));
      // Fit the two axes SEPARATELY, not one bounding sphere. A sofa is long,
      // low and shallow: its sphere is nearly as tall as it is wide, so fitting
      // one left the piece marooned in the middle of the frame with air above
      // and below it. Horizontally the turntable really does sweep the full
      // circle (2r at every angle); vertically it only ever needs its own
      // height plus however much footprint the camera's tilt projects up into
      // the frame. Taking the max of the two puts the piece across the tile.
      // ...and frame the SHADOW too, not just the piece. The stage's raking key
      // sits at (1.2, 0.95, 0.5)·r aimed at the origin, so the contact shadow is
      // thrown the opposite way — screen LEFT and slightly back — and runs
      // `height / tan(elevation)` along the floor beyond the piece's own
      // footprint. Fitting the piece alone therefore cut that shadow off against
      // the left edge in a hard straight line at most angles of the turn, which
      // on a brand surface reads as a broken render.
      //
      // The light does NOT rotate with the piece (only the turntable spins), so
      // the shadow always leaves in the same screen direction and this is a
      // fixed amount rather than something to re-solve per frame.
      //
      // The frame simply gets BIGGER — it does not slide. Shifting it toward the
      // shadow packed piece and shadow tightly together, but it put the SOFA off
      // centre: measured on a phone the piece sat with 161px of gutter on one
      // side and 68px on the other, which is what you see, not the shadow it was
      // buying room for. A centred piece is worth more than the few percent of
      // size that growing symmetrically costs.
      const keyElev = Math.atan2(0.95, Math.hypot(1.2, 0.5));
      const shadowRun = (hgt / Math.tan(keyElev)) * (1.2 / Math.hypot(1.2, 0.5));
      // Only a FRACTION of the run needs framing: the shadow starts at the
      // piece's silhouette, not its centre, so most of it already falls inside —
      // and it fades out rather than ending at a hard edge. Reserving the whole
      // run nearly doubled the frame and shrank the sofa by a third, which is
      // the opposite of the point. This is the smallest reserve that stops the
      // hard cut, measured at every angle of the turn.
      const rEff = r + shadowRun * 0.42;
      const tilt = Math.atan(ELEVATION);
      const vExtent = hgt * Math.cos(tilt) + 2 * rEff * Math.sin(tilt);
      const dist = Math.max(
        rEff / Math.tan(hFov / 2),
        (vExtent / 2) / Math.tan(vFov / 2),
      ) * 1.04;
      camera.position.set(0, hgt * 0.5 + dist * ELEVATION, dist);
      camera.lookAt(0, hgt * 0.42, 0);
      camera.updateProjectionMatrix();
    };

    const resize = (eng) => {
      const w = Math.max(1, Math.round(host.clientWidth));
      const h = Math.max(1, Math.round(host.clientHeight));
      const key = `${w}x${h}`;
      if (eng.sized === key) return;
      eng.sized = key;
      eng.renderer.setSize(w, h, false);
      eng.camera.aspect = w / h;
      frameCamera(eng);
    };

    // Build (or re-build) the piece on the turntable. Generation-guarded: the
    // catalog can land mid-boot, and two overlapping rebuilds must not both add
    // a group to the scene.
    const rebuild = async (eng) => {
      const gen = ++eng.gen;
      const { scene3d: sc, fabricByCode: fabs } = propsRef.current;
      const pieces = sc?.pieces || [];
      if (!pieces.length) return;
      const { THREE, deps, turntable, quilt, grain, retarget } = eng;
      const codes = [...new Set(pieces.map((p) => p.fabricCode).filter(Boolean))];
      const look = new Map();
      for (const code of codes) {
        // Sequential on purpose: it's one fabric, and a card is never the place
        // to open several texture fetches at once on a phone.
        look.set(code, await loadFabricAppearance(THREE, code, (fabs || {})[code] || null, eng.fabricCache));
      }
      const loaded = await loadConfiguratorModels({ pieces });
      if (!alive || eng.gen !== gen) return;
      if (eng.group) { turntable.remove(eng.group); disposeGroup(eng.group); eng.group = null; }
      const group = buildConfiguratorGroup(deps, { pieces }, {
        ...STANDARD_CONFIGURATOR_FINISH, normalMap: quilt, grainMap: grain,
        colorFor: (c) => look.get(c)?.color ?? null,
        textureFor: (c) => look.get(c)?.texture || null,
        pbrFor: (c) => look.get(c)?.pbr || null,
        normalFor: (c) => look.get(c)?.normal || null,
        extrasFor: (c) => look.get(c)?.extra || null,
        modelFor: loaded.modelFor,
      });
      // Centre the piece ON the turntable's axis and sit it on the floor —
      // otherwise it orbits its own origin and wanders out of frame.
      const box = new THREE.Box3().setFromObject(group);
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      group.position.set(-c.x, -box.min.y, -c.z);
      turntable.add(group);
      eng.group = group;
      // Frame on the HORIZONTAL radius, not the near silhouette: a 174×102
      // settee is wide face-on and narrow in profile, so framing what's visible
      // now would clip it a quarter-turn later. It's framed for its worst angle.
      eng.radius = Math.max(1, Math.hypot(size.x, size.z) / 2);
      eng.height = size.y;
      retarget?.({ x: 0, z: 0 }, eng.radius);
      eng.sized = '';           // re-fit the camera to the new piece
      resize(eng);
    };

    const teardown = (eng) => {
      stopLoop(eng);
      if (eng.group) { eng.turntable.remove(eng.group); disposeGroup(eng.group); eng.group = null; }
      eng.quilt?.dispose?.();
      eng.grain?.dispose?.();
      disposeAppearanceCache(eng.fabricCache);
      eng.disposeStage?.();
      eng.renderer?.domElement?.remove();
      eng.renderer?.dispose?.();
    };

    const boot = async () => {
      if (started || !alive) return;
      started = true;
      let eng = null;
      try {
        const [THREE, { RoomEnvironment }, { RoundedBoxGeometry }] = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
          safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        ]);
        if (!alive) return;
        const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        // PCF, not PCFSoft — three r184 deprecated PCFSoftShadowMap and falls
        // back to exactly this, so naming it costs nothing and drops the warning.
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.setClearColor(0x000000, 0);           // transparent — the card's own ground shows
        renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        // Presentation lighting — the piece turns alone on a white card, with no
        // floor or room to give it form; see setupConfiguratorStage.
        const { dispose: disposeStage, retarget, updateShadow } = setupConfiguratorStage(deps, renderer, scene, 120, { presentation: true });
        scene.background = null;                        // keep the alpha (the stage set a colour)
        const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE, {
          anisotropy: fabricAnisotropy(renderer),
        });
        const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 6000);
        // The turntable: the PIECE turns while the camera and the light rig hold
        // still — so the key keeps raking across the channels from the same side
        // and the quilting reads plush through the whole revolution.
        const turntable = new THREE.Group();
        scene.add(turntable);

        eng = {
          THREE, deps, renderer, scene, camera, turntable, quilt, grain, retarget, updateShadow, disposeStage,
          group: null, fabricCache: makeAppearanceCache(),
          raf: 0, last: 0, angle: STILL_ANGLE, gen: 0, visible: true, sized: '',
        };
        engineRef.current = eng;

        // A lost context (backgrounded on a low-memory phone, a driver reset) is
        // not worth recovering here — hand the card back its silhouette.
        renderer.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          stopLoop(eng);
          report('failed');
        });

        await rebuild(eng);
        if (!alive) return;
        if (!eng.group) { report('failed'); return; }
        report('ready');
        renderFrame(eng);
        eng.visible = onScreen;
        if (onScreen) startLoop(eng);
      } catch {
        if (eng) { teardown(eng); if (engineRef.current === eng) engineRef.current = null; }
        report('failed');
      }
    };

    rebuildRef.current = () => {
      const eng = engineRef.current;
      if (!eng) return;
      rebuild(eng).then(() => { if (engineRef.current === eng) renderFrame(eng); });
    };

    // ── Boot only once the card is genuinely on screen.
    let io = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        const eng = engineRef.current;
        if (onScreen) { boot(); if (eng) { eng.visible = true; startLoop(eng); } }
        else if (eng) { eng.visible = false; stopLoop(eng); }
      }, { rootMargin: '96px' });
      io.observe(host);
    } else { onScreen = true; boot(); }   // no observer → boot immediately, as before one existed

    // A hidden tab must not animate.
    const onVisibility = () => {
      const eng = engineRef.current;
      if (!eng) return;
      if (document.hidden) stopLoop(eng);
      else if (eng.visible) startLoop(eng);
    };
    document.addEventListener('visibilitychange', onVisibility);

    const ro = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => { const eng = engineRef.current; if (eng) { resize(eng); renderFrame(eng); } })
      : null;
    ro?.observe(host);

    return () => {
      alive = false;
      rebuildRef.current = null;
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      const eng = engineRef.current;
      if (eng) { teardown(eng); engineRef.current = null; }
    };
  }, [hasScene]);

  // The catalog lands after the card paints, so the scene goes from empty to
  // real once (and a fabric edit can change it again). Rebuild the GROUP —
  // never the renderer.
  useEffect(() => { rebuildRef.current?.(); }, [sceneKey]);

  // A block-level SPAN, not a div: the one caller lives inside the launch
  // card's <a>, where every wrapper has to be phrasing content.
  return <span ref={hostRef} className={className} style={{ display: 'block' }} aria-hidden />;
}
