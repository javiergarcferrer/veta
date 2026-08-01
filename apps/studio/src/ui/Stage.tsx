/**
 * THE STAGE — the model rendered THROUGH THE WIDGET'S OWN PIPELINE.
 *
 * `setupStage` + `buildSceneGroup` from `@veta/scene`, over the same
 * `@veta/materials` taxonomy the visitor's widget binds. That is the whole
 * point: a hand-rolled preview would answer for itself, and a green check in
 * the fidelity panel has to mean green THERE.
 *
 * three.js is DYNAMICALLY imported (CONTRACTS.md: the engines never import it —
 * ~730 KB of module evaluation belongs behind a code split), and this component
 * is the app layer that finally names it.
 *
 * The View derives NOTHING: it reports what the build OBSERVED (`BuildReport`)
 * upward and renders whatever `resolveFidelityChecks` makes of it.
 */
import { useEffect, useRef } from 'react';
import type { BuildReport } from '../vm/fidelity.ts';
import type { StudioModel } from '../vm/types.ts';

interface StageProps {
  model: StudioModel | null;
  fabricCode?: string | null;
  onReport?: (report: BuildReport | null) => void;
  onBuilding?: (building: boolean) => void;
}

interface Rig {
  THREE: any;
  renderer: any;
  scene: any;
  camera: any;
  stage: { dispose(): void; retarget(c: any, r?: number): void; setShadow(m: '2d' | '3d'): void };
  group: any | null;
  disposeGroup: (g: any) => void;
  observer: ResizeObserver;
  frame: number;
}

export function Stage({ model, fabricCode = null, onReport, onBuilding }: StageProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const rig = useRef<Rig | null>(null);
  const alive = useRef(true);

  // Boot ONE renderer for the pane's life; models are swapped INTO it. A
  // per-model context would leak WebGL contexts until the browser starts
  // dropping the oldest one under the dealer.
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void (async () => {
      const el = host.current;
      if (!el) return;
      const [THREE, scene, env] = await Promise.all([
        import('three'),
        import('@veta/scene'),
        import('three/examples/jsm/environments/RoomEnvironment.js'),
      ]);
      if (disposed || !host.current) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
      renderer.shadowMap.enabled = true;
      const scene3 = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 1, 6000);
      camera.position.set(210, 150, 260);
      camera.lookAt(0, 40, 0);
      const stage = scene.setupStage(THREE as any, renderer, scene3, 160, {
        RoomEnvironment: env.RoomEnvironment,
        grid: true,
      });
      el.appendChild(renderer.domElement);
      const resize = (): void => {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(el);
      const tick = (): void => {
        if (!alive.current) return;
        rig.current!.frame = requestAnimationFrame(tick);
        renderer.render(scene3, camera);
      };
      rig.current = {
        THREE, renderer, scene: scene3, camera, stage,
        group: null, disposeGroup: scene.disposeGroup as any, observer, frame: 0,
      };
      tick();
    })();
    return () => {
      disposed = true;
      alive.current = false;
      const r = rig.current;
      if (!r) return;
      cancelAnimationFrame(r.frame);
      r.observer.disconnect();
      if (r.group) r.disposeGroup(r.group);
      r.stage.dispose();
      r.renderer.dispose();
      r.renderer.domElement.remove();
      rig.current = null;
    };
  }, []);

  // Rebuild the group whenever the piece or its tagging changes. The report is
  // taken off the BUILT group — an observation, never a restatement of the row.
  useEffect(() => {
    let cancelled = false;
    onBuilding?.(true);
    onReport?.(null);
    void (async () => {
      // The rig boots asynchronously; wait for it rather than dropping the build
      // (a model selected during the very first paint must still render).
      for (let i = 0; i < 100 && !rig.current && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const r = rig.current;
      if (cancelled || !r) return;
      if (r.group) { r.disposeGroup(r.group); r.scene.remove(r.group); r.group = null; }
      if (!model) { onBuilding?.(false); return; }

      const scene = await import('@veta/scene');
      if (cancelled || !rig.current) return;
      const url = model.mesh?.url || '';
      let modelFor: (piece: any) => any = () => null;
      let meshLoaded = false;
      if (url) {
        try {
          const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
          const utils = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
          const loaded = await scene.loadModels(
            { pieces: [{ }] },
            {
              THREE: r.THREE,
              loaderFor: (ext: string) => (ext === 'glb' || ext === 'gltf' ? new GLTFLoader() : null),
              descFor: () => ({ url, upAxis: model.mesh?.upAxis || 'y', rotateY: model.mesh?.rotateY || 0, scale: model.mesh?.scale || undefined }),
              toCreasedNormals: utils.toCreasedNormals as any,
            },
          );
          modelFor = loaded.modelFor;
          meshLoaded = !!loaded.modelFor({});
        } catch {
          meshLoaded = false;                       // the fidelity panel names it
        }
      }
      if (cancelled || !rig.current) return;

      const group = scene.buildSceneGroup(r.THREE, {
        pieces: [{
          x: 0,
          z: 0,
          widthCm: model.plan?.widthCm ?? null,
          depthCm: model.plan?.depthCm ?? null,
          collection: model.collection || null,
          fabricCode: fabricCode || null,
          parts: (model.parts as any) || null,
        }],
      }, { modelFor });
      r.scene.add(group);
      r.group = group;
      r.stage.setShadow('3d');
      onReport?.(reportOf(group, meshLoaded));
      onBuilding?.(false);
    })();
    return () => { cancelled = true; };
  }, [model, fabricCode, onBuilding, onReport]);

  return (
    <div className="stage" ref={host}>
      {!model ? <div className="empty">Select a model</div> : null}
    </div>
  );
}

/** What the BUILT group actually contains — the six observations the fidelity
 *  panel reports. Read off `userData` markers the scene builder stamps. */
function reportOf(group: any, meshLoaded: boolean): BuildReport {
  let meshCount = 0;
  let factoryMeshes = 0;
  let finishMaterials = 0;
  let fabricWithScan = false;
  let fabricPixels = false;
  group?.traverse?.((o: any) => {
    if (!o?.isMesh) return;
    meshCount++;
    if (o.userData?.factoryFinish) factoryMeshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.userData?.partFinish) finishMaterials++;
      if (m.userData?.scanFinish) {
        fabricWithScan = true;
        // A texture that 404s degrades to a flat tint without throwing anywhere
        // — the image is the only place that failure is visible.
        const img = m.map?.image;
        if (img && (img.width || img.videoWidth || img.byteLength)) fabricPixels = true;
      }
    }
  });
  return { meshLoaded, meshCount, factoryMeshes, fabricWithScan, fabricPixels, finishMaterials };
}
