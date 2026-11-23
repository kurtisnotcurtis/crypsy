/**
 * Crypsy — Shared Note Draft Surface Controller
 * Unifies identical toolbar, color-picker, tag-popover, image-popover,
 * clipboard-paste, and drag-and-drop wiring for both the Note Composer
 * and the Edit Note Modal.
 */

import { handleListEnterKeydown } from '../markdown';
import {
  extractClipboardImages,
  extractImageUrlFromClipboardHtml,
  extractStandaloneImageUrl,
  noteImageFromFile,
  noteImageFromUrl,
} from '../media';
import type { NoteColor, NoteImage } from '../types';
import { autoResizeTextarea } from '../utils';

export interface NoteDraftData {
  pinned: boolean;
  color: NoteColor;
  tags: string[];
  images: NoteImage[];
}

export interface NoteDraftSurfaceConfig {
  surfaceEl: HTMLElement;
  descriptionEl: HTMLTextAreaElement;
  pinBtn: HTMLButtonElement;
  colorPickerEl: HTMLElement;
  tagBtn: HTMLButtonElement;
  tagPopover: HTMLElement;
  tagSearch: HTMLInputElement;
  tagOptions: HTMLElement;
  tagsRow: HTMLElement;
  removeTagAttr: string;
  imageBtn: HTMLButtonElement | null;
  imagePopover: HTMLElement | null;
  imageStatus: HTMLElement | null;
  uploadImageBtn: HTMLButtonElement | null;
  imageFileInput: HTMLInputElement | null;
  imageUrlInput: HTMLInputElement | null;
  addImageUrlBtn: HTMLButtonElement | null;
  imagesRow: HTMLElement | null;
  removeImageAttr: string;
  getDraft: () => NoteDraftData | null;
  onBeforeAttachImage?: () => void;
  onRenderTags: () => void;
  onRenderImages: () => void;
  onTagsChanged: () => void;
  onUpdateColorDots: (pickerEl: HTMLElement, activeColor: NoteColor) => void;
  onRenderTagPopoverOptions: (
    optionsContainer: HTMLElement,
    searchValue: string,
    selectedTags: string[],
    onToggleTag: (tag: string) => void
  ) => void;
  onOpenLightbox: (src: string) => void;
}

export interface NoteDraftSurfaceHandle {
  handleClipboardPaste: (e: ClipboardEvent) => Promise<boolean>;
  closePopoversIfOutside: (target: Node | null) => void;
}

