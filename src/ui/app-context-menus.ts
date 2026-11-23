/**
 * Crypsy — Declarative Workspace Context Menu Builders (Notes & Boards)
 */

import type { ContextMenuEntry } from './context-menu';
import type { Board, Note, NoteColor } from '../types';

export interface NoteContextMenuActions {
  onEdit: () => void;
  onTogglePin: () => void | Promise<void>;
  onDuplicate: () => void | Promise<void>;
  onCopyText: () => void;
  onSetColor: (color: NoteColor) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

export function buildNoteContextMenuEntries(
  note: Note,
  actions: NoteContextMenuActions
): ContextMenuEntry[] {
  return [
    {
      type: 'action',
      id: 'edit-note',
      label: 'Edit Note',
      onSelect: actions.onEdit,
    },
    {
      type: 'action',
      id: 'pin-note',
      label: note.pinned ? 'Unpin Note' : 'Pin Note',
      onSelect: actions.onTogglePin,
    },
    {
      type: 'action',
      id: 'dup-note',
      label: 'Duplicate Note',
      onSelect: actions.onDuplicate,
    },
    {
      type: 'action',
      id: 'copy-note',
      label: 'Copy Note Text',
      onSelect: actions.onCopyText,
    },
    { type: 'divider' },
    {
      type: 'color-row',
      label: 'Tint',
      activeColor: note.color || 'default',
      onSelectColor: actions.onSetColor,
    },
    { type: 'divider' },
    {
      type: 'action',
      id: 'delete-note',
      label: 'Delete Note',
      danger: true,
      onSelect: actions.onDelete,
    },
  ];
}

export interface BoardContextMenuActions {
  onOpen: () => void;
  onRename?: () => void;
  onTogglePin: () => void | Promise<void>;
  onDuplicate: () => void | Promise<void>;
  onSetColor: (color: NoteColor) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

export function buildBoardContextMenuEntries(
  board: Board,
  actions: BoardContextMenuActions
): ContextMenuEntry[] {
  return [
    {
      type: 'action',
      id: 'open-board',
      label: 'Open Board',
      onSelect: actions.onOpen,
    },
    ...(actions.onRename
      ? [
          {
            type: 'action' as const,
            id: 'rename-board',
            label: 'Rename Board...',
            onSelect: actions.onRename,
          },
        ]
      : []),
    {
      type: 'action',
      id: 'pin-board',
      label: board.pinned ? 'Unpin Board' : 'Pin Board',
      onSelect: actions.onTogglePin,
    },
    {
      type: 'action',
      id: 'dup-board',
      label: 'Duplicate Board',
      onSelect: actions.onDuplicate,
    },
    { type: 'divider' },
    {
      type: 'color-row',
      label: 'Theme',
      activeColor: board.color || 'default',
      onSelectColor: actions.onSetColor,
    },
    { type: 'divider' },
    {
      type: 'action',
      id: 'delete-board',
      label: 'Delete Board',
      danger: true,
      onSelect: actions.onDelete,
    },
  ];
}
