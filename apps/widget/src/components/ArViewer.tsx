/**
 * "SEE IT IN YOUR SPACE" — WebAR for the configured design.
 *
 * The headline difference against a plain 3D spin: the real piece, true to
 * scale, on the visitor's own floor, in the fabric they picked. The design is
 * exported to a GLB client-side (no hosting, nothing uploaded) and handed to
 * Google's `<model-viewer>`, which drives WebXR / Scene Viewer / Quick Look and
 * generates the USDZ iOS needs on the fly.
 *
 * TWO OPTIONAL DEPENDENCIES, both loaded through `loadOptionalModule`:
 * `@google/model-viewer` and `qrcode`. Neither is declared as a build-time
 * import, so this app builds and typechecks without them installed, and each
 * feature simply stays hidden until a deploy carries the package — an AR button
 * that is absent is a missing nicety; an AR button that breaks the bundle is a
 * dead configurator.
 *
 * On a DESKTOP (no camera, no AR) the answer is not an error but the phone
 * handoff: the same build encoded into a QR, so the visitor scans it and
 * continues on the device where AR works.
 */

import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@veta/i18n';
import type { SceneView } from '../vm/scene.ts';
import { loadOptionalModule } from '../lib/dynamicImport.ts';
import { exportGlb, type SceneExportOptions } from '../lib/sceneExport.ts';

export interface ArViewerProps {
  open: boolean;
  view: SceneView;
  exportOptions: SceneExportOptions;
  locale: Locale;
  brandName: string;
  /** The desktop→phone handoff URL (already carries `?build=`). */
  phoneUrl: string;
  onClose: () => void;
}

export default function ArViewer({ open, view, exportOptions, locale, brandName, phoneUrl, onClose }: ArViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'building' | 'ready' | 'unavailable' | 'error'>('idle');
  const [qr, setQr] = useState('');

  useEffect(() => {
    if (!open) { setStatus('idle'); setQr(''); return undefined; }
    let alive = true;
    let objectUrl = '';
    let element: any = null;
    setStatus('building');

    (async () => {
      try {
        if (!view.pieces.length) { if (alive) setStatus('error'); return; }
        const blob = await exportGlb(view, exportOptions);
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);

        // model-viewer registers a custom element as a SIDE EFFECT of loading.
        // Absent (not installed) → the modal falls back to the QR handoff.
        const mv = await loadOptionalModule('@google/model-viewer');
        if (!alive) return;
        if (!mv || !hostRef.current) { setStatus('unavailable'); return; }

        element = document.createElement('model-viewer');
        element.setAttribute('src', objectUrl);
        element.setAttribute('alt', `${brandName} — 3D`.trim());
        element.setAttribute('camera-controls', '');
        element.setAttribute('touch-action', 'pan-y');
        element.setAttribute('shadow-intensity', '1');
        element.setAttribute('environment-image', 'neutral');
        element.setAttribute('ar', '');
        element.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
        element.setAttribute('ar-scale', 'fixed');   // true to scale — never resizable
        element.setAttribute('ar-placement', 'floor');
        element.style.width = '100%';
        element.style.height = '100%';
        hostRef.current.appendChild(element);
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();

    return () => {
      alive = false;
      try { element?.remove(); } catch { /* already gone */ }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, view, exportOptions, brandName]);

  // The desktop handoff QR. Drawn only when there is a URL to hand off and the
  // device could not offer AR itself.
  useEffect(() => {
    if (!open || !phoneUrl || status === 'ready') { setQr(''); return undefined; }
    let alive = true;
    (async () => {
      const QR = await loadOptionalModule<{ toDataURL(text: string, opts?: unknown): Promise<string> }>('qrcode');
      if (!alive || !QR?.toDataURL) return;
      try {
        setQr(await QR.toDataURL(phoneUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' }));
      } catch { /* no QR is a missing nicety, never an error state */ }
    })();
    return () => { alive = false; };
  }, [open, phoneUrl, status]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t(locale, 'tools.ar')}>
      <div className="modal__panel">
        <header className="modal__head">
          <h2>{t(locale, 'tools.ar')}</h2>
          <button type="button" className="btn btn--quiet" onClick={onClose}>{t(locale, 'common.close')}</button>
        </header>
        <div ref={hostRef} className="modal__body" />
        {status === 'building' ? <p className="modal__status">{t(locale, 'inbox.loading')}</p> : null}
        {status === 'error' ? <p className="modal__status">{t(locale, 'error.load')}</p> : null}
        {qr ? (
          <figure className="modal__qr">
            <img src={qr} alt={t(locale, 'tools.ar')} width={160} height={160} />
            <figcaption>{t(locale, 'hint.view3d')}</figcaption>
          </figure>
        ) : null}
      </div>
    </div>
  );
}
