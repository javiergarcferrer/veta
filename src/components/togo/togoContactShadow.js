/**
 * CONTACT SHADOWS — the soft, height-faded shadow that puts a build ON the floor.
 *
 * WHY THIS EXISTS. The stage used to ground a piece with the raking key's
 * shadow map, and no dial on it could ever look good. three r184's
 * `PCFShadowMap` is a FIVE-TAP Vogel disk whose kernel is `shadow.radius *
 * texelSize` wide: at radius 3.5 on a 2048 map spanning ~1400 cm that is a
 * ~2.4 cm penumbra — a razor edge under a 200 cm sofa — and five stochastic
 * taps rotated by interleaved-gradient noise quantise the edge to six levels,
 * which is the GRAIN that showed along it. Widening `shadow.radius` spreads the
 * same five taps further apart, so the honest fix makes it grainier, not
 * softer. A shadow-map dial was never going to get there.
 *
 * WHAT THIS IS. The contact-shadow technique from three.js's own
 * `webgl_shadow_contact` example (MIT) — the same one @react-three/drei ships
 * as `<ContactShadows>`. An orthographic camera sits ON the floor looking UP,
 * renders the furniture into a render target with a material that writes
 * nothing but "how close to the floor is this fragment", and that buffer is
 * blurred separably and mapped onto a plane at ground level. What lands is the
 * shadow a softbox actually casts: DARK and tight where a cushion touches the
 * floor, fading out under the parts that lift away from it. No stencil, no
 * quantisation, no second sofa lying beside the real one.
 *
 * It is written against bare `three` on purpose. drei's version is R3F-only —
 * a React renderer this stage does not use — and three's `HorizontalBlurShader`
 * addon would have to be threaded through four separate `deps` bags (the live
 * stage, the turntable, the thumbnail baker, the model studio), so the ~20
 * lines of separable gaussian live here instead, with three's own weights.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never touches the key light. The key
 * still carries the raking carve across the Togo's channels and still shadows
 * one module onto the next — short-range detail, which is the one regime those
 * five taps are fine in. This owns the GROUND, and only the ground.
 */

// three's own separable gaussian weights (HorizontalBlurShader/VerticalBlurShader),
// nine taps summing to exactly 1. Kept as one material with a direction uniform
// so a pass is a uniform write rather than a second program.
const BLUR_TAPS = [
  [-4, 0.051], [-3, 0.0918], [-2, 0.12245], [-1, 0.1531],
  [0, 0.1633],
  [1, 0.1531], [2, 0.12245], [3, 0.0918], [4, 0.051],
];

const blurFragment = `
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec4 sum = vec4(0.0);
    ${BLUR_TAPS.map(([o, w]) => `sum += texture2D(tDiffuse, vUv + uDir * ${o.toFixed(1)}) * ${w};`).join('\n    ')}
    gl_FragColor = sum;
  }
`;

/**
 * Build the rig. Nothing is added to a scene here — the caller owns `plane`
 * (see setupTogoStage), which keeps this module free of any scene graph it
 * doesn't own.
 *
 *  height   — cm above the floor at which a surface stops casting entirely.
 *             The whole look lives here: it is what makes a cushion's contact
 *             read darker than the backrest floating 70 cm up.
 *  falloff  — >1 pulls the darkness toward the contact line (1 = linear).
 *  blurCm   — penumbra RADIUS in cm. The kernel spans ±4 taps, so the tap
 *             spacing is a quarter of this.
 */
