/**
 * Crypsy — Free-Form Spatial Board Editor
 * Supports pannable/zoomable dot-grid canvas, click-anywhere text boxes,
 * move/resize/rotate/align transforms, clipboard image & link pasting,
 * drag-and-drop image insertion, and in-session undo/redo.
 */

import {
  type BoardClipboardHost,
  handleBoardPasteEvent,
  pasteFromBoardSystemClipboard,
} from './board-clipboard';
import {
  GRID_STYLES,
  GRID_STYLE_LABELS,
  buildCanvasContextMenuEntries,
  buildItemContextMenuEntries,
} from './board-context-menu';
import {
  type ItemMetrics,
  type ResizeHandleDir,
  clamp,
  computeResizedItemRect,
  normalizeAngleDeg,
} from './board-geometry';
import { BoardHistory } from './board-history';
import { BoardInkToolbar } from './board-ink-toolbar';
import { BoardLiveCanvas } from './board-live-canvas';
import {
  alignBoardItemsInPlace,
  cloneItemsForPaste,
  summarizeBoardItemsForClipboard,
} from './board-ops';
import { renderBoardItemHtml } from './board-render';
import { BoardSelectionBar } from './board-selection-bar';
import {
  type ContextMenuController,
  shouldBypassCustomContextMenu,
} from './context-menu';
import {
  type StrokePoint,
  computePointPressure,
  lassoSelectsRect,
  lassoSelectsStroke,
  normalizeRawStroke,
  segmentHitsStroke,
} from './ink';
import { noteImageFromFile, noteImageFromUrl } from './media';
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
  createId,
  escapeHtml,
  getRotatedRectAabb,
  isEditableElement,
  maybeById,
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

type HandleDir = ResizeHandleDir | 'rotate';

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
  return createId('bi');
}

