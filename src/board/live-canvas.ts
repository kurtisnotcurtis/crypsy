/**
 * Crypsy — Board Live 2D Canvas Overlay
 * Handles DPR-scaled viewport canvas setup and renders live ink strokes,
 * eraser cursor circles, and lasso selection polygons.
 */

import {
  AUTO_INK_TOKEN,
  type StrokePoint,
  renderStrokeToCanvas2d,
  resolveLiveInkColor,
} from './ink';
import type { Board, BoardInkTool } from '../types';

export class BoardLiveCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: HTMLElement;

  constructor(canvas: HTMLCanvasElement, viewport: HTMLElement) {
    this.canvas = canvas;
    this.viewport = viewport;
  }

  public clear(): void {
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.canvas.classList.add('hidden');
  }

  public renderDrawStroke(
    board: Board,
    points: StrokePoint[],
    tool: BoardInkTool,
    strokeColor: string,
    strokeWidth: number,
    opacity: number
  ): void {
    const ctx = this.prepareContext(board);
    if (!ctx) return;
    renderStrokeToCanvas2d(ctx, points, tool, strokeColor, strokeWidth, opacity);
  }

  public renderEraserCursor(board: Board, pt: { x: number; y: number }): void {
    const ctx = this.prepareContext(board);
    if (!ctx) return;
    const r = 10 / board.viewport.zoom;
    ctx.save();
    ctx.strokeStyle = resolveLiveInkColor(AUTO_INK_TOKEN);
    ctx.lineWidth = 1.5 / board.viewport.zoom;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  public renderLassoPolygon(board: Board, points: Array<[number, number]>): void {
    if (points.length < 2) return;
    const ctx = this.prepareContext(board);
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = '#8ab4f8';
    ctx.fillStyle = 'rgba(138, 180, 248, 0.1)';
    ctx.lineWidth = 1.75 / board.viewport.zoom;
    ctx.setLineDash([6 / board.viewport.zoom, 4 / board.viewport.zoom]);
    ctx.beginPath();
    ctx.moveTo(points[0]![0], points[0]![1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i]![0], points[i]![1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private prepareContext(board: Board): CanvasRenderingContext2D | null {
    const rect = this.viewport.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.canvas.classList.remove('hidden');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const z = board.viewport.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, board.viewport.panX * dpr, board.viewport.panY * dpr);
    return ctx;
  }
}
