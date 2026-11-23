/**
 * Crypsy — Board Drawing & Ink Toolbar Controller
 * Owns tool selection (Select, Lasso, Eraser, Pen/Highlighter slots),
 * touch-draw mode, ink preset customization popover, and swatch pickers.
 */

import { AUTO_INK_TOKEN, INK_SWATCHES } from './ink';
import type { BoardInkTool } from './types';
import { byId } from './utils';

export type BoardActiveTool = 'select' | 'lasso' | 'eraser' | 'pen' | 'highlighter';

export interface InkPreset {
  slot: number;
  tool: BoardInkTool;
  color: string;
  width: number;
  opacity: number;
}

export interface BoardInkToolbarHost {
  viewport: HTMLElement;
  onBeforeToolChange: () => void;
  onCloseAllPopovers: () => void;
  onShowHint: (message: string) => void;
}

interface InkToolbarElements {
  drawRack: HTMLElement;
  toolSelectBtn: HTMLButtonElement;
  toolLassoBtn: HTMLButtonElement;
  toolEraserBtn: HTMLButtonElement;
  penSlot0Btn: HTMLButtonElement;
  penSlot1Btn: HTMLButtonElement;
  penSlot2Btn: HTMLButtonElement;
  highlighterSlotBtn: HTMLButtonElement;
  touchDrawBtn: HTMLButtonElement;
  inkPopover: HTMLElement;
  inkPopoverTitle: HTMLElement;
  inkWidthLabel: HTMLElement;
  inkWidthRange: HTMLInputElement;
  inkWidthQuick: HTMLElement;
  inkColorSwatches: HTMLElement;
}

export function renderInkSwatchButtonsHtml(includeAuto: boolean): string {
  return INK_SWATCHES.filter((s) => includeAuto || s.color !== AUTO_INK_TOKEN)
    .map(
      (s) =>
        `<button type="button" class="ink-swatch-btn" data-ink-color="${s.color}" title="${s.label}" aria-label="${s.label}"${
          s.color === AUTO_INK_TOKEN ? '' : ` style="background:${s.color};"`
        }></button>`
    )
    .join('');
}

export class BoardInkToolbar {
  private readonly host: BoardInkToolbarHost;
  private readonly els: InkToolbarElements;

  private activeTool: BoardActiveTool = 'select';
  private activeInkSlot = 0;
  private editingInkSlot = 0;
  private touchDrawEnabled = false;
  private readonly presets: InkPreset[] = [
    { slot: 0, tool: 'pen', color: AUTO_INK_TOKEN, width: 3, opacity: 1 },
    { slot: 1, tool: 'pen', color: '#4285f4', width: 3, opacity: 1 },
    { slot: 2, tool: 'pen', color: '#ea4335', width: 4.5, opacity: 1 },
    { slot: 3, tool: 'highlighter', color: '#fbbc04', width: 18, opacity: 0.42 },
  ];

  constructor(host: BoardInkToolbarHost) {
    this.host = host;
    this.els = {
      drawRack: byId('boardDrawRack'),
      toolSelectBtn: byId<HTMLButtonElement>('boardToolSelectBtn'),
      toolLassoBtn: byId<HTMLButtonElement>('boardToolLassoBtn'),
      toolEraserBtn: byId<HTMLButtonElement>('boardToolEraserBtn'),
      penSlot0Btn: byId<HTMLButtonElement>('boardPenSlot0Btn'),
      penSlot1Btn: byId<HTMLButtonElement>('boardPenSlot1Btn'),
      penSlot2Btn: byId<HTMLButtonElement>('boardPenSlot2Btn'),
      highlighterSlotBtn: byId<HTMLButtonElement>('boardHighlighterSlotBtn'),
      touchDrawBtn: byId<HTMLButtonElement>('boardTouchDrawBtn'),
      inkPopover: byId('boardInkPopover'),
      inkPopoverTitle: byId('boardInkPopoverTitle'),
      inkWidthLabel: byId('boardInkWidthLabel'),
      inkWidthRange: byId<HTMLInputElement>('boardInkWidthRange'),
      inkWidthQuick: byId('boardInkWidthQuick'),
      inkColorSwatches: byId('boardInkColorSwatches'),
    };

    this.els.inkColorSwatches.innerHTML = renderInkSwatchButtonsHtml(true);
    this.updateUi();
    this.bindEvents();
  }

  public getActiveTool(): BoardActiveTool {
    return this.activeTool;
  }

  public isTouchDrawEnabled(): boolean {
    return this.touchDrawEnabled;
  }

  public getActivePreset(): InkPreset {
    return this.presets[this.activeInkSlot] ?? this.presets[0]!;
  }

  public isPopoverOpen(): boolean {
    return !this.els.inkPopover.classList.contains('hidden');
  }

  public closePopover(): void {
    this.els.inkPopover.classList.add('hidden');
  }

  public closePopoverIfOutside(target: Node | null): void {
    if (
      target &&
      !this.els.inkPopover.contains(target) &&
      !this.els.drawRack.contains(target)
    ) {
      this.closePopover();
    }
  }

  public setActiveTool(tool: BoardActiveTool, slotIndex?: number): void {
    if (slotIndex !== undefined && this.presets[slotIndex]) {
      this.activeInkSlot = slotIndex;
    }
    this.activeTool = tool;
    this.updateUi();
  }

