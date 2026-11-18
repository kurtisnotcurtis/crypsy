/**
 * Crypsy — Shared Accessible Custom Context Menu Controller
 * Supports declarative actions, color swatch rows, viewport collision flipping,
 * keyboard navigation (ArrowUp/Down/Home/End/Enter/Escape), and safe bypasses for
 * editable inputs (spellcheck) and Shift+Right-Click.
 */

import type { NoteColor } from './types';
import { escapeHtml, isEditableElement, maybeById } from './utils';

export type ContextMenuEntry =
  | {
      type: 'action';
      id: string;
      label: string;
      shortcut?: string | undefined;
      danger?: boolean | undefined;
      disabled?: boolean | undefined;
      checked?: boolean | undefined;
      onSelect: () => void | Promise<void>;
    }
  | {
      type: 'color-row';
      label?: string | undefined;
      activeColor: NoteColor;
      onSelectColor: (color: NoteColor) => void | Promise<void>;
    }
  | { type: 'divider' }
  | { type: 'label'; text: string };

const PALETTE_COLORS: Array<{ id: NoteColor; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'coral', label: 'Coral' },
  { id: 'amber', label: 'Amber' },
  { id: 'sage', label: 'Sage' },
  { id: 'teal', label: 'Teal' },
  { id: 'cobalt', label: 'Cobalt' },
  { id: 'plum', label: 'Plum' },
];

export function clampMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8
): { left: number; top: number } {
  let left = clientX;
  if (left + menuWidth > viewportWidth - margin) {
    left = clientX - menuWidth;
  }
  left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - menuWidth - margin)));

  let top = clientY;
  if (top + menuHeight > viewportHeight - margin) {
    top = clientY - menuHeight;
  }
  top = Math.max(margin, Math.min(top, Math.max(margin, viewportHeight - menuHeight - margin)));

  return { left: Math.round(left), top: Math.round(top) };
}

export function shouldBypassCustomContextMenu(
  e: MouseEvent,
  lockOverlayEl?: HTMLElement | null
): boolean {
  if (e.shiftKey) return true;
  if (lockOverlayEl && !lockOverlayEl.classList.contains('hidden')) return true;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return false;
  if (isEditableElement(target)) return true;
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}

export class ContextMenuController {
  private readonly menuEl: HTMLElement | null;
  private entries: ContextMenuEntry[] = [];
  private previousFocus: HTMLElement | null = null;

  constructor(menuId = 'crypsyContextMenu') {
    this.menuEl = maybeById(menuId);
    this.bindEvents();
  }

  public isOpen(): boolean {
    return Boolean(this.menuEl && !this.menuEl.classList.contains('hidden'));
  }

  public containsTarget(target: Node | null): boolean {
    return Boolean(this.menuEl && target && this.menuEl.contains(target));
  }

  public open(clientX: number, clientY: number, entries: ContextMenuEntry[]): void {
    if (!this.menuEl || entries.length === 0) return;

    this.entries = entries;
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    this.menuEl.innerHTML = entries
      .map((entry, idx) => {
        if (entry.type === 'divider') {
          return '<div class="context-menu-divider" role="separator"></div>';
        }
        if (entry.type === 'label') {
          return `<div class="context-menu-section-label">${escapeHtml(entry.text)}</div>`;
        }
        if (entry.type === 'color-row') {
          const dots = PALETTE_COLORS.map(
            (c) =>
              `<button type="button" class="color-dot ${entry.activeColor === c.id ? 'active' : ''}" data-cm-row-idx="${idx}" data-color="${escapeHtml(c.id)}" title="${escapeHtml(c.label)}" aria-label="${escapeHtml(c.label)}"></button>`
          ).join('');
          return `
            <div class="context-menu-colors">
              ${entry.label ? `<span class="context-menu-colors-label">${escapeHtml(entry.label)}</span>` : ''}
              <div class="context-menu-color-dots">${dots}</div>
            </div>
          `;
        }

        const classes = ['context-menu-item'];
        if (entry.danger) classes.push('danger');
        if (entry.checked) classes.push('checked');
        const checkHtml =
          entry.checked !== undefined
            ? `<span class="context-menu-check">${entry.checked ? '&#10003;' : ''}</span>`
            : '';
        const shortcutHtml = entry.shortcut
          ? `<span class="context-menu-shortcut">${escapeHtml(entry.shortcut)}</span>`
          : '';

        return `
          <button
            type="button"
            class="${classes.join(' ')}"
            role="menuitem"
            data-cm-idx="${idx}"
            ${entry.disabled ? 'disabled aria-disabled="true"' : ''}
          >
            ${checkHtml}
            <span class="context-menu-label">${escapeHtml(entry.label)}</span>
            ${shortcutHtml}
          </button>
        `;
      })
      .join('');

    this.menuEl.style.visibility = 'hidden';
    this.menuEl.classList.remove('hidden');

    const rect = this.menuEl.getBoundingClientRect();
    const pos = clampMenuPosition(
      clientX,
      clientY,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight
    );

    this.menuEl.style.left = `${pos.left}px`;
    this.menuEl.style.top = `${pos.top}px`;
    this.menuEl.style.visibility = '';
    this.menuEl.focus({ preventScroll: true });
  }

