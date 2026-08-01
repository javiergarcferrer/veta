/**
 * planToDxf — turn a configured plan into a DXF, the open ASCII CAD interchange
 * that AutoCAD and every DWG-capable tool (LibreCAD, ODA, the online viewers)
 * reads natively. It's the INVERSE of the DWG→SVG import the catalog does: we
 * authored the plan symbols FROM the manufacturer's DWGs, and this hands a placed
 * layout back OUT as CAD geometry an architect can drop straight into their
 * drawing. A true binary .dwg can't be authored client-side (libredwg-web is a
 * READER, no encoder) — DXF is Autodesk's own interchange format, so a
 * downloadable .dxf is the right, dependency-free, offline export.
 *
 * Coordinates: the configurator works in CENTIMETRES, plan space (x right, y
 * DOWN, origin top-left — screen coords). DXF is y-UP, so we flip Y once, at
 * emit. Each placed piece's plan SVG (the "2D furniture" outline — only M/L/Z
 * paths + <circle>, since the plan geometry importer already polyline-ified every
 * arc/spline) is parsed, scaled to the model footprint, centred, rotated by the
 * placement's angle EXACTLY as the on-screen tile (CSS rotate, clockwise in
 * y-down), and translated to the placement — so the DXF outline matches the
 * configurator to the millimetre. A piece with no SVG falls back to its footprint
 * rectangle, so the export still carries the right sizes and positions.
 *
 * Pure: no DOM, no libredwg, no wasm. The View wraps the returned string in a
 * Blob and downloads it.
 */
import type { PlanPoint } from './meshToPlan.ts';

export type { PlanPoint };

/** A stroke: a run of points, optionally closed. */
export interface PlanSubpath {
  pts: PlanPoint[];
  closed: boolean;
}

export interface PlanSvgCircle {
  cx: number;
  cy: number;
  r: number;
}

export interface ParsedPlanSvg {
  polys: PlanSubpath[];
  circles: PlanSvgCircle[];
  vbW: number;
  vbH: number;
}

export interface PlacedCircle {
  x: number;
  y: number;
  r: number;
}

export interface PlacedPiece {
  polys: PlanSubpath[];
  circles: PlacedCircle[];
  center: PlanPoint;
}

/** One placed piece: (x,y) = footprint-AABB top-left in plan cm, rot in degrees. */
export interface DxfPlacement {
  pieceId?: string | number;
  x?: number;
  y?: number;
  rot?: number;
  widthCm?: number;
  depthCm?: number;
  label?: string;
  /** The plan symbol; optional (a missing outline falls back to the footprint box). */
  svg?: string;
}

export interface DxfLayer {
  name: string;
  color: number;
}

export interface DxfLayerTable {
  furniture: DxfLayer;
  text: DxfLayer;
  frame: DxfLayer;
}

export interface PlanToDxfOptions {
  /** Rides as a heading on the overall frame. */
  label?: string;
  /** Layer-name prefix; default `DEFAULT_DXF_LAYER_PREFIX`. */
  layerPrefix?: string;
}

/** Layer-name prefix — every layer is `${prefix}-…`, so one drawing namespaces cleanly. */
export const DEFAULT_DXF_LAYER_PREFIX = 'VETA';

/**
 * Layer names + AutoCAD Color Index — furniture, labels, the overall-size frame.
 * The prefix is a parameter; the colours are fixed (they're the meaning, not the
 * branding).
 */
export function dxfLayers(layerPrefix: string = DEFAULT_DXF_LAYER_PREFIX): DxfLayerTable {
  const p = String(layerPrefix ?? '').trim() || DEFAULT_DXF_LAYER_PREFIX;
  return {
    furniture: { name: `${p}-MUEBLES`, color: 7 }, // white/black (the outlines)
    text: { name: `${p}-TEXTO`, color: 3 },        // green (piece labels)
    frame: { name: `${p}-CONJUNTO`, color: 5 },    // blue (overall footprint)
  };
}

/** The default-prefix layer table, for callers that just want the names. */
export const DXF_LAYERS: DxfLayerTable = dxfLayers();

