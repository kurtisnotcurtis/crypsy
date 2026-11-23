/**
 * Crypsy — Board In-Session Undo/Redo History Stack
 */

import type { BoardItem } from '../types';

function cloneBoardItems(items: BoardItem[]): BoardItem[] {
  return structuredClone(items);
}

export class BoardHistory {
  private readonly maxHistory: number;
  private undoStack: BoardItem[][] = [];
  private redoStack: BoardItem[][] = [];

  constructor(maxHistory = 60) {
    this.maxHistory = maxHistory;
  }

  public push(items: BoardItem[]): void {
    this.undoStack.push(cloneBoardItems(items));
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public undo(currentItems: BoardItem[]): BoardItem[] | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(cloneBoardItems(currentItems));
    return prev;
  }

  public redo(currentItems: BoardItem[]): BoardItem[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneBoardItems(currentItems));
    return next;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