  public updateUi(): void {
    this.els.toolSelectBtn.classList.toggle('active', this.activeTool === 'select');
    this.els.toolLassoBtn.classList.toggle('active', this.activeTool === 'lasso');
    this.els.toolEraserBtn.classList.toggle('active', this.activeTool === 'eraser');
    this.els.touchDrawBtn.classList.toggle('active', this.touchDrawEnabled);

    const presetBtns = [
      this.els.penSlot0Btn,
      this.els.penSlot1Btn,
      this.els.penSlot2Btn,
      this.els.highlighterSlotBtn,
    ];
    for (let i = 0; i < this.presets.length; i++) {
      const preset = this.presets[i]!;
      const btn = presetBtns[i];
      if (!btn) continue;
      const isActive =
        (this.activeTool === 'pen' || this.activeTool === 'highlighter') &&
        this.activeInkSlot === i;
      btn.classList.toggle('active', isActive);
      const swatchEl = btn.querySelector<HTMLElement>('[data-swatch-slot]');
      if (swatchEl) {
        swatchEl.setAttribute('data-ink-token', preset.color);
        swatchEl.style.background = preset.color === AUTO_INK_TOKEN ? '' : preset.color;
      }
    }

    this.host.viewport.setAttribute('data-tool', this.activeTool);
  }

  private openPopoverForSlot(slot: number): void {
    const preset = this.presets[slot];
    if (!preset) return;
    this.host.onCloseAllPopovers();
    this.editingInkSlot = slot;
    this.els.inkPopoverTitle.textContent =
      preset.tool === 'highlighter' ? 'Customize Highlighter' : `Customize Pen ${slot + 1}`;
    this.els.inkWidthRange.min = preset.tool === 'highlighter' ? '10' : '1.5';
    this.els.inkWidthRange.max = preset.tool === 'highlighter' ? '32' : '10';
    this.els.inkWidthRange.step = preset.tool === 'highlighter' ? '2' : '0.5';
    this.els.inkWidthRange.value = String(preset.width);
    this.els.inkWidthLabel.textContent = `${preset.width}px`;

    const quickWidths = preset.tool === 'highlighter' ? [12, 18, 24, 30] : [1.5, 3, 5, 8];
    this.els.inkWidthQuick.innerHTML = quickWidths
      .map(
        (w) =>
          `<button type="button" class="tool-btn${preset.width === w ? ' active' : ''}" data-ink-quick-w="${w}">${w}px</button>`
      )
      .join('');

    this.els.inkColorSwatches.querySelectorAll<HTMLElement>('[data-ink-color]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-ink-color') === preset.color);
    });
    this.els.inkPopover.classList.remove('hidden');
  }

  private bindEvents(): void {
    this.els.drawRack.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      const toolBtn = target?.closest<HTMLElement>('[data-board-tool]');
      if (toolBtn) {
        const nextTool = toolBtn.getAttribute('data-board-tool') as BoardActiveTool | null;
        if (nextTool === 'select' || nextTool === 'lasso' || nextTool === 'eraser') {
          this.host.onBeforeToolChange();
          this.host.onCloseAllPopovers();
          this.setActiveTool(nextTool);
        }
        return;
      }

      const slotBtn = target?.closest<HTMLElement>('[data-ink-slot]');
      if (slotBtn) {
        const slot = Number(slotBtn.getAttribute('data-ink-slot'));
        const preset = this.presets[slot];
        if (!preset) return;
        const alreadyActive =
          (this.activeTool === 'pen' || this.activeTool === 'highlighter') &&
          this.activeInkSlot === slot;
        if (alreadyActive) {
          if (this.els.inkPopover.classList.contains('hidden')) {
            this.openPopoverForSlot(slot);
          } else {
            this.host.onCloseAllPopovers();
          }
        } else {
          this.host.onBeforeToolChange();
          this.host.onCloseAllPopovers();
          this.setActiveTool(preset.tool, slot);
        }
      }
    });

    this.els.touchDrawBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.touchDrawEnabled = !this.touchDrawEnabled;
      this.updateUi();
      this.host.onShowHint(
        this.touchDrawEnabled
          ? 'Touch Draw ON: Single finger draws ink.'
          : 'Touch Draw OFF: Single finger pans; use stylus or Pen tool to draw.'
      );
    });

    this.els.inkWidthRange.addEventListener('input', () => {
      const preset = this.presets[this.editingInkSlot];
      if (!preset) return;
      const val = parseFloat(this.els.inkWidthRange.value);
      if (Number.isFinite(val)) {
        preset.width = val;
        this.els.inkWidthLabel.textContent = `${val}px`;
        this.els.inkWidthQuick.querySelectorAll<HTMLElement>('[data-ink-quick-w]').forEach((b) => {
          b.classList.toggle('active', parseFloat(b.getAttribute('data-ink-quick-w') || '') === val);
        });
      }
    });

    this.els.inkWidthQuick.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-ink-quick-w]');
      const preset = this.presets[this.editingInkSlot];
      if (!btn || !preset) return;
      const val = parseFloat(btn.getAttribute('data-ink-quick-w') || '');
      if (Number.isFinite(val)) {
        preset.width = val;
        this.els.inkWidthRange.value = String(val);
        this.els.inkWidthLabel.textContent = `${val}px`;
        this.els.inkWidthQuick.querySelectorAll<HTMLElement>('[data-ink-quick-w]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
      }
    });

    this.els.inkColorSwatches.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-ink-color]');
      const preset = this.presets[this.editingInkSlot];
      const color = btn?.getAttribute('data-ink-color');
      if (!btn || !preset || !color) return;
      preset.color = color;
      this.els.inkColorSwatches.querySelectorAll<HTMLElement>('[data-ink-color]').forEach((el) => {
        el.classList.toggle('active', el === btn);
      });
      this.updateUi();
    });
  }
}
