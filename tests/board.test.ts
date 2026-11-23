import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeResizedItemRect, normalizeAngleDeg } from '../src/board-geometry';
import { BoardHistory } from '../src/board-history';
import { alignBoardItemsInPlace, summarizeBoardItemsForClipboard } from '../src/board-ops';
import {
  AUTO_INK_TOKEN,
  buildCenterlinePath,
  buildVariableWidthStrokePath,
  lassoSelectsRect,
  lassoSelectsStroke,
  normalizeRawStroke,
  pointInPolygon,
  sanitizeInkColor,
  segmentHitsStroke,
  simplifyStrokePoints,
} from '../src/ink';
import type { BoardStrokeItem } from '../src/types';

describe('board ink geometry', () => {
  it('sanitizes ink colors against injection', () => {
    assert.equal(sanitizeInkColor(undefined), AUTO_INK_TOKEN);
    assert.equal(sanitizeInkColor(AUTO_INK_TOKEN), AUTO_INK_TOKEN);
    assert.equal(sanitizeInkColor('#4285f4'), '#4285f4');
    assert.equal(sanitizeInkColor('red; background:url(x)'), AUTO_INK_TOKEN);
  });

  it('simplifies collinear points while keeping endpoints', () => {
    const simplified = simplifyStrokePoints(
      [
        [0, 0, 0.5],
        [10, 0, 0.5],
        [20, 0, 0.5],
        [30, 0, 0.5],
      ],
      0.5
    );
    assert.equal(simplified.length, 2);
    assert.deepEqual(simplified[0], [0, 0, 0.5]);
    assert.deepEqual(simplified[1], [30, 0, 0.5]);
  });

  it('normalizes raw strokes and builds non-empty SVG paths', () => {
    const norm = normalizeRawStroke(
      [
        [100, 100, 0.5],
        [140, 120, 0.7],
        [180, 110, 0.6],
      ],
      'pen',
      4
    );
    assert.ok(norm.width > 80);
    assert.ok(norm.height > 20);
    assert.ok(buildCenterlinePath(norm.points).startsWith('M'));
    assert.ok(buildVariableWidthStrokePath(norm.points, 4).endsWith('Z'));
  });

  it('hit-tests strokes with eraser segment and lasso polygon', () => {
    const norm = normalizeRawStroke(
      [
        [10, 10, 0.5],
        [110, 10, 0.5],
      ],
      'pen',
      4
    );
    const stroke: BoardStrokeItem = {
      id: 's1',
      type: 'stroke',
      tool: 'pen',
      strokeColor: '#4285f4',
      strokeWidth: 4,
      opacity: 1,
      x: norm.x,
      y: norm.y,
      width: norm.width,
      height: norm.height,
      sourceWidth: norm.sourceWidth,
      sourceHeight: norm.sourceHeight,
      rotation: 0,
      zIndex: 1,
      points: norm.points,
    };

    assert.equal(segmentHitsStroke(stroke, stroke.width, stroke.height!, 60, 0, 60, 20, 6), true);
    assert.equal(segmentHitsStroke(stroke, stroke.width, stroke.height!, 60, 80, 60, 100, 6), false);

    const box: [number, number][] = [
      [0, 0],
      [120, 0],
      [120, 40],
      [0, 40],
    ];
    assert.equal(pointInPolygon(50, 10, box), true);
    assert.equal(pointInPolygon(200, 10, box), false);
    assert.equal(lassoSelectsStroke(stroke, stroke.width, stroke.height!, box), true);
    assert.equal(lassoSelectsRect(20, 10, 30, 20, 0, box), true);
    assert.equal(lassoSelectsRect(200, 200, 30, 20, 0, box), false);
  });
});

describe('board transforms, history & ops', () => {
  it('normalizes angles into (-180, 180]', () => {
    assert.equal(normalizeAngleDeg(0), 0);
    assert.equal(normalizeAngleDeg(360), 0);
    assert.equal(normalizeAngleDeg(270), -90);
    assert.equal(normalizeAngleDeg(-180), 180);
  });

  it('computes resized item rect anchoring opposite corner and preserving aspect ratio', () => {
    const res = computeResizedItemRect({
      startMetrics: { x: 100, y: 100, w: 200, h: 100, rotation: 0 },
      handle: 'se',
      dx: 100,
      dy: 10,
      minW: 60,
      minH: 45,
      preserveAspect: true,
      aspectRatio: 2,
    });
    assert.equal(res.x, 100);
    assert.equal(res.y, 100);
    assert.equal(res.width, 300);
    assert.equal(res.height, 150);
    assert.equal(res.changedHeight, true);
  });

  it('tracks undo/redo history snapshots with bounded depth', () => {
    const history = new BoardHistory(2);
    const s0: BoardStrokeItem[] = [];
    const mk = (id: string): BoardStrokeItem => ({
      id,
      type: 'stroke',
      tool: 'pen',
      strokeColor: '#000',
      strokeWidth: 2,
      opacity: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      sourceWidth: 10,
      sourceHeight: 10,
      rotation: 0,
      zIndex: 1,
      points: [[0, 0, 0.5]],
    });
    const s1 = [mk('a')];
    const s2 = [mk('a'), mk('b')];
    const s3 = [mk('a'), mk('b'), mk('c')];

    history.push(s0);
    history.push(s1);
    history.push(s2);
    assert.equal(history.canUndo(), true);
    assert.equal(history.canRedo(), false);

    const u1 = history.undo(s3);
    assert.equal(u1?.length, 2);
    assert.equal(history.canRedo(), true);

    const u2 = history.undo(u1!);
    assert.equal(u2?.length, 1);
    assert.equal(history.canUndo(), false);

    const r1 = history.redo(u2!);
    assert.equal(r1?.length, 2);
  });

  it('aligns board items and summarizes clipboard contents', () => {
    const a = {
      id: 't1',
      type: 'text' as const,
      x: 100,
      y: 20,
      width: 100,
      rotation: 0,
      zIndex: 1,
      color: 'default' as const,
      content: 'Hello',
      align: 'left' as const,
      fontSize: 15,
    };
    const b = {
      id: 't2',
      type: 'text' as const,
      x: 250,
      y: 80,
      width: 100,
      rotation: 0,
      zIndex: 2,
      color: 'default' as const,
      content: 'World',
      align: 'left' as const,
      fontSize: 15,
    };
    alignBoardItemsInPlace(
      [
        { item: a, aabb: { minX: 100, minY: 20, maxX: 200, maxY: 60 } },
        { item: b, aabb: { minX: 250, minY: 80, maxX: 350, maxY: 120 } },
      ],
      'left'
    );
    assert.equal(a.x, 100);
    assert.equal(b.x, 100);
    assert.equal(summarizeBoardItemsForClipboard([a, b]), 'Hello\n\nWorld');
  });
});
