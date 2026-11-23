/**
 * Pure-TypeScript Smooth Ink & Geometry Engine for Crypsy Spatial Boards.
 * Zero runtime dependencies: handles pressure normalization, RDP point simplification,
 * smooth variable-width SVG/Canvas2D stroke generation, eraser hit-testing, and lasso geometry.
 */

import type { BoardStrokeItem } from '../types';

export interface InkSwatch {
  id: string;
  label: string;
  color: string;
}

export const AUTO_INK_TOKEN = 'auto-ink';

export const INK_SWATCHES: readonly InkSwatch[] = [
  { id: 'auto-ink', label: 'Auto Ink (Adapts to Dark/Light)', color: AUTO_INK_TOKEN },
  { id: 'blue', label: 'Blue', color: '#4285f4' },
  { id: 'red', label: 'Red', color: '#ea4335' },
  { id: 'green', label: 'Green', color: '#34a853' },
  { id: 'purple', label: 'Purple', color: '#a142f4' },
  { id: 'yellow', label: 'Yellow', color: '#fbbc04' },
  { id: 'orange', label: 'Orange', color: '#fa7b17' },
  { id: 'teal', label: 'Teal', color: '#24c1e0' },
];

export type StrokePoint = [number, number, number];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Validates stroke color strings so serialized/loaded JSON cannot inject arbitrary style text.
 */
export function sanitizeInkColor(color: string | undefined): string {
  if (!color || color === AUTO_INK_TOKEN) return AUTO_INK_TOKEN;
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  return AUTO_INK_TOKEN;
}

/**
 * Resolves 'auto-ink' into an explicit Canvas 2D color matching the active Crypsy theme.
 */
export function resolveLiveInkColor(token: string): string {
  const safe = sanitizeInkColor(token);
  if (safe !== AUTO_INK_TOKEN) return safe;
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'light') return '#202124';
  }
  return '#e8eaed';
}

/**
 * Normalizes pen pressure or derives subtle velocity-tapered pressure for mouse/touch input.
 */
export function computePointPressure(
  rawPressure: number,
  pointerType: string,
  dx: number,
  dy: number,
  dtMs: number,
  prevPressure: number
): number {
  if (pointerType === 'pen' && Number.isFinite(rawPressure) && rawPressure > 0) {
    const clamped = clamp(rawPressure, 0.08, 1);
    return round2(prevPressure * 0.35 + clamped * 0.65);
  }
  const dist = Math.hypot(dx, dy);
  const velocity = dist / Math.max(4, dtMs); // px/ms in canvas space
  const target = clamp(0.72 - velocity * 0.09, 0.38, 0.72);
  return round2(prevPressure * 0.6 + target * 0.4);
}

/**
 * Squared perpendicular distance from point P to segment AB.
 */
export function distancePointToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 1e-9) {
    const dx = px - ax;
    const dy = py - ay;
    return dx * dx + dy * dy;
  }
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1);
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/**
 * Minimum squared distance between segment AB and segment CD.
 */
export function distanceSegmentToSegmentSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distancePointToSegmentSq(ax, ay, cx, cy, dx, dy),
    distancePointToSegmentSq(bx, by, cx, cy, dx, dy),
    distancePointToSegmentSq(cx, cy, ax, ay, bx, by),
    distancePointToSegmentSq(dx, dy, ax, ay, bx, by)
  );
}

function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    px >= Math.min(ax, bx) - 1e-6 &&
    px <= Math.max(ax, bx) + 1e-6 &&
    py >= Math.min(ay, by) - 1e-6 &&
    py <= Math.max(ay, by) + 1e-6
  );
}