export function bindNoteDraftSurface(config: NoteDraftSurfaceConfig): NoteDraftSurfaceHandle {
  const {
    surfaceEl,
    descriptionEl,
    pinBtn,
    colorPickerEl,
    tagBtn,
    tagPopover,
    tagSearch,
    tagOptions,
    tagsRow,
    removeTagAttr,
    imageBtn,
    imagePopover,
    imageStatus,
    uploadImageBtn,
    imageFileInput,
    imageUrlInput,
    addImageUrlBtn,
    imagesRow,
    removeImageAttr,
    getDraft,
    onBeforeAttachImage,
    onRenderTags,
    onRenderImages,
    onTagsChanged,
    onUpdateColorDots,
    onRenderTagPopoverOptions,
    onOpenLightbox,
  } = config;

  const setImageStatus = (msg: string, isError = false): void => {
    if (!imageStatus) return;
    imageStatus.textContent = msg;
    imageStatus.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
  };

  const attachImage = (img: NoteImage): void => {
    const draft = getDraft();
    if (!draft) return;
    onBeforeAttachImage?.();
    draft.images.push(img);
    onRenderImages();
  };

  const handleImageFiles = async (files: Iterable<File>): Promise<void> => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const noteImg = await noteImageFromFile(file);
        attachImage(noteImg);
      } catch (err) {
        console.warn('Could not process image file:', err);
      }
    }
  };

  const handleClipboardPaste = async (e: ClipboardEvent): Promise<boolean> => {
    const cd = e.clipboardData;
    if (!cd) return false;

    const imageFiles = extractClipboardImages(cd);
    if (imageFiles.length > 0) {
      e.preventDefault();
      await handleImageFiles(imageFiles);
      return true;
    }

    const plainText = cd.getData('text/plain');
    const extractedUrl = extractStandaloneImageUrl(plainText);
    if (extractedUrl) {
      e.preventDefault();
      try {
        const noteImg = await noteImageFromUrl(extractedUrl.url, extractedUrl.alt);
        attachImage(noteImg);
        return true;
      } catch {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          const start = active.selectionStart ?? active.value.length;
          const end = active.selectionEnd ?? active.value.length;
          active.value = active.value.slice(0, start) + plainText + active.value.slice(end);
        }
        return false;
      }
    }

    if (!plainText.trim()) {
      const htmlData = cd.getData('text/html');
      const htmlImg = extractImageUrlFromClipboardHtml(htmlData);
      if (htmlImg) {
        e.preventDefault();
        try {
          const noteImg = await noteImageFromUrl(htmlImg.url, htmlImg.alt);
          attachImage(noteImg);
          return true;
        } catch {
          return false;
        }
      }
    }

    return false;
  };

  // Description auto-resize & smart list continuation
  descriptionEl.addEventListener('input', () => {
    autoResizeTextarea(descriptionEl);
  });
  descriptionEl.addEventListener('keydown', handleListEnterKeydown);

  // Pin toggle
  pinBtn.addEventListener('click', () => {
    const draft = getDraft();
    if (!draft) return;
    draft.pinned = !draft.pinned;
    pinBtn.classList.toggle('active', draft.pinned);
  });

  // Color picker
  colorPickerEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const dot = target?.closest('.color-dot');
    const draft = getDraft();
    if (!dot || !draft) return;
    const color = (dot.getAttribute('data-color') ?? 'default') as NoteColor;
    draft.color = color;
    surfaceEl.setAttribute('data-color', color);
    onUpdateColorDots(colorPickerEl, color);
  });

  // Tag popover
  const toggleTag = (tag: string): void => {
    const draft = getDraft();
    if (!draft) return;
    if (draft.tags.includes(tag)) {
      draft.tags = draft.tags.filter((t) => t !== tag);
    } else {
      draft.tags.push(tag);
    }
    onRenderTags();
    onTagsChanged();
    onRenderTagPopoverOptions(tagOptions, tagSearch.value, draft.tags, toggleTag);
  };

  tagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const draft = getDraft();
    if (!draft) return;
    const isHidden = tagPopover.classList.contains('hidden');
    if (isHidden) {
      tagSearch.value = '';
      onRenderTagPopoverOptions(tagOptions, '', draft.tags, toggleTag);
      tagPopover.classList.remove('hidden');
      tagSearch.focus();
    } else {
      tagPopover.classList.add('hidden');
    }
  });

  tagSearch.addEventListener('input', () => {
    const draft = getDraft();
    if (!draft) return;
    onRenderTagPopoverOptions(tagOptions, tagSearch.value, draft.tags, toggleTag);
  });

  tagsRow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const rmBtn = target?.closest(`[${removeTagAttr}]`);
    const draft = getDraft();
    if (!rmBtn || !draft) return;
    const tag = rmBtn.getAttribute(removeTagAttr);
    if (!tag) return;
    draft.tags = draft.tags.filter((t) => t !== tag);
    onRenderTags();
  });

  // Image popover & controls
  imageBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getDraft() || !imagePopover) return;
    const isHidden = imagePopover.classList.contains('hidden');
    tagPopover.classList.add('hidden');
    if (isHidden) {
      setImageStatus('Tip: Paste images or URLs directly with Ctrl+V');
      imagePopover.classList.remove('hidden');
      imageUrlInput?.focus();
    } else {
      imagePopover.classList.add('hidden');
    }
  });

  uploadImageBtn?.addEventListener('click', () => {
    imageFileInput?.click();
  });

  imageFileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await handleImageFiles(Array.from(input.files));
      imagePopover?.classList.add('hidden');
    }
    input.value = '';
  });

  const submitImageUrl = async (): Promise<void> => {
    const raw = imageUrlInput?.value.trim() ?? '';
    if (!raw || !getDraft()) return;
    setImageStatus('Downloading & processing image...');
    try {
      const noteImg = await noteImageFromUrl(raw);
      attachImage(noteImg);
      if (imageUrlInput) imageUrlInput.value = '';
      setImageStatus(
        noteImg.sourceType === 'embedded'
          ? 'Downloaded & encrypted as WebP!'
          : 'Linked external image (CORS restricted download).'
      );
      setTimeout(() => {
        imagePopover?.classList.add('hidden');
      }, 700);
    } catch (err) {
      setImageStatus(err instanceof Error ? err.message : 'Could not load image URL.', true);
    }
  };

  addImageUrlBtn?.addEventListener('click', () => {
    void submitImageUrl();
  });

  imageUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitImageUrl();
    }
  });

  imagesRow?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const draft = getDraft();
    if (!target || !draft) return;
    const rmBtn = target.closest(`[${removeImageAttr}]`);
    if (rmBtn) {
      e.stopPropagation();
      const imgId = rmBtn.getAttribute(removeImageAttr);
      draft.images = draft.images.filter((img) => img.id !== imgId);
      onRenderImages();
      return;
    }
    const lightImg = target.closest('[data-lightbox-src]');
    if (lightImg) {
      e.stopPropagation();
      onOpenLightbox(lightImg.getAttribute('data-lightbox-src') ?? '');
    }
  });

  // Clipboard paste & Drag-and-Drop on surface
  surfaceEl.addEventListener('paste', (e) => {
    if (e.target === imageUrlInput) return;
    void handleClipboardPaste(e);
  });

  surfaceEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      surfaceEl.classList.add('drag-over');
    }
  });

  surfaceEl.addEventListener('dragleave', () => {
    surfaceEl.classList.remove('drag-over');
  });

  surfaceEl.addEventListener('drop', async (e) => {
    surfaceEl.classList.remove('drag-over');
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      await handleImageFiles(Array.from(e.dataTransfer.files));
    }
  });

  const closePopoversIfOutside = (target: Node | null): void => {
    if (!target) return;
    if (!tagPopover.contains(target) && target !== tagBtn) {
      tagPopover.classList.add('hidden');
    }
    if (
      imagePopover &&
      !imagePopover.contains(target) &&
      target !== imageBtn &&
      !imageBtn?.contains(target)
    ) {
      imagePopover.classList.add('hidden');
    }
  };

  return {
    handleClipboardPaste,
    closePopoversIfOutside,
  };
}
