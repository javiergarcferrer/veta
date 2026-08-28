import { useEffect, useRef, useState } from 'react';
import { Loader2, Smartphone, AlertCircle, View } from 'lucide-react';
import Modal from '../Modal.jsx';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { buildArGroup, exportGlbBlob, loadSceneFabrics } from './togoGlbExport.js';
import { loadTogoModels } from './togoModelLoader.js';
import { disposeGroup as disposeModel } from './togoSceneBuilder.js';

const DEFAULT_FINISH = { sheen: 0.6, sheenRoughness: 0.55, roughness: 0.82, repeat: 3, normalScale: 1.0 };

/**
 * "Ver en tu espacio" — WebAR for the configured Togo layout. The headline gap
 * vs every consumer sofa configurator: not just a 3D spin, but the real sofa,
 * true-to-scale, placed on the customer's floor through their camera (iOS AR
 * Quick Look + Android Scene Viewer / WebXR), upholstered in their chosen fabric.
 *
 * It exports the SAME fabric-baked three.js scene the inline preview renders to a
 * GLB (client-side, no hosting), then hands it to Google's <model-viewer> — the
 * de-facto cross-platform AR launcher, which generates the USDZ on the fly for
 * iOS. Everything (three, the exporter, model-viewer) is lazy-loaded ONLY when a
 * visitor opens this, so the configurator's first paint pays nothing for AR.
 */