export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (Math.abs(o1) < 1e-6 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(o2) < 1e-6 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  if (Math.abs(o3) < 1e-6 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(o4) < 1e-6 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/**
 * Iterative Ramer-Douglas-Peucker simplification keeping stroke endpoints and pressure values.
 */
export function simplifyStrokePoints(
  points: readonly StrokePoint[],
  epsilon = 0.65
): StrokePoint[] {
  if (points.length <= 2) {
    return points.map((p) => [round1(p[0]), round1(p[1]), round2(p[2])]);
  }

  const epsSq = epsilon * epsilon;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;
    if (endIdx - startIdx <= 1) continue;

    const a = points[startIdx]!;
    const b = points[endIdx]!;
    let maxDistSq = -1;
    let maxIdx = -1;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const p = points[i]!;
      const dSq = distancePointToSegmentSq(p[0], p[1], a[0], a[1], b[0], b[1]);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > epsSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx], [maxIdx, endIdx]);
    }
  }

  const out: StrokePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) {
      const p = points[i]!;
      out.push([round1(p[0]), round1(p[1]), round2(p[2])]);
    }
  }
  return out;
}

/**
 * Lightly subdivides a polyline with quadratic Bezier midpoints for smooth stroke ribbons.
 */
function sampleSmoothCurvePoints(points: readonly StrokePoint[]): StrokePoint[] {
  const deduped: StrokePoint[] = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 0.35) {
      deduped.push(p);
    }
  }
  if (deduped.length <= 2) return deduped;

  const smoothed: StrokePoint[] = [deduped[0]!];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = deduped[i - 1]!;
    const curr = deduped[i]!;
    const next = deduped[i + 1]!;

    const m0x = (prev[0] + curr[0]) * 0.5;
    const m0y = (prev[1] + curr[1]) * 0.5;
    const m0p = (prev[2] + curr[2]) * 0.5;

    const m1x = (curr[0] + next[0]) * 0.5;
    const m1y = (curr[1] + next[1]) * 0.5;
    const m1p = (curr[2] + next[2]) * 0.5;

    const span = Math.hypot(curr[0] - m0x, curr[1] - m0y) + Math.hypot(m1x - curr[0], m1y - curr[1]);
    const steps = span > 18 ? 3 : span > 7 ? 2 : 1;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const omt = 1 - t;
      const x = omt * omt * m0x + 2 * omt * t * curr[0] + t * t * m1x;
      const y = omt * omt * m0y + 2 * omt * t * curr[1] + t * t * m1y;
      const pr = omt * omt * m0p + 2 * omt * t * curr[2] + t * t * m1p;
      smoothed.push([x, y, pr]);
    }
  }
  smoothed.push(deduped[deduped.length - 1]!);
  return smoothed;
}

/**
 * Generates an SVG quadratic midpoint centerline path (ideal for highlighters or thin hit paths).
 */
export function buildCenterlinePath(points: readonly StrokePoint[]): string {
  if (points.length === 0) return '';
  const p0 = points[0]!;
  if (points.length === 1) {
    return `M${round1(p0[0])} ${round1(p0[1])} L${round1(p0[0] + 0.1)} ${round1(p0[1])}`;
  }
  if (points.length === 2) {
    const p1 = points[1]!;
    return `M${round1(p0[0])} ${round1(p0[1])} L${round1(p1[0])} ${round1(p1[1])}`;
  }

  const p1 = points[1]!;
  const parts: string[] = [
    `M${round1(p0[0])} ${round1(p0[1])}`,
    `L${round1((p0[0] + p1[0]) * 0.5)} ${round1((p0[1] + p1[1]) * 0.5)}`,
  ];
  for (let i = 1; i < points.length - 1; i++) {
    const c = points[i]!;
    const n = points[i + 1]!;
    parts.push(
      `Q${round1(c[0])} ${round1(c[1])} ${round1((c[0] + n[0]) * 0.5)} ${round1((c[1] + n[1]) * 0.5)}`
    );
  }
  const last = points[points.length - 1]!;
  parts.push(`L${round1(last[0])} ${round1(last[1])}`);
  return parts.join(' ');
}

