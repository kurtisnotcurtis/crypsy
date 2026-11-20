/**
 * Crypsy — Free-Form Spatial Board Editor
 * Supports pannable/zoomable dot-grid canvas, click-anywhere text boxes,
 * move/resize/rotate/align transforms, clipboard image & link pasting,
 * drag-and-drop image insertion, and in-session undo/redo.
 */

import {
  type ContextMenuController,
  type ContextMenuEntry,
  shouldBypassCustomContextMenu,
} from './context-menu';
import {
  AUTO_INK_TOKEN,
  INK_SWATCHES,
  type StrokePoint,
  computePointPressure,
  lassoSelectsRect,
  lassoSelectsStroke,
  normalizeRawStroke,
  renderStrokeToCanvas2d,
  resolveLiveInkColor,
  segmentHitsStroke,
} from './ink';
import {
  extractClipboardImages,
  extractImageUrlFromClipboardHtml,
  extractStandaloneImageUrl,
  extractStandaloneWebUrl,
  noteImageFromFile,
  noteImageFromUrl,
} from './media';
import type {
  Board,
  BoardGridStyle,
  BoardImageItem,
  BoardInkTool,
  BoardItem,
  BoardLinkItem,
  BoardStrokeItem,
  BoardTextAlign,
  BoardTextItem,
  NoteColor,
  NoteImage,
} from './types';
import {
  autoResizeTextarea,
  byId,
  escapeHtml,
  getRotatedRectAabb,
  isEditableElement,
  maybeById,
  renderBoardItemHtml,
} from './utils';

export interface BoardEditorHost {
  getBoard: () => Board | null;
  getSearchQuery: () => string;
  getAllTags: () => string[];
  contextMenu: ContextMenuController;
  isLocked: () => boolean;
  onAddTagToVault: (tag: string) => void;
  renderTagPopoverOptions: (
    container: HTMLElement,
    searchValue: string,
    selectedTags: string[],
    onToggleTag: (tag: string) => void
  ) => void;
  updateColorDots: (pickerEl: HTMLElement, activeColor: NoteColor) => void;
  onBoardMutated: (board: Board, immediate?: boolean) => void;
  onDeleteBoard: (boardId: string) => void;
  onCloseBoard: () => void;
  onOpenLightbox: (src: string) => void;
  isExternalImageAllowed?: (url: string) => boolean;
  onAllowExternalUrl?: (url: string) => void;
}

type HandleDir = 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e' | 'rotate';
type BoardActiveTool = 'select' | 'lasso' | 'eraser' | 'pen' | 'highlighter';

interface InkPreset {
  slot: number;
  tool: BoardInkTool;
  color: string;
  width: number;
  opacity: number;
}

const GRID_STYLES: readonly BoardGridStyle[] = ['dots', 'grid', 'ruled', 'blank'];
const GRID_STYLE_LABELS: Record<BoardGridStyle, string> = {
  dots: 'Dots',
  grid: 'Grid',
  ruled: 'Ruled',
  blank: 'Blank',
};