export function createContactShadow(THREE, {
  resolution = 512, height = 95, falloff = 1.5, blurCm = 12, darkness = 1,
} = {}) {
  const rt = new THREE.WebGLRenderTarget(resolution, resolution);
  const rtBlur = new THREE.WebGLRenderTarget(resolution, resolution, { depthBuffer: false });
  for (const t of [rt, rtBlur]) {
    t.texture.generateMipmaps = false;
    t.texture.minFilter = THREE.LinearFilter;
    t.texture.magFilter = THREE.LinearFilter;
  }

  // Looking UP from the floor: rotation.x = +90° swings the default -Z gaze onto
  // +Y, which also puts camera-right on world +X and camera-up on world +Z — the
  // mapping the display plane below is built to match, so the shadow is never
  // mirrored under an asymmetric layout.
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, height);
  cam.rotation.x = Math.PI / 2;

  // The caster material. It reports WORLD height, not camera depth, so the fade
  // is a physical "how far off the floor is this" rather than a function of
  // wherever the frustum happens to sit. NoBlending + depth test means the
  // LOWEST surface over a texel wins outright: a solid piece can't stack a dozen
  // overlapping shells into a black blob the way alpha accumulation would.
  const casterMat = new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: height },
      uFalloff: { value: falloff },
      uDarkness: { value: darkness },
    },
    vertexShader: `
      varying float vWorldY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uHeight;
      uniform float uFalloff;
      uniform float uDarkness;
      varying float vWorldY;
      void main() {
        float h = clamp(vWorldY / uHeight, 0.0, 1.0);
        gl_FragColor = vec4(0.0, 0.0, 0.0, pow(1.0 - h, uFalloff) * uDarkness);
      }
    `,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
  });

  // Full-clip blit quad — the vertex shader writes clip space directly, so the
  // camera it renders under is irrelevant and the pass can't be thrown off by
  // the stage's own framing.
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: blurFragment,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  quadScene.add(new THREE.Mesh(quadGeo, blurMat));

  // Unit plane laid into XZ, so a resize is a scale rather than new geometry
  // every time the layout grows. rotateX(+90°) sends local +Y to world +Z,
  // matching the camera's up axis above — hence no texture flip anywhere.
  const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
  const planeMat = new THREE.MeshBasicMaterial({
    map: rt.texture,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  // A hair above the catcher plane so a client's room photo (which lies at y=0)
  // can't z-fight with it; depthWrite is off, so the furniture still occludes.
  plane.position.y = 0.25;
  plane.renderOrder = 0;
  plane.castShadow = false;
  plane.receiveShadow = false;

  let size = 1;
  const scratch = new THREE.Color();

  /** Frame the rig over the layout: centre it and size it to `span` cm across. */
  const setFrame = (cx, cz, span) => {
    size = Math.max(1, span);
    plane.position.x = cx;
    plane.position.z = cz;
    plane.scale.set(size, 1, size);
    cam.position.set(cx, 0, cz);
    cam.left = -size / 2; cam.right = size / 2;
    cam.top = size / 2; cam.bottom = -size / 2;
    cam.updateProjectionMatrix();
  };

  const setOpacity = (o) => { planeMat.opacity = o; };

  const blurPass = (renderer, spacingUv) => {
    // H: rt → rtBlur, then V: rtBlur → rt, so the result always lands back in
    // `rt` and the plane's `map` never has to be re-pointed.
    blurMat.uniforms.tDiffuse.value = rt.texture;
    blurMat.uniforms.uDir.value.set(spacingUv, 0);
    renderer.setRenderTarget(rtBlur);
    renderer.render(quadScene, quadCam);
    blurMat.uniforms.tDiffuse.value = rtBlur.texture;
    blurMat.uniforms.uDir.value.set(0, spacingUv);
    renderer.setRenderTarget(rt);
    renderer.render(quadScene, quadCam);
  };

  /**
   * Re-bake the shadow. Called only when the world actually moved (the stage
   * drives it off the same `shadowsDirty` flag that gates the shadow-map pass),
   * so orbiting and panning cost nothing.
   */
  const update = (renderer, scene) => {
    // Everything that isn't a shadow CASTER has to leave: `scene.overrideMaterial`
    // is blunt, and under it the invisible drag pads (transparent planes 2 cm off
    // the floor) would each stamp a hard black rectangle, the grid would stamp a
    // full square, and this very plane — sitting at floor level, i.e. h = 0 —
    // would stamp solid darkness edge to edge. `castShadow` is the flag the mesh
    // builders already maintain for exactly this question, so reusing it means a
    // new prop can never quietly forget to opt out.
    const hidden = [];
    scene.traverse((o) => {
      if (o.isMesh && o.visible && !o.castShadow) { o.visible = false; hidden.push(o); }
    });

    const prevTarget = renderer.getRenderTarget();
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(scratch);

    scene.background = null;          // else the ground colour fills the buffer
    scene.overrideMaterial = casterMat;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    // Two passes, the second tighter: a single wide gaussian reads as a flat
    // smear, while a wide pass carrying a narrow one keeps a defined core under
    // the contact line and still dissolves at the rim.
    blurPass(renderer, (blurCm / 4) / size);
    blurPass(renderer, (blurCm / 4) * 0.4 / size);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(scratch, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
    for (const o of hidden) o.visible = true;
  };

  const dispose = () => {
    rt.dispose();
    rtBlur.dispose();
    casterMat.dispose();
    blurMat.dispose();
    quadGeo.dispose();
    planeGeo.dispose();
    planeMat.dispose();
  };

  return { plane, setFrame, setOpacity, update, dispose };
}
