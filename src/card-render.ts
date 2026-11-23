/**
 * Crypsy — Workspace Card & Board Minimap Rendering Helpers
 */

import { renderBlockedExternalImageHtml, renderBoardItemHtml } from './board-render';
import { renderMarkdownDescription } from './markdown';
import type { Board, Note } from './types';
import {
  escapeHtml,
  formatTimestamp,
  getRotatedRectAabb,
  highlightText,
} from './utils';

export type ExternalImageAllowedFn = (src: string) => boolean;

export function renderImageOrPrivacyPlaceholderHtml(
  src: string,
  alt: string,
  isAllowed: ExternalImageAllowedFn,
  options: { className?: string; lazy?: boolean } = {}
): string {
  if (isAllowed(src)) {
    const cls = options.className ? ` class="${options.className}"` : '';
    const lazyAttr = options.lazy ? ' loading="lazy"' : '';
    return `<img${cls} src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" data-lightbox-src="${escapeHtml(src)}" referrerpolicy="no-referrer"${lazyAttr} />`;
  }
  return renderBlockedExternalImageHtml(src);
}

export function createNoteCardHtml(
  note: Note,
  searchQuery: string,
  isAllowed: ExternalImageAllowedFn
): string {
  const renderImg = (src: string, alt: string, options?: { className?: string; lazy?: boolean }) =>
    renderImageOrPrivacyPlaceholderHtml(src, alt, isAllowed, options);

  const titleHtml = note.title ? highlightText(note.title, searchQuery) : '';
  const descHtml = note.description
    ? renderMarkdownDescription(note.id, note.description, searchQuery, renderImg)
    : '';
  const images = Array.isArray(note.images) ? note.images : [];
  const imagesHtml =
    images.length > 0
      ? `<div class="note-card-images ${images.length === 1 ? 'single-image' : ''}">` +
        images
          .map(
            (img) => `
            <div class="note-image-item">
              ${renderImg(img.src, img.alt || 'Note image', { lazy: true })}
              <span class="note-image-badge">${img.sourceType === 'external' ? 'External URL' : 'Encrypted WebP'}</span>
            </div>
          `
          )
          .join('') +
        `</div>`
      : '';

  const tagsHtml = (note.tags || [])
    .map(
      (tag) =>
        `<span class="tag-chip" data-filter-tag="${escapeHtml(tag)}" title="Filter by #${escapeHtml(tag)}">#${highlightText(tag, searchQuery)}</span>`
    )
    .join('');

  return `
    <article class="note-card" data-note-id="${escapeHtml(note.id)}" data-color="${escapeHtml(note.color || 'default')}">
      ${imagesHtml}
      <div class="note-card-header">
        <h3 class="note-card-title">${titleHtml || '<span style="color:var(--text-muted);font-weight:400">Untitled</span>'}</h3>
        <button
          type="button"
          class="icon-btn pin-btn note-card-pin ${note.pinned ? 'active' : ''}"
          data-toggle-pin="${escapeHtml(note.id)}"
          title="${note.pinned ? 'Unpin note' : 'Pin note'}"
          aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 17v5"></path>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
          </svg>
        </button>
      </div>

      ${descHtml ? `<div class="note-card-desc">${descHtml}</div>` : ''}

      ${tagsHtml ? `<div class="note-tags-row">${tagsHtml}</div>` : ''}

      <div class="note-card-footer">
        <span class="note-card-date">Edited ${formatTimestamp(note.updatedAt)}</span>
        <button
          type="button"
          class="icon-btn danger-btn"
          data-delete-note="${escapeHtml(note.id)}"
          title="Delete note"
          aria-label="Delete note"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </article>
  `;
}

