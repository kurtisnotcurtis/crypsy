/**
 * Crypsy — Board Clipboard Paste & System Clipboard Read Helpers
 */

import {
  extractClipboardImages,
  extractImageUrlFromClipboardHtml,
  extractStandaloneImageUrl,
  extractStandaloneWebUrl,
  noteImageFromFile,
  noteImageFromUrl,
} from '../media';
import type { Board, NoteImage } from '../types';

export interface BoardClipboardHost {
  getInsertCanvasPoint: (board: Board) => { x: number; y: number };
  isEditingItemText: () => boolean;
  hasCopiedItems: () => boolean;
  getLastCopiedSummary: () => string;
  pasteCopiedItemsAt: (board: Board, x: number, y: number) => void;
  insertImageItem: (img: NoteImage, x: number, y: number) => Promise<void>;
  insertLinkItem: (url: string, label: string | undefined, x: number, y: number) => void;
  createTextItem: (x: number, y: number, content: string, startEditing: boolean) => void;
  showTransientHint: (message: string) => void;
}

export async function handleBoardPasteEvent(
  e: ClipboardEvent,
  board: Board,
  host: BoardClipboardHost
): Promise<boolean> {
  const cd = e.clipboardData;
  if (!cd) return false;

  const images = extractClipboardImages(cd);
  if (images.length > 0) {
    e.preventDefault();
    const pos = host.getInsertCanvasPoint(board);
    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      if (!file) continue;
      try {
        const noteImg = await noteImageFromFile(file);
        await host.insertImageItem(noteImg, pos.x + i * 24, pos.y + i * 24);
      } catch (err) {
        console.warn('Could not paste image onto board:', err);
      }
    }
    return true;
  }

  // If actively editing inside a text box, let plain-text / URL paste go into the textarea normally
  if (host.isEditingItemText()) {
    return false;
  }

  const plainText = cd.getData('text/plain');
  const htmlData = cd.getData('text/html');
  const lastSummary = host.getLastCopiedSummary();

  if (
    host.hasCopiedItems() &&
    ((lastSummary && plainText === lastSummary) ||
      (!plainText.trim() && !extractImageUrlFromClipboardHtml(htmlData)))
  ) {
    e.preventDefault();
    const pos = host.getInsertCanvasPoint(board);
    host.pasteCopiedItemsAt(board, pos.x, pos.y);
    return true;
  }

  const imgUrl = extractStandaloneImageUrl(plainText);
  if (imgUrl) {
    e.preventDefault();
    try {
      const noteImg = await noteImageFromUrl(imgUrl.url, imgUrl.alt);
      const pos = host.getInsertCanvasPoint(board);
      await host.insertImageItem(noteImg, pos.x, pos.y);
      return true;
    } catch (err) {
      console.warn('Could not load pasted image URL onto board:', err);
    }
  }

  const webUrl = extractStandaloneWebUrl(plainText);
  if (webUrl) {
    e.preventDefault();
    const pos = host.getInsertCanvasPoint(board);
    host.insertLinkItem(webUrl.url, webUrl.label, pos.x, pos.y);
    return true;
  }

  if (!plainText.trim()) {
    const htmlImg = extractImageUrlFromClipboardHtml(htmlData);
    if (htmlImg) {
      e.preventDefault();
      try {
        const noteImg = await noteImageFromUrl(htmlImg.url, htmlImg.alt);
        const pos = host.getInsertCanvasPoint(board);
        await host.insertImageItem(noteImg, pos.x, pos.y);
        return true;
      } catch {
        return false;
      }
    }
  }

  // Plain text pasted onto canvas with no active text box -> create a text box at cursor!
  if (plainText.trim()) {
    e.preventDefault();
    const pos = host.getInsertCanvasPoint(board);
    host.createTextItem(pos.x, pos.y, plainText.trim(), false);
    return true;
  }

  return false;
}

export async function pasteFromBoardSystemClipboard(
  board: Board,
  x: number,
  y: number,
  host: BoardClipboardHost
): Promise<void> {
  if (navigator.clipboard?.read) {
    try {
      const clipItems = await navigator.clipboard.read();
      for (const clip of clipItems) {
        const imgMime = clip.types.find((t) => t.startsWith('image/'));
        if (imgMime) {
          const blob = await clip.getType(imgMime);
          const noteImg = await noteImageFromFile(blob);
          await host.insertImageItem(noteImg, x, y);
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
      if (host.hasCopiedItems() && text === host.getLastCopiedSummary()) {
        host.pasteCopiedItemsAt(board, x, y);
        return;
      }
      const imgUrl = extractStandaloneImageUrl(text);
      if (imgUrl) {
        const noteImg = await noteImageFromUrl(imgUrl.url, imgUrl.alt);
        await host.insertImageItem(noteImg, x, y);
        return;
      }
      const webUrl = extractStandaloneWebUrl(text);
      if (webUrl) {
        host.insertLinkItem(webUrl.url, webUrl.label, x, y);
        return;
      }
      if (text.trim()) {
        host.createTextItem(x, y, text.trim(), false);
        return;
      }
    } catch {
      // Fall through to internal clipboard / Ctrl+V hint
    }
  }

  if (host.hasCopiedItems()) {
    host.pasteCopiedItemsAt(board, x, y);
    return;
  }

  host.showTransientHint('Clipboard read is restricted here — press Ctrl+V to paste.');
}