function appendCapArc(
  outline: [number, number][],
  cx: number,
  cy: number,
  radius: number,
  startAngle: number
): void {
  for (let k = 1; k <= 3; k++) {
    const angle = startAngle - (k / 4) * Math.PI;
    outline.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
}

/**
 * Computes closed polygon vertices representing a variable-width calligraphy/ink ribbon.
 */
export function computeVariableWidthOutline(
  points: readonly StrokePoint[],
  baseWidth: number
): [number, number][] {
  const pts = sampleSmoothCurvePoints(points);
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    const [cx, cy, p] = pts[0]!;
    const r = Math.max(0.75, baseWidth * 0.5 * (0.45 + 0.65 * clamp(p, 0.08, 1)));
    const ring: [number, number][] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return ring;
  }

  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let firstTangentX = 1;
  let firstTangentY = 0;
  let lastTangentX = 1;
  let lastTangentY = 0;
  let firstRadius = baseWidth * 0.5;
  let lastRadius = baseWidth * 0.5;

  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i]!;
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;

    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty);
    if (len > 1e-6) {
      tx /= len;
      ty /= len;
    } else {
      tx = lastTangentX;
      ty = lastTangentY;
    }

    const nx = -ty;
    const ny = tx;
    const radius = Math.max(0.45, baseWidth * 0.5 * (0.38 + 0.68 * clamp(curr[2], 0.05, 1)));

    if (i === 0) {
      firstTangentX = tx;
      firstTangentY = ty;
      firstRadius = radius;
    }
    if (i === pts.length - 1) {
      lastTangentX = tx;
      lastTangentY = ty;
      lastRadius = radius;
    }

    left.push([curr[0] + nx * radius, curr[1] + ny * radius]);
    right.push([curr[0] - nx * radius, curr[1] - ny * radius]);
  }

  const contour: [number, number][] = [...left];
  const endPt = pts[pts.length - 1]!;
  const endNormalAngle = Math.atan2(lastTangentX, -lastTangentY);
  appendCapArc(contour, endPt[0], endPt[1], lastRadius, endNormalAngle);

  for (let i = right.length - 1; i >= 0; i--) {
    contour.push(right[i]!);
  }

  const startPt = pts[0]!;
  const startNegNormalAngle = Math.atan2(-firstTangentX, firstTangentY);
  appendCapArc(contour, startPt[0], startPt[1], firstRadius, startNegNormalAngle);
  return contour;
}

/**
 * Emits a closed SVG path outline for a variable-width Pen stroke.
 */
export function buildVariableWidthStrokePath(
  points: readonly StrokePoint[],
  baseWidth: number
): string {
  const contour = computeVariableWidthOutline(points, baseWidth);
  if (contour.length === 0) return '';
  const cmds = contour.map(
    (pt, i) => `${i === 0 ? 'M' : 'L'}${round1(pt[0])} ${round1(pt[1])}`
  );
  cmds.push('Z');
  return cmds.join(' ');
}

/**
 * Simplifies raw canvas samples, computes padded bounding box, and returns item positioning fields.
 */
export function normalizeRawStroke(
  rawPoints: readonly StrokePoint[],
  tool: 'pen' | 'highlighter',
  strokeWidth: number
): {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  points: StrokePoint[];
} {
  const epsilon = tool === 'highlighter' ? 1.1 : 0.65;
  const simplified = simplifyStrokePoints(rawPoints, epsilon);
  if (simplified.length === 0) {
    return { x: 0, y: 0, width: 16, height: 16, sourceWidth: 16, sourceHeight: 16, points: [[8, 8, 0.5]] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of simplified) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }

  const pad = Math.max(4, Math.ceil(strokeWidth * 0.65));
  const x = Math.round(minX - pad);
  const y = Math.round(minY - pad);
  const sourceWidth = Math.max(12, Math.round(maxX - minX + pad * 2));
  const sourceHeight = Math.max(12, Math.round(maxY - minY + pad * 2));

  const localPoints: StrokePoint[] = simplified.map(([px, py, pr]) => [
    round1(px - x),
    round1(py - y),
    round2(pr),
  ]);

  return {
    x,
    y,
    width: sourceWidth,
    height: sourceHeight,
    sourceWidth,
    sourceHeight,
    points: localPoints,
  };
}

/**
 * Renders an active or completed stroke into a Canvas 2D context in world canvas coordinates.
 */
