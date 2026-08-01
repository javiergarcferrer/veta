/**
 * THE 3D VIEW — the same design, upholstered, under the studio rig.
 *
 * three.js is loaded on the FIRST mount of this component and never before (see
 * `lib/three.ts`): the plan editor, the price deck and the lead form are the
 * paths most visitors take, and none of them should pay for a renderer. That is
 * also why nothing in `components/` imports three statically — this file talks
 * to it only through the bundle it awaited.
 *
 * The scene graph is rebuilt whenever the design changes and DISPOSED on the way
 * out (`disposeGroup` frees every geometry/material/texture the build owns).
 * The render loop is on-demand: a frame is drawn when something moved, not 60
 * times a second on an idle phone.
 */

import { useEffect, useRef, useState } from 'react';
import { buildSceneGroup, disposeGroup, setupStage } from '@veta/scene';
import { t, type Locale } from '@veta/i18n';
import type { SceneView as SceneViewModel } from '../vm/scene.ts';
import { sceneFabricCodes } from '../vm/scene.ts';
import { loadThree } from '../lib/three.ts';
import { loadFabricMaps, type FabricMaps } from '../lib/appearance.ts';
import type { ImageOps, MaterialSource } from '@veta/materials';

export interface SceneViewProps {
  view: SceneViewModel;
  source: MaterialSource;
  imageOps: ImageOps;
  renderParams?: Record<string, unknown> | null;
  locale: Locale;
  swatchUrlFor?: (code: string) => string | null;
}

export default function SceneView({ view, source, imageOps, renderParams, locale, swatchUrlFor }: SceneViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // One effect owns the whole renderer lifetime. `alive` guards every await:
  // a visitor who switches back to the plan mid-load must not get a canvas
  // appended into an unmounted host.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let alive = true;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const { THREE, RoundedBoxGeometry, RoomEnvironment } = await loadThree();
        if (!alive) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
        const stage = setupStage(THREE, renderer, scene, view.radius, { RoomEnvironment, grid: true });

        let maps: FabricMaps | null = null;
        let group: any = null;
        const rebuild = async () => {
          maps?.dispose();
          maps = await loadFabricMaps(sceneFabricCodes(view), { THREE, source, imageOps, swatchUrlFor });
          if (!alive) { maps.dispose(); return; }
          if (group) disposeGroup(group);
          group = buildSceneGroup(THREE, { pieces: view.pieces as never }, {
            RoundedBoxGeometry,
            params: (renderParams ?? null) as never,
            colorFor: (code: string) => maps?.colors.get(code) ?? null,
            textureFor: (code: string) => maps?.textures.get(code) ?? null,
            normalFor: (code: string) => maps?.normals.get(code) ?? null,
            pbrFor: (code: string) => (maps?.pbr.get(code) ?? null) as never,
          });
          scene.add(group);
          stage.retarget({ x: 0, z: 0 }, view.radius);
          stage.setShadow('3d');
          render();
        };

        // Orbit by hand: the visitor drags to turn around the build and wheels
        // to close in. A full controls addon would be another chunk for two
        // gestures.
        let theta = Math.PI * 0.25;
        let phi = Math.PI * 0.32;
        let distance = view.radius * 3.2;
        const place = () => {
          camera.position.set(
            Math.sin(phi) * Math.cos(theta) * distance,
            Math.cos(phi) * distance,
            Math.sin(phi) * Math.sin(theta) * distance,
          );
          camera.lookAt(0, view.radius * 0.28, 0);
        };
        const render = () => {
          const rect = host.getBoundingClientRect();
          const w = Math.max(1, Math.round(rect.width));
          const h = Math.max(1, Math.round(rect.height));
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          place();
          renderer.render(scene, camera);
        };

        let dragging = false;
        let last = { x: 0, y: 0 };
        const canvas = renderer.domElement as HTMLCanvasElement;
        const onDown = (e: PointerEvent) => { dragging = true; last = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture?.(e.pointerId); };
        const onMove = (e: PointerEvent) => {
          if (!dragging) return;
          theta -= (e.clientX - last.x) * 0.008;
          phi = Math.min(Math.PI * 0.48, Math.max(0.12, phi - (e.clientY - last.y) * 0.006));
          last = { x: e.clientX, y: e.clientY };
          render();
        };
        const onUp = () => { dragging = false; };
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          distance = Math.min(view.radius * 8, Math.max(view.radius * 1.2, distance * (1 + Math.sign(e.deltaY) * 0.12)));
          render();
        };
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        const onResize = () => render();
        globalThis.addEventListener?.('resize', onResize);

        await rebuild();
        if (!alive) return;
        setStatus('ready');

        cleanup = () => {
          globalThis.removeEventListener?.('resize', onResize);
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('wheel', onWheel);
          if (group) disposeGroup(group);
          maps?.dispose();
          stage.dispose();
          renderer.dispose();
          canvas.remove();
        };
      } catch {
        if (alive) setStatus('error');
      }
    })();

    return () => { alive = false; cleanup?.(); };
    // The whole scene is rebuilt when the design changes: the pieces array is
    // the identity of a build, and rebuilding is cheaper than diffing a graph.
  }, [view, source, imageOps, renderParams, swatchUrlFor]);

  return (
    <div className="stage">
      <div ref={hostRef} className="stage__host" />
      {status !== 'ready' ? (
        <p className="stage__status">{t(locale, status === 'error' ? 'error.load' : 'inbox.loading')}</p>
      ) : null}
    </div>
  );
}