export default function TogoArViewer({ open, onClose, scene3d, material, storeName, phoneUrl, fabricByCode }) {
  const hostRef = useRef(null);
  const sceneRef = useRef(scene3d); sceneRef.current = scene3d;
  const finishRef = useRef(material); finishRef.current = material;
  const fabricsRef = useRef(fabricByCode); fabricsRef.current = fabricByCode;
  const [status, setStatus] = useState('idle');   // idle | building | ready | error
  const [arSupported, setArSupported] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');   // desktop handoff QR (of phoneUrl)
  const mvRef = useRef(null);                       // the live <model-viewer> element

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    let objectUrl = null;
    let disposeGroup = null;
    let mv = null;
    setStatus('building');
    setArSupported(false);

    (async () => {
      try {
        const sd = sceneRef.current;
        if (!sd || !(sd.pieces || []).length) { if (alive) setStatus('error'); return; }

        // Load three + the GLB exporter (code-split, on demand).
        const [THREE, { RoundedBoxGeometry }, { GLTFExporter }] = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
          safeDynamicImport(() => import('three/examples/jsm/exporters/GLTFExporter.js')),
        ]);
        if (!alive) return;

        // Bake the chosen fabrics + finish into the GLB so AR shows real cloth —
        // the REAL tileable textures from the dealer's pCon library when linked
        // (base AND per-part picks), exact/sampled colours otherwise — AND load
        // the REAL Togo meshes (FBX/GLB/…) for the placed pieces, so AR places
        // the actual product, not the procedural stand-in. A piece with no real
        // model falls back to procedural geometry inside buildTogoGroup.
        //
        // The models load into a PRIVATE cache (the second arg) precisely
        // because this viewer frees them the moment the GLB is baked: it is
        // short-lived and runs on a phone's memory budget. The loader's default
        // cache is session-shared — the live stage and the offscreen thumbnail
        // engine hold those same parsed meshes — so disposing it would blank
        // the configurator behind the AR modal (every geometry/material the
        // stage had bound, freed under it).
        const [{ fabricTextures, colors, pbr, normals, extras, dispose: disposeFabrics }, { cache: modelCache, modelFor }] = await Promise.all([
          loadSceneFabrics(THREE, sd, fabricsRef.current || {}, (c) => swatchProxyUrl(c) || swatchUrl(c)),
          loadTogoModels(sd, new Map()),
        ]);
        if (!alive) { disposeFabrics(); modelCache.forEach((m) => disposeModel(m.object || m)); return; }

        const built = buildArGroup({ THREE, RoundedBoxGeometry }, sd, {
          ...DEFAULT_FINISH, ...(finishRef.current || {}), fabricTextures, colors, pbr, normals, extras, modelFor,
        });
        disposeGroup = built.dispose;
        const blob = await exportGlbBlob({ GLTFExporter, THREE }, built.root);
        built.dispose();                 // GLB is self-contained — free the scene now
        modelCache.forEach((m) => disposeModel(m.object || m)); // free the source meshes
        disposeGroup = null;
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);

        // Register + mount <model-viewer> imperatively (dodges custom-element JSX
        // typing and lets us drive AR + read support directly off the element).
        await safeDynamicImport(() => import('@google/model-viewer'));
        if (!alive || !hostRef.current) return;
        mv = document.createElement('model-viewer');
        mv.setAttribute('src', objectUrl);
        mv.setAttribute('alt', `Configuración Togo de ${storeName || ''} en 3D`.trim());
        mv.setAttribute('camera-controls', '');
        mv.setAttribute('touch-action', 'pan-y');
        mv.setAttribute('interaction-prompt', 'none');
        mv.setAttribute('shadow-intensity', '1');
        mv.setAttribute('shadow-softness', '1');
        mv.setAttribute('exposure', '1');
        mv.setAttribute('environment-image', 'neutral');
        mv.setAttribute('ar', '');
        mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
        mv.setAttribute('ar-scale', 'fixed');           // true-to-scale, no resizing
        mv.setAttribute('ar-placement', 'floor');
        mv.style.width = '100%';
        mv.style.height = '100%';
        mv.style.backgroundColor = 'transparent';
        mv.addEventListener('load', () => { if (alive) setArSupported(!!mv.canActivateAR); });
        hostRef.current.appendChild(mv);
        mvRef.current = mv;
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();

    return () => {
      alive = false;
      mvRef.current = null;
      try { mv?.remove(); } catch { /* already gone */ }
      disposeGroup?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, storeName]);

  // Desktop handoff QR: this device can't place the sofa in AR (no camera / not
  // a phone), so we render `phoneUrl` as a QR — scan it and the SAME build opens
  // on the phone, where "Ver en tu espacio" works. `qrcode` is code-split so the
  // configurator's first paint never pays for it. Skipped once the device proves
  // AR-capable (a phone) — there the AR button is the answer, not a QR.
  useEffect(() => {
    if (!open || !phoneUrl || arSupported) { setQrDataUrl(''); return undefined; }
    let alive = true;
    (async () => {
      try {
        const mod = await safeDynamicImport(() => import('qrcode'));
        const QR = mod.default || mod;
        const url = await QR.toDataURL(phoneUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
        if (alive) setQrDataUrl(url);
      } catch { if (alive) setQrDataUrl(''); }
    })();
    return () => { alive = false; };
  }, [open, phoneUrl, arSupported]);

  const launchAr = () => { try { mvRef.current?.activateAR?.(); } catch { /* unsupported */ } };

  return (
    <Modal open={open} onClose={onClose} title="Ver en tu espacio" size="lg">
      <div className="space-y-3">
        <div className="relative w-full h-[58vh] min-h-[420px] rounded-xl border border-ink-200 bg-ink-50/40 overflow-hidden">
          <div ref={hostRef} className="absolute inset-0" />
          {status !== 'ready' && (
            <div className="absolute inset-0 grid place-items-center text-center px-6">
              {status === 'error' ? (
                <div className="text-ink-500 text-sm flex flex-col items-center gap-2">
                  <AlertCircle size={22} className="text-ink-400" />
                  No se pudo preparar la vista. Agrega al menos una pieza e inténtalo de nuevo.
                </div>
              ) : (
                <div className="text-ink-500 text-sm flex flex-col items-center gap-2">
                  <Loader2 size={20} className="animate-spin" /> Preparando tu sofá…
                </div>
              )}
            </div>
          )}
        </div>

        {status === 'ready' && (
          arSupported ? (
            <button type="button" onClick={launchAr} className="btn-primary w-full justify-center text-sm">
              <View size={16} /> Verlo en tu espacio (Realidad Aumentada)
            </button>
          ) : phoneUrl ? (
            // Desktop → hand the build off to the phone via a QR, where AR works.
            <div className="rounded-xl border border-ink-200 bg-surface p-4 flex items-center gap-4">
              <div className="shrink-0 rounded-lg bg-white p-2 border border-ink-100">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Código QR para abrir tu diseño en el teléfono" width={132} height={132} className="block h-[132px] w-[132px]" />
                ) : (
                  <div className="grid h-[132px] w-[132px] place-items-center"><Loader2 size={18} className="animate-spin text-ink-400" /></div>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium text-ink-800">
                  <Smartphone size={16} className="shrink-0 text-brand-500" /> Escanéalo con tu teléfono
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-600">
                  La realidad aumentada necesita la cámara del móvil. Escanea el código y tu diseño se abre tal cual en el teléfono, listo para colocarlo a tamaño real en tu sala.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-ink-200 bg-surface px-3 py-2.5 text-xs text-ink-600 flex items-center gap-2">
              <Smartphone size={16} className="shrink-0 text-ink-500" />
              Arrastra para girar el modelo. Para colocarlo a tamaño real en tu sala, abre el configurador desde tu teléfono.
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
