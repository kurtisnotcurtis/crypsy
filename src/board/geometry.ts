/**
 * Pure 2D transform math for Spatial Board items (clamping, angle normalization, rotated resize).
 */

export type ResizeHandleDir = 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e';

export interface ItemMetrics {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function normalizeAngleDeg(deg: number): number {
  let a = Math.round(deg) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a === 0 ? 0 : a;
}

/**
 * Computes the new axis-aligned position & size for a (possibly rotated) board item
 * being dragged from one of its resize handles while anchoring the opposite edge/corner.
 */
export function computeResizedItemRect(params: {
  startMetrics: ItemMetrics;
  handle: ResizeHandleDir;
  dx: number;
  dy: number;
  minW: number;
  minH: number;
  preserveAspect: boolean;
  aspectRatio: number;
}): { x: number; y: number; width: number; height: number; changedHeight: boolean } {
  const { startMetrics, handle, dx, dy, minW, minH, preserveAspect, aspectRatio } = params;
  const { x: sx0, y: sy0, w: sw, h: sh, rotation } = startMetrics;
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const localDx = dx * cos + dy * sin;
  const localDy = -dx * sin + dy * cos;

  let nextW = sx !== 0 ? Math.max(minW, sw + sx * localDx) : sw;
  let nextH = sy !== 0 ? Math.max(minH, sh + sy * localDy) : sh;

  if (preserveAspect && sx !== 0 && sy !== 0) {
    if (Math.abs(nextW - sw) / sw >= Math.abs(nextH - sh) / sh) {
      nextH = Math.max(minH, nextW / aspectRatio);
    } else {
      nextW = Math.max(minW, nextH * aspectRatio);
    }
  }

  const dw = nextW - sw;
  const dh = nextH - sh;
  const offsetLocalX = (sx * dw) / 2;
  const offsetLocalY = (sy * dh) / 2;

  const startCenterX = sx0 + sw / 2;
  const startCenterY = sy0 + sh / 2;
  const nextCenterX = startCenterX + offsetLocalX * cos - offsetLocalY * sin;
  const nextCenterY = startCenterY + offsetLocalX * sin + offsetLocalY * cos;

  return {
    x: Math.round(nextCenterX - nextW / 2),
    y: Math.round(nextCenterY - nextH / 2),
    width: Math.round(nextW),
    height: Math.round(nextH),
    changedHeight: sy !== 0,
  };
}