interface ItemMetrics {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

type ActiveGesture =
  | {
      kind: 'pan';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
    }
  | {
      kind: 'move';
      pointerId: number;
      startCanvasX: number;
      startCanvasY: number;
      moved: boolean;
      enterEditOnClick: boolean;
      snapshots: Map<string, { x: number; y: number }>;
    }
  | {
      kind: 'resize';
      pointerId: number;
      itemId: string;
      handle: Exclude<HandleDir, 'rotate'>;
      startCanvasX: number;
      startCanvasY: number;
      startMetrics: ItemMetrics;
      aspectRatio: number;
      isImage: boolean;
      moved: boolean;
    }
  | {
      kind: 'rotate';
      pointerId: number;
      itemId: string;
      centerX: number;
      centerY: number;
      startAngleRad: number;
      startRotationDeg: number;
      moved: boolean;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startCanvasX: number;
      startCanvasY: number;
      additive: boolean;
      moved: boolean;
    }
  | {
      kind: 'draw';
      pointerId: number;
      pointerType: string;
      tool: BoardInkTool;
      strokeColor: string;
      strokeWidth: number;
      opacity: number;
      rawPoints: StrokePoint[];
      lastTime: number;
      lastPressure: number;
      startPt: { x: number; y: number };
      straightLinePt: { x: number; y: number } | null;
    }
  | {
      kind: 'erase';
      pointerId: number;
      prevCanvasPt: { x: number; y: number };
      erasedAny: boolean;
      undoPushed: boolean;
    }
  | {
      kind: 'lasso';
      pointerId: number;
      points: [number, number][];
      additive: boolean;
    }
  | {
      kind: 'pinch';
      pointerIds: [number, number];
      startDist: number;
      startCanvasMidX: number;
      startCanvasMidY: number;
      startZoom: number;
    };

const GRID_STEP = 16;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const MAX_UNDO_HISTORY = 40;

function createItemId(): string {
  return `bi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function normalizeAngleDeg(deg: number): number {
  let a = Math.round(deg) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a === 0 ? 0 : a;
}

function cloneItems(items: BoardItem[]): BoardItem[] {
  return JSON.parse(JSON.stringify(items)) as BoardItem[];
}

export class BoardEditorController {
  private readonly host: BoardEditorHost;
  private readonly els = {
    backdrop: byId('boardEditorBackdrop'),
    shell: byId('boardEditorShell'),
    closeBtn: byId<HTMLButtonElement>('boardCloseBtn'),
    titleInput: byId<HTMLInputElement>('boardTitleInput'),
    pinBtn: byId<HTMLButtonElement>('boardPinBtn'),
    tagBtn: byId<HTMLButtonElement>('boardTagBtn'),
    tagPopover: byId('boardTagPopover'),
    tagSearch: byId<HTMLInputElement>('boardTagSearch'),
    tagOptions: byId('boardTagOptions'),
    tagsRow: byId('boardTagsRow'),
    colorPicker: byId('boardColorPicker'),
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
    addTextBtn: byId<HTMLButtonElement>('boardAddTextBtn'),
    addImageBtn: byId<HTMLButtonElement>('boardAddImageBtn'),
    imagePopover: byId('boardImagePopover'),
    uploadImageBtn: byId<HTMLButtonElement>('boardUploadImageBtn'),
    imageFileInput: byId<HTMLInputElement>('boardImageFileInput'),
    imageUrlInput: byId<HTMLInputElement>('boardImageUrlInput'),
    confirmImageUrlBtn: byId<HTMLButtonElement>('boardConfirmImageUrlBtn'),
    imageStatus: byId('boardImageStatus'),
    addLinkBtn: byId<HTMLButtonElement>('boardAddLinkBtn'),
    linkPopover: byId('boardLinkPopover'),
    linkUrlInput: byId<HTMLInputElement>('boardLinkUrlInput'),
    linkLabelInput: byId<HTMLInputElement>('boardLinkLabelInput'),
    linkError: byId('boardLinkError'),
    confirmLinkBtn: byId<HTMLButtonElement>('boardConfirmLinkBtn'),
    undoBtn: byId<HTMLButtonElement>('boardUndoBtn'),
    redoBtn: byId<HTMLButtonElement>('boardRedoBtn'),
    snapBtn: byId<HTMLButtonElement>('boardSnapBtn'),
    paperBtn: byId<HTMLButtonElement>('boardPaperBtn'),
    zoomOutBtn: byId<HTMLButtonElement>('boardZoomOutBtn'),
    zoomResetBtn: byId<HTMLButtonElement>('boardZoomResetBtn'),
    zoomInBtn: byId<HTMLButtonElement>('boardZoomInBtn'),
    fitBtn: byId<HTMLButtonElement>('boardFitBtn'),
    deleteBtn: byId<HTMLButtonElement>('boardDeleteBtn'),

    selectionBar: byId('boardSelectionBar'),
    selTextGroup: byId('boardSelTextGroup'),
    selFontDecBtn: byId<HTMLButtonElement>('boardSelFontDecBtn'),
    selFontSizeLabel: byId('boardSelFontSizeLabel'),
    selFontIncBtn: byId<HTMLButtonElement>('boardSelFontIncBtn'),
    selBoldBtn: byId<HTMLButtonElement>('boardSelBoldBtn'),
    selItalicBtn: byId<HTMLButtonElement>('boardSelItalicBtn'),
    selAlignLeftBtn: byId<HTMLButtonElement>('boardSelAlignLeftBtn'),
    selAlignCenterBtn: byId<HTMLButtonElement>('boardSelAlignCenterBtn'),
    selAlignRightBtn: byId<HTMLButtonElement>('boardSelAlignRightBtn'),
    selStrokeGroup: byId('boardSelStrokeGroup'),
    selStrokeDecBtn: byId<HTMLButtonElement>('boardSelStrokeDecBtn'),
    selStrokeWidthLabel: byId('boardSelStrokeWidthLabel'),
    selStrokeIncBtn: byId<HTMLButtonElement>('boardSelStrokeIncBtn'),
    selStrokeColorPicker: byId('boardSelStrokeColorPicker'),
    selColorGroup: byId('boardSelColorGroup'),
    selColorPicker: byId('boardSelColorPicker'),
    selRotateLeftBtn: byId<HTMLButtonElement>('boardSelRotateLeftBtn'),
    selRotationLabel: byId<HTMLButtonElement>('boardSelRotationLabel'),
    selRotateRightBtn: byId<HTMLButtonElement>('boardSelRotateRightBtn'),
    selMultiAlignGroup: byId('boardSelMultiAlignGroup'),
    selSendBackBtn: byId<HTMLButtonElement>('boardSelSendBackBtn'),
    selBringFrontBtn: byId<HTMLButtonElement>('boardSelBringFrontBtn'),
    selDuplicateBtn: byId<HTMLButtonElement>('boardSelDuplicateBtn'),
    selDeleteBtn: byId<HTMLButtonElement>('boardSelDeleteBtn'),

    viewport: byId('boardCanvasViewport'),
    world: byId('boardCanvasWorld'),
    itemsLayer: byId('boardItemsLayer'),
    selectionOverlay: byId('boardSelectionOverlay'),
    inkLiveCanvas: byId<HTMLCanvasElement>('boardInkLiveCanvas'),
    marqueeRect: byId('boardMarqueeRect'),
    canvasHint: maybeById('boardCanvasHint'),
  };

  private selectedIds = new Set<string>();
  private editingItemId: string | null = null;
  private editingLinkLabelId: string | null = null;
  private snapToGrid = false;
  private spacePressed = false;
  private activeTool: BoardActiveTool = 'select';
  private activeInkSlot = 0;
  private editingInkSlot = 0;
  private touchDrawEnabled = false;
  private activeTouchPoints = new Map<number, { clientX: number; clientY: number }>();
  private longPressState: {
    timerId: number;
    pointerId: number;
    startClientX: number;
    startClientY: number;
  } | null = null;
  private inkPresets: InkPreset[] = [
    { slot: 0, tool: 'pen', color: AUTO_INK_TOKEN, width: 3, opacity: 1 },
    { slot: 1, tool: 'pen', color: '#4285f4', width: 3, opacity: 1 },
    { slot: 2, tool: 'pen', color: '#ea4335', width: 4.5, opacity: 1 },
    { slot: 3, tool: 'highlighter', color: '#fbbc04', width: 18, opacity: 0.42 },
  ];
  private lastCanvasCursor: { x: number; y: number } | null = null;
  private gesture: ActiveGesture | null = null;
  private isRenderingItems = false;
  private undoStack: BoardItem[][] = [];
  private redoStack: BoardItem[][] = [];
  private copiedItems: BoardItem[] = [];
  private lastCopiedSummary = '';
  private hintResetTimer: number | null = null;
  private defaultCanvasHint =
    'Click anywhere to type • Draw directly with stylus or Pen tool • Drag border to move • Ctrl+V to paste image or link';

  constructor(host: BoardEditorHost) {
    this.host = host;
    this.initInkPickers();
    this.updateDrawToolbarUi();
    this.bindEvents();
  }

  public isOpen(): boolean {
    return !this.els.backdrop.classList.contains('hidden');
  }

  public isGestureActive(): boolean {
    return this.gesture !== null;
  }

  private clearLongPressTimer(): void {
    if (this.longPressState) {
      window.clearTimeout(this.longPressState.timerId);
      this.longPressState = null;
    }
  }

  private openContextMenuForTarget(
    board: Board,
    clientX: number,
    clientY: number,
    target: HTMLElement | null
  ): void {
    this.closePopovers();
    let itemEl = target?.closest<HTMLElement>('[data-board-item-id]') ?? null;
    if (!itemEl && target?.closest('#boardSelectionOverlay') && this.selectedIds.size === 1) {
      const onlyId = Array.from(this.selectedIds)[0];
      itemEl = onlyId ? this.getItemElement(onlyId) : null;
    }

    const pt = this.clientToCanvas(clientX, clientY, board);
    if (itemEl) {
      const itemId = itemEl.getAttribute('data-board-item-id');
      const item = board.items.find((it) => it.id === itemId);
      if (item) {
        this.commitActiveTextEdit(item.id);
        if (!this.selectedIds.has(item.id)) {
          this.selectedIds = new Set([item.id]);
        }
        this.renderItems();
        this.updateSelectionBar();
        this.openItemContextMenu(clientX, clientY, board);
        return;
      }
    }

    this.lastCanvasCursor = { x: pt.x, y: pt.y };
    this.commitActiveTextEdit();
    this.selectedIds.clear();
    this.renderItems();
    this.updateSelectionBar();
    this.openCanvasContextMenu(clientX, clientY, board, pt);
  }

  public open(board: Board): void {
    this.selectedIds.clear();
    this.editingItemId = null;
    this.editingLinkLabelId = null;
    this.gesture = null;
    this.activeTouchPoints.clear();
    this.clearLongPressTimer();
    this.clearLiveCanvas();
    this.undoStack = [];
    this.redoStack = [];
    this.lastCanvasCursor = null;
    if (this.els.canvasHint?.textContent) {
      this.defaultCanvasHint = this.els.canvasHint.textContent;
    }

    this.els.titleInput.value = board.title;
    this.els.shell.setAttribute('data-color', board.color || 'default');
    this.els.pinBtn.classList.toggle('active', board.pinned);
    this.host.updateColorDots(this.els.colorPicker, board.color || 'default');

    this.host.contextMenu.close();
    this.closePopovers();
    this.els.backdrop.classList.remove('hidden');
    this.renderBoardMeta(board);
    this.updateDrawToolbarUi();
    this.applyViewport(board);
    this.renderItems();
    this.updateSelectionBar();
    this.updateHistoryButtons();
    this.els.viewport.focus();
  }

  public close(): void {
    this.commitActiveTextEdit();
    this.selectedIds.clear();
    this.editingItemId = null;
    this.editingLinkLabelId = null;
    this.gesture = null;
    this.undoStack = [];
    this.redoStack = [];
    this.activeTouchPoints.clear();
    this.clearLongPressTimer();
    this.clearLiveCanvas();
    this.els.itemsLayer.innerHTML = '';
    this.els.titleInput.value = '';
    this.els.tagsRow.innerHTML = '';
    this.updateHistoryButtons();
    this.host.contextMenu.close();
    this.closePopovers();
    this.els.backdrop.classList.add('hidden');
    this.host.onCloseBoard();
  }

  /**
   * Clears all decrypted board snapshots, clipboard copies, and DOM nodes from memory on lock.
   */
  public clearSensitiveMemory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.copiedItems = [];
    this.lastCopiedSummary = '';
    this.selectedIds.clear();
    this.editingItemId = null;
    this.editingLinkLabelId = null;
    this.gesture = null;
    this.activeTouchPoints.clear();
    this.clearLongPressTimer();
    this.clearLiveCanvas();
    this.els.itemsLayer.innerHTML = '';
    this.els.titleInput.value = '';
    this.els.tagsRow.innerHTML = '';
    this.updateHistoryButtons();
    this.updateSelectionBar();
    this.els.backdrop.classList.add('hidden');
  }

  public refreshFromExternal(): void {
    if (!this.isOpen() || this.gesture || this.editingItemId) return;
    const board = this.host.getBoard();
    if (!board) {
      this.close();
      return;
    }
    this.els.titleInput.value = board.title;
    this.els.shell.setAttribute('data-color', board.color || 'default');
    this.els.pinBtn.classList.toggle('active', board.pinned);
    this.host.updateColorDots(this.els.colorPicker, board.color || 'default');
    this.renderBoardMeta(board);
    this.applyViewport(board);
    this.renderItems();
    this.updateSelectionOverlay();
    this.updateSelectionBar();
  }

  /**
   * Handles Escape key precedence inside the Board Editor. Returns true if consumed.
   */
  public handleEscapeKey(): boolean {
    if (!this.isOpen()) return false;

    if (
      !this.els.tagPopover.classList.contains('hidden') ||
      !this.els.imagePopover.classList.contains('hidden') ||
      !this.els.linkPopover.classList.contains('hidden') ||
      !this.els.inkPopover.classList.contains('hidden')
    ) {
      this.closePopovers();
      return true;
    }

    if (this.editingItemId || this.editingLinkLabelId) {
      this.commitActiveTextEdit();
      this.renderItems();
      this.updateSelectionOverlay();
      this.updateSelectionBar();
      return true;
    }

    if (this.selectedIds.size > 0) {
      this.selectedIds.clear();
      this.renderItems();
      this.updateSelectionOverlay();
      this.updateSelectionBar();
      return true;
    }

    if (this.activeTool !== 'select') {
      this.setActiveTool('select');
      return true;
    }

    this.close();
    return true;
  }

  /**
   * Handles keyboard shortcuts (Delete, Ctrl+Z/Y, Ctrl+D) when Board Editor is open.
   */
  public handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.isOpen()) return false;

    if (e.code === 'Space' && !isEditableElement(document.activeElement)) {
      if (!this.spacePressed) {
        this.spacePressed = true;
        this.els.viewport.classList.add('space-pan');
      }
      e.preventDefault();
      return true;
    }

    const editingText = isEditableElement(document.activeElement);
    if (editingText) return false;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return true;
    }
    if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      this.redo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd' && this.selectedIds.size > 0) {
      e.preventDefault();
      this.duplicateSelected();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectAll();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'c' && this.selectedIds.size > 0) {
      e.preventDefault();
      this.copySelected();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'x' && this.selectedIds.size > 0) {
      e.preventDefault();
      this.cutSelected();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedIds.size > 0) {
      e.preventDefault();
      this.deleteSelected();
      return true;
    }

    return false;
  }

  public handleKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space' && this.spacePressed) {
      this.spacePressed = false;
      this.els.viewport.classList.remove('space-pan');
    }
  }

  /**
   * Handles clipboard paste (images, image URLs, web links) onto the open Board canvas.
   */
  public async handlePaste(e: ClipboardEvent): Promise<boolean> {
    if (!this.isOpen()) return false;
    const board = this.host.getBoard();
    if (!board) return false;

    const active = document.activeElement;
    if (
      active === this.els.titleInput ||
      active === this.els.tagSearch ||
      active === this.els.imageUrlInput ||
      active === this.els.linkUrlInput ||
      active === this.els.linkLabelInput
    ) {
      return false;
    }

    const cd = e.clipboardData;
    if (!cd) return false;

    const images = extractClipboardImages(cd);
    if (images.length > 0) {
      e.preventDefault();
      const pos = this.getInsertCanvasPoint(board);
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        if (!file) continue;
        try {
          const noteImg = await noteImageFromFile(file);
          await this.insertImageItem(noteImg, pos.x + i * 24, pos.y + i * 24);
        } catch (err) {
          console.warn('Could not paste image onto board:', err);
        }
      }
      return true;
    }

    // If actively editing inside a text box, let plain-text / URL paste go into the textarea normally
    if (this.editingItemId || this.editingLinkLabelId) {
      return false;
    }

    const plainText = cd.getData('text/plain');
    const htmlData = cd.getData('text/html');

    if (
      this.copiedItems.length > 0 &&
      ((this.lastCopiedSummary && plainText === this.lastCopiedSummary) ||
        (!plainText.trim() && !extractImageUrlFromClipboardHtml(htmlData)))
    ) {
      e.preventDefault();
      const pos = this.getInsertCanvasPoint(board);
      this.pasteCopiedItemsAt(board, pos.x, pos.y);
      return true;
    }

    const imgUrl = extractStandaloneImageUrl(plainText);
    if (imgUrl) {
      e.preventDefault();
      try {
        const noteImg = await noteImageFromUrl(imgUrl.url, imgUrl.alt);
        const pos = this.getInsertCanvasPoint(board);
        await this.insertImageItem(noteImg, pos.x, pos.y);
        return true;
      } catch (err) {
        console.warn('Could not load pasted image URL onto board:', err);
      }
    }

    const webUrl = extractStandaloneWebUrl(plainText);
    if (webUrl) {
      e.preventDefault();
      const pos = this.getInsertCanvasPoint(board);
      this.insertLinkItem(webUrl.url, webUrl.label, pos.x, pos.y);
      return true;
    }

    if (!plainText.trim()) {
      const htmlImg = extractImageUrlFromClipboardHtml(htmlData);
      if (htmlImg) {
        e.preventDefault();
        try {
          const noteImg = await noteImageFromUrl(htmlImg.url, htmlImg.alt);
          const pos = this.getInsertCanvasPoint(board);
          await this.insertImageItem(noteImg, pos.x, pos.y);
          return true;
        } catch {
          return false;
        }
      }
    }

    // Plain text pasted onto canvas with no active text box -> create a text box at cursor!
    if (plainText.trim()) {
      e.preventDefault();
      const pos = this.getInsertCanvasPoint(board);
      this.createTextItem(pos.x, pos.y, plainText.trim(), false);
      return true;
    }

    return false;
  }

  private closePopovers(): void {
    this.els.tagPopover.classList.add('hidden');
    this.els.imagePopover.classList.add('hidden');
    this.els.linkPopover.classList.add('hidden');
    this.els.inkPopover.classList.add('hidden');
    this.els.linkError.classList.add('hidden');
  }

  private renderSwatchButtonsHtml(includeAuto: boolean): string {
    return INK_SWATCHES.filter((s) => includeAuto || s.color !== AUTO_INK_TOKEN)
      .map(
        (s) =>
          `<button type="button" class="ink-swatch-btn" data-ink-color="${s.color}" title="${s.label}" aria-label="${s.label}"${
            s.color === AUTO_INK_TOKEN ? '' : ` style="background:${s.color};"`
          }></button>`
      )
      .join('');
  }

  private initInkPickers(): void {
    this.els.inkColorSwatches.innerHTML = this.renderSwatchButtonsHtml(true);
    this.els.selStrokeColorPicker.innerHTML = this.renderSwatchButtonsHtml(true);
  }

  private getActiveInkPreset(): InkPreset {
    return this.inkPresets[this.activeInkSlot] ?? this.inkPresets[0]!;
  }

  private setActiveTool(tool: BoardActiveTool, slotIndex?: number): void {
    if (slotIndex !== undefined && this.inkPresets[slotIndex]) {
      this.activeInkSlot = slotIndex;
    }
    this.activeTool = tool;
    this.updateDrawToolbarUi();
  }

  private updateDrawToolbarUi(): void {
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
    for (let i = 0; i < this.inkPresets.length; i++) {
      const preset = this.inkPresets[i]!;
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

    this.els.viewport.setAttribute('data-tool', this.activeTool);
  }

  private openInkPopoverForSlot(slot: number): void {
    const preset = this.inkPresets[slot];
    if (!preset) return;
    this.closePopovers();
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

  private cycleBoardGridStyle(): void {
    const board = this.host.getBoard();
    if (!board) return;
    const current = board.gridStyle ?? 'dots';
    const next = GRID_STYLES[(GRID_STYLES.indexOf(current) + 1) % GRID_STYLES.length]!;
    board.gridStyle = next;
    this.applyViewport(board);
    this.host.onBoardMutated(board, true);
  }

  private getLiveCanvasCtx(board: Board): CanvasRenderingContext2D | null {
    const canvas = this.els.inkLiveCanvas;
    const w = this.els.viewport.clientWidth;
    const h = this.els.viewport.clientHeight;
    if (w <= 0 || h <= 0) return null;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    canvas.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const z = board.viewport.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, board.viewport.panX * dpr, board.viewport.panY * dpr);
    return ctx;
  }

  private clearLiveCanvas(): void {
    const canvas = this.els.inkLiveCanvas;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.classList.add('hidden');
  }

  private renderLiveDrawOverlay(board: Board, pt?: { x: number; y: number }): void {
    if (!this.gesture) return;
    const ctx = this.getLiveCanvasCtx(board);
    if (!ctx) return;

    if (this.gesture.kind === 'draw') {
      const pts: StrokePoint[] = this.gesture.straightLinePt
        ? [
            [this.gesture.startPt.x, this.gesture.startPt.y, 0.58],
            [this.gesture.straightLinePt.x, this.gesture.straightLinePt.y, 0.58],
          ]
        : this.gesture.rawPoints;
      renderStrokeToCanvas2d(
        ctx,
        pts,
        this.gesture.tool,
        this.gesture.strokeColor,
        this.gesture.strokeWidth,
        this.gesture.opacity
      );
    } else if (this.gesture.kind === 'erase' && pt) {
      const r = 10 / board.viewport.zoom;
      ctx.save();
      ctx.strokeStyle = resolveLiveInkColor(AUTO_INK_TOKEN);
      ctx.lineWidth = 1.5 / board.viewport.zoom;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (this.gesture.kind === 'lasso' && this.gesture.points.length >= 2) {
      ctx.save();
      ctx.strokeStyle = '#8ab4f8';
      ctx.fillStyle = 'rgba(138, 180, 248, 0.1)';
      ctx.lineWidth = 1.75 / board.viewport.zoom;
      ctx.setLineDash([6 / board.viewport.zoom, 4 / board.viewport.zoom]);
      ctx.beginPath();
      ctx.moveTo(this.gesture.points[0]![0], this.gesture.points[0]![1]);
      for (let i = 1; i < this.gesture.points.length; i++) {
        ctx.lineTo(this.gesture.points[i]![0], this.gesture.points[i]![1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private eraseStrokesAlongSegment(
    board: Board,
    segA: { x: number; y: number },
    segB: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'erase' }>
  ): void {
    const hitRadius = 10 / Math.max(0.25, board.viewport.zoom);
    const hitIds: string[] = [];
    for (const item of board.items) {
      if (item.type !== 'stroke') continue;
      const m = this.getItemMetrics(item);
      if (segmentHitsStroke(item, m.w, m.h, segA.x, segA.y, segB.x, segB.y, hitRadius)) {
        hitIds.push(item.id);
      }
    }
    if (hitIds.length === 0) return;

    if (!gesture.undoPushed) {
      this.pushUndoSnapshot(board);
      gesture.undoPushed = true;
    }
    const hitSet = new Set(hitIds);
    board.items = board.items.filter((it) => !hitSet.has(it.id));
    for (const id of hitIds) this.selectedIds.delete(id);
    gesture.erasedAny = true;
    this.renderItems();
    this.updateSelectionBar();
  }

  private commitStrokeFromGesture(
    board: Board,
    finished: Extract<ActiveGesture, { kind: 'draw' }>
  ): void {
    const sourcePts: StrokePoint[] = finished.straightLinePt
      ? [
          [finished.startPt.x, finished.startPt.y, 0.58],
          [finished.straightLinePt.x, finished.straightLinePt.y, 0.58],
        ]
      : finished.rawPoints;
    if (sourcePts.length === 0) return;

    const norm = normalizeRawStroke(sourcePts, finished.tool, finished.strokeWidth);
    const strokeItem: BoardStrokeItem = {
      id: createItemId(),
      type: 'stroke',
      tool: finished.tool,
      strokeColor: finished.strokeColor,
      strokeWidth: finished.strokeWidth,
      opacity: finished.opacity,
      x: norm.x,
      y: norm.y,
      width: norm.width,
      height: norm.height,
      sourceWidth: norm.sourceWidth,
      sourceHeight: norm.sourceHeight,
      rotation: 0,
      zIndex: this.nextZIndex(board),
      points: norm.points,
    };

    this.pushUndoSnapshot(board);
    board.items.push(strokeItem);
    this.renderItems();
    this.host.onBoardMutated(board, true);
  }

  private commitLassoSelection(
    board: Board,
    finished: Extract<ActiveGesture, { kind: 'lasso' }>
  ): void {
    const poly = finished.points;
    let perimeter = 0;
    for (let i = 1; i < poly.length; i++) {
      perimeter += Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]);
    }
    if (poly.length < 3 || perimeter < 12) {
      if (!finished.additive) {
        this.selectedIds.clear();
        this.renderItems();
        this.updateSelectionBar();
      }
      return;
    }

    const nextSel = finished.additive ? new Set(this.selectedIds) : new Set<string>();
    for (const item of board.items) {
      const m = this.getItemMetrics(item);
      if (item.type === 'stroke') {
        if (lassoSelectsStroke(item, m.w, m.h, poly)) {
          nextSel.add(item.id);
        }
      } else if (lassoSelectsRect(m.x, m.y, m.w, m.h, m.rotation, poly)) {
        nextSel.add(item.id);
      }
    }
    this.selectedIds = nextSel;
    this.renderItems();
    this.updateSelectionBar();
  }

  private clientToCanvas(clientX: number, clientY: number, board: Board): { x: number; y: number } {
    const rect = this.els.viewport.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    return {
      x: (vx - board.viewport.panX) / board.viewport.zoom,
      y: (vy - board.viewport.panY) / board.viewport.zoom,
    };
  }

  private getViewportCenterCanvas(board: Board): { x: number; y: number } {
    const rect = this.els.viewport.getBoundingClientRect();
    return {
      x: (rect.width / 2 - board.viewport.panX) / board.viewport.zoom,
      y: (rect.height / 2 - board.viewport.panY) / board.viewport.zoom,
    };
  }

  private getInsertCanvasPoint(board: Board): { x: number; y: number } {
    if (this.lastCanvasCursor) {
      return { ...this.lastCanvasCursor };
    }
    const center = this.getViewportCenterCanvas(board);
    return { x: Math.round(center.x - 110), y: Math.round(center.y - 40) };
  }

  private snapValue(v: number): number {
    return this.snapToGrid ? Math.round(v / GRID_STEP) * GRID_STEP : Math.round(v);
  }

  private nextZIndex(board: Board): number {
    return board.items.reduce((max, item) => Math.max(max, item.zIndex || 0), 0) + 1;
  }

  private pushUndoSnapshot(board: Board): void {
    this.undoStack.push(cloneItems(board.items));
    if (this.undoStack.length > MAX_UNDO_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  private undo(): void {
    const board = this.host.getBoard();
    if (!board || this.undoStack.length === 0) return;
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneItems(board.items));
    board.items = prev;
    this.selectedIds.clear();
    this.editingItemId = null;
    this.renderItems();
    this.updateSelectionOverlay();
    this.updateSelectionBar();
    this.updateHistoryButtons();
    this.host.onBoardMutated(board, true);
  }

  private redo(): void {
    const board = this.host.getBoard();
    if (!board || this.redoStack.length === 0) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneItems(board.items));
    board.items = next;
    this.selectedIds.clear();
    this.editingItemId = null;
    this.renderItems();
    this.updateSelectionOverlay();
    this.updateSelectionBar();
    this.updateHistoryButtons();
    this.host.onBoardMutated(board, true);
  }

  private updateHistoryButtons(): void {
    this.els.undoBtn.disabled = this.undoStack.length === 0;
    this.els.redoBtn.disabled = this.redoStack.length === 0;
  }

  private applyViewport(board: Board): void {
    const { panX, panY, zoom } = board.viewport;
    const gridStyle: BoardGridStyle = board.gridStyle ?? 'dots';
    this.els.world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    this.els.viewport.setAttribute('data-grid', gridStyle);
    this.els.paperBtn.textContent = GRID_STYLE_LABELS[gridStyle];

    if (gridStyle === 'ruled') {
      const ruleStep = 32 * zoom;
      this.els.viewport.style.backgroundSize = `100% ${ruleStep}px`;
    } else if (gridStyle === 'blank') {
      this.els.viewport.style.backgroundSize = '';
    } else {
      const dotStep = 24 * zoom;
      this.els.viewport.style.backgroundSize = `${dotStep}px ${dotStep}px`;
    }
    this.els.viewport.style.backgroundPosition = `${panX}px ${panY}px`;
    this.els.zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
  }

  private setZoomAroundClientPoint(nextZoomRaw: number, clientX?: number, clientY?: number): void {
    const board = this.host.getBoard();
    if (!board) return;
    const nextZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM);
    const rect = this.els.viewport.getBoundingClientRect();
    const vx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
    const vy = clientY !== undefined ? clientY - rect.top : rect.height / 2;
    const canvasX = (vx - board.viewport.panX) / board.viewport.zoom;
    const canvasY = (vy - board.viewport.panY) / board.viewport.zoom;

    board.viewport.zoom = nextZoom;
    board.viewport.panX = vx - canvasX * nextZoom;
    board.viewport.panY = vy - canvasY * nextZoom;
    this.applyViewport(board);
    this.host.onBoardMutated(board, false);
  }

  private fitBoardToView(): void {
    const board = this.host.getBoard();
    if (!board) return;
    if (board.items.length === 0) {
      board.viewport = { panX: 0, panY: 0, zoom: 1 };
      this.applyViewport(board);
      this.host.onBoardMutated(board, false);
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of board.items) {
      const m = this.getItemMetrics(item);
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.w);
      maxY = Math.max(maxY, m.y + m.h);
    }

    const rect = this.els.viewport.getBoundingClientRect();
    const pad = 64;
    const contentW = Math.max(100, maxX - minX);
    const contentH = Math.max(100, maxY - minY);
    const zoom = clamp(
      Math.min((rect.width - pad * 2) / contentW, (rect.height - pad * 2) / contentH),
      MIN_ZOOM,
      1.25
    );
    board.viewport.zoom = zoom;
    board.viewport.panX = rect.width / 2 - ((minX + maxX) / 2) * zoom;
    board.viewport.panY = rect.height / 2 - ((minY + maxY) / 2) * zoom;
    this.applyViewport(board);
    this.host.onBoardMutated(board, false);
  }

  private renderBoardMeta(board: Board): void {
    this.els.tagsRow.innerHTML = board.tags
      .map(
        (t) => `
      <span class="tag-chip">
        #${escapeHtml(t)}
        <button type="button" class="tag-chip-remove" data-remove-board-tag="${escapeHtml(t)}">&times;</button>
      </span>
    `
      )
      .join('');
  }

  private getItemElement(itemId: string): HTMLElement | null {
    return this.els.itemsLayer.querySelector<HTMLElement>(`[data-board-item-id="${CSS.escape(itemId)}"]`);
  }

  private getItemMetrics(item: BoardItem): ItemMetrics {
    const el = this.getItemElement(item.id);
    const fallbackH = item.type === 'stroke' ? item.sourceHeight : 80;
    const w = el && el.offsetWidth > 0 ? el.offsetWidth : item.width || 220;
    const h = el && el.offsetHeight > 0 ? el.offsetHeight : item.height || fallbackH;
    return {
      x: item.x,
      y: item.y,
      w,
      h,
      rotation: item.rotation || 0,
    };
  }

  private getItemAabb(item: BoardItem): { minX: number; minY: number; maxX: number; maxY: number } {
    const { x, y, w, h, rotation } = this.getItemMetrics(item);
    return getRotatedRectAabb(x, y, w, h, rotation);
  }

  private renderItems(): void {
    const board = this.host.getBoard();
    if (!board) {
      this.els.itemsLayer.innerHTML = '';
      return;
    }

    const existingTa = this.editingItemId
      ? this.els.itemsLayer.querySelector<HTMLTextAreaElement>(
          `[data-board-textarea="${CSS.escape(this.editingItemId)}"]`
        )
      : null;
    const preservedSelection =
      existingTa && document.activeElement === existingTa
        ? {
            start: existingTa.selectionStart ?? existingTa.value.length,
            end: existingTa.selectionEnd ?? existingTa.value.length,
          }
        : null;

    const query = this.host.getSearchQuery();
    const sorted = [...board.items].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    this.isRenderingItems = true;
    try {
      this.els.itemsLayer.innerHTML = sorted
        .map((item) =>
          renderBoardItemHtml(item, query, {
            selected: this.selectedIds.has(item.id),
            editingText: this.editingItemId === item.id,
            editingLinkLabel: this.editingLinkLabelId === item.id,
            allowExternalUrl: this.host.isExternalImageAllowed,
          })
        )
        .join('');
    } finally {
      this.isRenderingItems = false;
    }

    if (this.editingItemId) {
      const ta = this.els.itemsLayer.querySelector<HTMLTextAreaElement>(
        `[data-board-textarea="${CSS.escape(this.editingItemId)}"]`
      );
      if (ta) {
        autoResizeTextarea(ta, 40);
        ta.focus();
        const len = ta.value.length;
        if (preservedSelection) {
          ta.setSelectionRange(
            Math.min(len, preservedSelection.start),
            Math.min(len, preservedSelection.end)
          );
        } else {
          ta.setSelectionRange(len, len);
        }
      }
    }

    if (this.editingLinkLabelId) {
      const inp = this.els.itemsLayer.querySelector<HTMLInputElement>(
        `[data-board-link-input="${CSS.escape(this.editingLinkLabelId)}"]`
      );
      if (inp) {
        inp.focus();
        inp.select();
      }
    }

    this.updateSelectionOverlay();
  }

  private updateSelectionOverlay(): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size !== 1) {
      this.els.selectionOverlay.classList.add('hidden');
      this.els.selectionOverlay.innerHTML = '';
      return;
    }

    const singleId = Array.from(this.selectedIds)[0];
    const item = board.items.find((it) => it.id === singleId);
    if (!item) {
      this.els.selectionOverlay.classList.add('hidden');
      this.els.selectionOverlay.innerHTML = '';
      return;
    }

    const m = this.getItemMetrics(item);
    this.els.selectionOverlay.classList.remove('hidden');
    this.els.selectionOverlay.style.left = `${m.x}px`;
    this.els.selectionOverlay.style.top = `${m.y}px`;
    this.els.selectionOverlay.style.width = `${m.w}px`;
    this.els.selectionOverlay.style.height = `${m.h}px`;
    this.els.selectionOverlay.style.transform = `rotate(${m.rotation}deg)`;

    const handles: HandleDir[] =
      item.type === 'image' || item.type === 'stroke'
        ? ['nw', 'ne', 'sw', 'se', 'rotate']
        : ['nw', 'ne', 'sw', 'se', 'w', 'e', 'rotate'];

    const angleTag =
      this.gesture?.kind === 'rotate'
        ? `<div class="board-rotate-angle">${normalizeAngleDeg(m.rotation)}°</div>`
        : '';

    this.els.selectionOverlay.innerHTML =
      `<div class="board-rotate-stem"></div>${angleTag}` +
      handles
        .map((h) => `<div class="board-handle" data-handle="${h}" title="${h === 'rotate' ? 'Drag to rotate (Shift snaps 15°)' : 'Drag to resize'}"></div>`)
        .join('');
  }

  private updateSelectionBar(): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size === 0) {
      this.els.selectionBar.classList.add('hidden');
      return;
    }

    const selectedItems = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selectedItems.length === 0) {
      this.els.selectionBar.classList.add('hidden');
      return;
    }

    this.els.selectionBar.classList.remove('hidden');
    const textItems = selectedItems.filter((it): it is BoardTextItem => it.type === 'text');
    const strokeItems = selectedItems.filter((it): it is BoardStrokeItem => it.type === 'stroke');
    const allStrokes = strokeItems.length > 0 && strokeItems.length === selectedItems.length;

    if (textItems.length > 0 && textItems.length === selectedItems.length) {
      this.els.selTextGroup.classList.remove('hidden');
      const primary = textItems[0]!;
      this.els.selFontSizeLabel.textContent = `${primary.fontSize || 15}px`;
      this.els.selBoldBtn.classList.toggle('active', Boolean(primary.bold));
      this.els.selItalicBtn.classList.toggle('active', Boolean(primary.italic));
      this.els.selAlignLeftBtn.classList.toggle('active', (primary.align || 'left') === 'left');
      this.els.selAlignCenterBtn.classList.toggle('active', primary.align === 'center');
      this.els.selAlignRightBtn.classList.toggle('active', primary.align === 'right');
    } else {
      this.els.selTextGroup.classList.add('hidden');
    }

    if (allStrokes) {
      this.els.selStrokeGroup.classList.remove('hidden');
      this.els.selColorGroup.classList.add('hidden');
      const primaryStroke = strokeItems[0]!;
      this.els.selStrokeWidthLabel.textContent = `${primaryStroke.strokeWidth}px`;
      this.els.selStrokeColorPicker
        .querySelectorAll<HTMLElement>('[data-ink-color]')
        .forEach((btn) => {
          btn.classList.toggle('active', btn.getAttribute('data-ink-color') === primaryStroke.strokeColor);
        });
    } else {
      this.els.selStrokeGroup.classList.add('hidden');
      this.els.selColorGroup.classList.remove('hidden');
    }

    const first = selectedItems[0]!;
    this.host.updateColorDots(this.els.selColorPicker, first.color || 'default');
    this.els.selRotationLabel.textContent = `${normalizeAngleDeg(first.rotation || 0)}°`;
    this.els.selMultiAlignGroup.classList.toggle('hidden', selectedItems.length < 2);
  }

  private commitActiveTextEdit(preserveItemId?: string): void {
    const board = this.host.getBoard();
    if (!board) return;

    if (this.editingItemId) {
      const ta = this.els.itemsLayer.querySelector<HTMLTextAreaElement>(
        `[data-board-textarea="${CSS.escape(this.editingItemId)}"]`
      );
      const idx = board.items.findIndex((it) => it.id === this.editingItemId);
      const item = idx !== -1 ? board.items[idx] : undefined;
      if (item && item.type === 'text' && ta) {
        const nextVal = ta.value;
        if (nextVal.trim() === '' && item.id !== preserveItemId) {
          board.items.splice(idx, 1);
          this.selectedIds.delete(item.id);
          this.host.onBoardMutated(board, true);
        } else if (item.content !== nextVal) {
          item.content = nextVal;
          this.host.onBoardMutated(board, true);
        }
      }
      this.editingItemId = null;
    }

    if (this.editingLinkLabelId) {
      const inp = this.els.itemsLayer.querySelector<HTMLInputElement>(
        `[data-board-link-input="${CSS.escape(this.editingLinkLabelId)}"]`
      );
      const item = board.items.find((it) => it.id === this.editingLinkLabelId);
      if (item && item.type === 'link' && inp) {
        const nextLabel = inp.value.trim();
        if (item.label !== nextLabel) {
          item.label = nextLabel || undefined;
          this.host.onBoardMutated(board, true);
        }
      }
      this.editingLinkLabelId = null;
    }
  }

  private createTextItem(x: number, y: number, initialContent = '', startEditing = true): void {
    const board = this.host.getBoard();
    if (!board) return;
    this.commitActiveTextEdit();
    this.pushUndoSnapshot(board);

    const newItem: BoardTextItem = {
      id: createItemId(),
      type: 'text',
      x: this.snapValue(x),
      y: this.snapValue(y),
      width: 240,
      rotation: 0,
      zIndex: this.nextZIndex(board),
      color: 'default',
      content: initialContent,
      align: 'left',
      fontSize: 15,
    };

    board.items.push(newItem);
    this.selectedIds = new Set([newItem.id]);
    this.editingItemId = startEditing ? newItem.id : null;
    this.renderItems();
    this.updateSelectionBar();
    if (!startEditing) {
      this.host.onBoardMutated(board, true);
    }
  }

  private async insertImageItem(noteImg: NoteImage, x: number, y: number): Promise<void> {
    const board = this.host.getBoard();
    if (!board) return;
    this.commitActiveTextEdit();

    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const probe = new Image();
      probe.referrerPolicy = 'no-referrer';
      probe.onload = () => {
        const nw = probe.naturalWidth || 320;
        const nh = probe.naturalHeight || 220;
        const scale = Math.min(1, 360 / nw, 320 / nh);
        resolve({
          w: Math.max(120, Math.round(nw * scale)),
          h: Math.max(90, Math.round(nh * scale)),
        });
      };
      probe.onerror = () => resolve({ w: 280, h: 200 });
      probe.src = noteImg.src;
    });

    this.pushUndoSnapshot(board);
    const newItem: BoardImageItem = {
      id: createItemId(),
      type: 'image',
      x: this.snapValue(x),
      y: this.snapValue(y),
      width: dims.w,
      height: dims.h,
      rotation: 0,
      zIndex: this.nextZIndex(board),
      color: 'default',
      image: noteImg,
    };

    board.items.push(newItem);
    this.selectedIds = new Set([newItem.id]);
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private insertLinkItem(rawUrl: string, label?: string, x?: number, y?: number): void {
    const board = this.host.getBoard();
    if (!board) return;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http:// and https:// URLs are supported');
    }

    this.commitActiveTextEdit();
    this.pushUndoSnapshot(board);
    const pos =
      x !== undefined && y !== undefined ? { x, y } : this.getInsertCanvasPoint(board);

    const newItem: BoardLinkItem = {
      id: createItemId(),
      type: 'link',
      x: this.snapValue(pos.x),
      y: this.snapValue(pos.y),
      width: 260,
      rotation: 0,
      zIndex: this.nextZIndex(board),
      color: 'default',
      url: parsed.href,
      label: label?.trim() || parsed.hostname,
    };

    board.items.push(newItem);
    this.selectedIds = new Set([newItem.id]);
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private mutateSelectedItems(mutator: (items: BoardItem[], board: Board) => void): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size === 0) return;
    const selected = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selected.length === 0) return;
    this.pushUndoSnapshot(board);
    mutator(selected, board);
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private alignSelectedItems(axis: 'left' | 'centerX' | 'right' | 'top' | 'centerY'): void {
    this.mutateSelectedItems((selected) => {
      if (selected.length < 2) return;
      const entries = selected.map((item) => ({ item, aabb: this.getItemAabb(item) }));
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
    });
  }

  private duplicateSelected(): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size === 0) return;
    const selected = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selected.length === 0) return;
    this.pushUndoSnapshot(board);
    let nextZ = this.nextZIndex(board);
    const nextSel = new Set<string>();
    for (const orig of selected) {
      const copy = JSON.parse(JSON.stringify(orig)) as BoardItem;
      copy.id = createItemId();
      copy.x += 24;
      copy.y += 24;
      copy.zIndex = nextZ++;
      board.items.push(copy);
      nextSel.add(copy.id);
    }
    this.editingItemId = null;
    this.editingLinkLabelId = null;
    this.selectedIds = nextSel;
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private deleteSelected(): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size === 0) return;
    this.pushUndoSnapshot(board);
    board.items = board.items.filter((it) => !this.selectedIds.has(it.id));
    this.selectedIds.clear();
    this.editingItemId = null;
    this.editingLinkLabelId = null;
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private selectAll(): void {
    const board = this.host.getBoard();
    if (!board || board.items.length === 0) return;
    this.commitActiveTextEdit();
    this.selectedIds = new Set(board.items.map((it) => it.id));
    this.renderItems();
    this.updateSelectionBar();
  }

  private copySelected(): void {
    const board = this.host.getBoard();
    if (!board || this.selectedIds.size === 0) return;
    const selected = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selected.length === 0) return;

    this.copiedItems = cloneItems(selected);
    const summaryParts = selected.map((it) => {
      if (it.type === 'text') return it.content;
      if (it.type === 'link') return it.url;
      if (it.type === 'stroke') return '';
      return it.image.sourceType === 'external' ? it.image.src : it.image.alt || '[Board Image]';
    });
    this.lastCopiedSummary = summaryParts.filter(Boolean).join('\n\n');

    if (this.lastCopiedSummary && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(this.lastCopiedSummary).catch(() => {
        // Ignore clipboard permission errors on restricted origins
      });
    }
    this.showTransientHint(
      `Copied ${selected.length} item${selected.length === 1 ? '' : 's'} to clipboard.`
    );
  }

  private cutSelected(): void {
    this.copySelected();
    this.deleteSelected();
  }

  private pasteCopiedItemsAt(board: Board, targetX: number, targetY: number): void {
    if (this.copiedItems.length === 0) return;
    this.commitActiveTextEdit();
    this.pushUndoSnapshot(board);

    const minX = this.copiedItems.reduce((m, it) => Math.min(m, it.x), Infinity);
    const minY = this.copiedItems.reduce((m, it) => Math.min(m, it.y), Infinity);
    let dx = Math.round(targetX - minX);
    let dy = Math.round(targetY - minY);
    if (dx === 0 && dy === 0) {
      dx = 24;
      dy = 24;
    }

    let z = this.nextZIndex(board);
    const nextSel = new Set<string>();
    for (const src of this.copiedItems) {
      const copy = JSON.parse(JSON.stringify(src)) as BoardItem;
      copy.id = createItemId();
      copy.x = this.snapValue(src.x + dx);
      copy.y = this.snapValue(src.y + dy);
      copy.zIndex = z++;
      board.items.push(copy);
      nextSel.add(copy.id);
    }

    this.selectedIds = nextSel;
    this.renderItems();
    this.updateSelectionBar();
    this.host.onBoardMutated(board, true);
  }

  private async pasteFromContextMenu(x: number, y: number): Promise<void> {
    const board = this.host.getBoard();
    if (!board) return;
    this.lastCanvasCursor = { x: Math.round(x), y: Math.round(y) };

    if (navigator.clipboard?.read) {
      try {
        const clipItems = await navigator.clipboard.read();
        for (const clip of clipItems) {
          const imgMime = clip.types.find((t) => t.startsWith('image/'));
          if (imgMime) {
            const blob = await clip.getType(imgMime);
            const noteImg = await noteImageFromFile(blob);
            await this.insertImageItem(noteImg, x, y);
            return;
          }
        }
      } catch {
        // Fall through to readText / internal clipboard
      }
    }

    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (this.copiedItems.length > 0 && text === this.lastCopiedSummary) {
          this.pasteCopiedItemsAt(board, x, y);
          return;
        }
        const imgUrl = extractStandaloneImageUrl(text);
        if (imgUrl) {
          const noteImg = await noteImageFromUrl(imgUrl.url, imgUrl.alt);
          await this.insertImageItem(noteImg, x, y);
          return;
        }
        const webUrl = extractStandaloneWebUrl(text);
        if (webUrl) {
          this.insertLinkItem(webUrl.url, webUrl.label, x, y);
          return;
        }
        if (text.trim()) {
          this.createTextItem(x, y, text.trim(), false);
          return;
        }
      } catch {
        // Fall through to internal clipboard / Ctrl+V hint
      }
    }

    if (this.copiedItems.length > 0) {
      this.pasteCopiedItemsAt(board, x, y);
      return;
    }

    this.showTransientHint('Clipboard read is restricted here — press Ctrl+V to paste.');
  }

  private showTransientHint(message: string): void {
    if (!this.els.canvasHint) return;
    if (this.hintResetTimer !== null) {
      window.clearTimeout(this.hintResetTimer);
      this.hintResetTimer = null;
    }
    this.els.canvasHint.textContent = message;
    this.hintResetTimer = window.setTimeout(() => {
      this.hintResetTimer = null;
      if (this.els.canvasHint) {
        this.els.canvasHint.textContent = this.defaultCanvasHint;
      }
    }, 2600);
  }

  private setSelectedColor(color: NoteColor): void {
    this.mutateSelectedItems((items) => {
      for (const it of items) it.color = color;
    });
  }

  private mutateSelectedStrokeItems(fn: (item: BoardStrokeItem) => void): void {
    this.mutateSelectedItems((items) => {
      for (const item of items) {
        if (item.type === 'stroke') fn(item);
      }
    });
  }

  private setSelectedStrokeColor(color: string): void {
    this.mutateSelectedStrokeItems((it) => {
      it.strokeColor = color;
    });
  }

  private adjustSelectedStrokeWidth(delta: number): void {
    this.mutateSelectedStrokeItems((it) => {
      const minW = it.tool === 'highlighter' ? 8 : 1;
      const maxW = it.tool === 'highlighter' ? 36 : 16;
      it.strokeWidth = Math.max(minW, Math.min(maxW, Math.round((it.strokeWidth + delta) * 2) / 2));
    });
  }

  private mutateSelectedTextItems(fn: (item: BoardTextItem) => void): void {
    this.mutateSelectedItems((items) => {
      for (const item of items) {
        if (item.type === 'text') fn(item);
      }
    });
  }

  private setSelectedTextAlign(align: BoardTextAlign): void {
    this.mutateSelectedTextItems((it) => {
      it.align = align;
    });
  }

  private toggleSelectedBold(): void {
    this.mutateSelectedTextItems((it) => {
      it.bold = !it.bold;
    });
  }

  private toggleSelectedItalic(): void {
    this.mutateSelectedTextItems((it) => {
      it.italic = !it.italic;
    });
  }

  private rotateSelectedBy(deltaDeg: number): void {
    this.mutateSelectedItems((items) => {
      for (const it of items) it.rotation = normalizeAngleDeg((it.rotation || 0) + deltaDeg);
    });
  }

  private resetSelectedRotation(): void {
    this.mutateSelectedItems((items) => {
      for (const it of items) it.rotation = 0;
    });
  }

  private bringSelectedToFront(): void {
    this.mutateSelectedItems((items, board) => {
      let z = this.nextZIndex(board);
      for (const it of items) it.zIndex = z++;
    });
  }

  private sendSelectedToBack(): void {
    this.mutateSelectedItems((items, board) => {
      const minZ = board.items.reduce((min, it) => Math.min(min, it.zIndex || 1), 1);
      let z = Math.max(1, minZ - items.length);
      for (const it of items) it.zIndex = z++;
    });
  }

  private openImagePopover(): void {
    this.closePopovers();
    this.els.imageStatus.textContent = 'Tip: Paste images anywhere on the board with Ctrl+V';
    this.els.imageStatus.style.color = 'var(--text-secondary)';
    this.els.imagePopover.classList.remove('hidden');
    this.els.imageUrlInput.focus();
  }

  private openLinkPopover(): void {
    this.closePopovers();
    this.els.linkUrlInput.value = '';
    this.els.linkLabelInput.value = '';
    this.els.linkPopover.classList.remove('hidden');
    this.els.linkUrlInput.focus();
  }

  private openCanvasContextMenu(
    clientX: number,
    clientY: number,
    board: Board,
    pt: { x: number; y: number }
  ): void {
    const entries: ContextMenuEntry[] = [];
    if (this.activeTool !== 'select') {
      entries.push(
        {
          type: 'action',
          id: 'tool-select',
          label: 'Switch to Select / Type Tool',
          shortcut: 'Esc',
          onSelect: () => this.setActiveTool('select'),
        },
        { type: 'divider' }
      );
    }

    entries.push(
      {
        type: 'action',
        id: 'new-text',
        label: 'New Text Box Here',
        shortcut: 'Click',
        onSelect: () => this.createTextItem(pt.x, pt.y, '', true),
      },
      {
        type: 'action',
        id: 'paste',
        label: 'Paste',
        shortcut: 'Ctrl+V',
        onSelect: () => this.pasteFromContextMenu(pt.x, pt.y),
      },
      {
        type: 'action',
        id: 'add-image',
        label: 'Add Image...',
        onSelect: () => this.openImagePopover(),
      },
      {
        type: 'action',
        id: 'add-link',
        label: 'Add Link...',
        onSelect: () => this.openLinkPopover(),
      },
      { type: 'divider' },
      {
        type: 'action',
        id: 'select-all',
        label: 'Select All Items',
        shortcut: 'Ctrl+A',
        disabled: board.items.length === 0,
        onSelect: () => this.selectAll(),
      },
      {
        type: 'action',
        id: 'fit-board',
        label: 'Fit Contents to View',
        onSelect: () => this.fitBoardToView(),
      },
      {
        type: 'action',
        id: 'zoom-reset',
        label: 'Reset Zoom (100%)',
        onSelect: () => this.setZoomAroundClientPoint(1, clientX, clientY),
      },
      {
        type: 'action',
        id: 'toggle-grid',
        label: 'Snap to Grid',
        checked: this.snapToGrid,
        onSelect: () => {
          this.snapToGrid = !this.snapToGrid;
          this.els.snapBtn.classList.toggle('active', this.snapToGrid);
        },
      },
      {
        type: 'action',
        id: 'cycle-paper',
        label: `Paper: ${GRID_STYLE_LABELS[board.gridStyle ?? 'dots']} (Switch)`,
        onSelect: () => this.cycleBoardGridStyle(),
      }
    );

    this.host.contextMenu.open(clientX, clientY, entries);
  }

  private openItemContextMenu(clientX: number, clientY: number, board: Board): void {
    const selected = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selected.length === 0) return;

    const single = selected.length === 1 ? selected[0] : undefined;
    const allText = selected.every((it): it is BoardTextItem => it.type === 'text');
    const allStrokes = selected.every((it): it is BoardStrokeItem => it.type === 'stroke');
    const entries: ContextMenuEntry[] = [];

    if (single?.type === 'text') {
      entries.push({
        type: 'action',
        id: 'edit-text',
        label: 'Edit Text',
        shortcut: 'Click',
        onSelect: () => {
          this.editingItemId = single.id;
          this.renderItems();
          this.updateSelectionBar();
        },
      });
    } else if (single?.type === 'image') {
      entries.push({
        type: 'action',
        id: 'view-image',
        label: 'View Full Size',
        shortcut: 'DblClick',
        onSelect: () => this.host.onOpenLightbox(single.image.src),
      });
    } else if (single?.type === 'link') {
      entries.push(
        {
          type: 'action',
          id: 'open-link',
          label: 'Open Link in New Tab',
          onSelect: () => {
            window.open(single.url, '_blank', 'noopener,noreferrer');
          },
        },
        {
          type: 'action',
          id: 'copy-link-url',
          label: 'Copy URL',
          onSelect: () => {
            if (navigator.clipboard?.writeText) {
              void navigator.clipboard.writeText(single.url).catch(() => {});
            }
            this.showTransientHint('Copied URL to clipboard.');
          },
        },
        {
          type: 'action',
          id: 'rename-link',
          label: 'Rename Link Label',
          onSelect: () => {
            this.editingLinkLabelId = single.id;
            this.renderItems();
            this.updateSelectionBar();
          },
        }
      );
    }

    if (allText) {
      const firstText = selected[0] as BoardTextItem;
      const align = firstText.align || 'left';
      entries.push(
        {
          type: 'action',
          id: 'toggle-bold',
          label: 'Bold',
          checked: Boolean(firstText.bold),
          onSelect: () => this.toggleSelectedBold(),
        },
        {
          type: 'action',
          id: 'toggle-italic',
          label: 'Italic',
          checked: Boolean(firstText.italic),
          onSelect: () => this.toggleSelectedItalic(),
        },
        {
          type: 'action',
          id: 'align-left',
          label: 'Align Text Left',
          checked: align === 'left',
          onSelect: () => this.setSelectedTextAlign('left'),
        },
        {
          type: 'action',
          id: 'align-center',
          label: 'Align Text Center',
          checked: align === 'center',
          onSelect: () => this.setSelectedTextAlign('center'),
        },
        {
          type: 'action',
          id: 'align-right',
          label: 'Align Text Right',
          checked: align === 'right',
          onSelect: () => this.setSelectedTextAlign('right'),
        }
      );
    }

    if (allStrokes) {
      entries.push(
        {
          type: 'action',
          id: 'stroke-thicker',
          label: 'Thicker Ink',
          onSelect: () => this.adjustSelectedStrokeWidth(1),
        },
        {
          type: 'action',
          id: 'stroke-thinner',
          label: 'Thinner Ink',
          onSelect: () => this.adjustSelectedStrokeWidth(-1),
        }
      );
    }

    if (entries.length > 0) {
      entries.push({ type: 'divider' });
    }

    entries.push(
      {
        type: 'action',
        id: 'cut',
        label: 'Cut',
        shortcut: 'Ctrl+X',
        onSelect: () => this.cutSelected(),
      },
      {
        type: 'action',
        id: 'copy',
        label: 'Copy',
        shortcut: 'Ctrl+C',
        onSelect: () => this.copySelected(),
      },
      {
        type: 'action',
        id: 'duplicate',
        label: 'Duplicate',
        shortcut: 'Ctrl+D',
        onSelect: () => this.duplicateSelected(),
      }
    );

    if (!allStrokes) {
      entries.push(
        { type: 'divider' },
        {
          type: 'color-row',
          label: 'Tint',
          activeColor: selected[0]?.color || 'default',
          onSelectColor: (c) => this.setSelectedColor(c),
        }
      );
    }

    entries.push(
      { type: 'divider' },
      {
        type: 'action',
        id: 'bring-front',
        label: 'Bring to Front',
        onSelect: () => this.bringSelectedToFront(),
      },
      {
        type: 'action',
        id: 'send-back',
        label: 'Send to Back',
        onSelect: () => this.sendSelectedToBack(),
      },
      {
        type: 'action',
        id: 'rotate-90',
        label: 'Rotate +90°',
        onSelect: () => this.rotateSelectedBy(90),
      },
      {
        type: 'action',
        id: 'rotate-reset',
        label: 'Reset Rotation (0°)',
        disabled: selected.every((it) => !it.rotation),
        onSelect: () => this.resetSelectedRotation(),
      }
    );

    if (selected.length >= 2) {
      entries.push(
        { type: 'divider' },
        { type: 'label', text: 'Align Selection' },
        {
          type: 'action',
          id: 'multi-left',
          label: 'Align Left Edges',
          onSelect: () => this.alignSelectedItems('left'),
        },
        {
          type: 'action',
          id: 'multi-cx',
          label: 'Align Horizontal Centers',
          onSelect: () => this.alignSelectedItems('centerX'),
        },
        {
          type: 'action',
          id: 'multi-top',
          label: 'Align Top Edges',
          onSelect: () => this.alignSelectedItems('top'),
        },
        {
          type: 'action',
          id: 'multi-cy',
          label: 'Align Vertical Centers',
          onSelect: () => this.alignSelectedItems('centerY'),
        }
      );
    }

    entries.push(
      { type: 'divider' },
      {
        type: 'action',
        id: 'delete-items',
        label: selected.length > 1 ? `Delete ${selected.length} Items` : 'Delete',
        shortcut: 'Del',
        danger: true,
        onSelect: () => this.deleteSelected(),
      }
    );

    this.host.contextMenu.open(clientX, clientY, entries);
  }

  private bindEvents(): void {
    // Top Toolbar Events
    this.els.closeBtn.addEventListener('click', () => {
      this.close();
    });

    this.els.titleInput.addEventListener('input', () => {
      const board = this.host.getBoard();
      if (!board) return;
      board.title = this.els.titleInput.value;
      this.host.onBoardMutated(board, false);
    });

    this.els.titleInput.addEventListener('blur', () => {
      const board = this.host.getBoard();
      if (!board) return;
      board.title = this.els.titleInput.value.trim() || 'Untitled Board';
      this.els.titleInput.value = board.title;
      this.host.onBoardMutated(board, true);
    });

    this.els.pinBtn.addEventListener('click', () => {
      const board = this.host.getBoard();
      if (!board) return;
      board.pinned = !board.pinned;
      this.els.pinBtn.classList.toggle('active', board.pinned);
      this.host.onBoardMutated(board, true);
    });

    this.els.colorPicker.addEventListener('click', (e) => {
      const board = this.host.getBoard();
      const target = e.target as HTMLElement | null;
      const dot = target?.closest('.color-dot');
      if (!board || !dot) return;
      const color = (dot.getAttribute('data-color') ?? 'default') as NoteColor;
      board.color = color;
      this.els.shell.setAttribute('data-color', color);
      this.host.updateColorDots(this.els.colorPicker, color);
      this.host.onBoardMutated(board, true);
    });

    const toggleBoardTag = (tag: string): void => {
      const board = this.host.getBoard();
      if (!board) return;
      if (!this.host.getAllTags().includes(tag)) {
        this.host.onAddTagToVault(tag);
      }
      if (board.tags.includes(tag)) {
        board.tags = board.tags.filter((t) => t !== tag);
      } else {
        board.tags.push(tag);
      }
      this.renderBoardMeta(board);
      this.host.renderTagPopoverOptions(
        this.els.tagOptions,
        this.els.tagSearch.value,
        board.tags,
        toggleBoardTag
      );
      this.host.onBoardMutated(board, true);
    };

    this.els.tagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const board = this.host.getBoard();
      if (!board) return;
      const isHidden = this.els.tagPopover.classList.contains('hidden');
      this.closePopovers();
      if (isHidden) {
        this.els.tagSearch.value = '';
        this.host.renderTagPopoverOptions(this.els.tagOptions, '', board.tags, toggleBoardTag);
        this.els.tagPopover.classList.remove('hidden');
        this.els.tagSearch.focus();
      }
    });

    this.els.tagSearch.addEventListener('input', () => {
      const board = this.host.getBoard();
      if (!board) return;
      this.host.renderTagPopoverOptions(
        this.els.tagOptions,
        this.els.tagSearch.value,
        board.tags,
        toggleBoardTag
      );
    });

    this.els.tagsRow.addEventListener('click', (e) => {
      const board = this.host.getBoard();
      const target = e.target as HTMLElement | null;
      const rmBtn = target?.closest('[data-remove-board-tag]');
      if (!board || !rmBtn) return;
      const tag = rmBtn.getAttribute('data-remove-board-tag');
      if (!tag) return;
      board.tags = board.tags.filter((t) => t !== tag);
      this.renderBoardMeta(board);
      this.host.onBoardMutated(board, true);
    });

    this.els.addTextBtn.addEventListener('click', () => {
      const board = this.host.getBoard();
      if (!board) return;
      const pos = this.getInsertCanvasPoint(board);
      this.createTextItem(pos.x, pos.y, '', true);
    });

    this.els.addImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = this.els.imagePopover.classList.contains('hidden');
      if (isHidden) {
        this.openImagePopover();
      } else {
        this.closePopovers();
      }
    });

    this.els.uploadImageBtn.addEventListener('click', () => {
      this.els.imageFileInput.click();
    });

    this.els.imageFileInput.addEventListener('change', async () => {
      const board = this.host.getBoard();
      if (!board || !this.els.imageFileInput.files?.length) return;
      const pos = this.getInsertCanvasPoint(board);
      let idx = 0;
      for (const file of Array.from(this.els.imageFileInput.files)) {
        if (!file.type.startsWith('image/')) continue;
        try {
          const img = await noteImageFromFile(file);
          await this.insertImageItem(img, pos.x + idx * 24, pos.y + idx * 24);
          idx++;
        } catch (err) {
          console.warn('Could not load board image file:', err);
        }
      }
      this.els.imageFileInput.value = '';
      this.closePopovers();
    });

    const submitImageUrl = async (): Promise<void> => {
      const board = this.host.getBoard();
      const raw = this.els.imageUrlInput.value.trim();
      if (!board || !raw) return;
      this.els.imageStatus.textContent = 'Downloading & processing image...';
      this.els.imageStatus.style.color = 'var(--text-secondary)';
      try {
        const img = await noteImageFromUrl(raw);
        const pos = this.getInsertCanvasPoint(board);
        await this.insertImageItem(img, pos.x, pos.y);
        this.els.imageUrlInput.value = '';
        this.closePopovers();
      } catch (err) {
        this.els.imageStatus.textContent =
          err instanceof Error ? err.message : 'Could not load image URL.';
        this.els.imageStatus.style.color = 'var(--danger)';
      }
    };

    this.els.confirmImageUrlBtn.addEventListener('click', () => {
      void submitImageUrl();
    });
    this.els.imageUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submitImageUrl();
      }
    });

    this.els.addLinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = this.els.linkPopover.classList.contains('hidden');
      if (isHidden) {
        this.openLinkPopover();
      } else {
        this.closePopovers();
      }
    });

    const submitLink = (): void => {
      const url = this.els.linkUrlInput.value.trim();
      const label = this.els.linkLabelInput.value.trim();
      if (!url) return;
      try {
        this.insertLinkItem(url, label || undefined);
        this.closePopovers();
      } catch (err) {
        this.els.linkError.textContent = err instanceof Error ? err.message : 'Invalid URL';
        this.els.linkError.classList.remove('hidden');
      }
    };

    this.els.confirmLinkBtn.addEventListener('click', submitLink);
    this.els.linkUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitLink();
      }
    });
    this.els.linkLabelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitLink();
      }
    });

    this.els.drawRack.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      const toolBtn = target?.closest<HTMLElement>('[data-board-tool]');
      if (toolBtn) {
        const nextTool = toolBtn.getAttribute('data-board-tool') as BoardActiveTool | null;
        if (nextTool === 'select' || nextTool === 'lasso' || nextTool === 'eraser') {
          this.commitActiveTextEdit();
          this.renderItems();
          this.closePopovers();
          this.setActiveTool(nextTool);
        }
        return;
      }

      const slotBtn = target?.closest<HTMLElement>('[data-ink-slot]');
      if (slotBtn) {
        const slot = Number(slotBtn.getAttribute('data-ink-slot'));
        const preset = this.inkPresets[slot];
        if (!preset) return;
        const alreadyActive =
          (this.activeTool === 'pen' || this.activeTool === 'highlighter') &&
          this.activeInkSlot === slot;
        if (alreadyActive) {
          if (this.els.inkPopover.classList.contains('hidden')) {
            this.openInkPopoverForSlot(slot);
          } else {
            this.closePopovers();
          }
        } else {
          this.commitActiveTextEdit();
          this.renderItems();
          this.closePopovers();
          this.setActiveTool(preset.tool, slot);
        }
      }
    });

    this.els.touchDrawBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.touchDrawEnabled = !this.touchDrawEnabled;
      this.updateDrawToolbarUi();
      this.showTransientHint(
        this.touchDrawEnabled
          ? 'Touch Draw ON: Single finger draws ink.'
          : 'Touch Draw OFF: Single finger pans; use stylus or Pen tool to draw.'
      );
    });

    this.els.inkWidthRange.addEventListener('input', () => {
      const preset = this.inkPresets[this.editingInkSlot];
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
      const preset = this.inkPresets[this.editingInkSlot];
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
      const preset = this.inkPresets[this.editingInkSlot];
      const color = btn?.getAttribute('data-ink-color');
      if (!btn || !preset || !color) return;
      preset.color = color;
      this.els.inkColorSwatches.querySelectorAll<HTMLElement>('[data-ink-color]').forEach((el) => {
        el.classList.toggle('active', el === btn);
      });
      this.updateDrawToolbarUi();
    });

    this.els.undoBtn.addEventListener('click', () => this.undo());
    this.els.redoBtn.addEventListener('click', () => this.redo());
    this.els.snapBtn.addEventListener('click', () => {
      this.snapToGrid = !this.snapToGrid;
      this.els.snapBtn.classList.toggle('active', this.snapToGrid);
    });
    this.els.paperBtn.addEventListener('click', () => {
      this.cycleBoardGridStyle();
    });

    this.els.zoomOutBtn.addEventListener('click', () => {
      const board = this.host.getBoard();
      if (board) this.setZoomAroundClientPoint(board.viewport.zoom - 0.15);
    });
    this.els.zoomInBtn.addEventListener('click', () => {
      const board = this.host.getBoard();
      if (board) this.setZoomAroundClientPoint(board.viewport.zoom + 0.15);
    });
    this.els.zoomResetBtn.addEventListener('click', () => {
      this.setZoomAroundClientPoint(1);
    });
    this.els.fitBtn.addEventListener('click', () => {
      this.fitBoardToView();
    });

    this.els.deleteBtn.addEventListener('click', () => {
      const board = this.host.getBoard();
      if (!board) return;
      const id = board.id;
      this.selectedIds.clear();
      this.editingItemId = null;
      this.els.backdrop.classList.add('hidden');
      this.host.onDeleteBoard(id);
    });

    // Contextual Selection Bar Events
    this.els.selFontDecBtn.addEventListener('click', () =>
      this.mutateSelectedTextItems((it) => {
        it.fontSize = Math.max(11, (it.fontSize || 15) - 2);
      })
    );
    this.els.selFontIncBtn.addEventListener('click', () =>
      this.mutateSelectedTextItems((it) => {
        it.fontSize = Math.min(48, (it.fontSize || 15) + 2);
      })
    );
    this.els.selBoldBtn.addEventListener('click', () => this.toggleSelectedBold());
    this.els.selItalicBtn.addEventListener('click', () => this.toggleSelectedItalic());

    this.els.selAlignLeftBtn.addEventListener('click', () => this.setSelectedTextAlign('left'));
    this.els.selAlignCenterBtn.addEventListener('click', () => this.setSelectedTextAlign('center'));
    this.els.selAlignRightBtn.addEventListener('click', () => this.setSelectedTextAlign('right'));

    this.els.selStrokeDecBtn.addEventListener('click', () => this.adjustSelectedStrokeWidth(-1));
    this.els.selStrokeIncBtn.addEventListener('click', () => this.adjustSelectedStrokeWidth(1));
    this.els.selStrokeColorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('[data-ink-color]');
      const color = btn?.getAttribute('data-ink-color');
      if (color) this.setSelectedStrokeColor(color);
    });

    this.els.selColorPicker.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const dot = target?.closest('.color-dot');
      if (!dot) return;
      this.setSelectedColor((dot.getAttribute('data-color') ?? 'default') as NoteColor);
    });

    this.els.selRotateLeftBtn.addEventListener('click', () => this.rotateSelectedBy(-15));
    this.els.selRotateRightBtn.addEventListener('click', () => this.rotateSelectedBy(15));
    this.els.selRotationLabel.addEventListener('click', () => this.resetSelectedRotation());

    this.els.selMultiAlignGroup.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('[data-board-align]');
      const axis = btn?.getAttribute('data-board-align') as
        | 'left'
        | 'centerX'
        | 'right'
        | 'top'
        | 'centerY'
        | null;
      if (axis) this.alignSelectedItems(axis);
    });

    this.els.selBringFrontBtn.addEventListener('click', () => this.bringSelectedToFront());
    this.els.selSendBackBtn.addEventListener('click', () => this.sendSelectedToBack());
    this.els.selDuplicateBtn.addEventListener('click', () => this.duplicateSelected());
    this.els.selDeleteBtn.addEventListener('click', () => this.deleteSelected());

    // Prevent toolbar buttons from stealing focus/blurring active text editing
    this.els.selectionBar.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
      }
    });

    this.els.itemsLayer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const allowBtn = target?.closest<HTMLElement>('[data-allow-external-url]');
      if (allowBtn) {
        e.stopPropagation();
        const url = allowBtn.getAttribute('data-allow-external-url');
        if (url) {
          this.host.onAllowExternalUrl?.(url);
          this.renderItems();
        }
      }
    });

    // Canvas Text Input Events
    this.els.itemsLayer.addEventListener('input', (e) => {
      const target = e.target;
      if (target instanceof HTMLTextAreaElement && target.hasAttribute('data-board-textarea')) {
        autoResizeTextarea(target, 40);
        const board = this.host.getBoard();
        const itemId = target.getAttribute('data-board-textarea');
        const item = board?.items.find((it) => it.id === itemId);
        if (board && item && item.type === 'text') {
          item.content = target.value;
          if (item.height && target.scrollHeight + 16 > item.height) {
            item.height = undefined;
            const itemEl = target.closest<HTMLElement>('[data-board-item-id]');
            if (itemEl) itemEl.style.height = '';
          }
          this.updateSelectionOverlay();
          this.host.onBoardMutated(board, false);
        }
      }
    });

    this.els.itemsLayer.addEventListener('focusout', (e) => {
      if (this.isRenderingItems || this.gesture) return;
      const target = e.target;
      if (
        target instanceof HTMLTextAreaElement &&
        target.hasAttribute('data-board-textarea') &&
        this.editingItemId === target.getAttribute('data-board-textarea')
      ) {
        this.commitActiveTextEdit();
        this.renderItems();
        this.updateSelectionBar();
      } else if (
        target instanceof HTMLInputElement &&
        target.hasAttribute('data-board-link-input') &&
        this.editingLinkLabelId === target.getAttribute('data-board-link-input')
      ) {
        this.commitActiveTextEdit();
        this.renderItems();
        this.updateSelectionBar();
      }
    });

    this.els.itemsLayer.addEventListener('keydown', (e) => {
      const target = e.target;
      if (
        e.key === 'Enter' &&
        target instanceof HTMLInputElement &&
        target.hasAttribute('data-board-link-input')
      ) {
        e.preventDefault();
        this.commitActiveTextEdit();
        this.renderItems();
        this.updateSelectionBar();
      }
    });

    this.els.itemsLayer.addEventListener('dblclick', (e) => {
      const board = this.host.getBoard();
      if (!board) return;
      const target = e.target as HTMLElement | null;
      const itemEl = target?.closest<HTMLElement>('[data-board-item-id]');
      if (!itemEl) return;
      const itemId = itemEl.getAttribute('data-board-item-id');
      const item = board.items.find((it) => it.id === itemId);
      if (!item) return;

      if (item.type === 'text') {
        this.commitActiveTextEdit();
        this.selectedIds = new Set([item.id]);
        this.editingItemId = item.id;
        this.renderItems();
        this.updateSelectionBar();
      } else if (item.type === 'image') {
        this.host.onOpenLightbox(item.image.src);
      } else if (item.type === 'link') {
        this.commitActiveTextEdit();
        this.selectedIds = new Set([item.id]);
        this.editingLinkLabelId = item.id;
        this.renderItems();
        this.updateSelectionBar();
      }
    });

    // Close popovers on backdrop/toolbar click
    this.els.shell.addEventListener('click', (e) => {
      const target = e.target as Node | null;
      if (target && !this.els.tagPopover.contains(target) && !this.els.tagBtn.contains(target)) {
        this.els.tagPopover.classList.add('hidden');
      }
      if (
        target &&
        !this.els.imagePopover.contains(target) &&
        !this.els.addImageBtn.contains(target)
      ) {
        this.els.imagePopover.classList.add('hidden');
      }
      if (
        target &&
        !this.els.linkPopover.contains(target) &&
        !this.els.addLinkBtn.contains(target)
      ) {
        this.els.linkPopover.classList.add('hidden');
      }
      if (
        target &&
        !this.els.inkPopover.contains(target) &&
        !this.els.drawRack.contains(target)
      ) {
        this.els.inkPopover.classList.add('hidden');
      }
    });

    // Drag & Drop Image Files onto Board Canvas
    this.els.viewport.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    });

    this.els.viewport.addEventListener('drop', async (e) => {
      const board = this.host.getBoard();
      if (!board || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const pos = this.clientToCanvas(e.clientX, e.clientY, board);
      let idx = 0;
      for (const file of Array.from(e.dataTransfer.files)) {
        if (!file.type.startsWith('image/')) continue;
        try {
          const img = await noteImageFromFile(file);
          await this.insertImageItem(img, pos.x + idx * 24, pos.y + idx * 24);
          idx++;
        } catch (err) {
          console.warn('Could not drop image onto board:', err);
        }
      }
    });

    // Wheel Zoom & Two-Finger Pan
    this.els.viewport.addEventListener(
      'wheel',
      (e) => {
        const board = this.host.getBoard();
        if (!board) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const factor = e.deltaY < 0 ? 1.1 : 0.9;
          this.setZoomAroundClientPoint(board.viewport.zoom * factor, e.clientX, e.clientY);
        } else {
          board.viewport.panX -= e.deltaX;
          board.viewport.panY -= e.deltaY;
          this.applyViewport(board);
          this.host.onBoardMutated(board, false);
        }
      },
      { passive: false }
    );

    // Pointer Interactions (Pan, Pinch, Draw, Erase, Lasso, Handle Resize/Rotate, Item Drag, Marquee, Click-Anywhere Text)
    this.els.viewport.addEventListener('pointerdown', (e) => {
      const board = this.host.getBoard();
      if (!board) return;

      const target = e.target as HTMLElement | null;
      if (e.pointerType === 'touch') {
        this.activeTouchPoints.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        if (this.activeTouchPoints.size >= 2) {
          this.clearLongPressTimer();
          if (
            this.gesture &&
            (this.gesture.kind === 'draw' ||
              this.gesture.kind === 'lasso' ||
              this.gesture.kind === 'marquee' ||
              this.gesture.kind === 'pan' ||
              this.gesture.kind === 'move')
          ) {
            if (this.els.viewport.hasPointerCapture(this.gesture.pointerId)) {
              this.els.viewport.releasePointerCapture(this.gesture.pointerId);
            }
            this.clearLiveCanvas();
            this.els.marqueeRect.classList.add('hidden');
            this.els.viewport.classList.remove('panning');
            this.gesture = null;
          }

          if (this.activeTouchPoints.size === 2) {
            const entries = Array.from(this.activeTouchPoints.entries());
            const [id1, p1] = entries[0]!;
            const [id2, p2] = entries[1]!;
            const rect = this.els.viewport.getBoundingClientRect();
            const midX = (p1.clientX + p2.clientX) * 0.5;
            const midY = (p1.clientY + p2.clientY) * 0.5;
            const dist = Math.max(12, Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY));
            this.gesture = {
              kind: 'pinch',
              pointerIds: [id1, id2],
              startDist: dist,
              startCanvasMidX: (midX - rect.left - board.viewport.panX) / board.viewport.zoom,
              startCanvasMidY: (midY - rect.top - board.viewport.panY) / board.viewport.zoom,
              startZoom: board.viewport.zoom,
            };
          }
          return;
        }
      }

      if (target?.closest('a') && e.pointerType !== 'pen' && this.activeTool === 'select') {
        return;
      }

      if (e.pointerType === 'touch' && this.activeTool === 'select' && !this.host.isLocked()) {
        this.clearLongPressTimer();
        const touchClientX = e.clientX;
        const touchClientY = e.clientY;
        const touchTarget = target;
        const touchPointerId = e.pointerId;
        const timerId = window.setTimeout(() => {
          const activeBoard = this.host.getBoard();
          if (!activeBoard || !this.longPressState || this.longPressState.pointerId !== touchPointerId) {
            return;
          }
          this.longPressState = null;
          if (
            this.gesture &&
            this.gesture.kind !== 'pinch' &&
            this.gesture.pointerId === touchPointerId
          ) {
            if (this.els.viewport.hasPointerCapture(touchPointerId)) {
              this.els.viewport.releasePointerCapture(touchPointerId);
            }
            this.els.viewport.classList.remove('panning');
            this.gesture = null;
          }
          this.openContextMenuForTarget(activeBoard, touchClientX, touchClientY, touchTarget);
        }, 520);
        this.longPressState = {
          timerId,
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
        };
      }

      // Middle click or Space+Left click -> Pan
      if (e.button === 1 || (e.button === 0 && this.spacePressed)) {
        e.preventDefault();
        this.els.viewport.setPointerCapture(e.pointerId);
        this.els.viewport.classList.add('panning');
        this.gesture = {
          kind: 'pan',
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: board.viewport.panX,
          startPanY: board.viewport.panY,
        };
        return;
      }

      // Hardware stylus barrel eraser OR Eraser tool -> Erase strokes under pointer
      const isBarrelEraser =
        e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
      if (isBarrelEraser || (e.button === 0 && this.activeTool === 'eraser')) {
        e.preventDefault();
        this.commitActiveTextEdit();
        this.els.viewport.setPointerCapture(e.pointerId);
        const pt = this.clientToCanvas(e.clientX, e.clientY, board);
        const eraseGesture: Extract<ActiveGesture, { kind: 'erase' }> = {
          kind: 'erase',
          pointerId: e.pointerId,
          prevCanvasPt: pt,
          erasedAny: false,
          undoPushed: false,
        };
        this.gesture = eraseGesture;
        this.eraseStrokesAlongSegment(board, pt, pt, eraseGesture);
        this.renderLiveDrawOverlay(board, pt);
        return;
      }

      if (e.button !== 0) return;

      // 1. Handle on single selected item
      const handleEl = target?.closest<HTMLElement>('[data-handle]');
      if (handleEl && this.selectedIds.size === 1) {
        const handle = handleEl.getAttribute('data-handle') as HandleDir | null;
        const singleId = Array.from(this.selectedIds)[0];
        const item = board.items.find((it) => it.id === singleId);
        if (handle && item) {
          e.preventDefault();
          e.stopPropagation();
          if (this.editingItemId || this.editingLinkLabelId) {
            this.commitActiveTextEdit(item.id);
            this.renderItems();
          }
          this.els.viewport.setPointerCapture(e.pointerId);
          const pt = this.clientToCanvas(e.clientX, e.clientY, board);
          const m = this.getItemMetrics(item);

          if (handle === 'rotate') {
            const cx = m.x + m.w / 2;
            const cy = m.y + m.h / 2;
            this.gesture = {
              kind: 'rotate',
              pointerId: e.pointerId,
              itemId: item.id,
              centerX: cx,
              centerY: cy,
              startAngleRad: Math.atan2(pt.y - cy, pt.x - cx),
              startRotationDeg: m.rotation,
              moved: false,
            };
          } else {
            this.gesture = {
              kind: 'resize',
              pointerId: e.pointerId,
              itemId: item.id,
              handle,
              startCanvasX: pt.x,
              startCanvasY: pt.y,
              startMetrics: m,
              aspectRatio: m.w / Math.max(1, m.h),
              isImage: item.type === 'image' || item.type === 'stroke',
              moved: false,
            };
          }
          return;
        }
      }

      // 1b. Armed Lasso / Pen / Highlighter OR auto-detected stylus Pen input
      const isPenInput = e.pointerType === 'pen';
      const isTouchDraw = e.pointerType === 'touch' && this.touchDrawEnabled;
      const isArmedDrawTool = this.activeTool === 'pen' || this.activeTool === 'highlighter';
      if (this.activeTool === 'lasso') {
        e.preventDefault();
        this.commitActiveTextEdit();
        this.els.viewport.focus();
        this.els.viewport.setPointerCapture(e.pointerId);
        const pt = this.clientToCanvas(e.clientX, e.clientY, board);
        this.gesture = {
          kind: 'lasso',
          pointerId: e.pointerId,
          points: [[pt.x, pt.y]],
          additive: e.shiftKey,
        };
        this.renderLiveDrawOverlay(board);
        return;
      }

      if (isArmedDrawTool || isPenInput || isTouchDraw) {
        e.preventDefault();
        this.commitActiveTextEdit();
        this.els.viewport.focus();
        this.els.viewport.setPointerCapture(e.pointerId);
        const pt = this.clientToCanvas(e.clientX, e.clientY, board);
        const preset = this.getActiveInkPreset();
        const initialPressure = computePointPressure(e.pressure, e.pointerType, 0, 0, 16, 0.55);
        this.gesture = {
          kind: 'draw',
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          tool: preset.tool,
          strokeColor: preset.color,
          strokeWidth: preset.width,
          opacity: preset.opacity,
          rawPoints: [[pt.x, pt.y, initialPressure]],
          lastTime: performance.now(),
          lastPressure: initialPressure,
          startPt: { x: pt.x, y: pt.y },
          straightLinePt: null,
        };
        this.renderLiveDrawOverlay(board);
        return;
      }

      // 2. Clicking inside an actively edited textarea or link input
      if (
        (target instanceof HTMLTextAreaElement && target.hasAttribute('data-board-textarea')) ||
        (target instanceof HTMLInputElement && target.hasAttribute('data-board-link-input'))
      ) {
        return;
      }

      // 3. Clicking an existing board item (border selects/moves without entering edit; text interior enters edit on click)
      const itemEl = target?.closest<HTMLElement>('[data-board-item-id]');
      if (itemEl) {
        const itemId = itemEl.getAttribute('data-board-item-id');
        const item = board.items.find((it) => it.id === itemId);
        if (item) {
          e.preventDefault();
          const clickedTextInterior = Boolean(
            target?.closest('.board-text-view, .board-text-input')
          );
          const wasEditingThisItem = this.editingItemId === item.id;

          this.commitActiveTextEdit(item.id);

          if (e.shiftKey) {
            if (this.selectedIds.has(item.id)) {
              this.selectedIds.delete(item.id);
            } else {
              this.selectedIds.add(item.id);
            }
          } else if (!this.selectedIds.has(item.id)) {
            this.selectedIds = new Set([item.id]);
          }

          this.renderItems();
          this.updateSelectionBar();

          if (this.selectedIds.has(item.id)) {
            this.els.viewport.setPointerCapture(e.pointerId);
            const pt = this.clientToCanvas(e.clientX, e.clientY, board);
            const snapshots = new Map<string, { x: number; y: number }>();
            for (const selId of this.selectedIds) {
              const selItem = board.items.find((it) => it.id === selId);
              if (selItem) snapshots.set(selId, { x: selItem.x, y: selItem.y });
            }
            this.gesture = {
              kind: 'move',
              pointerId: e.pointerId,
              startCanvasX: pt.x,
              startCanvasY: pt.y,
              moved: false,
              enterEditOnClick:
                item.type === 'text' &&
                clickedTextInterior &&
                !wasEditingThisItem &&
                !e.shiftKey &&
                this.selectedIds.size === 1,
              snapshots,
            };
          }
          return;
        }
      }

      // 4. Empty canvas click/drag -> touch pan (when Touch Draw is off) or marquee / click-to-type
      e.preventDefault();
      this.els.viewport.focus();
      this.els.viewport.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch' && !this.touchDrawEnabled) {
        this.els.viewport.classList.add('panning');
        this.gesture = {
          kind: 'pan',
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: board.viewport.panX,
          startPanY: board.viewport.panY,
        };
        return;
      }

      const pt = this.clientToCanvas(e.clientX, e.clientY, board);
      this.lastCanvasCursor = { x: pt.x, y: pt.y };
      this.gesture = {
        kind: 'marquee',
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCanvasX: pt.x,
        startCanvasY: pt.y,
        additive: e.shiftKey,
        moved: false,
      };
    });

    this.els.viewport.addEventListener('pointermove', (e) => {
      const board = this.host.getBoard();
      if (!board) return;

      if (e.pointerType === 'touch' && this.activeTouchPoints.has(e.pointerId)) {
        this.activeTouchPoints.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      }

      if (this.longPressState && this.longPressState.pointerId === e.pointerId) {
        if (
          Math.hypot(
            e.clientX - this.longPressState.startClientX,
            e.clientY - this.longPressState.startClientY
          ) > 6
        ) {
          this.clearLongPressTimer();
        }
      }

      if (this.gesture?.kind === 'pinch') {
        if (!this.gesture.pointerIds.includes(e.pointerId)) return;
        const p1 = this.activeTouchPoints.get(this.gesture.pointerIds[0]);
        const p2 = this.activeTouchPoints.get(this.gesture.pointerIds[1]);
        if (!p1 || !p2) return;

        const rect = this.els.viewport.getBoundingClientRect();
        const midX = (p1.clientX + p2.clientX) * 0.5;
        const midY = (p1.clientY + p2.clientY) * 0.5;
        const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
        const nextZoom = clamp(
          this.gesture.startZoom * (dist / this.gesture.startDist),
          MIN_ZOOM,
          MAX_ZOOM
        );
        board.viewport.zoom = nextZoom;
        board.viewport.panX = midX - rect.left - this.gesture.startCanvasMidX * nextZoom;
        board.viewport.panY = midY - rect.top - this.gesture.startCanvasMidY * nextZoom;
        this.applyViewport(board);
        return;
      }

      if (!this.gesture || this.gesture.pointerId !== e.pointerId) return;

      if (this.gesture.kind === 'pan') {
        board.viewport.panX = this.gesture.startPanX + (e.clientX - this.gesture.startClientX);
        board.viewport.panY = this.gesture.startPanY + (e.clientY - this.gesture.startClientY);
        this.applyViewport(board);
        return;
      }

      const pt = this.clientToCanvas(e.clientX, e.clientY, board);

      if (this.gesture.kind === 'draw') {
        if (e.shiftKey) {
          this.gesture.straightLinePt = { x: pt.x, y: pt.y };
          this.renderLiveDrawOverlay(board);
          return;
        }
        this.gesture.straightLinePt = null;
        const coalesced =
          typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const samples = coalesced.length > 0 ? coalesced : [e];
        const minDist = 0.65 / Math.max(0.25, board.viewport.zoom);
        for (const ev of samples) {
          const evPt = this.clientToCanvas(ev.clientX, ev.clientY, board);
          const last = this.gesture.rawPoints[this.gesture.rawPoints.length - 1]!;
          const dx = evPt.x - last[0];
          const dy = evPt.y - last[1];
          if (Math.hypot(dx, dy) < minDist) continue;
          const now = performance.now();
          const dt = Math.max(1, now - this.gesture.lastTime);
          const pressure = computePointPressure(
            ev.pressure,
            this.gesture.pointerType,
            dx,
            dy,
            dt,
            this.gesture.lastPressure
          );
          this.gesture.lastTime = now;
          this.gesture.lastPressure = pressure;
          this.gesture.rawPoints.push([evPt.x, evPt.y, pressure]);
        }
        this.renderLiveDrawOverlay(board);
        return;
      }

      if (this.gesture.kind === 'erase') {
        this.eraseStrokesAlongSegment(board, this.gesture.prevCanvasPt, pt, this.gesture);
        this.gesture.prevCanvasPt = pt;
        this.renderLiveDrawOverlay(board, pt);
        return;
      }

      if (this.gesture.kind === 'lasso') {
        const last = this.gesture.points[this.gesture.points.length - 1];
        if (!last || Math.hypot(pt.x - last[0], pt.y - last[1]) >= 3 / Math.max(0.25, board.viewport.zoom)) {
          this.gesture.points.push([pt.x, pt.y]);
        }
        this.renderLiveDrawOverlay(board);
        return;
      }

      if (this.gesture.kind === 'move') {
        const dx = pt.x - this.gesture.startCanvasX;
        const dy = pt.y - this.gesture.startCanvasY;
        if (!this.gesture.moved && Math.hypot(dx, dy) > 3) {
          this.gesture.moved = true;
          this.pushUndoSnapshot(board);
        }
        if (!this.gesture.moved) return;

        let adjDx = dx;
        let adjDy = dy;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) adjDy = 0;
          else adjDx = 0;
        }

        for (const [id, orig] of this.gesture.snapshots.entries()) {
          const item = board.items.find((it) => it.id === id);
          if (!item) continue;
          item.x = this.snapValue(orig.x + adjDx);
          item.y = this.snapValue(orig.y + adjDy);
          const el = this.getItemElement(id);
          if (el) {
            el.style.left = `${item.x}px`;
            el.style.top = `${item.y}px`;
          }
        }
        this.updateSelectionOverlay();
        return;
      }

      if (this.gesture.kind === 'resize') {
        const dx = pt.x - this.gesture.startCanvasX;
        const dy = pt.y - this.gesture.startCanvasY;
        if (!this.gesture.moved && Math.hypot(dx, dy) > 2) {
          this.gesture.moved = true;
          this.pushUndoSnapshot(board);
        }
        if (!this.gesture.moved) return;

        const targetId = this.gesture.itemId;
        const item = board.items.find((it) => it.id === targetId);
        if (!item) return;

        const { x: sx0, y: sy0, w: sw, h: sh, rotation } = this.gesture.startMetrics;
        const hDir = this.gesture.handle;
        const sx = hDir.includes('e') ? 1 : hDir.includes('w') ? -1 : 0;
        const sy = hDir.includes('s') ? 1 : hDir.includes('n') ? -1 : 0;

        const rad = (rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const localDx = dx * cos + dy * sin;
        const localDy = -dx * sin + dy * cos;

        const minW = item.type === 'stroke' ? 12 : item.type === 'image' ? 60 : 120;
        const minH = item.type === 'stroke' ? 12 : item.type === 'image' ? 45 : 40;

        let nextW = sx !== 0 ? Math.max(minW, sw + sx * localDx) : sw;
        let nextH = sy !== 0 ? Math.max(minH, sh + sy * localDy) : sh;

        if (this.gesture.isImage && sx !== 0 && sy !== 0 && !e.shiftKey) {
          const ratio = this.gesture.aspectRatio;
          if (Math.abs(nextW - sw) / sw >= Math.abs(nextH - sh) / sh) {
            nextH = Math.max(minH, nextW / ratio);
          } else {
            nextW = Math.max(minW, nextH * ratio);
          }
        }

        const dw = nextW - sw;
        const dh = nextH - sh;
        const offsetLocalX = (sx * dw) / 2;
        const offsetLocalY = (sy * dh) / 2;

        const startCenterX = sx0 + sw / 2;
        const startCenterY = sy0 + sh / 2;
        const nextCenterX = startCenterX + offsetLocalX * cos - offsetLocalY * sin;
        const nextCenterY = startCenterY + offsetLocalX * sin + offsetLocalY * cos;

        item.x = Math.round(nextCenterX - nextW / 2);
        item.y = Math.round(nextCenterY - nextH / 2);
        item.width = Math.round(nextW);
        if (item.type === 'image' || item.type === 'stroke' || sy !== 0) {
          item.height = Math.round(nextH);
        }

        const el = this.getItemElement(item.id);
        if (el) {
          el.style.left = `${item.x}px`;
          el.style.top = `${item.y}px`;
          el.style.width = `${item.width}px`;
          if (item.height) el.style.height = `${item.height}px`;
        }
        this.updateSelectionOverlay();
        return;
      }

      if (this.gesture.kind === 'rotate') {
        const angleNow = Math.atan2(pt.y - this.gesture.centerY, pt.x - this.gesture.centerX);
        const deltaDeg = ((angleNow - this.gesture.startAngleRad) * 180) / Math.PI;
        if (!this.gesture.moved && Math.abs(deltaDeg) > 1) {
          this.gesture.moved = true;
          this.pushUndoSnapshot(board);
        }
        if (!this.gesture.moved) return;

        const targetId = this.gesture.itemId;
        const item = board.items.find((it) => it.id === targetId);
        if (!item) return;

        let nextDeg = this.gesture.startRotationDeg + deltaDeg;
        if (e.shiftKey) {
          nextDeg = Math.round(nextDeg / 15) * 15;
        }
        item.rotation = normalizeAngleDeg(nextDeg);
        const el = this.getItemElement(item.id);
        if (el) {
          el.style.transform = `rotate(${item.rotation}deg)`;
        }
        this.updateSelectionOverlay();
        this.updateSelectionBar();
        return;
      }

      if (this.gesture.kind === 'marquee') {
        const dist = Math.hypot(
          e.clientX - this.gesture.startClientX,
          e.clientY - this.gesture.startClientY
        );
        if (!this.gesture.moved && dist > 5) {
          this.gesture.moved = true;
          this.commitActiveTextEdit();
          this.els.marqueeRect.classList.remove('hidden');
        }
        if (!this.gesture.moved) return;

        const rect = this.els.viewport.getBoundingClientRect();
        const x1 = Math.min(this.gesture.startClientX, e.clientX) - rect.left;
        const y1 = Math.min(this.gesture.startClientY, e.clientY) - rect.top;
        const w = Math.abs(e.clientX - this.gesture.startClientX);
        const h = Math.abs(e.clientY - this.gesture.startClientY);
        this.els.marqueeRect.style.left = `${x1}px`;
        this.els.marqueeRect.style.top = `${y1}px`;
        this.els.marqueeRect.style.width = `${w}px`;
        this.els.marqueeRect.style.height = `${h}px`;

        const minCX = Math.min(this.gesture.startCanvasX, pt.x);
        const maxCX = Math.max(this.gesture.startCanvasX, pt.x);
        const minCY = Math.min(this.gesture.startCanvasY, pt.y);
        const maxCY = Math.max(this.gesture.startCanvasY, pt.y);

        const nextSel = this.gesture.additive ? new Set(this.selectedIds) : new Set<string>();
        for (const item of board.items) {
          const aabb = this.getItemAabb(item);
          const overlaps =
            aabb.maxX >= minCX && aabb.minX <= maxCX && aabb.maxY >= minCY && aabb.minY <= maxCY;
          if (overlaps) nextSel.add(item.id);
        }
        this.selectedIds = nextSel;
        this.renderItems();
        this.updateSelectionBar();
      }
    });

    const finishPointer = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') {
        this.activeTouchPoints.delete(e.pointerId);
      }
      if (this.longPressState && this.longPressState.pointerId === e.pointerId) {
        this.clearLongPressTimer();
      }

      const board = this.host.getBoard();
      if (!this.gesture) return;
      if (this.gesture.kind === 'pinch') {
        if (!this.gesture.pointerIds.includes(e.pointerId)) return;
        this.gesture = null;
        if (board) this.host.onBoardMutated(board, false);
        return;
      }
      if (this.gesture.pointerId !== e.pointerId) return;
      const finished = this.gesture;
      this.gesture = null;

      if (this.els.viewport.hasPointerCapture(e.pointerId)) {
        this.els.viewport.releasePointerCapture(e.pointerId);
      }
      this.els.viewport.classList.remove('panning');
      this.els.marqueeRect.classList.add('hidden');
      this.clearLiveCanvas();

      if (!board) return;

      if (finished.kind === 'pan') {
        this.host.onBoardMutated(board, false);
        return;
      }

      if (finished.kind === 'draw') {
        if (e.type !== 'pointercancel' || e.pointerType !== 'touch') {
          this.commitStrokeFromGesture(board, finished);
        }
        return;
      }

      if (finished.kind === 'erase') {
        if (finished.erasedAny) {
          this.host.onBoardMutated(board, true);
        }
        return;
      }

      if (finished.kind === 'lasso') {
        if (e.type !== 'pointercancel') {
          this.commitLassoSelection(board, finished);
        }
        return;
      }

      if (finished.kind === 'marquee') {
        if (!finished.moved) {
          // Deselect-before-create: clear active selection/edit first; if already clear, click anywhere to type!
          const hadSelectionOrEdit =
            this.selectedIds.size > 0 ||
            this.editingItemId !== null ||
            this.editingLinkLabelId !== null;
          this.commitActiveTextEdit();
          this.selectedIds.clear();
          this.renderItems();
          this.updateSelectionBar();

          if (!hadSelectionOrEdit) {
            this.createTextItem(finished.startCanvasX, finished.startCanvasY, '', true);
          }
        }
        return;
      }

      if (finished.moved) {
        this.host.onBoardMutated(board, true);
        this.updateSelectionOverlay();
        this.updateSelectionBar();
      } else if (
        finished.kind === 'move' &&
        finished.enterEditOnClick &&
        this.selectedIds.size === 1
      ) {
        const singleId = Array.from(this.selectedIds)[0];
        const clickedItem = board.items.find((it) => it.id === singleId);
        if (clickedItem && clickedItem.type === 'text') {
          this.editingItemId = clickedItem.id;
          this.renderItems();
          this.updateSelectionBar();
        }
      }
    };

    this.els.viewport.addEventListener('pointerup', finishPointer);
    this.els.viewport.addEventListener('pointercancel', finishPointer);

    // Custom Right-Click Context Menu on Canvas & Board Items
    this.els.viewport.addEventListener('contextmenu', (e) => {
      const board = this.host.getBoard();
      if (!board || this.host.isLocked() || shouldBypassCustomContextMenu(e)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      this.openContextMenuForTarget(board, e.clientX, e.clientY, e.target as HTMLElement | null);
    });
  }
}

export { maybeById };