export function renderStrokeToCanvas2d(
  ctx: CanvasRenderingContext2D,
  points: readonly StrokePoint[],
  tool: 'pen' | 'highlighter',
  strokeColor: string,
  strokeWidth: number,
  opacity: number
): void {
  if (points.length === 0) return;
  const color = resolveLiveInkColor(strokeColor);

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0.05, 1);

  if (tool === 'highlighter') {
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = points[0]!;
    ctx.moveTo(p0[0], p0[1]);
    if (points.length === 1) {
      ctx.lineTo(p0[0] + 0.1, p0[1]);
    } else if (points.length === 2) {
      const p1 = points[1]!;
      ctx.lineTo(p1[0], p1[1]);
    } else {
      const p1 = points[1]!;
      ctx.lineTo((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5);
      for (let i = 1; i < points.length - 1; i++) {
        const c = points[i]!;
        const n = points[i + 1]!;
        ctx.quadraticCurveTo(c[0], c[1], (c[0] + n[0]) * 0.5, (c[1] + n[1]) * 0.5);
      }
      const last = points[points.length - 1]!;
      ctx.lineTo(last[0], last[1]);
    }
    ctx.stroke();
  } else {
    const contour = computeVariableWidthOutline(points, strokeWidth);
    if (contour.length > 0) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(contour[0]![0], contour[0]![1]);
      for (let i = 1; i < contour.length; i++) {
        ctx.lineTo(contour[i]![0], contour[i]![1]);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Generates inline SVG markup for a persisted `BoardStrokeItem` (canvas or card thumbnail).
 */
export function renderBoardStrokeSvg(item: BoardStrokeItem, minimap = false): string {
  const safeColor = sanitizeInkColor(item.strokeColor);
  const paint = safeColor === AUTO_INK_TOKEN ? 'currentColor' : safeColor;
  const rawSw = Number(item.sourceWidth || item.width || 12);
  const rawSh = Number(item.sourceHeight || item.height || 12);
  const sw = Math.max(12, Number.isFinite(rawSw) ? rawSw : 12);
  const sh = Math.max(12, Number.isFinite(rawSh) ? rawSh : 12);
  const isHighlighter = item.tool === 'highlighter';
  const rawWidth = Number(item.strokeWidth);
  const strokeWidth = clamp(Number.isFinite(rawWidth) ? rawWidth : isHighlighter ? 18 : 3, 1, 64);
  const rawOpacity = Number(item.opacity ?? (isHighlighter ? 0.42 : 1));
  const alpha = clamp(Number.isFinite(rawOpacity) ? rawOpacity : isHighlighter ? 0.42 : 1, 0.1, 1);

  if (isHighlighter) {
    const d = buildCenterlinePath(item.points);
    const hitPath = minimap
      ? ''
      : `<path class="board-ink-hit" d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(16, strokeWidth + 6)}" stroke-linecap="round" stroke-linejoin="round" />`;
    return `<svg class="board-ink-svg is-highlighter" data-ink="${safeColor}" viewBox="0 0 ${sw} ${sh}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${paint}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${alpha}" />${hitPath}</svg>`;
  }

  const fillPath = buildVariableWidthStrokePath(item.points, strokeWidth);
  const hitCenter = minimap
    ? ''
    : `<path class="board-ink-hit" d="${buildCenterlinePath(item.points)}" fill="none" stroke="transparent" stroke-width="${Math.max(14, strokeWidth + 8)}" stroke-linecap="round" stroke-linejoin="round" />`;

  return `<svg class="board-ink-svg is-pen" data-ink="${safeColor}" viewBox="0 0 ${sw} ${sh}" preserveAspectRatio="none"><path d="${fillPath}" fill="${paint}" opacity="${alpha}" />${hitCenter}</svg>`;
}

/**
 * Maps a `BoardStrokeItem`'s local points into scaled & rotated world canvas coordinates.
 */
export function getStrokeWorldPolyline(
  item: BoardStrokeItem,
  renderedWidth: number,
  renderedHeight: number
): [number, number][] {
  const w = Math.max(1, renderedWidth);
  const h = Math.max(1, renderedHeight);
  const sw = Math.max(1, item.sourceWidth || w);
  const sh = Math.max(1, item.sourceHeight || h);
  const sx = w / sw;
  const sy = h / sh;

  const cx = item.x + w * 0.5;
  const cy = item.y + h * 0.5;
  const rad = ((item.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return item.points.map(([lx, ly]) => {
    const bx = lx * sx - w * 0.5;
    const by = ly * sy - h * 0.5;
    return [cx + bx * cos - by * sin, cy + bx * sin + by * cos];
  });
}

/**
 * Tests whether a dragged eraser segment intersects an existing `BoardStrokeItem` in world canvas space.
 */
export function segmentHitsStroke(
  item: BoardStrokeItem,
  renderedWidth: number,
  renderedHeight: number,
  segAx: number,
  segAy: number,
  segBx: number,
  segBy: number,
  eraserRadiusCanvas: number
): boolean {
  const pts = getStrokeWorldPolyline(item, renderedWidth, renderedHeight);
  if (pts.length === 0) return false;

  const scaleApprox = Math.max(
    renderedWidth / Math.max(1, item.sourceWidth || renderedWidth),
    renderedHeight / Math.max(1, item.sourceHeight || renderedHeight)
  );
  const hitR = eraserRadiusCanvas + item.strokeWidth * 0.5 * scaleApprox;
  const hitRSq = hitR * hitR;

  if (pts.length === 1) {
    const p = pts[0]!;
    return distancePointToSegmentSq(p[0], p[1], segAx, segAy, segBx, segBy) <= hitRSq;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (distanceSegmentToSegmentSq(a[0], a[1], b[0], b[1], segAx, segAy, segBx, segBy) <= hitRSq) {
      return true;
    }
  }
  return false;
}

/**
 * Ray-casting point-in-polygon check for closed lasso selection loops.
 */
export function pointInPolygon(px: number, py: number, polygon: readonly [number, number][]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]![0];
    const yi = polygon[i]![1];
    const xj = polygon[j]![0];
    const yj = polygon[j]![1];
    const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polylineIntersectsPolygonEdges(
  linePts: readonly [number, number][],
  polygon: readonly [number, number][]
): boolean {
  for (let i = 0; i < linePts.length - 1; i++) {
    const a = linePts[i]!;
    const b = linePts[i + 1]!;
    for (let k = 0, p = polygon.length - 1; k < polygon.length; p = k++) {
      const c = polygon[p]!;
      const d = polygon[k]!;
      if (segmentsIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if a closed lasso polygon encloses or crosses any part of a `BoardStrokeItem`.
 */
export function lassoSelectsStroke(
  item: BoardStrokeItem,
  renderedWidth: number,
  renderedHeight: number,
  polygon: readonly [number, number][]
): boolean {
  if (polygon.length < 3) return false;
  const pts = getStrokeWorldPolyline(item, renderedWidth, renderedHeight);
  for (const [px, py] of pts) {
    if (pointInPolygon(px, py, polygon)) return true;
  }
  return pts.length >= 2 && polylineIntersectsPolygonEdges(pts, polygon);
}

/**
 * Returns true if a closed lasso polygon encloses or overlaps a rotated rectangle (text/image/link item).
 */
export function lassoSelectsRect(
  x: number,
  y: number,
  width: number,
  height: number,
  rotationDeg: number,
  polygon: readonly [number, number][]
): boolean {
  if (polygon.length < 3) return false;
  const cx = x + width * 0.5;
  const cy = y + height * 0.5;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const cornersLocal: [number, number][] = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ];
  const cornersWorld: [number, number][] = cornersLocal.map(([lx, ly]) => [
    cx + lx * cos - ly * sin,
    cy + lx * sin + ly * cos,
  ]);

  if (pointInPolygon(cx, cy, polygon)) return true;
  for (const [wx, wy] of cornersWorld) {
    if (pointInPolygon(wx, wy, polygon)) return true;
  }

  // Also test if any lasso vertex falls inside the rotated rectangle
  for (const [px, py] of polygon) {
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= halfW && Math.abs(ly) <= halfH) return true;
  }

  const closedCorners = [...cornersWorld, cornersWorld[0]!];
  return polylineIntersectsPolygonEdges(closedCorners, polygon);
}
