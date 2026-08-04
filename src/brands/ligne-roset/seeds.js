/**
 * LIGNE ROSET'S OWN TOGO MODULES, as importable catalog rows.
 *
 * ── LIGNE ROSET BRAND PACKAGE ───────────────────────────────────────────────
 * The one-tap "quick start" the Modelos studio offers so a fresh Ligne Roset
 * environment isn't empty; the dealer can then upload their own DWGs alongside
 * (or instead of) these.
 *
 * THIS IS SAMPLE DATA, NOT PRODUCT DATA. It is a real manufacturer's real sofa,
 * so it is reachable ONLY through the Ligne Roset module set's `seeds`
 * capability — seeding another manufacturer's empty catalog with someone else's
 * pieces would be inventing their catalog for them. It used to be imported
 * straight by the studio page, which is what made it offerable anywhere.
 *
 * LOADED LAZILY (see `brands/modules/ligneRoset.js`): the five SVG plans are
 * ~165 KB of markup and the public configurator resolves brand modules too — it
 * must not download a seed library it can never import.
 *
 * The footprint metadata comes from `assets/togo/pieces.js` (measured from the
 * source DWGs and shared with the procedural-geometry fallback), and the plans
 * ride in as inline SVG via `?raw` so they can be written straight into
 * `togo_models`.
 */
import { TOGO_PIECES } from '../../assets/togo/pieces.js';
import svgChauf from '../../assets/togo/togo_chauf.svg?raw';
import svgA from '../../assets/togo/togo_a.svg?raw';
import svgGb from '../../assets/togo/togo_gb.svg?raw';
import svgMc from '../../assets/togo/togo_mc.svg?raw';
import svgLounge from '../../assets/togo/togo_lounge.svg?raw';

const SVG_BY_ID = { chauf: svgChauf, a: svgA, gb: svgGb, mc: svgMc, lounge: svgLounge };

export const TOGO_SEEDS = TOGO_PIECES.map((p) => ({
  name: p.label,
  model: p.model,
  widthCm: p.widthCm,
  depthCm: p.depthCm,
  svg: SVG_BY_ID[p.id],
  match: p.match,
}));

export default TOGO_SEEDS;
