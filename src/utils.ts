/**
 * Shared DOM, text escaping, and formatting utilities for Crypsy.
 */

export const APP_VERSION =
  typeof __CRYPSY_VERSION__ === 'string' && __CRYPSY_VERSION__.length > 0
    ? __CRYPSY_VERSION__
    : 'dev';

export function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const rand =
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${prefix}-${Date.now()}-${rand}`;
}

export function normalizeTag(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/^#/, '');
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return el as T;
}

export function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightText(text: string, query: string): string {
  const raw = String(text);
  if (!query || !query.trim()) return escapeHtml(raw);
  const cleanQ = query.trim().replace(/^#/, '');
  if (!cleanQ) return escapeHtml(raw);
  const escapedRegex = cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedRegex, 'gi');
  let out = '';
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIdx) {
      out += escapeHtml(raw.slice(lastIdx, match.index));
    }
    out += `<mark class="search-highlight">${escapeHtml(match[0])}</mark>`;
    lastIdx = regex.lastIndex;
    if (match[0].length === 0) break;
  }
  if (lastIdx < raw.length) {
    out += escapeHtml(raw.slice(lastIdx));
  }
  return out;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(ms: number): string {
  if (!ms) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return formatTimestamp(ms);
}

export function autoResizeTextarea(textarea: HTMLTextAreaElement, minHeight = 32): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
}

export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export function getRotatedRectAabb(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!rotation) {
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    { lx: -w / 2, ly: -h / 2 },
    { lx: w / 2, ly: -h / 2 },
    { lx: -w / 2, ly: h / 2 },
    { lx: w / 2, ly: h / 2 },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const rx = cx + c.lx * cos - c.ly * sin;
    const ry = cy + c.lx * sin + c.ly * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { minX, minY, maxX, maxY };
}

export function isSafeDataImageUrl(url: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico);base64,[A-Za-z0-9+/=]+$/i.test(
    String(url).trim()
  );
}

export function isExternalHttpUrl(url: string): boolean {
  const trimmed = String(url).trim();
  if (!trimmed) return false;
  if (/^https?:/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
