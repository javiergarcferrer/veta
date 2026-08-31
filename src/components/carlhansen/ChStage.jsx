import { useEffect, useMemo, useRef } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { partKeyFor } from '../../lib/configurator/meshParts.js';
import { loaderFor, normalizeLoaded, extOf } from '../configurator/modelLoader.js';
import { setupConfiguratorStage, sampleSwatchColor, disposeGroup } from '../configurator/sceneBuilder.js';
import { chSurfaceFor } from '../../core/catalog/index.js';

/**
 * EL CONFIGURADOR 3D DE CARL HANSEN — una pieza, girándola, con los ejes
 * pintando la malla en vivo.
 *
 * ── POR QUÉ ESTE COMPONENTE EXISTE ──────────────────────────────────────────
 * El único configurador 3D que este producto tenía era el de Ligne Roset, y su
 * instrumento es una PLANTA: colocas módulos, los arrastras, y el precio es la
 * suma de lo que pusiste. Para una silla eso es el instrumento equivocado — una
 * Wishbone es UNA pieza, y lo que se elige es su madera, su acabado y su
 * asiento. Así que esta es la otra mitad que faltaba: la misma cocina de 3D
 * (el mismo rig de luces, el mismo cargador de mallas, el mismo muestreo de
 * swatches), con UNA pieza en el centro que se gira y se re-viste.
 *
 * Lo que NO es: un visor. El binding material→eje que el humano confirmó en
 * ChMeshPanel es exactamente lo que hace que tocar «Nogal, aceite» repinte los
 * trece grupos de madera de la malla y nada más. Sin ese binding esto sería una
 * foto que gira.
 *
 * ── LA MALLA ES NUESTRA, NO DE LA CACHÉ COMPARTIDA ──────────────────────────
 * Se carga con `loaderFor`/`normalizeLoaded` directamente y NO por
 * `loadConfiguratorModels`: esa caché comparte el objeto parseado entre el escenario
 * vivo, las miniaturas y la tarjeta giratoria, y aquí MUTAMOS los materiales en
 * cada cambio de eje. Pintar sobre un objeto compartido teñiría la miniatura de
 * otra pantalla. Una pieza, una instancia, y `disposeGroup` al desmontar.
 *
 * ── QUÉ APAGA EL MOTOR ──────────────────────────────────────────────────────
 * Sin WebGL, sin malla publicada o con el contexto perdido esto reporta
 * `failed` y no dibuja nada — nunca una caja rota. El panel de al lado ya dice
 * en cristiano por qué un modelo no trae 3D.
 */

const FOV = 32;
const MIN_PITCH = -0.15;
const MAX_PITCH = 0.62;
const DEFAULT_YAW = -0.55;
const DEFAULT_PITCH = 0.22;

/** Una vuelta lenta mientras nadie toca — se detiene al primer arrastre y no
 *  existe si el visitante pidió menos movimiento. */
const IDLE_DEG_PER_SEC = 7;
const FRAME_MS = 1000 / 60;

