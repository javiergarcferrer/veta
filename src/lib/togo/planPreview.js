// Pure Model helper for the dealer-inbox plan preview + downloads. Takes the
// togo-embed payload's `models` map ({ <id>: { name, widthCm, depthCm, svg } })
// and a lead's placed `items` ([{ modelId, x, y, rot, ... }]) and produces:
//   - `planPlacements` → the exact placement shape `planToDxf` consumes, so the
//     DXF export is a real CAD file (not an SVG fallback), and
//   - `composePlanPreview` → a self-contained, monochrome, hairline-ruled inline
//     SVG string of the top-down layout, ready to render responsively AND to
//     rasterise to PNG on a canvas (the View owns that DOM/canvas step).
//
// The placement transform MIRRORS planToDxf.placePiece EXACTLY (scale-to-
// footprint, centre, rotate about the footprint-AABB centre) so the preview, the
// DXF and the on-screen configurator all agree — but this stays in SCREEN space
// (y-down), embedding each model's original plan `<svg>` markup via an SVG
// transform rather than re-parsing it to points. No React, no DOM, no mutation.

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Match planToDxf's angle handling: round to 0.1° against float noise, wrap 0–360.
const norm360 = (deg) => {
  const d = Math.round(num(deg) * 10) / 10;
  return ((d % 360) + 360) % 360;
};

// Compact decimal (no scientific notation, kill -0) for the SVG string.
const f = (n) => {
  const r = Math.round(num(n) * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/** The "0 0 W H" viewBox of a plan svg → { vbW, vbH } (0/0 when absent). */
export function viewBoxOf(svg) {
  const m = String(svg || '').match(/viewBox="([^"]+)"/);
  if (!m) return { vbW: 0, vbH: 0 };
  const n = m[1].trim().split(/[\s,]+/).map(Number);
  return { vbW: n[2] || 0, vbH: n[3] || 0 };
}

// Inner markup of an <svg>…</svg>, defensively stripped of <script>, on*
// handlers and per-shape stroke sizing (the composed root sets ONE uniform
// hairline, so every piece reads the same weight).
function innerSvg(svg) {
  const m = String(svg || '').match(/<svg\b[^>]*>([\s\S]*)<\/svg>/i);
  let inner = m ? m[1] : '';
  inner = inner
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\sstroke-width\s*=\s*"[^"]*"/gi, '')
    .replace(/\sstroke-width\s*=\s*'[^']*'/gi, '');
  return inner.trim();
}

/**
 * One placed piece's plan geometry, in screen (y-down) cm — same convention as
 * planToDxf.placePiece and the on-screen footprint: (x,y) is the top-left of the
 * ROTATED axis-aligned bounding box, (cx,cy) its centre.
 */
export function placedPieceGeom(model, item) {
  const vb = viewBoxOf(model?.svg);
  const W = num(model?.widthCm) || vb.vbW || 0;
  const H = num(model?.depthCm) || vb.vbH || 0;
  const rot = norm360(item?.rot);
  const rad = (rot * Math.PI) / 180;
  // Snap cos/sin to integers at the cardinals — a square layout stays crisp.
  const cardinal = rot % 90 === 0;
  const cos = cardinal ? Math.round(Math.cos(rad)) : Math.cos(rad);
  const sin = cardinal ? Math.round(Math.sin(rad)) : Math.sin(rad);
  const fpW = Math.abs(W * cos) + Math.abs(H * sin);
  const fpH = Math.abs(W * sin) + Math.abs(H * cos);
  const cx = num(item?.x) + fpW / 2;
  const cy = num(item?.y) + fpH / 2;
  return { W, H, vbW: vb.vbW, vbH: vb.vbH, rot, fpW, fpH, cx, cy };
}

/**
 * The placement rows `planToDxf(placements, { label })` consumes, built from the
 * inbox payload. A missing model still contributes its position (planToDxf falls
 * back to the footprint rectangle from widthCm/depthCm). Returns [] when there is
 * nothing to export.
 */
export function planPlacements(models, items) {
  return (items || [])
    .filter((it) => it && it.modelId != null)
    .map((it) => {
      const m = (models || {})[it.modelId] || {};
      return {
        pieceId: it.modelId,
        x: num(it.x),
        y: num(it.y),
        rot: num(it.rot),
        widthCm: num(m.widthCm),
        depthCm: num(m.depthCm),
        label: m.name || '',
        svg: m.svg || '',
      };
    });
}

/**
 * Compose the monochrome top-down plan SVG for a lead. Returns
 *   { svg, width, height, viewBox: { x, y, w, h }, pieceCount }
 * where `svg` is a standalone (xmlns-carrying) string sized only by its viewBox
 * (so it scales responsively AND rasterises cleanly), or `null` when there is
 * nothing placeable (no models, no positions, or a degenerate box).
 */
export function composePlanPreview(models, items, opts = {}) {
  const margin = num(opts.margin, 24);
  const placed = (items || [])
    .filter((it) => it && (models || {})[it.modelId])
    .map((it) => ({ it, model: models[it.modelId], geom: placedPieceGeom(models[it.modelId], it) }))
    .filter(({ geom }) => geom.fpW > 0 && geom.fpH > 0);
  if (!placed.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { geom } of placed) {
    minX = Math.min(minX, geom.cx - geom.fpW / 2);
    minY = Math.min(minY, geom.cy - geom.fpH / 2);
    maxX = Math.max(maxX, geom.cx + geom.fpW / 2);
    maxY = Math.max(maxY, geom.cy + geom.fpH / 2);
  }
  const vx = minX - margin;
  const vy = minY - margin;
  const vw = maxX - minX + margin * 2;
  const vh = maxY - minY + margin * 2;
  if (!(vw > 0) || !(vh > 0)) return null;

  // ONE uniform hairline for the whole plan, sized as a fraction of the drawing
  // so it renders ~1px thin at any layout size or raster scale (user units = cm).
  const stroke = Math.max(Math.max(vw, vh) / 440, 0.2);

  const groups = placed.map(({ model, geom }) => {
    const inner = innerSvg(model.svg);
    const sx = geom.vbW ? geom.W / geom.vbW : 1;
    const sy = geom.vbH ? geom.H / geom.vbH : 1;
    if (inner && geom.vbW > 0 && geom.vbH > 0) {
      const tf = `translate(${f(geom.cx)} ${f(geom.cy)}) rotate(${f(geom.rot)}) `
        + `scale(${f(sx)} ${f(sy)}) translate(${f(-geom.vbW / 2)} ${f(-geom.vbH / 2)})`;
      return `<g transform="${tf}">${inner}</g>`;
    }
    // No usable outline → the footprint rectangle, centred + rotated in place.
    const tf = `translate(${f(geom.cx)} ${f(geom.cy)}) rotate(${f(geom.rot)})`;
    return `<g transform="${tf}"><rect x="${f(-geom.W / 2)}" y="${f(-geom.H / 2)}" `
      + `width="${f(geom.W)}" height="${f(geom.H)}"/></g>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}" `
    + `preserveAspectRatio="xMidYMid meet" fill="none" stroke="#a3a3a3" stroke-width="${f(stroke)}" `
    + `stroke-linejoin="round" stroke-linecap="round" style="color:#a3a3a3">${groups}</svg>`;

  return { svg, width: vw, height: vh, viewBox: { x: vx, y: vy, w: vw, h: vh }, pieceCount: placed.length };
}
