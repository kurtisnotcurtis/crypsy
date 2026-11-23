/**
 * Declarative context menu builders for Spatial Board canvas and selected items.
 */

import type { ContextMenuEntry } from '../ui/context-menu';
import type {
  Board,
  BoardGridStyle,
  BoardItem,
  BoardStrokeItem,
  BoardTextAlign,
  BoardTextItem,
  NoteColor,
} from '../types';

export interface CanvasContextMenuActions {
  activeTool: string;
  snapToGrid: boolean;
  gridStyleLabel: string;
  setSelectTool: () => void;
  createTextAt: (x: number, y: number) => void;
  pasteAt: (x: number, y: number) => void | Promise<void>;
  openImagePopover: () => void;
  openLinkPopover: () => void;
  selectAll: () => void;
  fitBoardToView: () => void;
  resetZoomAt: () => void;
  toggleSnapToGrid: () => void;
  cyclePaperStyle: () => void;
}

export interface ItemContextMenuActions {
  editText: (itemId: string) => void;
  openLightbox: (src: string) => void;
  renameLink: (itemId: string) => void;
  copyUrl: (url: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  setTextAlign: (align: BoardTextAlign) => void;
  adjustStrokeWidth: (delta: number) => void;
  cut: () => void;
  copy: () => void;
  duplicate: () => void;
  setColor: (color: NoteColor) => void;
  bringToFront: () => void;
  sendToBack: () => void;
  rotateBy: (deg: number) => void;
  resetRotation: () => void;
  align: (axis: 'left' | 'centerX' | 'right' | 'top' | 'centerY') => void;
  deleteSelected: () => void;
}

export const GRID_STYLES: readonly BoardGridStyle[] = ['dots', 'grid', 'ruled', 'blank'];
export const GRID_STYLE_LABELS: Record<BoardGridStyle, string> = {
  dots: 'Dots',
  grid: 'Grid',
  ruled: 'Ruled',
  blank: 'Blank',
};

export function buildCanvasContextMenuEntries(
  board: Board,
  pt: { x: number; y: number },
  actions: CanvasContextMenuActions
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  if (actions.activeTool !== 'select') {
    entries.push(
      {
        type: 'action',
        id: 'tool-select',
        label: 'Switch to Select / Type Tool',
        shortcut: 'Esc',
        onSelect: actions.setSelectTool,
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
      onSelect: () => actions.createTextAt(pt.x, pt.y),
    },
    {
      type: 'action',
      id: 'paste',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      onSelect: () => actions.pasteAt(pt.x, pt.y),
    },
    {
      type: 'action',
      id: 'add-image',
      label: 'Add Image...',
      onSelect: actions.openImagePopover,
    },
    {
      type: 'action',
      id: 'add-link',
      label: 'Add Link...',
      onSelect: actions.openLinkPopover,
    },
    { type: 'divider' },
    {
      type: 'action',
      id: 'select-all',
      label: 'Select All Items',
      shortcut: 'Ctrl+A',
      disabled: board.items.length === 0,
      onSelect: actions.selectAll,
    },
    {
      type: 'action',
      id: 'fit-board',
      label: 'Fit Contents to View',
      onSelect: actions.fitBoardToView,
    },
    {
      type: 'action',
      id: 'zoom-reset',
      label: 'Reset Zoom (100%)',
      onSelect: actions.resetZoomAt,
    },
    {
      type: 'action',
      id: 'toggle-grid',
      label: 'Snap to Grid',
      checked: actions.snapToGrid,
      onSelect: actions.toggleSnapToGrid,
    },
    {
      type: 'action',
      id: 'cycle-paper',
      label: `Paper: ${actions.gridStyleLabel} (Switch)`,
      onSelect: actions.cyclePaperStyle,
    }
  );

  return entries;
}

export function buildItemContextMenuEntries(
  selected: BoardItem[],
  actions: ItemContextMenuActions
): ContextMenuEntry[] {
  if (selected.length === 0) return [];

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
      onSelect: () => actions.editText(single.id),
    });
  } else if (single?.type === 'image') {
    entries.push({
      type: 'action',
      id: 'view-image',
      label: 'View Full Size',
      shortcut: 'DblClick',
      onSelect: () => actions.openLightbox(single.image.src),
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
        onSelect: () => actions.copyUrl(single.url),
      },
      {
        type: 'action',
        id: 'rename-link',
        label: 'Rename Link Label',
        onSelect: () => actions.renameLink(single.id),
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
        onSelect: actions.toggleBold,
      },
      {
        type: 'action',
        id: 'toggle-italic',
        label: 'Italic',
        checked: Boolean(firstText.italic),
        onSelect: actions.toggleItalic,
      },
      {
        type: 'action',
        id: 'align-left',
        label: 'Align Text Left',
        checked: align === 'left',
        onSelect: () => actions.setTextAlign('left'),
      },
      {
        type: 'action',
        id: 'align-center',
        label: 'Align Text Center',
        checked: align === 'center',
        onSelect: () => actions.setTextAlign('center'),
      },
      {
        type: 'action',
        id: 'align-right',
        label: 'Align Text Right',
        checked: align === 'right',
        onSelect: () => actions.setTextAlign('right'),
      }
    );
  }

  if (allStrokes) {
    entries.push(
      {
        type: 'action',
        id: 'stroke-thicker',
        label: 'Thicker Ink',
        onSelect: () => actions.adjustStrokeWidth(1),
      },
      {
        type: 'action',
        id: 'stroke-thinner',
        label: 'Thinner Ink',
        onSelect: () => actions.adjustStrokeWidth(-1),
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
      onSelect: actions.cut,
    },
    {
      type: 'action',
      id: 'copy',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      onSelect: actions.copy,
    },
    {
      type: 'action',
      id: 'duplicate',
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      onSelect: actions.duplicate,
    }
  );

  if (!allStrokes) {
    entries.push(
      { type: 'divider' },
      {
        type: 'color-row',
        label: 'Tint',
        activeColor: selected[0]?.color || 'default',
        onSelectColor: actions.setColor,
      }
    );
  }

  entries.push(
    { type: 'divider' },
    {
      type: 'action',
      id: 'bring-front',
      label: 'Bring to Front',
      onSelect: actions.bringToFront,
    },
    {
      type: 'action',
      id: 'send-back',
      label: 'Send to Back',
      onSelect: actions.sendToBack,
    },
    {
      type: 'action',
      id: 'rotate-90',
      label: 'Rotate +90°',
      onSelect: () => actions.rotateBy(90),
    },
    {
      type: 'action',
      id: 'rotate-reset',
      label: 'Reset Rotation (0°)',
      disabled: selected.every((it) => !it.rotation),
      onSelect: actions.resetRotation,
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
        onSelect: () => actions.align('left'),
      },
      {
        type: 'action',
        id: 'multi-cx',
        label: 'Align Horizontal Centers',
        onSelect: () => actions.align('centerX'),
      },
      {
        type: 'action',
        id: 'multi-top',
        label: 'Align Top Edges',
        onSelect: () => actions.align('top'),
      },
      {
        type: 'action',
        id: 'multi-cy',
        label: 'Align Vertical Centers',
        onSelect: () => actions.align('centerY'),
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
      onSelect: actions.deleteSelected,
    }
  );

  return entries;
}
