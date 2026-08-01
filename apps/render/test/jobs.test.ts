// The pure half: job validation and the angle→pose table. No browser, no
// esbuild, no network — this file must stay green in any checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CAMERA_POSES,
  DEFAULT_SIZE_PX,
  MAX_PIXELS,
  MAX_PLACEMENTS,
  MAX_SIZE_PX,
  MIN_SIZE_PX,
  RENDER_ANGLES,
  canonicalJson,
  isRenderAngle,
  isRenderable,
  normalizeRgb,
  poseFor,
  resolveCameraPose,
  safeAssetUrl,
  sanitizeJob,
  type RenderAngle,
  type SceneBounds,
} from '../src/jobs.ts';

const onePiece = { pieceId: 'sofa-a', x: 0, y: 0, rot: 0 };

const boundsOf = (w: number, h: number, d: number): SceneBounds => ({
  min: { x: -w / 2, y: 0, z: -d / 2 },
  max: { x: w / 2, y: h, z: d / 2 },
});

// ── Defaults ────────────────────────────────────────────────────────────────

test('an empty payload sanitizes to the documented defaults', () => {
  const { job, dropped } = sanitizeJob({});
  assert.equal(job.angle, 'hero');
  assert.equal(job.format, 'png');
  assert.deepEqual(job.size, { width: DEFAULT_SIZE_PX, height: DEFAULT_SIZE_PX });
  assert.deepEqual(job.build, []);
  assert.equal(job.transparent, false);
  assert.equal(job.background, null);
  assert.deepEqual(dropped, []);
  // Nothing to draw ⇒ not renderable. That is the one refusal the service makes.
  assert.equal(isRenderable(job), false);
});

test('junk in place of a job object is reported, never thrown', () => {
  for (const raw of [null, undefined, 'nope', 42, [] as unknown]) {
    const { job } = sanitizeJob(raw as never);
    assert.equal(job.angle, 'hero');
  }
  const { dropped } = sanitizeJob('nope' as never);
  assert.ok(dropped.some((d) => d.reason === 'not_an_object'));
});

// ── Angle / format ──────────────────────────────────────────────────────────

test('an unknown angle renders the default AND says so', () => {
  const { job, dropped } = sanitizeJob({ build: [onePiece], angle: 'hro' });
  assert.equal(job.angle, 'hero');
  assert.deepEqual(dropped, [{ path: 'angle', reason: 'unknown_angle' }]);
});

test('every named angle survives sanitizing', () => {
  for (const angle of RENDER_ANGLES) {
    const { job, dropped } = sanitizeJob({ build: [onePiece], angle });
    assert.equal(job.angle, angle);
    assert.deepEqual(dropped, []);
    assert.ok(isRenderAngle(angle));
  }
  assert.equal(isRenderAngle('turntable'), false);
});

test('jpg is accepted as jpeg; anything else is refused and reported', () => {
  assert.equal(sanitizeJob({ format: 'jpg' }).job.format, 'jpeg');
  assert.equal(sanitizeJob({ format: 'jpeg' }).job.format, 'jpeg');
  const { job, dropped } = sanitizeJob({ format: 'webp' });
  assert.equal(job.format, 'png');
  assert.ok(dropped.some((d) => d.path === 'format'));
});

// ── Placements ──────────────────────────────────────────────────────────────

test('a placement with no piece id is dropped, and the rest still render', () => {
  const { job, dropped } = sanitizeJob({
    build: [onePiece, { x: 10, y: 10 }, 'garbage', { pieceId: 'sofa-b', x: 90, y: 0, rot: 90 }],
  });
  assert.deepEqual(job.build.map((p) => p.pieceId), ['sofa-a', 'sofa-b']);
  assert.deepEqual(
    dropped.map((d) => `${d.path}:${d.reason}`),
    ['build[1]:missing_pieceId', 'build[2]:not_an_object'],
  );
});