export default function ChStage({
  meshUrl = '',
  axes = null,
  binding = null,
  className = '',
  onStatus = null,
}) {
  const hostRef = useRef(null);
  const engineRef = useRef(null);
  const statusRef = useRef(null);

  // Lo que el motor lee sin re-arrancar: los ejes cambian en cada clic del
  // configurador y el repintado NO puede reconstruir la escena.
  const propsRef = useRef({ axes, binding, onStatus });
  propsRef.current = { axes, binding, onStatus };

  /** La firma de lo PINTADO: eje → opción elegida. Cambia con cada clic y es lo
   *  único que dispara un repintado. */
  const paintKey = useMemo(
    () => (axes || []).map((a) => `${a?.id || ''}:${a?.selected?.key || ''}`).join('|'),
    [axes],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !meshUrl) return undefined;

    let alive = true;
    const report = (s) => {
      if (statusRef.current === s) return;
      statusRef.current = s;
      propsRef.current.onStatus?.(s);
    };

    const boot = async () => {
      let eng = null;
      try {
        const [THREE, { RoomEnvironment }] = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
        ]);
        if (!alive) return;
        const deps = { THREE, RoomEnvironment };

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const { dispose: disposeStage, retarget, updateShadow } =
          setupConfiguratorStage(deps, renderer, scene, 60, { presentation: true });
        scene.background = null;

        const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000);
        const turntable = new THREE.Group();
        scene.add(turntable);

        eng = {
          THREE, renderer, scene, camera, turntable, disposeStage, retarget, updateShadow,
          group: null, radius: 60, height: 80,
          yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, dolly: 1,
          raf: 0, last: 0, idle: true, sized: '', texCache: new Map(), painted: '',
        };
        engineRef.current = eng;

        renderer.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          if (eng.raf) { cancelAnimationFrame(eng.raf); eng.raf = 0; }
          report('failed');
        });

        // ── la malla ──────────────────────────────────────────────────────────
        const ext = extOf(meshUrl);
        const loader = await loaderFor(ext);
        if (!loader) throw new Error(`sin lector para .${ext}`);
        const res = await loader.loadAsync(meshUrl);
        if (!alive || engineRef.current !== eng) return;
        const root = normalizeLoaded(ext, res);
        if (!root) throw new Error('la malla llegó vacía');

        // Centrada sobre el eje del giro y apoyada en el suelo: si no, orbita
        // su propio origen y se va del cuadro.
        const box = new THREE.Box3().setFromObject(root);
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        root.position.set(-c.x, -box.min.y, -c.z);
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        turntable.add(root);
        eng.group = root;
        eng.radius = Math.max(1, Math.hypot(size.x, size.z) / 2);
        eng.height = Math.max(1, size.y);
        retarget?.({ x: 0, z: 0 }, eng.radius);

        // ── los grupos de material, indexados como los indexó el binding ─────
        // `partKeyFor(nombre, índice)` es LA MISMA llave con la que se guardó el
        // binding en chMeshImport, así que un grupo sin nombre («#3») sigue
        // encontrando su eje.
        const targets = [];
        let node = 0;
        root.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const i = node++;
          for (const mat of mats) {
            if (!mat) continue;
            targets.push({ key: partKeyFor(mat.name, i), mat });
          }
        });
        eng.targets = targets;

        // El asa que usa el efecto de repintado: los ejes cambian sin volver a
        // montar el motor, así que el clic entra por aquí.
        eng.repaint = () => { paint(eng); };
        await paint(eng, true);
        if (!alive || engineRef.current !== eng) return;
        resize(eng);
        report('ready');
        startLoop(eng);
      } catch (e) {
        if (eng) teardown(eng);
        if (engineRef.current === eng) engineRef.current = null;
        console.error('[ChStage] no se pudo montar el 3D:', e);
        report('failed');
      }
    };

    /** El color de una textura de swatch, cacheado por url. */
    const swatchColor = async (eng, url) => {
      if (!url) return null;
      if (eng.texCache.has(url)) return eng.texCache.get(url);
      let out = null;
      try {
        const tex = await new eng.THREE.TextureLoader().loadAsync(url);
        out = sampleSwatchColor(tex.image);
        tex.dispose?.();
      } catch { out = null; }
      eng.texCache.set(url, out);
      return out;
    };

    /**
     * Pintar cada grupo con el eje que le toca.
     *
     * El repintado NO reconstruye: toca `color`, `roughness` y `metalness` de
     * los materiales que ya están en la escena. Un clic en un eje cuesta un
     * frame, no una recarga de malla.
     */
    const paint = async (eng, force = false) => {
      const { axes: ax, binding: bind } = propsRef.current;
      const key = (ax || []).map((a) => `${a?.id || ''}:${a?.selected?.key || ''}`).join('|');
      if (!force && key === eng.painted) return;
      eng.painted = key;

      const axisById = new Map((ax || []).filter((a) => a?.id).map((a) => [a.id, a]));
      const axisForGroup = new Map(
        (bind?.groups || []).filter((g) => g?.name && g?.axisId).map((g) => [String(g.name), g.axisId]),
      );

      // El eje de ACABADO (aceite/laca/jabón) no tiene grupo propio: modifica el
      // brillo de la madera. Se resuelve una vez y se aplica a lo que sea madera.
      const finishAxis = (ax || []).find((a) => a?.kind === 'finish') || null;

      for (const t of eng.targets || []) {
        const axis = axisById.get(axisForGroup.get(t.key));
        if (!axis?.selected) continue;
        const opt = axis.selected;
        const swatch = await swatchColor(eng, opt.swatch);
        if (engineRef.current !== eng) return;
        // El Modelo decide la superficie; aquí sólo se aplica. Un grupo cuya
        // opción no dice nada utilizable se queda como vino de fábrica.
        const surface = chSurfaceFor({
          kind: axis.kind,
          label: opt.label,
          groupLabel: opt.groupLabel,
          finishLabel: finishAxis?.selected?.label || '',
          sampled: swatch,
        });
        if (!surface) continue;
        const { mat } = t;
        if (surface.color != null && mat.color?.setHex) mat.color.setHex(surface.color);
        if (surface.roughness != null && 'roughness' in mat) mat.roughness = surface.roughness;
        if (surface.metalness != null && 'metalness' in mat) mat.metalness = surface.metalness;
        mat.needsUpdate = true;
      }
      draw(eng);
    };

    const draw = (eng) => {
      if (!eng?.group) return;
      const { camera } = eng;
      const r = Math.max(eng.radius, eng.height * 0.5);
      const dist = (r / Math.tan((FOV * Math.PI) / 360)) * 1.9 * eng.dolly;
      const cx = Math.sin(eng.yaw) * Math.cos(eng.pitch) * dist;
      const cz = Math.cos(eng.yaw) * Math.cos(eng.pitch) * dist;
      const cy = eng.height * 0.45 + Math.sin(eng.pitch) * dist;
      camera.position.set(cx, cy, cz);
      camera.lookAt(0, eng.height * 0.42, 0);
      camera.updateProjectionMatrix();
      eng.updateShadow?.();
      eng.renderer.render(eng.scene, eng.camera);
    };

    const startLoop = (eng) => {
      if (!eng || eng.raf || prefersReducedMotion()) { draw(eng); return; }
      eng.last = 0;
      const step = (t) => {
        if (engineRef.current !== eng) return;
        eng.raf = requestAnimationFrame(step);
        if (eng.last && (t - eng.last) < FRAME_MS) return;
        const dt = eng.last ? Math.min(0.05, (t - eng.last) / 1000) : 0;
        eng.last = t;
        // La vuelta lenta es cortesía, no el estado: al primer arrastre se apaga
        // para siempre y la pieza queda donde el dealer la dejó.
        if (eng.idle) eng.yaw += (dt * IDLE_DEG_PER_SEC * Math.PI) / 180;
        draw(eng);
      };
      eng.raf = requestAnimationFrame(step);
    };

    const resize = (eng) => {
      const w = Math.max(1, Math.round(host.clientWidth));
      const h = Math.max(1, Math.round(host.clientHeight));
      const k = `${w}x${h}`;
      if (eng.sized === k) return;
      eng.sized = k;
      eng.renderer.setSize(w, h, false);
      eng.camera.aspect = w / h;
      draw(eng);
    };

    const teardown = (eng) => {
      if (eng.raf) { cancelAnimationFrame(eng.raf); eng.raf = 0; }
      if (eng.group) { eng.turntable.remove(eng.group); disposeGroup(eng.group); eng.group = null; }
      eng.disposeStage?.();
      eng.renderer?.domElement?.remove();
      eng.renderer?.dispose?.();
    };

    // ── girar con el dedo / el ratón ────────────────────────────────────────
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e) => {
      const eng = engineRef.current;
      if (!eng) return;
      dragging = true;
      eng.idle = false;                 // se acabó la vuelta de cortesía
      lastX = e.clientX; lastY = e.clientY;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      const eng = engineRef.current;
      if (!dragging || !eng) return;
      eng.yaw -= (e.clientX - lastX) * 0.01;
      eng.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, eng.pitch + (e.clientY - lastY) * 0.006));
      lastX = e.clientX; lastY = e.clientY;
      draw(eng);
    };
    const onUp = (e) => {
      dragging = false;
      if (e?.currentTarget) e.currentTarget.style.cursor = 'grab';
    };
    const onWheel = (e) => {
      const eng = engineRef.current;
      if (!eng) return;
      e.preventDefault();
      eng.dolly = Math.max(0.55, Math.min(2.2, eng.dolly * (1 + Math.sign(e.deltaY) * 0.08)));
      draw(eng);
    };

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
    host.addEventListener('wheel', onWheel, { passive: false });

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { const eng = engineRef.current; if (eng) resize(eng); })
      : null;
    ro?.observe(host);

    boot();

    return () => {
      alive = false;
      ro?.disconnect();
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      host.removeEventListener('wheel', onWheel);
      const eng = engineRef.current;
      if (eng) { teardown(eng); engineRef.current = null; }
      statusRef.current = null;
    };
    // El arranque depende SÓLO de la malla: cambiar de eje repinta (abajo), no
    // vuelve a montar el motor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshUrl]);

  // El repintado en vivo: cada clic del configurador pasa por aquí.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !eng.targets) return;
    eng.repaint?.();
  }, [paintKey]);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
