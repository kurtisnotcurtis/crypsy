/**
 * Crypsy — Pure Vault Collection Mutation Helpers (Notes, Boards, Tags)
 */

import type { ActiveFilter, Board, Note } from '../types';
import { createId } from '../utils';

export interface VaultCollection {
  notes: Note[];
  boards: Board[];
  tags: string[];
  activeFilter: ActiveFilter;
}

export function createNewBoard(
  boardsCount: number,
  rawTitle?: string,
  initialTag?: string | null,
  now = Date.now()
): Board {
  const trimmed = (rawTitle ?? '').trim();
  return {
    id: createId('board'),
    title: trimmed || `Untitled Board ${boardsCount + 1}`,
    tags: initialTag ? [initialTag] : [],
    pinned: false,
    color: 'default',
    viewport: { panX: 0, panY: 0, zoom: 1 },
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function duplicateNoteInList(notes: Note[], noteId: string, now = Date.now()): Note | null {
  const idx = notes.findIndex((n) => n.id === noteId);
  const note = idx !== -1 ? notes[idx] : undefined;
  if (!note) return null;

  const clone: Note = {
    id: createId('note'),
    title: note.title ? `${note.title} (Copy)` : 'Untitled (Copy)',
    description: note.description,
    images: note.images ? note.images.map((img) => ({ ...img })) : [],
    tags: [...(note.tags || [])],
    pinned: false,
    color: note.color,
    createdAt: now,
    updatedAt: now,
  };
  notes.splice(idx + 1, 0, clone);
  return clone;
}

export function duplicateBoardInList(
  boards: Board[],
  boardId: string,
  now = Date.now()
): Board | null {
  const idx = boards.findIndex((b) => b.id === boardId);
  const board = idx !== -1 ? boards[idx] : undefined;
  if (!board) return null;

  const clone: Board = {
    id: createId('board'),
    title: board.title ? `${board.title} (Copy)` : 'Untitled Board (Copy)',
    tags: [...(board.tags || [])],
    pinned: false,
    color: board.color,
    viewport: { ...board.viewport },
    items: board.items.map((item) => ({
      ...structuredClone(item),
      id: createId('bi'),
    })),
    createdAt: now,
    updatedAt: now,
  };
  boards.splice(idx + 1, 0, clone);
  return clone;
}

export function deleteTagInVault(vault: VaultCollection, tagToDelete: string): void {
  vault.tags = vault.tags.filter((t) => t !== tagToDelete);
  vault.notes.forEach((n) => {
    n.tags = (n.tags || []).filter((t) => t !== tagToDelete);
  });
  vault.boards.forEach((b) => {
    b.tags = (b.tags || []).filter((t) => t !== tagToDelete);
  });
  if (vault.activeFilter.tag === tagToDelete) {
    vault.activeFilter = { type: 'all', tag: null };
  }
}

export function renameTagInVault(
  vault: VaultCollection,
  oldTag: string,
  rawNextTag: string
): boolean {
  const nextTag = rawNextTag.trim().toLowerCase().replace(/^#/, '');
  if (!nextTag || nextTag === oldTag) {
    return false;
  }

  if (vault.tags.includes(nextTag)) {
    vault.tags = vault.tags.filter((t) => t !== oldTag);
  } else {
    vault.tags = vault.tags.map((t) => (t === oldTag ? nextTag : t));
  }

  const replaceTagList = (tags: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const t of tags || []) {
      const mapped = t === oldTag ? nextTag : t;
      if (!out.includes(mapped)) out.push(mapped);
    }
    return out;
  };

  vault.notes.forEach((n) => {
    n.tags = replaceTagList(n.tags);
  });
  vault.boards.forEach((b) => {
    b.tags = replaceTagList(b.tags);
  });

  if (vault.activeFilter.type === 'tag' && vault.activeFilter.tag === oldTag) {
    vault.activeFilter = { type: 'tag', tag: nextTag };
  }

  return true;
}