test('rotation is normalized into [0,360) and non-finite coords fall back to 0', () => {
  const { job } = sanitizeJob({
    build: [{ pieceId: 'a', x: Number.NaN, y: Infinity, rot: -90 }, { pieceId: 'b', rot: 725 }],
  });
  assert.deepEqual(job.build[0], { pieceId: 'a', x: 0, y: 0, rot: 270 });
  assert.equal(job.build[1]!.rot, 5);
});

test('the widget\'s and the saved configuration\'s field names both land on one shape', () => {
  // A saved row says {id, z, rotationDeg}; the widget says {pieceId, y, rot}.
  const { job } = sanitizeJob({ build: [{ id: 'a', x: 5, z: 7, rotationDeg: 45, code: 'TONA-12' }] });
  assert.deepEqual(job.build[0], { pieceId: 'a', x: 5, y: 7, rot: 45, fabricCode: 'TONA-12' });
});

test('partMaterials arrive in two shapes and store as one', () => {
  const nested = sanitizeJob({ build: [{ pieceId: 'a', partMaterials: { legs: { code: 'X1' } } }] });
  const flat = sanitizeJob({ build: [{ pieceId: 'a', partMaterials: { legs: 'X1' } }] });
  assert.deepEqual(nested.job.build[0]!.partMaterials, { legs: 'X1' });
  assert.deepEqual(flat.job.build[0]!.partMaterials, { legs: 'X1' });
});

test('the placement count is capped and the overflow is reported', () => {
  const build = Array.from({ length: MAX_PLACEMENTS + 5 }, (_, i) => ({ pieceId: `p${i}`, x: i, y: 0, rot: 0 }));
  const { job, dropped } = sanitizeJob({ build });
  assert.equal(job.build.length, MAX_PLACEMENTS);
  assert.ok(dropped.some((d) => d.path === 'build' && d.reason.includes(String(MAX_PLACEMENTS))));
});

// ── Size ────────────────────────────────────────────────────────────────────

test('size clamps to the documented bounds', () => {
  assert.deepEqual(sanitizeJob({ size: { width: 1, height: 1 } }).job.size, { width: MIN_SIZE_PX, height: MIN_SIZE_PX });
  assert.deepEqual(
    sanitizeJob({ size: { width: 99_999, height: 99_999 } }).job.size,
    { width: MAX_SIZE_PX, height: MAX_SIZE_PX },
  );
  assert.deepEqual(sanitizeJob({ size: { width: 320.4, height: 320.6 } }).job.size, { width: 320, height: 321 });
});

test('an over-budget frame is scaled on BOTH axes, never cropped on one', () => {
  const { job, dropped } = sanitizeJob({ size: { width: MAX_SIZE_PX, height: MAX_SIZE_PX } });
  assert.ok(job.size.width * job.size.height <= MAX_PIXELS);
  // 2048×2048 IS the budget, so nothing is scaled and nothing is reported.
  assert.equal(dropped.some((d) => d.reason === 'over_pixel_budget'), false);
  const aspect = job.size.width / job.size.height;
  assert.ok(Math.abs(aspect - 1) < 0.01);
});

// ── URLs and colours (the security-shaped edges) ────────────────────────────

