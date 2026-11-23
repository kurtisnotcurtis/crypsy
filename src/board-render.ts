/**
 * HTML rendering for Spatial Board items (text, image, stroke, link)
 * and shared privacy placeholder markup for blocked external images.
 */

import { renderBoardStrokeSvg } from './ink';
import type { BoardItem } from './types';
import { escapeHtml, highlightText, isExternalHttpUrl } from './utils';

export function renderBlockedExternalImageHtml(
  src: string,
  options: { containerClass?: string; buttonLabel?: string; hideButton?: boolean } = {}
): string {
  let host = 'external host';
  try {
    host = new URL(src).hostname || host;
  } catch {
    // ignore invalid URL
  }
  const cls = options.containerClass ?? 'blocked-external-image';
  const btn = options.hideButton
    ? ''
    : `<button type="button" class="btn-link blocked-external-load-btn" data-allow-external-url="${escapeHtml(src)}">${escapeHtml(options.buttonLabel ?? 'Load external image')}</button>`;
  return `<div class="${cls}"><span>External image blocked (${escapeHtml(host)})</span>${btn}</div>`;
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
  allowExternalUrl?: ((url: string) => boolean) | undefined;
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
    const blockedExternal =
      isExternalHttpUrl(item.image.src) &&
      options.allowExternalUrl &&
      !options.allowExternalUrl(item.image.src);
    if (blockedExternal) {
      return `
        <div class="board-item type-image ${isSelected ? 'selected' : ''}" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
          ${renderBlockedExternalImageHtml(item.image.src, {
            containerClass: 'blocked-external-board-image',
            buttonLabel: 'Load once',
            hideButton: Boolean(options.minimap),
          })}
        </div>
      `;
    }
    return `
      <div class="board-item type-image ${isSelected ? 'selected' : ''}" ${idAttr} data-color="${colorAttr}" style="${baseStyle}">
        <img src="${escapeHtml(item.image.src)}" alt="${escapeHtml(item.image.alt || 'Board image')}" referrerpolicy="no-referrer" loading="lazy" />
      </div>
    `;
  }

  if (item.type === 'stroke') {
    const strokeH = item.height ?? item.sourceHeight;
    const strokeStyle = `left:${item.x - ox}px;top:${item.y - oy}px;width:${item.width}px;height:${strokeH}px;z-index:${item.zIndex};transform:rotate(${rot}deg);`;
    const hlClass = item.tool === 'highlighter' ? 'is-highlighter' : '';
    return `
      <div class="board-item type-stroke ${hlClass} ${isSelected ? 'selected' : ''}" ${idAttr} style="${strokeStyle}">
        ${renderBoardStrokeSvg(item, Boolean(options.minimap))}
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
