/**
 * Shared DOM, text escaping, and formatting utilities for Crypsy.
 */

import type { BoardItem } from './types';

export const APP_VERSION = '1.4.0';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return el as T;
}

export function maybeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightText(text: string, query: string): string {
  const safe = escapeHtml(text);
  if (!query || !query.trim()) return safe;
  const cleanQ = query.trim().replace(/^#/, '');
  if (!cleanQ) return safe;
  const escapedRegex = cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedRegex})`, 'gi');
  return safe.replace(regex, '<mark class="search-highlight">$1</mark>');
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(ms: number): string {
  if (!ms) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return formatTimestamp(ms);
}

export function autoResizeTextarea(textarea: HTMLTextAreaElement, minHeight = 32): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
}

export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export function getRotatedRectAabb(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!rotation) {
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    { lx: -w / 2, ly: -h / 2 },
    { lx: w / 2, ly: -h / 2 },
    { lx: -w / 2, ly: h / 2 },
    { lx: w / 2, ly: h / 2 },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const rx = cx + c.lx * cos - c.ly * sin;
    const ry = cy + c.lx * sin + c.ly * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { minX, minY, maxX, maxY };
}

export function renderBoardTextContentHtml(content: string, query: string): string {
  const lines = String(content).split(/\r?\n/);
  return lines
    .map((line) => {
      if (!line) return '<br />';
      const tokenRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/gi;
      let result = '';
      let lastIdx = 0;
      let match: RegExpExecArray | null;
      while ((match = tokenRegex.exec(line)) !== null) {
        if (match.index > lastIdx) {
          result += highlightText(line.slice(lastIdx, match.index), query);
        }
        if (match[1] && match[2]) {
          result += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${highlightText(match[1], query)}</a>`;
        } else if (match[3]) {
          result += `<a href="${escapeHtml(match[3])}" target="_blank" rel="noopener noreferrer">${highlightText(match[3], query)}</a>`;
        }
        lastIdx = tokenRegex.lastIndex;
      }
      if (lastIdx < line.length) {
        result += highlightText(line.slice(lastIdx), query);
      }
      return result;
    })
    .join('\n');
}

export interface RenderBoardItemOptions {
  selected?: boolean | undefined;
  editingText?: boolean | undefined;
  editingLinkLabel?: boolean | undefined;
  minimap?: boolean | undefined;
  offsetX?: number | undefined;
  offsetY?: number | undefined;
}

export function renderBoardItemHtml(
  item: BoardItem,
  query: string,
  options: RenderBoardItemOptions = {}
): string {
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;
  const isSelected = Boolean(options.selected);
  const isEditing = Boolean(options.editingText);
  const isEditingLabel = Boolean(options.editingLinkLabel);
  const rot = item.rotation || 0;

  const heightStyle = item.height ? `height:${item.height}px;` : '';
  const baseStyle = `left:${item.x - ox}px;top:${item.y - oy}px;width:${item.width}px;${heightStyle}z-index:${item.zIndex};transform:rotate(${rot}deg);`;
  const colorAttr = escapeHtml(item.color || 'default');
  const idAttr = options.minimap
    ? `data-rotation="${rot}"`
    : `data-board-item-id="${escapeHtml(item.id)}"`;

  if (item.type === 'text') {
    const textStyle = `font-size:${item.fontSize || 15}px;text-align:${item.align || 'left'};font-weight:${item.bold ? '700' : '400'};font-style:${item.italic ? 'italic' : 'normal'};`;
    if (isEditing && !options.minimap) {
      return `
        <div class="board-item type-text ${isSelected ? 'selected' : ''} editing" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
          <textarea class="board-text-input" data-board-textarea="${escapeHtml(item.id)}" style="${textStyle}" placeholder="Type note...">${escapeHtml(item.content)}</textarea>
        </div>
      `;
    }
    const viewHtml = item.content
      ? renderBoardTextContentHtml(item.content, query)
      : '<span style="color:var(--text-muted)">Click to type...</span>';
    return `
      <div class="board-item type-text ${isSelected ? 'selected' : ''}" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
        <div class="board-text-view" style="${textStyle}">${viewHtml}</div>
      </div>
    `;
  }

  if (item.type === 'image') {
    return `
      <div class="board-item type-image ${isSelected ? 'selected' : ''}" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
        <img src="${escapeHtml(item.image.src)}" alt="${escapeHtml(item.image.alt || 'Board image')}" referrerpolicy="no-referrer" loading="lazy" />
      </div>
    `;
  }

  let domain = item.url;
  try {
    domain = new URL(item.url).hostname;
  } catch {
    // keep raw URL
  }
  return `
    <div class="board-item type-link ${isSelected ? 'selected' : ''}" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
      <span class="board-link-domain">${escapeHtml(domain)}</span>
      ${
        isEditingLabel && !options.minimap
          ? `<input type="text" class="board-text-input" style="padding:2px 0;font-weight:600;font-size:0.95rem;" data-board-link-input="${escapeHtml(item.id)}" value="${escapeHtml(item.label || domain)}" />`
          : `<div class="board-link-label" title="Double-click to rename">${highlightText(item.label || domain, query)}</div>`
      }
      <a class="board-link-url" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${highlightText(item.url, query)}</a>
    </div>
  `;
}