test('only http(s) and data:image URLs are handed to the browser', () => {
  assert.equal(safeAssetUrl('https://cdn.example.com/a.glb'), 'https://cdn.example.com/a.glb');
  assert.equal(safeAssetUrl('http://cdn.example.com/a.glb'), 'http://cdn.example.com/a.glb');
  assert.equal(safeAssetUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  // A headless browser that will open file: is a headless browser that reads
  // the render host's own disk.
  assert.equal(safeAssetUrl('file:///etc/passwd'), null);
  assert.equal(safeAssetUrl('javascript:alert(1)'), null);
  assert.equal(safeAssetUrl('data:text/html,<script>'), null);
  assert.equal(safeAssetUrl(''), null);
  assert.equal(safeAssetUrl(42), null);
});

test('a refused model URL costs the mesh, not the piece', () => {
  const { job, dropped } = sanitizeJob({
    build: [onePiece],
    models: { 'sofa-a': { url: 'file:///etc/passwd', widthCm: 120, depthCm: 90 } },
  });
  assert.equal(job.models['sofa-a']!.url, undefined);
  assert.equal(job.models['sofa-a']!.widthCm, 120);   // the placeholder still knows its size
  assert.ok(dropped.some((d) => d.path === 'models.sofa-a.url'));
  assert.equal(isRenderable(job), true);
});

test('colours normalize from every form a caller might send', () => {
  assert.equal(normalizeRgb('#abc'), 0xaabbcc);
  assert.equal(normalizeRgb('#A1B2C3'), 0xa1b2c3);
  assert.equal(normalizeRgb('0xa1b2c3'), 0xa1b2c3);
  assert.equal(normalizeRgb(0xa1b2c3), 0xa1b2c3);
  assert.equal(normalizeRgb('rebeccapurple'), null);
  assert.equal(normalizeRgb(-1), null);
  assert.equal(normalizeRgb(0x1000000), null);
});

// ── Render params ───────────────────────────────────────────────────────────

test('renderParams keeps only what @veta/scene defines', () => {
  const { job, dropped } = sanitizeJob({
    renderParams: {
      seamBleed: 1.04,
      seamBleedTable: { togo: 1.04, saparella: 1, junk: 'x' },
      fallback: 'procedural-togo',
      frameHeightCm: 200,
      somethingElse: 'ignored',
    },
  });
  assert.equal(job.renderParams.seamBleed, 1.04);
  assert.deepEqual(job.renderParams.seamBleedTable, { saparella: 1, togo: 1.04 });
  assert.equal(job.renderParams.fallback, 'procedural-togo');
  assert.equal(job.renderParams.frameHeightCm, 200);
  assert.equal((job.renderParams as Record<string, unknown>).somethingElse, undefined);
  assert.ok(dropped.some((d) => d.path === 'renderParams.seamBleedTable.junk'));
});

// ── The pose table ──────────────────────────────────────────────────────────

test('every named angle has a pose', () => {
  for (const angle of RENDER_ANGLES) {
    const pose = DEFAULT_CAMERA_POSES[angle];
    assert.ok(pose, `${angle} has no pose`);
    assert.ok(pose.fovDeg > 0 && pose.fovDeg < 180);
    assert.ok(pose.margin >= 1);
    assert.ok(pose.targetLift >= 0 && pose.targetLift <= 1);
    assert.ok(pose.elevationDeg >= -20 && pose.elevationDeg <= 90);
  }
});

test('poseFor merges a job override over the table without mutating it', () => {
  const merged = poseFor('hero', undefined, { azimuthDeg: 90 });
  assert.equal(merged.azimuthDeg, 90);
  assert.equal(merged.fovDeg, DEFAULT_CAMERA_POSES.hero.fovDeg);
  assert.equal(DEFAULT_CAMERA_POSES.hero.azimuthDeg, 32);
});

test('front sits on +Z and dead centre; hero orbits off-axis', () => {
  const b = boundsOf(200, 70, 100);
  const front = resolveCameraPose('front', { bounds: b, aspect: 1 });
  assert.ok(Math.abs(front.position.x - front.target.x) < 1e-6);
  assert.ok(front.position.z > front.target.z);
  const hero = resolveCameraPose('hero', { bounds: b, aspect: 1 });
  assert.ok(hero.position.x > hero.target.x);
  assert.ok(hero.position.y > hero.target.y);
});

test('plan looks straight down, and its screen-up is the plan\'s own back', () => {
  const cam = resolveCameraPose('plan', { bounds: boundsOf(200, 70, 100), aspect: 1 });
  assert.ok(Math.abs(cam.position.x - cam.target.x) < 1e-6);
  assert.ok(Math.abs(cam.position.z - cam.target.z) < 1e-6);
  assert.ok(cam.position.y > cam.target.y);
  // Straight down, (0,1,0) is the view direction and lookAt degenerates.
  assert.deepEqual(cam.up, { x: 0, y: 0, z: -1 });
  assert.equal(cam.shadow, '2d');
});

test('the framing is MEASURED: a bigger scene pushes the camera back', () => {
  const near = resolveCameraPose('hero', { bounds: boundsOf(100, 40, 60), aspect: 1 });
  const far = resolveCameraPose('hero', { bounds: boundsOf(400, 200, 200), aspect: 1 });
  const dist = (c: typeof near) => Math.hypot(
    c.position.x - c.target.x, c.position.y - c.target.y, c.position.z - c.target.z);
  assert.ok(dist(far) > dist(near) * 2);
  assert.ok(far.radius > near.radius);
});

test('a portrait frame fits HORIZONTALLY — a sectional keeps its ends', () => {
  const b = boundsOf(300, 70, 100);
  const dist = (aspect: number) => {
    const c = resolveCameraPose('hero', { bounds: b, aspect });
    return Math.hypot(c.position.x - c.target.x, c.position.y - c.target.y, c.position.z - c.target.z);
  };
  // 1080×1350 (a feed image) must stand further back than 1600×900.
  assert.ok(dist(1080 / 1350) > dist(1600 / 900));
});

test('the aim point rides the scene\'s own height, not a fixed one', () => {
  const low = resolveCameraPose('hero', { bounds: boundsOf(200, 40, 100), aspect: 1 });
  const tall = resolveCameraPose('hero', { bounds: boundsOf(200, 220, 100), aspect: 1 });
  assert.ok(tall.target.y > low.target.y * 2);
  // …and an explicit frameHeightCm overrides the measurement (@veta/scene's own rule).
  const forced = resolveCameraPose('hero', { bounds: boundsOf(200, 220, 100), aspect: 1, params: { frameHeightCm: 40 } });
  assert.ok(Math.abs(forced.target.y - 40 * DEFAULT_CAMERA_POSES.hero.targetLift) < 1e-9);
});

test('an empty scene still produces a finite, usable camera', () => {
  const cam = resolveCameraPose('hero', { bounds: boundsOf(0, 0, 0), aspect: 1 });
  for (const v of [cam.position, cam.target]) {
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
  }
  assert.ok(cam.near > 0 && cam.far > cam.near);
});

test('a hostile pose override is clamped, never obeyed', () => {
  const { job } = sanitizeJob({
    build: [onePiece],
    poseOverride: { elevationDeg: 5000, fovDeg: 0.001, margin: 1e9, targetLift: -4, azimuthDeg: 725 },
  });
  const p = job.poseOverride!;
  assert.equal(p.elevationDeg, 90);
  assert.equal(p.fovDeg, 5);
  assert.equal(p.margin, 3);
  assert.equal(p.targetLift, 0);
  assert.equal(p.azimuthDeg, 5);
  const cam = resolveCameraPose('hero', { bounds: boundsOf(200, 70, 100), aspect: 1, override: p });
  assert.ok(Number.isFinite(cam.position.y));
});

test('an unknown angle asked of resolveCameraPose falls back rather than crashing', () => {
  const cam = resolveCameraPose('nope' as RenderAngle, { bounds: boundsOf(200, 70, 100), aspect: 1 });
  assert.ok(Number.isFinite(cam.position.x));
});

// ── Canonical JSON ──────────────────────────────────────────────────────────

test('canonicalJson is key-order independent and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ n: [{ z: 1, a: 2 }] }), '{"n":[{"a":2,"z":1}]}');
  // -0 and 0 are the same pixel; they must not be two cache entries.
  assert.equal(canonicalJson({ x: -0 }), canonicalJson({ x: 0 }));
});