export function renderBoardMinimapHtml(
  board: Board,
  searchQuery: string,
  isAllowed: ExternalImageAllowedFn
): string {
  const colorAttr = escapeHtml(board.color || 'default');
  const items = Array.isArray(board.items) ? board.items : [];
  if (items.length === 0) {
    return `<div class="board-card-minimap" data-color="${colorAttr}"><div class="board-minimap-empty">Empty board canvas</div></div>`;
  }

  const originX = items.reduce((m, it) => Math.min(m, it.x), Infinity);
  const originY = items.reduce((m, it) => Math.min(m, it.y), Infinity);
  const sorted = [...items].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  const itemsHtml = sorted
    .map((item) =>
      renderBoardItemHtml(item, searchQuery, {
        minimap: true,
        offsetX: originX,
        offsetY: originY,
        allowExternalUrl: isAllowed,
      })
    )
    .join('');

  return `<div class="board-card-minimap" data-color="${colorAttr}"><div class="board-minimap-world">${itemsHtml}</div></div>`;
}

export function fitBoardMinimaps(): void {
  document.querySelectorAll<HTMLElement>('.board-card-minimap').forEach((container) => {
    const world = container.querySelector<HTMLElement>('.board-minimap-world');
    if (!world) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;

    const itemEls = Array.from(world.children).filter((el): el is HTMLElement =>
      el.classList.contains('board-item')
    );
    if (itemEls.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of itemEls) {
      const w = el.offsetWidth || parseFloat(el.style.width) || 220;
      const h = el.offsetHeight || parseFloat(el.style.height) || 60;
      const x = el.offsetLeft;
      const y = el.offsetTop;
      const rot = parseFloat(el.getAttribute('data-rotation') || '0');
      const aabb = getRotatedRectAabb(x, y, w, h, rot);
      minX = Math.min(minX, aabb.minX);
      minY = Math.min(minY, aabb.minY);
      maxX = Math.max(maxX, aabb.maxX);
      maxY = Math.max(maxY, aabb.maxY);
    }

    const pad = 28;
    const boxMinX = minX - pad;
    const boxMinY = minY - pad;
    const boxW = Math.max(200, maxX - minX + pad * 2);
    const boxH = Math.max(100, maxY - minY + pad * 2);

    const scale = Math.min(cw / boxW, ch / boxH, 0.85);
    const tx = (cw - boxW * scale) / 2 - boxMinX * scale;
    const ty = (ch - boxH * scale) / 2 - boxMinY * scale;
    world.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
  });
}

export function createBoardCardHtml(
  board: Board,
  searchQuery: string,
  isAllowed: ExternalImageAllowedFn
): string {
  const titleHtml = board.title ? highlightText(board.title, searchQuery) : '';
  const tagsHtml = (board.tags || [])
    .map(
      (tag) =>
        `<span class="tag-chip" data-filter-tag="${escapeHtml(tag)}" title="Filter by #${escapeHtml(tag)}">#${highlightText(tag, searchQuery)}</span>`
    )
    .join('');

  const itemCount = board.items.length;

  return `
    <article class="note-card board-card" data-board-id="${escapeHtml(board.id)}" data-color="${escapeHtml(board.color || 'default')}">
      ${renderBoardMinimapHtml(board, searchQuery, isAllowed)}
      <div class="note-card-header">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          <h3 class="note-card-title">${titleHtml || '<span style="color:var(--text-muted);font-weight:400">Untitled Board</span>'}</h3>
          <span class="board-card-badge">Board</span>
        </div>
        <button
          type="button"
          class="icon-btn pin-btn note-card-pin ${board.pinned ? 'active' : ''}"
          data-toggle-board-pin="${escapeHtml(board.id)}"
          title="${board.pinned ? 'Unpin board' : 'Pin board'}"
          aria-label="${board.pinned ? 'Unpin board' : 'Pin board'}"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 17v5"></path>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
          </svg>
        </button>
      </div>

      ${tagsHtml ? `<div class="note-tags-row">${tagsHtml}</div>` : ''}

      <div class="note-card-footer">
        <span class="note-card-date">${itemCount} item${itemCount === 1 ? '' : 's'} &bull; Edited ${formatTimestamp(board.updatedAt)}</span>
        <button
          type="button"
          class="icon-btn danger-btn"
          data-delete-board="${escapeHtml(board.id)}"
          title="Delete board"
          aria-label="Delete board"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </article>
  `;
}