// Keeps fractional degrees — the sandbox configurator rotates freely, and the
// DXF must carry the exact placed angle (rounded to 0.1° against float noise).
const norm360 = (deg: unknown): number => {
  const d = Math.round((Number(deg) || 0) * 10) / 10;
  return ((d % 360) + 360) % 360;
};

// DXF reals: a plain decimal, no scientific notation (values live in [0, ~900]),
// 4dp is well under a millimetre; trim float dust and -0.
function fmt(n: unknown): string {
  const r = Math.round((Number(n) || 0) * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

function attr(tag: string, name: string): number {
  const m = tag.match(new RegExp(`${name}="(-?[0-9.eE+]+)"`));
  return m ? Number(m[1]) : NaN;
}

/**
 * Parse one SVG path's `d` (the plan geometry only ever emits `M x y (L x y)* Z?`,
 * repeated per stroke) → [{ pts:[{x,y}], closed }]. Tolerant of the rigid format
 * it's fed; ignores anything that isn't M/L/Z.
 */
export function parsePathData(d: unknown): PlanSubpath[] {
  const tokens = String(d || '').match(/[MLZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const subs: PlanSubpath[] = [];
  let cur: PlanSubpath | null = null;
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i++];
    if (t === 'M') {
      if (cur && cur.pts.length) subs.push(cur);
      cur = { pts: [{ x: +tokens[i++], y: +tokens[i++] }], closed: false };
    } else if (t === 'L') {
      if (!cur) cur = { pts: [], closed: false };
      cur.pts.push({ x: +tokens[i++], y: +tokens[i++] });
    } else if (t === 'Z') {
      if (cur) cur.closed = true;
    }
  }
  if (cur && cur.pts.length) subs.push(cur);
  return subs.filter((s) => s.pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
}

/** Parse a plan SVG → { polys, circles, vbW, vbH } in its own viewBox cm units. */
export function parsePlanSvg(svg: unknown): ParsedPlanSvg {
  const out: ParsedPlanSvg = { polys: [], circles: [], vbW: 0, vbH: 0 };
  if (!svg || typeof svg !== 'string') return out;
  const vb = svg.match(/viewBox="([^"]+)"/);
  if (vb) { const n = vb[1].trim().split(/[\s,]+/).map(Number); out.vbW = n[2] || 0; out.vbH = n[3] || 0; }
  for (const m of svg.matchAll(/\bd="([^"]*)"/g)) out.polys.push(...parsePathData(m[1]));
  for (const m of svg.matchAll(/<circle\b[^>]*>/g)) {
    const cx = attr(m[0], 'cx'), cy = attr(m[0], 'cy'), r = attr(m[0], 'r');
    if (Number.isFinite(cx) && Number.isFinite(cy) && r > 0) out.circles.push({ cx, cy, r });
  }
  return out;
}

/**
 * Transform a piece's local geometry into plan-world cm (still y-DOWN), placing
 * it EXACTLY as the on-screen tile: the viewBox is scaled to the model footprint,
 * centred, rotated by the placed angle (ANY angle — the configurator is a free
 * sandbox) about the footprint-AABB centre, then translated. Returns { polys,
 * circles, center } plus the footprint corners when no outline.
 */
export function placePiece(local: Partial<ParsedPlanSvg>, placement: DxfPlacement): PlacedPiece {
  const W = Number(placement.widthCm) || local.vbW || 0;
  const H = Number(placement.depthCm) || local.vbH || 0;
  const rot = norm360(placement.rot);
  const rad = (rot * Math.PI) / 180;
  // At the cardinal angles snap cos/sin to integers — kills the 6e-17 float dust
  // Math.cos(π/2) leaves so a square layout stays crisp; free angles keep the
  // real trig values.
  const cardinal = rot % 90 === 0;
  const cos = cardinal ? Math.round(Math.cos(rad)) : Math.cos(rad);
  const sin = cardinal ? Math.round(Math.sin(rad)) : Math.sin(rad);
  // (x,y) is the top-left of the rotated piece's axis-aligned bounding box —
  // the same footprint convention the on-screen tile uses.
  const fpW = Math.abs(W * cos) + Math.abs(H * sin);
  const fpH = Math.abs(W * sin) + Math.abs(H * cos);
  const cx = (Number(placement.x) || 0) + fpW / 2;
  const cy = (Number(placement.y) || 0) + fpH / 2;
  const sx = local.vbW ? W / local.vbW : 1;
  const sy = local.vbH ? H / local.vbH : 1;
  const tp = (lx: number, ly: number): PlanPoint => {
    const px = lx * sx - W / 2, py = ly * sy - H / 2;
    return { x: cx + (px * cos - py * sin), y: cy + (px * sin + py * cos) };
  };
  const polys: PlanSubpath[] = (local.polys || []).map((s) => ({ pts: s.pts.map((p) => tp(p.x, p.y)), closed: s.closed }));
  const circles: PlacedCircle[] = (local.circles || []).map((c) => ({ ...tp(c.cx, c.cy), r: c.r * (sx + sy) / 2 }));
  // No outline → the footprint rectangle, so the export still carries the size.
  if (!polys.length && !circles.length) {
    polys.push({ closed: true, pts: [tp(0, 0), tp(W, 0), tp(W, H), tp(0, H)] });
  }
  return { polys, circles, center: { x: cx, y: cy } };
}

// ── DXF emit ──────────────────────────────────────────────────────────────
// DXF is one (code, value) per physical line; AutoCAD prefers CRLF endings.
const pair = (code: number, val: string | number) => `${code}\r\n${val}\r\n`;

function lineEnt(layer: string, a: PlanPoint, b: PlanPoint): string {
  return pair(0, 'LINE') + pair(8, layer)
    + pair(10, fmt(a.x)) + pair(20, fmt(a.y)) + pair(30, 0)
    + pair(11, fmt(b.x)) + pair(21, fmt(b.y)) + pair(31, 0);
}

function polylineEnt(layer: string, pts: PlanPoint[], closed: boolean): string {
  let s = pair(0, 'POLYLINE') + pair(8, layer) + pair(66, 1) + pair(70, closed ? 1 : 0);
  for (const p of pts) s += pair(0, 'VERTEX') + pair(8, layer) + pair(10, fmt(p.x)) + pair(20, fmt(p.y)) + pair(30, 0);
  return s + pair(0, 'SEQEND') + pair(8, layer);
}

function circleEnt(layer: string, c: PlacedCircle): string {
  return pair(0, 'CIRCLE') + pair(8, layer) + pair(10, fmt(c.x)) + pair(20, fmt(c.y)) + pair(30, 0) + pair(40, fmt(c.r));
}

// Centred TEXT (72 = h-centre, 73 = v-middle; both anchor points = the centre).
function textEnt(layer: string, at: PlanPoint, height: number, str: string): string {
  return pair(0, 'TEXT') + pair(8, layer)
    + pair(10, fmt(at.x)) + pair(20, fmt(at.y)) + pair(30, 0)
    + pair(40, fmt(height)) + pair(1, str)
    + pair(72, 1) + pair(73, 2)
    + pair(11, fmt(at.x)) + pair(21, fmt(at.y)) + pair(31, 0);
}

function strokes(layer: string, polys: PlanSubpath[]): string {
  let s = '';
  for (const p of polys) {
    if (!p.pts.length) continue;
    // A bare 2-point stroke is a LINE (leaner); a real polyline stays a POLYLINE.
    if (p.pts.length === 2 && !p.closed) s += lineEnt(layer, p.pts[0], p.pts[1]);
    else s += polylineEnt(layer, p.pts, p.closed);
  }
  return s;
}

function header(extMax: PlanPoint): string {
  return pair(0, 'SECTION') + pair(2, 'HEADER')
    + pair(9, '$ACADVER') + pair(1, 'AC1009')
    + pair(9, '$INSUNITS') + pair(70, 5)        // 5 = centimetres
    + pair(9, '$MEASUREMENT') + pair(70, 1)     // 1 = metric (linetype/hatch tables)
    + pair(9, '$EXTMIN') + pair(10, 0) + pair(20, 0) + pair(30, 0)
    + pair(9, '$EXTMAX') + pair(10, fmt(extMax.x)) + pair(20, fmt(extMax.y)) + pair(30, 0)
    + pair(0, 'ENDSEC');
}

function tables(layers: DxfLayerTable): string {
  const layer = (l: DxfLayer) => pair(0, 'LAYER') + pair(2, l.name) + pair(70, 0) + pair(62, l.color) + pair(6, 'CONTINUOUS');
  const ls = Object.values(layers);
  return pair(0, 'SECTION') + pair(2, 'TABLES')
    + pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1)
    + pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0) + pair(3, 'Solid line') + pair(72, 65) + pair(73, 0) + pair(40, 0)
    + pair(0, 'ENDTAB')
    + pair(0, 'TABLE') + pair(2, 'STYLE') + pair(70, 1)
    + pair(0, 'STYLE') + pair(2, 'STANDARD') + pair(70, 0) + pair(40, 0) + pair(41, 1) + pair(50, 0) + pair(71, 0) + pair(42, 2.5) + pair(3, 'txt') + pair(4, '')
    + pair(0, 'ENDTAB')
    + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, ls.length)
    + ls.map(layer).join('')
    + pair(0, 'ENDTAB')
    + pair(0, 'ENDSEC');
}

