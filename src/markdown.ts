/**
 * Lightweight note Markdown renderer, checkbox line toggler, and smart list continuation.
 */

import { autoResizeTextarea, escapeHtml, highlightText } from './utils';

export type RenderInlineImageFn = (
  src: string,
  alt: string,
  options: { className?: string; lazy?: boolean }
) => string;

/**
 * Continues `- [ ]`, bullet, and numbered lists on Enter inside note textareas,
 * or exits the list when pressing Enter on an empty list item.
 */
export function handleListEnterKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
    return;
  }

  const textarea = e.currentTarget as HTMLTextAreaElement;
  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const lineBeforeCursor = value.slice(lineStart, start);
  const lineAfterCursor = value.slice(end, lineEnd);

  let nextPrefix: string | null = null;
  let isEmptyItem = false;

  const taskMatch = lineBeforeCursor.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/);
  if (taskMatch) {
    isEmptyItem = (taskMatch[4] ?? '').trim() === '' && lineAfterCursor.trim() === '';
    nextPrefix = `${taskMatch[1] ?? ''}${taskMatch[2] ?? '-'} [ ] `;
  } else {
    const ulMatch = lineBeforeCursor.match(/^(\s*)([-*+•])\s+(.*)$/);
    if (ulMatch) {
      isEmptyItem = (ulMatch[3] ?? '').trim() === '' && lineAfterCursor.trim() === '';
      nextPrefix = `${ulMatch[1] ?? ''}${ulMatch[2] ?? '-'} `;
    } else {
      const olMatch = lineBeforeCursor.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
      if (olMatch) {
        isEmptyItem = (olMatch[4] ?? '').trim() === '' && lineAfterCursor.trim() === '';
        const nextNum = parseInt(olMatch[2] ?? '0', 10) + 1;
        nextPrefix = `${olMatch[1] ?? ''}${nextNum}${olMatch[3] ?? '.'} `;
      }
    }
  }

  if (nextPrefix === null) return;

  e.preventDefault();
  if (isEmptyItem) {
    textarea.value = value.slice(0, lineStart) + value.slice(lineEnd);
    textarea.selectionStart = textarea.selectionEnd = lineStart;
  } else {
    const insertion = `\n${nextPrefix}`;
    textarea.value = value.slice(0, start) + insertion + value.slice(end);
    const nextPos = start + insertion.length;
    textarea.selectionStart = textarea.selectionEnd = nextPos;
  }
  autoResizeTextarea(textarea);
}

/**
 * Toggles a Markdown task checkbox (`- [ ]` <-> `- [x]`) at `lineIndex`.
 * Returns the updated description string, or `null` if the line is not a task item.
 */
export function toggleCheckboxLine(description: string, lineIndex: number): string | null {
  const lines = description.split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) return null;

  const line = lines[lineIndex];
  if (line === undefined) return null;
  const match = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s*.*)$/);
  if (!match) return null;

  const nextState = (match[2] ?? ' ').toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIndex] = `${match[1] ?? ''}${nextState}${match[3] ?? ''}`;
  return lines.join('\n');
}

/**
 * Renders a note's Markdown-lite description (tasks, bullet/ordered lists, inline images, search highlights).
 */
export function renderMarkdownDescription(
  noteId: string,
  text: string,
  query: string,
  renderImage: RenderInlineImageFn
): string {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out: string[] = [];
  let listType: 'ul' | 'ol' | 'task' | null = null;
  let listStart = 1;

  const closeList = (): void => {
    if (!listType) return;
    out.push(listType === 'ol' ? '</ol>' : '</ul>');
    listType = null;
    listStart = 1;
  };

  lines.forEach((rawLine, idx) => {
    const taskMatch = rawLine.match(/^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      if (listType !== 'task') {
        closeList();
        listType = 'task';
        out.push('<ul class="md-list md-task-list">');
      }
      const checked = (taskMatch[2] ?? '').toLowerCase() === 'x';
      const contentHtml = highlightText(taskMatch[3] ?? '', query);
      out.push(
        `<li class="md-task-item">` +
          `<input type="checkbox" class="md-checkbox" data-toggle-checkbox="${escapeHtml(noteId)}" data-line-index="${idx}" ${checked ? 'checked' : ''} aria-label="Toggle task" />` +
          `<span class="${checked ? 'md-task-done' : ''}">${contentHtml}</span>` +
          `</li>`
      );
      return;
    }

    const ulMatch = rawLine.match(/^(\s*)(?:[-*+•])\s+(.*)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        out.push('<ul class="md-list">');
      }
      out.push(`<li>${highlightText(ulMatch[2] ?? '', query)}</li>`);
      return;
    }

    const olMatch = rawLine.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (olMatch) {
      const num = parseInt(olMatch[2] ?? '1', 10);
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        listStart = Number.isFinite(num) && num > 0 ? num : 1;
        const startAttr = listStart !== 1 ? ` start="${listStart}"` : '';
        out.push(`<ol class="md-list"${startAttr}>`);
      }
      out.push(`<li>${highlightText(olMatch[3] ?? '', query)}</li>`);
      return;
    }

    closeList();
    const imgMatch = rawLine
      .trim()
      .match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)$/i);
    if (imgMatch && imgMatch[2]) {
      const altText = imgMatch[1] ?? '';
      const imgSrc = imgMatch[2];
      out.push(
        renderImage(imgSrc, altText || 'Inline note image', {
          className: 'md-inline-image',
          lazy: true,
        })
      );
      return;
    }
    if (rawLine.trim() === '') {
      out.push('<div class="md-spacer"></div>');
    } else {
      out.push(`<div class="md-line">${highlightText(rawLine, query)}</div>`);
    }
  });

  closeList();
  return out.join('');
}
