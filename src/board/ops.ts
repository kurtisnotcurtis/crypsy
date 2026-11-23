/**
 * Crypsy — Pure Board Item Alignment, Z-Order & Clipboard Copy/Paste Helpers
 */

import type { BoardAlignAxis } from './selection-bar';
import type { BoardItem } from '../types';
import { createId } from '../utils';

export interface ItemAabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function alignBoardItemsInPlace(
  entries: ReadonlyArray<{ item: BoardItem; aabb: ItemAabb }>,
  axis: BoardAlignAxis
): void {
  if (entries.length < 2) return;
  const minX = Math.min(...entries.map((e) => e.aabb.minX));
  const maxX = Math.max(...entries.map((e) => e.aabb.maxX));
  const minY = Math.min(...entries.map((e) => e.aabb.minY));
  const maxY = Math.max(...entries.map((e) => e.aabb.maxY));
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  for (const { item, aabb } of entries) {
    if (axis === 'left') item.x += minX - aabb.minX;
    if (axis === 'right') item.x += maxX - aabb.maxX;
    if (axis === 'centerX') item.x += midX - (aabb.minX + aabb.maxX) / 2;
    if (axis === 'top') item.y += minY - aabb.minY;
    if (axis === 'centerY') item.y += midY - (aabb.minY + aabb.maxY) / 2;
  }
}

/**
 * Re-indexes all board items 1..N placing selected items strictly behind unselected items
 * while preserving relative z-order within each group.
 */
export function sendItemsToBackInPlace(
  boardItems: BoardItem[],
  selectedIds: ReadonlySet<string>
): void {
  if (boardItems.length === 0 || selectedIds.size === 0) return;
  const sorted = [...boardItems].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const selected = sorted.filter((it) => selectedIds.has(it.id));
  const others = sorted.filter((it) => !selectedIds.has(it.id));
  const ordered = [...selected, ...others];
  ordered.forEach((it, idx) => {
    it.zIndex = idx + 1;
  });
}

/**
 * Re-indexes all board items 1..N placing selected items strictly in front of unselected items
 * while preserving relative z-order within each group.
 */
export function bringItemsToFrontInPlace(
  boardItems: BoardItem[],
  selectedIds: ReadonlySet<string>
): void {
  if (boardItems.length === 0 || selectedIds.size === 0) return;
  const sorted = [...boardItems].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const others = sorted.filter((it) => !selectedIds.has(it.id));
  const selected = sorted.filter((it) => selectedIds.has(it.id));
  const ordered = [...others, ...selected];
  ordered.forEach((it, idx) => {
    it.zIndex = idx + 1;
  });
}

export function summarizeBoardItemsForClipboard(items: readonly BoardItem[]): string {
  const parts = items
    .map((it) => {
      if (it.type === 'text') return it.content;
      if (it.type === 'link') return it.url;
      if (it.type === 'stroke') return '';
      return it.image.sourceType === 'external' ? it.image.src : it.image.alt || '[Board Image]';
    })
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join('\n\n');
  }

  const strokeCount = items.filter((it) => it.type === 'stroke').length;
  if (strokeCount > 0) {
    return `[Crypsy Ink: ${strokeCount} stroke${strokeCount === 1 ? '' : 's'}]`;
  }
  return '';
}

export function cloneItemsForPaste(
  sourceItems: readonly BoardItem[],
  targetX: number,
  targetY: number,
  startZIndex: number,
  snapValue: (v: number) => number
): BoardItem[] {
  if (sourceItems.length === 0) return [];
  const minX = sourceItems.reduce((m, it) => Math.min(m, it.x), Infinity);
  const minY = sourceItems.reduce((m, it) => Math.min(m, it.y), Infinity);
  let dx = Math.round(targetX - minX);
  let dy = Math.round(targetY - minY);
  if (dx === 0 && dy === 0) {
    dx = 24;
    dy = 24;
  }

  let z = startZIndex;
  return sourceItems.map((src) => {
    const copy = structuredClone(src);
    copy.id = createId('bi');
    copy.x = snapValue(src.x + dx);
    copy.y = snapValue(src.y + dy);
    copy.zIndex = z++;
    return copy;
  });
}