/**
 * Build the DXF for a set of placements. Each placement:
 *   { pieceId, x, y, rot, widthCm, depthCm, label, svg }
 * (x,y = footprint-AABB top-left in plan cm; rot = degrees, any angle; svg = the
 * plan symbol, optional). `opts.label` rides as a heading on the overall frame;
 * `opts.layerPrefix` names the three layers.
 */
export function planToDxf(placements: Array<DxfPlacement> | null | undefined, opts: PlanToDxfOptions = {}): string {
  const layers = dxfLayers(opts.layerPrefix);
  const pieces = (placements || []).map((pl) => ({ placed: placePiece(parsePlanSvg(pl.svg), pl), pl }));

  // Global bounds across every transformed point → flip Y (CAD is y-up) and
  // shift to a clean (0,0) bottom-left origin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p: PlanPoint) => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; };
  for (const { placed } of pieces) {
    for (const s of placed.polys) s.pts.forEach(grow);
    for (const c of placed.circles) { grow({ x: c.x - c.r, y: c.y - c.r }); grow({ x: c.x + c.r, y: c.y + c.r }); }
  }
  if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = 0; }
  const W = maxX - minX, H = maxY - minY;
  const fx = (x: number) => x - minX;          // shift left edge to 0
  const fy = (y: number) => maxY - y;          // flip y-down → y-up, top edge to H
  const map = (p: PlanPoint): PlanPoint => ({ x: fx(p.x), y: fy(p.y) });

  let ents = '';
  for (const { placed, pl } of pieces) {
    ents += strokes(layers.furniture.name, placed.polys.map((s) => ({ ...s, pts: s.pts.map(map) })));
    for (const c of placed.circles) ents += circleEnt(layers.furniture.name, { ...map(c), r: c.r });
    const label = (pl.label || '').trim();
    if (label) ents += textEnt(layers.text.name, map(placed.center), Math.max(6, Math.min(W, H, 220) / 14), label);
  }
  // Overall-footprint frame + its size label, so the designer reads the assembled
  // W×D at a glance (a true DIMENSION needs a DIMSTYLE/block; a labelled frame
  // opens everywhere and says the same thing).
  if (pieces.length && W > 0 && H > 0) {
    ents += polylineEnt(layers.frame.name, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], true);
    const heading = `${opts.label ? `${opts.label} · ` : ''}${Math.round(W)}×${Math.round(H)} cm`;
    ents += textEnt(layers.frame.name, { x: W / 2, y: H + Math.max(8, H / 18) }, Math.max(7, Math.min(W, H) / 12), heading);
  }

  return header({ x: W, y: H }) + tables(layers)
    + pair(0, 'SECTION') + pair(2, 'ENTITIES') + ents + pair(0, 'ENDSEC')
    + pair(0, 'EOF');
}
