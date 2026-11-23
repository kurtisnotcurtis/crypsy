/**
 * Crypsy — Board Contextual Selection Bar Controller
 * Owns all 25 selection-bar DOM refs, dynamic group visibility/state updates
 * for text/stroke/tint/rotation/alignment controls, and toolbar button bindings.
 */

import { normalizeAngleDeg } from './board-geometry';
import { renderInkSwatchButtonsHtml } from './board-ink-toolbar';
import type {
  BoardItem,
  BoardStrokeItem,
  BoardTextAlign,
  BoardTextItem,
  NoteColor,
} from './types';
import { byId } from './utils';

export type BoardAlignAxis = 'left' | 'centerX' | 'right' | 'top' | 'centerY';

export interface BoardSelectionBarHost {
  updateColorDots: (pickerEl: HTMLElement, activeColor: NoteColor) => void;
  onAdjustFontSize: (delta: number) => void;
  onToggleBold: () => void;
  onToggleItalic: () => void;
  onSetTextAlign: (align: BoardTextAlign) => void;
  onAdjustStrokeWidth: (delta: number) => void;
  onSetStrokeColor: (color: string) => void;
  onSetColor: (color: NoteColor) => void;
  onRotateBy: (deltaDeg: number) => void;
  onResetRotation: () => void;
  onAlign: (axis: BoardAlignAxis) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

interface SelectionBarElements {
  bar: HTMLElement;
  textGroup: HTMLElement;
  fontDecBtn: HTMLButtonElement;
  fontSizeLabel: HTMLElement;
  fontIncBtn: HTMLButtonElement;
  boldBtn: HTMLButtonElement;
  italicBtn: HTMLButtonElement;
  alignLeftBtn: HTMLButtonElement;
  alignCenterBtn: HTMLButtonElement;
  alignRightBtn: HTMLButtonElement;
  strokeGroup: HTMLElement;
  strokeDecBtn: HTMLButtonElement;
  strokeWidthLabel: HTMLElement;
  strokeIncBtn: HTMLButtonElement;
  strokeColorPicker: HTMLElement;
  colorGroup: HTMLElement;
  colorPicker: HTMLElement;
  rotateLeftBtn: HTMLButtonElement;
  rotationLabel: HTMLButtonElement;
  rotateRightBtn: HTMLButtonElement;
  multiAlignGroup: HTMLElement;
  sendBackBtn: HTMLButtonElement;
  bringFrontBtn: HTMLButtonElement;
  duplicateBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
}

export class BoardSelectionBar {
  private readonly host: BoardSelectionBarHost;
  private readonly els: SelectionBarElements;

  constructor(host: BoardSelectionBarHost) {
    this.host = host;
    this.els = {
      bar: byId('boardSelectionBar'),
      textGroup: byId('boardSelTextGroup'),
      fontDecBtn: byId<HTMLButtonElement>('boardSelFontDecBtn'),
      fontSizeLabel: byId('boardSelFontSizeLabel'),
      fontIncBtn: byId<HTMLButtonElement>('boardSelFontIncBtn'),
      boldBtn: byId<HTMLButtonElement>('boardSelBoldBtn'),
      italicBtn: byId<HTMLButtonElement>('boardSelItalicBtn'),
      alignLeftBtn: byId<HTMLButtonElement>('boardSelAlignLeftBtn'),
      alignCenterBtn: byId<HTMLButtonElement>('boardSelAlignCenterBtn'),
      alignRightBtn: byId<HTMLButtonElement>('boardSelAlignRightBtn'),
      strokeGroup: byId('boardSelStrokeGroup'),
      strokeDecBtn: byId<HTMLButtonElement>('boardSelStrokeDecBtn'),
      strokeWidthLabel: byId('boardSelStrokeWidthLabel'),
      strokeIncBtn: byId<HTMLButtonElement>('boardSelStrokeIncBtn'),
      strokeColorPicker: byId('boardSelStrokeColorPicker'),
      colorGroup: byId('boardSelColorGroup'),
      colorPicker: byId('boardSelColorPicker'),
      rotateLeftBtn: byId<HTMLButtonElement>('boardSelRotateLeftBtn'),
      rotationLabel: byId<HTMLButtonElement>('boardSelRotationLabel'),
      rotateRightBtn: byId<HTMLButtonElement>('boardSelRotateRightBtn'),
      multiAlignGroup: byId('boardSelMultiAlignGroup'),
      sendBackBtn: byId<HTMLButtonElement>('boardSelSendBackBtn'),
      bringFrontBtn: byId<HTMLButtonElement>('boardSelBringFrontBtn'),
      duplicateBtn: byId<HTMLButtonElement>('boardSelDuplicateBtn'),
      deleteBtn: byId<HTMLButtonElement>('boardSelDeleteBtn'),
    };

    this.els.strokeColorPicker.innerHTML = renderInkSwatchButtonsHtml(true);
    this.bindEvents();
  }