  public close(restoreFocus = false): void {
    if (!this.menuEl || !this.isOpen()) return;
    this.menuEl.classList.add('hidden');
    this.menuEl.innerHTML = '';
    this.entries = [];

    if (restoreFocus && this.previousFocus && document.contains(this.previousFocus)) {
      this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  }

  public handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.isOpen() || !this.menuEl) return false;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.close(true);
      return true;
    }

    if (e.key === 'Tab') {
      this.close(false);
      return false;
    }

    const items = Array.from(
      this.menuEl.querySelectorAll<HTMLButtonElement>('.context-menu-item:not([disabled])')
    );
    if (items.length === 0) return false;

    const activeIdx = items.findIndex((btn) => btn === document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = activeIdx < 0 ? 0 : (activeIdx + 1) % items.length;
      items[next]?.focus({ preventScroll: true });
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
      items[prev]?.focus({ preventScroll: true });
      return true;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus({ preventScroll: true });
      return true;
    }
    if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus({ preventScroll: true });
      return true;
    }
    if ((e.key === 'Enter' || e.key === ' ') && activeIdx !== -1) {
      e.preventDefault();
      items[activeIdx]?.click();
      return true;
    }

    return false;
  }

  private bindEvents(): void {
    if (!this.menuEl) return;

    this.menuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    this.menuEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const dotBtn = target.closest<HTMLElement>('[data-cm-row-idx]');
      if (dotBtn) {
        const rowIdx = parseInt(dotBtn.getAttribute('data-cm-row-idx') ?? '', 10);
        const color = dotBtn.getAttribute('data-color') as NoteColor | null;
        const entry = this.entries[rowIdx];
        if (entry && entry.type === 'color-row' && color) {
          this.close(false);
          void entry.onSelectColor(color);
        }
        return;
      }

      const itemBtn = target.closest<HTMLButtonElement>('[data-cm-idx]');
      if (!itemBtn || itemBtn.disabled) return;
      const idx = parseInt(itemBtn.getAttribute('data-cm-idx') ?? '', 10);
      const entry = this.entries[idx];
      if (entry && entry.type === 'action' && !entry.disabled) {
        this.close(false);
        void entry.onSelect();
      }
    });

    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.isOpen() && !this.menuEl?.contains(e.target as Node | null)) {
          this.close(false);
        }
      },
      true
    );

    window.addEventListener('blur', () => this.close(false));
    window.addEventListener('resize', () => this.close(false));
    document.addEventListener(
      'scroll',
      (e) => {
        if (this.isOpen() && !this.menuEl?.contains(e.target as Node | null)) {
          this.close(false);
        }
      },
      true
    );
    document.addEventListener(
      'wheel',
      () => {
        if (this.isOpen()) this.close(false);
      },
      { passive: true, capture: true }
    );
  }
}