function cloneItems(items: BoardItem[]): BoardItem[] {
  return structuredClone(items);
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
  private activeTouchPoints = new Map<number, { clientX: number; clientY: number }>();
  private longPressState: {
    timerId: number;
    pointerId: number;
    startClientX: number;
    startClientY: number;
  } | null = null;
  private lastCanvasCursor: { x: number; y: number } | null = null;
  private gesture: ActiveGesture | null = null;
  private isRenderingItems = false;
  private readonly history = new BoardHistory(MAX_UNDO_HISTORY);
  private readonly liveCanvas: BoardLiveCanvas;
  private readonly inkToolbar: BoardInkToolbar;
  private readonly selectionBar: BoardSelectionBar;
  private copiedItems: BoardItem[] = [];
  private lastCopiedSummary = '';
  private hintResetTimer: number | null = null;
  private defaultCanvasHint =
    'Click anywhere to type • Draw directly with stylus or Pen tool • Drag border to move • Ctrl+V to paste image or link';

  constructor(host: BoardEditorHost) {
    this.host = host;
    this.liveCanvas = new BoardLiveCanvas(this.els.inkLiveCanvas, this.els.viewport);
    this.inkToolbar = new BoardInkToolbar({
      viewport: this.els.viewport,
      onBeforeToolChange: () => {
        this.commitActiveTextEdit();
        this.renderItems();
      },
      onCloseAllPopovers: () => this.closePopovers(),
      onShowHint: (msg) => this.showTransientHint(msg),
    });
    this.selectionBar = new BoardSelectionBar({
      updateColorDots: (pickerEl, color) => this.host.updateColorDots(pickerEl, color),
      onAdjustFontSize: (delta) =>
        this.mutateSelectedTextItems((it) => {
          it.fontSize = Math.max(11, Math.min(48, (it.fontSize || 15) + delta));
        }),
      onToggleBold: () => this.toggleSelectedBold(),
      onToggleItalic: () => this.toggleSelectedItalic(),
      onSetTextAlign: (align) => this.setSelectedTextAlign(align),
      onAdjustStrokeWidth: (delta) => this.adjustSelectedStrokeWidth(delta),
      onSetStrokeColor: (color) => this.setSelectedStrokeColor(color),
      onSetColor: (color) => this.setSelectedColor(color),
      onRotateBy: (deg) => this.rotateSelectedBy(deg),
      onResetRotation: () => this.resetSelectedRotation(),
      onAlign: (axis) => this.alignSelectedItems(axis),
      onBringToFront: () => this.bringSelectedToFront(),
      onSendToBack: () => this.sendSelectedToBack(),
      onDuplicate: () => this.duplicateSelected(),
      onDelete: () => this.deleteSelected(),
    });
    this.bindEvents();
  }

  public isOpen(): boolean {
    return !this.els.backdrop.classList.contains('hidden');
  }

  public isGestureActive(): boolean {
    return this.gesture !== null;
  }

  public isEditingText(): boolean {
    return this.editingItemId !== null || this.editingLinkLabelId !== null;
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
    this.history.clear();
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
    this.inkToolbar.updateUi();
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
    this.history.clear();
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
    this.history.clear();
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
      this.inkToolbar.isPopoverOpen()
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

    if (this.inkToolbar.getActiveTool() !== 'select') {
      this.inkToolbar.setActiveTool('select');
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

  private getClipboardHost(): BoardClipboardHost {
    return {
      getInsertCanvasPoint: (b) => this.getInsertCanvasPoint(b),
      isEditingItemText: () => Boolean(this.editingItemId || this.editingLinkLabelId),
      hasCopiedItems: () => this.copiedItems.length > 0,
      getLastCopiedSummary: () => this.lastCopiedSummary,
      pasteCopiedItemsAt: (b, x, y) => this.pasteCopiedItemsAt(b, x, y),
      insertImageItem: (img, x, y) => this.insertImageItem(img, x, y),
      insertLinkItem: (url, label, x, y) => this.insertLinkItem(url, label, x, y),
      createTextItem: (x, y, content, startEditing) =>
        this.createTextItem(x, y, content, startEditing),
      showTransientHint: (msg) => this.showTransientHint(msg),
    };
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

    return handleBoardPasteEvent(e, board, this.getClipboardHost());
  }

  private closePopovers(): void {
    this.els.tagPopover.classList.add('hidden');
    this.els.imagePopover.classList.add('hidden');
    this.els.linkPopover.classList.add('hidden');
    this.inkToolbar.closePopover();
    this.els.linkError.classList.add('hidden');
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

  private clearLiveCanvas(): void {
    this.liveCanvas.clear();
  }

  private renderLiveDrawOverlay(board: Board, pt?: { x: number; y: number }): void {
    if (!this.gesture) return;

    if (this.gesture.kind === 'draw') {
      const pts: StrokePoint[] = this.gesture.straightLinePt
        ? [
            [this.gesture.startPt.x, this.gesture.startPt.y, 0.58],
            [this.gesture.straightLinePt.x, this.gesture.straightLinePt.y, 0.58],
          ]
        : this.gesture.rawPoints;
      this.liveCanvas.renderDrawStroke(
        board,
        pts,
        this.gesture.tool,
        this.gesture.strokeColor,
        this.gesture.strokeWidth,
        this.gesture.opacity
      );
    } else if (this.gesture.kind === 'erase' && pt) {
      this.liveCanvas.renderEraserCursor(board, pt);
    } else if (this.gesture.kind === 'lasso' && this.gesture.points.length >= 2) {
      this.liveCanvas.renderLassoPolygon(board, this.gesture.points);
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
    this.history.push(board.items);
    this.updateHistoryButtons();
  }

  private undo(): void {
    const board = this.host.getBoard();
    if (!board) return;
    const prev = this.history.undo(board.items);
    if (!prev) return;
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
    if (!board) return;
    const next = this.history.redo(board.items);
    if (!next) return;
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
    this.els.undoBtn.disabled = !this.history.canUndo();
    this.els.redoBtn.disabled = !this.history.canRedo();
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

  private syncSelectionClasses(): void {
    this.els.itemsLayer.querySelectorAll<HTMLElement>('[data-board-item-id]').forEach((el) => {
      const id = el.getAttribute('data-board-item-id');
      el.classList.toggle('selected', Boolean(id && this.selectedIds.has(id)));
    });
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
      this.selectionBar.hide();
      return;
    }
    const selectedItems = board.items.filter((it) => this.selectedIds.has(it.id));
    this.selectionBar.update(selectedItems);
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
      const entries = selected.map((item) => ({ item, aabb: this.getItemAabb(item) }));
      alignBoardItemsInPlace(entries, axis);
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
      const copy = structuredClone(orig);
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
    this.lastCopiedSummary = summarizeBoardItemsForClipboard(selected);

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

    const copies = cloneItemsForPaste(
      this.copiedItems,
      targetX,
      targetY,
      this.nextZIndex(board),
      (v) => this.snapValue(v)
    );
    const nextSel = new Set<string>();
    for (const copy of copies) {
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
    await pasteFromBoardSystemClipboard(board, x, y, this.getClipboardHost());
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
    const entries = buildCanvasContextMenuEntries(board, pt, {
      activeTool: this.inkToolbar.getActiveTool(),
      snapToGrid: this.snapToGrid,
      gridStyleLabel: GRID_STYLE_LABELS[board.gridStyle ?? 'dots'],
      setSelectTool: () => this.inkToolbar.setActiveTool('select'),
      createTextAt: (x, y) => this.createTextItem(x, y, '', true),
      pasteAt: (x, y) => this.pasteFromContextMenu(x, y),
      openImagePopover: () => this.openImagePopover(),
      openLinkPopover: () => this.openLinkPopover(),
      selectAll: () => this.selectAll(),
      fitBoardToView: () => this.fitBoardToView(),
      resetZoomAt: () => this.setZoomAroundClientPoint(1, clientX, clientY),
      toggleSnapToGrid: () => {
        this.snapToGrid = !this.snapToGrid;
        this.els.snapBtn.classList.toggle('active', this.snapToGrid);
      },
      cyclePaperStyle: () => this.cycleBoardGridStyle(),
    });
    this.host.contextMenu.open(clientX, clientY, entries);
  }

  private openItemContextMenu(clientX: number, clientY: number, board: Board): void {
    const selected = board.items.filter((it) => this.selectedIds.has(it.id));
    if (selected.length === 0) return;

    const entries = buildItemContextMenuEntries(selected, {
      editText: (id) => {
        this.editingItemId = id;
        this.renderItems();
        this.updateSelectionBar();
      },
      openLightbox: (src) => this.host.onOpenLightbox(src),
      renameLink: (id) => {
        this.editingLinkLabelId = id;
        this.renderItems();
        this.updateSelectionBar();
      },
      copyUrl: (url) => {
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(url).catch(() => {});
        }
        this.showTransientHint('Copied URL to clipboard.');
      },
      toggleBold: () => this.toggleSelectedBold(),
      toggleItalic: () => this.toggleSelectedItalic(),
      setTextAlign: (align) => this.setSelectedTextAlign(align),
      adjustStrokeWidth: (delta) => this.adjustSelectedStrokeWidth(delta),
      cut: () => this.cutSelected(),
      copy: () => this.copySelected(),
      duplicate: () => this.duplicateSelected(),
      setColor: (c) => this.setSelectedColor(c),
      bringToFront: () => this.bringSelectedToFront(),
      sendToBack: () => this.sendSelectedToBack(),
      rotateBy: (deg) => this.rotateSelectedBy(deg),
      resetRotation: () => this.resetSelectedRotation(),
      align: (axis) => this.alignSelectedItems(axis),
      deleteSelected: () => this.deleteSelected(),
    });
    this.host.contextMenu.open(clientX, clientY, entries);
  }

  private bindEvents(): void {
    this.bindTopToolbarEvents();
    this.bindCanvasEvents();
  }

  private bindTopToolbarEvents(): void {
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
  }

  private bindCanvasEvents(): void {
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
      this.inkToolbar.closePopoverIfOutside(target);
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
    this.els.viewport.addEventListener('pointerdown', (e) => this.handleViewportPointerDown(e));
    this.els.viewport.addEventListener('pointermove', (e) => this.handleViewportPointerMove(e));
    this.els.viewport.addEventListener('pointerup', (e) => this.handleViewportPointerFinish(e));
    this.els.viewport.addEventListener('pointercancel', (e) => this.handleViewportPointerFinish(e));

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

  private startPinchGesture(board: Board): void {
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
  }

  private armTouchLongPress(e: PointerEvent, target: HTMLElement | null): void {
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

  private startHandleGesture(e: PointerEvent, board: Board, handleEl: HTMLElement): boolean {
    const handle = handleEl.getAttribute('data-handle') as HandleDir | null;
    const singleId = Array.from(this.selectedIds)[0];
    const item = board.items.find((it) => it.id === singleId);
    if (!handle || !item) return false;

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
    return true;
  }

  private startItemMoveGesture(
    e: PointerEvent,
    board: Board,
    itemEl: HTMLElement,
    target: HTMLElement | null
  ): boolean {
    const itemId = itemEl.getAttribute('data-board-item-id');
    const item = board.items.find((it) => it.id === itemId);
    if (!item) return false;

    e.preventDefault();
    const clickedTextInterior = Boolean(target?.closest('.board-text-view, .board-text-input'));
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
    return true;
  }

  private handleViewportPointerDown(e: PointerEvent): void {
    const board = this.host.getBoard();
    if (!board) return;

    const target = e.target as HTMLElement | null;
    if (e.pointerType === 'touch') {
      this.activeTouchPoints.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      if (this.activeTouchPoints.size >= 2) {
        this.startPinchGesture(board);
        return;
      }
    }

    const activeTool = this.inkToolbar.getActiveTool();
    const touchDrawEnabled = this.inkToolbar.isTouchDrawEnabled();

    if (target?.closest('a') && e.pointerType !== 'pen' && activeTool === 'select') {
      return;
    }

    if (e.pointerType === 'touch' && activeTool === 'select' && !this.host.isLocked()) {
      this.armTouchLongPress(e, target);
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
    if (isBarrelEraser || (e.button === 0 && activeTool === 'eraser')) {
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
    if (handleEl && this.selectedIds.size === 1 && this.startHandleGesture(e, board, handleEl)) {
      return;
    }

    // 1b. Armed Lasso / Pen / Highlighter OR auto-detected stylus Pen input
    const isPenInput = e.pointerType === 'pen';
    const isTouchDraw = e.pointerType === 'touch' && touchDrawEnabled;
    const isArmedDrawTool = activeTool === 'pen' || activeTool === 'highlighter';
    if (activeTool === 'lasso') {
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
      const preset = this.inkToolbar.getActivePreset();
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
    if (itemEl && this.startItemMoveGesture(e, board, itemEl, target)) {
      return;
    }

    // 4. Empty canvas click/drag -> touch pan (when Touch Draw is off) or marquee / click-to-type
    e.preventDefault();
    this.els.viewport.focus();
    this.els.viewport.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && !touchDrawEnabled) {
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
  }

  private updatePinchGesture(
    board: Board,
    gesture: Extract<ActiveGesture, { kind: 'pinch' }>
  ): void {
    const p1 = this.activeTouchPoints.get(gesture.pointerIds[0]);
    const p2 = this.activeTouchPoints.get(gesture.pointerIds[1]);
    if (!p1 || !p2) return;

    const rect = this.els.viewport.getBoundingClientRect();
    const midX = (p1.clientX + p2.clientX) * 0.5;
    const midY = (p1.clientY + p2.clientY) * 0.5;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
    const nextZoom = clamp(gesture.startZoom * (dist / gesture.startDist), MIN_ZOOM, MAX_ZOOM);
    board.viewport.zoom = nextZoom;
    board.viewport.panX = midX - rect.left - gesture.startCanvasMidX * nextZoom;
    board.viewport.panY = midY - rect.top - gesture.startCanvasMidY * nextZoom;
    this.applyViewport(board);
  }

  private updateDrawGesture(
    e: PointerEvent,
    board: Board,
    pt: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'draw' }>
  ): void {
    if (e.shiftKey) {
      gesture.straightLinePt = { x: pt.x, y: pt.y };
      this.renderLiveDrawOverlay(board);
      return;
    }
    gesture.straightLinePt = null;
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [e];
    const minDist = 0.65 / Math.max(0.25, board.viewport.zoom);
    for (const ev of samples) {
      const evPt = this.clientToCanvas(ev.clientX, ev.clientY, board);
      const last = gesture.rawPoints[gesture.rawPoints.length - 1]!;
      const dx = evPt.x - last[0];
      const dy = evPt.y - last[1];
      if (Math.hypot(dx, dy) < minDist) continue;
      const now = performance.now();
      const dt = Math.max(1, now - gesture.lastTime);
      const pressure = computePointPressure(
        ev.pressure,
        gesture.pointerType,
        dx,
        dy,
        dt,
        gesture.lastPressure
      );
      gesture.lastTime = now;
      gesture.lastPressure = pressure;
      gesture.rawPoints.push([evPt.x, evPt.y, pressure]);
    }
    this.renderLiveDrawOverlay(board);
  }

  private updateMoveGesture(
    e: PointerEvent,
    board: Board,
    pt: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'move' }>
  ): void {
    const dx = pt.x - gesture.startCanvasX;
    const dy = pt.y - gesture.startCanvasY;
    if (!gesture.moved && Math.hypot(dx, dy) > 3) {
      gesture.moved = true;
      this.pushUndoSnapshot(board);
    }
    if (!gesture.moved) return;

    let adjDx = dx;
    let adjDy = dy;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) adjDy = 0;
      else adjDx = 0;
    }

    for (const [id, orig] of gesture.snapshots.entries()) {
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
  }

  private updateResizeGesture(
    e: PointerEvent,
    board: Board,
    pt: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'resize' }>
  ): void {
    const dx = pt.x - gesture.startCanvasX;
    const dy = pt.y - gesture.startCanvasY;
    if (!gesture.moved && Math.hypot(dx, dy) > 2) {
      gesture.moved = true;
      this.pushUndoSnapshot(board);
    }
    if (!gesture.moved) return;

    const item = board.items.find((it) => it.id === gesture.itemId);
    if (!item) return;

    const minW = item.type === 'stroke' ? 12 : item.type === 'image' ? 60 : 120;
    const minH = item.type === 'stroke' ? 12 : item.type === 'image' ? 45 : 40;
    const next = computeResizedItemRect({
      startMetrics: gesture.startMetrics,
      handle: gesture.handle,
      dx,
      dy,
      minW,
      minH,
      preserveAspect: gesture.isImage && !e.shiftKey,
      aspectRatio: gesture.aspectRatio,
    });

    item.x = next.x;
    item.y = next.y;
    item.width = next.width;
    if (item.type === 'image' || item.type === 'stroke' || next.changedHeight) {
      item.height = next.height;
    }

    const el = this.getItemElement(item.id);
    if (el) {
      el.style.left = `${item.x}px`;
      el.style.top = `${item.y}px`;
      el.style.width = `${item.width}px`;
      if (item.height) el.style.height = `${item.height}px`;
    }
    this.updateSelectionOverlay();
  }

  private updateRotateGesture(
    e: PointerEvent,
    board: Board,
    pt: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'rotate' }>
  ): void {
    const angleNow = Math.atan2(pt.y - gesture.centerY, pt.x - gesture.centerX);
    const deltaDeg = ((angleNow - gesture.startAngleRad) * 180) / Math.PI;
    if (!gesture.moved && Math.abs(deltaDeg) > 1) {
      gesture.moved = true;
      this.pushUndoSnapshot(board);
    }
    if (!gesture.moved) return;

    const item = board.items.find((it) => it.id === gesture.itemId);
    if (!item) return;

    let nextDeg = gesture.startRotationDeg + deltaDeg;
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
  }

  private updateMarqueeGesture(
    e: PointerEvent,
    board: Board,
    pt: { x: number; y: number },
    gesture: Extract<ActiveGesture, { kind: 'marquee' }>
  ): void {
    const dist = Math.hypot(e.clientX - gesture.startClientX, e.clientY - gesture.startClientY);
    if (!gesture.moved && dist > 5) {
      gesture.moved = true;
      this.commitActiveTextEdit();
      this.els.marqueeRect.classList.remove('hidden');
    }
    if (!gesture.moved) return;

    const rect = this.els.viewport.getBoundingClientRect();
    const x1 = Math.min(gesture.startClientX, e.clientX) - rect.left;
    const y1 = Math.min(gesture.startClientY, e.clientY) - rect.top;
    const w = Math.abs(e.clientX - gesture.startClientX);
    const h = Math.abs(e.clientY - gesture.startClientY);
    this.els.marqueeRect.style.left = `${x1}px`;
    this.els.marqueeRect.style.top = `${y1}px`;
    this.els.marqueeRect.style.width = `${w}px`;
    this.els.marqueeRect.style.height = `${h}px`;

    const minCX = Math.min(gesture.startCanvasX, pt.x);
    const maxCX = Math.max(gesture.startCanvasX, pt.x);
    const minCY = Math.min(gesture.startCanvasY, pt.y);
    const maxCY = Math.max(gesture.startCanvasY, pt.y);

    const nextSel = gesture.additive ? new Set(this.selectedIds) : new Set<string>();
    for (const item of board.items) {
      const aabb = this.getItemAabb(item);
      const overlaps =
        aabb.maxX >= minCX && aabb.minX <= maxCX && aabb.maxY >= minCY && aabb.minY <= maxCY;
      if (overlaps) nextSel.add(item.id);
    }
    this.selectedIds = nextSel;
    this.syncSelectionClasses();
    this.updateSelectionBar();
  }

  private handleViewportPointerMove(e: PointerEvent): void {
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
      if (this.gesture.pointerIds.includes(e.pointerId)) {
        this.updatePinchGesture(board, this.gesture);
      }
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

    switch (this.gesture.kind) {
      case 'draw':
        this.updateDrawGesture(e, board, pt, this.gesture);
        break;
      case 'erase':
        this.eraseStrokesAlongSegment(board, this.gesture.prevCanvasPt, pt, this.gesture);
        this.gesture.prevCanvasPt = pt;
        this.renderLiveDrawOverlay(board, pt);
        break;
      case 'lasso': {
        const last = this.gesture.points[this.gesture.points.length - 1];
        if (
          !last ||
          Math.hypot(pt.x - last[0], pt.y - last[1]) >= 3 / Math.max(0.25, board.viewport.zoom)
        ) {
          this.gesture.points.push([pt.x, pt.y]);
        }
        this.renderLiveDrawOverlay(board);
        break;
      }
      case 'move':
        this.updateMoveGesture(e, board, pt, this.gesture);
        break;
      case 'resize':
        this.updateResizeGesture(e, board, pt, this.gesture);
        break;
      case 'rotate':
        this.updateRotateGesture(e, board, pt, this.gesture);
        break;
      case 'marquee':
        this.updateMarqueeGesture(e, board, pt, this.gesture);
        break;
    }
  }

  private handleViewportPointerFinish(e: PointerEvent): void {
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
  }
}