  public hide(): void {
    this.els.bar.classList.add('hidden');
  }

  public update(selectedItems: BoardItem[]): void {
    if (selectedItems.length === 0) {
      this.hide();
      return;
    }

    this.els.bar.classList.remove('hidden');
    const textItems = selectedItems.filter((it): it is BoardTextItem => it.type === 'text');
    const strokeItems = selectedItems.filter((it): it is BoardStrokeItem => it.type === 'stroke');
    const allStrokes = strokeItems.length > 0 && strokeItems.length === selectedItems.length;

    if (textItems.length > 0 && textItems.length === selectedItems.length) {
      this.els.textGroup.classList.remove('hidden');
      const primary = textItems[0]!;
      this.els.fontSizeLabel.textContent = `${primary.fontSize || 15}px`;
      this.els.boldBtn.classList.toggle('active', Boolean(primary.bold));
      this.els.italicBtn.classList.toggle('active', Boolean(primary.italic));
      this.els.alignLeftBtn.classList.toggle('active', (primary.align || 'left') === 'left');
      this.els.alignCenterBtn.classList.toggle('active', primary.align === 'center');
      this.els.alignRightBtn.classList.toggle('active', primary.align === 'right');
    } else {
      this.els.textGroup.classList.add('hidden');
    }

    if (allStrokes) {
      this.els.strokeGroup.classList.remove('hidden');
      this.els.colorGroup.classList.add('hidden');
      const primaryStroke = strokeItems[0]!;
      this.els.strokeWidthLabel.textContent = `${primaryStroke.strokeWidth}px`;
      this.els.strokeColorPicker
        .querySelectorAll<HTMLElement>('[data-ink-color]')
        .forEach((btn) => {
          btn.classList.toggle(
            'active',
            btn.getAttribute('data-ink-color') === primaryStroke.strokeColor
          );
        });
    } else {
      this.els.strokeGroup.classList.add('hidden');
      this.els.colorGroup.classList.remove('hidden');
    }

    const first = selectedItems[0]!;
    this.host.updateColorDots(this.els.colorPicker, first.color || 'default');
    this.els.rotationLabel.textContent = `${normalizeAngleDeg(first.rotation || 0)}°`;
    this.els.multiAlignGroup.classList.toggle('hidden', selectedItems.length < 2);
  }

  private bindEvents(): void {
    this.els.fontDecBtn.addEventListener('click', () => this.host.onAdjustFontSize(-2));
    this.els.fontIncBtn.addEventListener('click', () => this.host.onAdjustFontSize(2));
    this.els.boldBtn.addEventListener('click', () => this.host.onToggleBold());
    this.els.italicBtn.addEventListener('click', () => this.host.onToggleItalic());

    this.els.alignLeftBtn.addEventListener('click', () => this.host.onSetTextAlign('left'));
    this.els.alignCenterBtn.addEventListener('click', () => this.host.onSetTextAlign('center'));
    this.els.alignRightBtn.addEventListener('click', () => this.host.onSetTextAlign('right'));

    this.els.strokeDecBtn.addEventListener('click', () => this.host.onAdjustStrokeWidth(-1));
    this.els.strokeIncBtn.addEventListener('click', () => this.host.onAdjustStrokeWidth(1));
    this.els.strokeColorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('[data-ink-color]');
      const color = btn?.getAttribute('data-ink-color');
      if (color) this.host.onSetStrokeColor(color);
    });

    this.els.colorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const dot = target?.closest('.color-dot');
      if (!dot) return;
      this.host.onSetColor((dot.getAttribute('data-color') ?? 'default') as NoteColor);
    });

    this.els.rotateLeftBtn.addEventListener('click', () => this.host.onRotateBy(-15));
    this.els.rotateRightBtn.addEventListener('click', () => this.host.onRotateBy(15));
    this.els.rotationLabel.addEventListener('click', () => this.host.onResetRotation());

    this.els.multiAlignGroup.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('[data-board-align]');
      const axis = btn?.getAttribute('data-board-align') as BoardAlignAxis | null;
      if (axis) this.host.onAlign(axis);
    });

    this.els.bringFrontBtn.addEventListener('click', () => this.host.onBringToFront());
    this.els.sendBackBtn.addEventListener('click', () => this.host.onSendToBack());
    this.els.duplicateBtn.addEventListener('click', () => this.host.onDuplicate());
    this.els.deleteBtn.addEventListener('click', () => this.host.onDelete());

    // Prevent toolbar buttons from stealing focus/blurring active text editing
    this.els.bar.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
      }
    });
  }
}
