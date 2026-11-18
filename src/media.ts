/**
 * Shared client-side image compression, URL fetching, and clipboard media parsing.
 */

import type { NoteImage } from './types';

const MAX_IMAGE_DIMENSION = 1440;
const WEBP_QUALITY = 0.82;

export function createImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Decodes an image Blob, scales it to fit MAX_IMAGE_DIMENSION, and encodes to WebP (or JPEG fallback).
 */
export async function compressImageBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) {
        width = 800;
        height = 600;
      }
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const webp = canvas.toDataURL('image/webp', WEBP_QUALITY);
      resolve(
        webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', WEBP_QUALITY)
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not decode image file'));
    };
    img.src = objectUrl;
  });
}

/**
 * Converts a local File or clipboard Blob into an embedded WebP NoteImage.
 */
export async function noteImageFromFile(file: File | Blob, alt?: string): Promise<NoteImage> {
  const dataUrl = await compressImageBlobToDataUrl(file);
  return {
    id: createImageId(),
    src: dataUrl,
    alt: alt || (file instanceof File ? file.name : 'Pasted image'),
    sourceType: 'embedded',
    createdAt: Date.now(),
  };
}

/**
 * Downloads an image from a URL and compresses it to an embedded WebP data URL
 * so it is encrypted inside the vault. If the remote host blocks CORS fetch(),
 * falls back to verifying via <img> load and storing as an external URL with
 * referrerpolicy="no-referrer".
 */
export async function noteImageFromUrl(rawUrl: string, alt?: string): Promise<NoteImage> {
  const url = rawUrl.trim();
  if (!url) throw new Error('Empty image URL');

  if (url.startsWith('data:image/')) {
    const res = await fetch(url);
    const blob = await res.blob();
    return noteImageFromFile(blob, alt || 'Embedded image');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http:// and https:// image URLs are supported');
  }

  try {
    const res = await fetch(parsed.href, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.type.startsWith('image/') || blob.size > 0) {
        const dataUrl = await compressImageBlobToDataUrl(blob);
        return {
          id: createImageId(),
          src: dataUrl,
          alt: alt || parsed.pathname.split('/').pop() || 'Downloaded image',
          sourceType: 'embedded',
          createdAt: Date.now(),
        };
      }
    }
  } catch {
    // CORS blocked or fetch failed; fall back to direct <img> verification
  }

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load image from URL'));
    img.src = parsed.href;
  });

  return {
    id: createImageId(),
    src: parsed.href,
    alt: alt || parsed.pathname.split('/').pop() || 'External image',
    sourceType: 'external',
    createdAt: Date.now(),
  };
}

export function extractStandaloneImageUrl(
  text: string
): { url: string; alt?: string | undefined } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const mdMatch = trimmed.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)$/i);
  if (mdMatch && mdMatch[2]) {
    return { url: mdMatch[2], alt: mdMatch[1] || undefined };
  }
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith('data:image/')) {
    return { url: trimmed };
  }
  if (/^https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#][^\s]*)?$/i.test(trimmed)) {
    return { url: trimmed };
  }
  return null;
}

export function extractImageUrlFromClipboardHtml(
  html: string
): { url: string; alt?: string | undefined } | null {
  if (!html || !html.includes('<img')) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img[src]');
    const src = img?.getAttribute('src')?.trim();
    if (
      src &&
      (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image/'))
    ) {
      return { url: src, alt: img?.getAttribute('alt') || undefined };
    }
  } catch {
    // ignore parse failure
  }
  return null;
}

export function extractStandaloneWebUrl(
  text: string
): { url: string; label?: string | undefined } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const mdLinkMatch = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
  if (mdLinkMatch && mdLinkMatch[2]) {
    return { url: mdLinkMatch[2], label: mdLinkMatch[1] || undefined };
  }
  if (/\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { url: parsed.href };
    }
  } catch {
    return null;
  }
  return null;
}

export function extractClipboardImages(cd: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < cd.items.length; i++) {
    const item = cd.items[i];
    if (item && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}
