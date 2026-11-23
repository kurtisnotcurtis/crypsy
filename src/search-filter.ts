/**
 * Crypsy — Pure Note & Board Filtering / Search Helpers
 */

import type { ActiveFilter, Board, Note } from './types';

export function filterNotes(
  notes: readonly Note[],
  activeFilter: ActiveFilter,
  searchQuery: string
): Note[] {
  if (activeFilter.type === 'boards') return [];

  const q = searchQuery.trim().toLowerCase();
  const cleanTagQuery = q.startsWith('#') ? q.slice(1) : q;

  return notes
    .filter((note) => {
      if (activeFilter.type === 'pinned' && !note.pinned) return false;
      if (activeFilter.type === 'tag' && activeFilter.tag && !note.tags.includes(activeFilter.tag)) {
        return false;
      }

      if (!q) return true;

      const titleMatch = note.title.toLowerCase().includes(q);
      const descMatch = note.description.toLowerCase().includes(q);
      const tagMatch = note.tags.some((t) => t.toLowerCase().includes(cleanTagQuery));
      return titleMatch || descMatch || tagMatch;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function filterBoards(
  boards: readonly Board[],
  activeFilter: ActiveFilter,
  searchQuery: string
): Board[] {
  const q = searchQuery.trim().toLowerCase();
  const cleanTagQuery = q.startsWith('#') ? q.slice(1) : q;

  // Keep default All Notes view Notes-only unless searching
  if (activeFilter.type === 'all' && !q) {
    return [];
  }

  return boards
    .filter((board) => {
      if (activeFilter.type === 'pinned' && !board.pinned) return false;
      if (
        activeFilter.type === 'tag' &&
        activeFilter.tag &&
        !board.tags.includes(activeFilter.tag)
      ) {
        return false;
      }

      if (!q) return true;

      const titleMatch = board.title.toLowerCase().includes(q);
      const tagMatch = board.tags.some((t) => t.toLowerCase().includes(cleanTagQuery));
      const itemMatch = board.items.some((item) => {
        if (item.type === 'text') return item.content.toLowerCase().includes(q);
        if (item.type === 'link') {
          return (
            item.url.toLowerCase().includes(q) ||
            (item.label || '').toLowerCase().includes(q) ||
            (item.description || '').toLowerCase().includes(q)
          );
        }
        if (item.type === 'image') return (item.image.alt || '').toLowerCase().includes(q);
        return false;
      });
      return titleMatch || tagMatch || itemMatch;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
