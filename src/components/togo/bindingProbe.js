/**
 * Mesh binding probe — measure the facts the auto-link matcher
 * (`lib/togo/autoLink.js`) needs from a model's real 3D file: its height in
 * cm and, for one-arm/lounge pieces, WHICH side the arm is on. Loads the mesh
 * through the same cached loader the configurator uses; pure matrix math on
 * the vertex buffers, no scene mounted.
 *
 * This file only SAMPLES: vertices → bounds + a 12×8 top-down height map.
 * The reading of that map (back edge, arm band, facing convention) is the
 * pure `armSideFromHeightMap` in `lib/togo/autoLink.js`, pinned against real
 * Noka/Kashima maps by `tests/togoAutoLink.test.js`.
 */
import { loadTogoModels } from './togoModelLoader.js';
import { autoUnitScale } from '../../lib/togo/togoModel.js';
import { armSideFromHeightMap } from '../../lib/togo/autoLink.js';

const COLS = 12;
const ROWS = 8;
const SAMPLE_TARGET = 40000;

/** @returns {Promise<{ heightCm?: number, armSide?: 'left'|'right'|null }>} */
export async function probeMeshBinding(card) {
  if (!card?.mesh) return {};
  const { modelFor } = await loadTogoModels({ pieces: [{ mesh: card.mesh }] });
  const real = modelFor({ mesh: card.mesh });
  if (!real?.object) return {};
  const obj = real.object;
  obj.updateMatrixWorld(true);
  const zUp = (card.meshUpAxis || 'y') === 'z';

  // World-space vertex sample + bounds.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pts = [];
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / SAMPLE_TARGET));
    const e = o.matrixWorld.elements;
    for (let i = 0; i < pos.count; i += stride) {
      const x0 = pos.getX(i);
      const y0 = pos.getY(i);
      const z0 = pos.getZ(i);
      const x = e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12];
      let y = e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13];
      let z = e[2] * x0 + e[6] * y0 + e[10] * z0 + e[14];
      if (zUp) { const t = y; y = z; z = t; }
      pts.push(x, y, z);
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }
  });
  if (!pts.length) return {};
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!(size[0] > 0) || !(size[1] > 0) || !(size[2] > 0)) return {};
  const unit = autoUnitScale(Math.max(...size));
  const heightCm = Math.round(size[1] * unit);

  // Top-down height map: COLS along x, ROWS along z, normalized 0..1 heights.
  const hm = Array.from({ length: ROWS }, () => new Array(COLS).fill(-1));
  for (let i = 0; i < pts.length; i += 3) {
    const cx = Math.min(COLS - 1, Math.floor(((pts[i] - min[0]) / size[0]) * COLS));
    const cz = Math.min(ROWS - 1, Math.floor(((pts[i + 2] - min[2]) / size[2]) * ROWS));
    const y = (pts[i + 1] - min[1]) / size[1];
    if (y > hm[cz][cx]) hm[cz][cx] = y;
  }
  return { heightCm, armSide: armSideFromHeightMap(hm) };
}
