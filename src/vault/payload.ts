/**
 * Crypsy — Vault Payload Boundary Normalization & Conflict Merging
 *
 * All decrypted vault JSON passes through `normalizeVaultPayload()` before
 * touching application state or DOM rendering. Numbers are coerced and bounded,
 * enums are whitelisted, URLs are protocol-checked, and arrays are defaulted.
 */

import { sanitizeInkColor, type StrokePoint } from '../board/ink';
import {
  BOARD_GRID_STYLES,
  BOARD_INK_TOOLS,
  BOARD_TEXT_ALIGNS,
  NOTE_COLORS,
  type Board,
  type BoardGridStyle,
  type BoardImageItem,
  type BoardInkTool,
  type BoardItem,
  type BoardLinkItem,
  type BoardStrokeItem,
  type BoardTextAlign,
  type BoardTextItem,
  type Note,
  type NoteColor,
  type NoteImage,
  type VaultPayload,
} from '../types';
import { createId, normalizeTag } from '../utils';

const NOTE_COLOR_SET: ReadonlySet<string> = new Set(NOTE_COLORS);
const TEXT_ALIGN_SET: ReadonlySet<string> = new Set(BOARD_TEXT_ALIGNS);
const INK_TOOL_SET: ReadonlySet<string> = new Set(BOARD_INK_TOOLS);
const GRID_STYLE_SET: ReadonlySet<string> = new Set(BOARD_GRID_STYLES);

function asFiniteNumber(val: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

function asOptionalFiniteNumber(val: unknown, min?: number, max?: number): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return undefined;
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

function asString(val: unknown, fallback = ''): string {
  return typeof val === 'string' ? val : fallback;
}

function asNonEmptyId(val: unknown, prefix: string): string {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  return createId(prefix);
}

export function sanitizeNoteColor(val: unknown): NoteColor {
  return typeof val === 'string' && NOTE_COLOR_SET.has(val) ? (val as NoteColor) : 'default';
}

export function sanitizeBoardTextAlign(val: unknown): BoardTextAlign {
  return typeof val === 'string' && TEXT_ALIGN_SET.has(val) ? (val as BoardTextAlign) : 'left';
}

export function sanitizeBoardInkTool(val: unknown): BoardInkTool {
  return typeof val === 'string' && INK_TOOL_SET.has(val) ? (val as BoardInkTool) : 'pen';
}

export function sanitizeBoardGridStyle(val: unknown): BoardGridStyle | undefined {
  return typeof val === 'string' && GRID_STYLE_SET.has(val)
    ? (val as BoardGridStyle)
    : undefined;
}

export function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSafeImageSrc(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return true;
  }
  return isSafeHttpUrl(trimmed);
}

function normalizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = normalizeTag(item);
    if (clean && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out;
}

function normalizeNoteImage(raw: unknown, now: number): NoteImage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!isSafeImageSrc(obj.src)) return null;
  const src = obj.src.trim();
  const sourceType: NoteImage['sourceType'] =
    obj.sourceType === 'external' || /^https?:\/\//i.test(src) ? 'external' : 'embedded';
  const alt = typeof obj.alt === 'string' ? obj.alt : undefined;
  return {
    id: asNonEmptyId(obj.id, 'img'),
    src,
    ...(alt !== undefined ? { alt } : {}),
    sourceType,
    createdAt: asFiniteNumber(obj.createdAt, now, 0),
  };
}

function normalizeNote(raw: unknown, now: number): Note | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const createdAt = asFiniteNumber(obj.createdAt, now, 0);
  const updatedAt = asFiniteNumber(obj.updatedAt, createdAt, 0);
  const images = Array.isArray(obj.images)
    ? obj.images
        .map((img) => normalizeNoteImage(img, now))
        .filter((img): img is NoteImage => img !== null)
    : undefined;

  return {
    id: asNonEmptyId(obj.id, 'note'),
    title: asString(obj.title),
    description: asString(obj.description),
    ...(images && images.length > 0 ? { images } : {}),
    tags: normalizeTagList(obj.tags),
    pinned: Boolean(obj.pinned),
    color: sanitizeNoteColor(obj.color),
    createdAt,
    updatedAt,
  };
}

function normalizeStrokePoints(raw: unknown): StrokePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: StrokePoint[] = [];
  for (const pt of raw) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const x = asFiniteNumber(pt[0], NaN);
    const y = asFiniteNumber(pt[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const p = asFiniteNumber(pt[2], 0.5, 0.05, 1);
    out.push([x, y, p]);
  }
  return out;
}

function normalizeBoardItem(raw: unknown, index: number, now: number): BoardItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type !== 'text' && type !== 'image' && type !== 'link' && type !== 'stroke') {
    return null;
  }

  const base = {
    id: asNonEmptyId(obj.id, 'bi'),
    x: asFiniteNumber(obj.x, 0, -1e6, 1e6),
    y: asFiniteNumber(obj.y, 0, -1e6, 1e6),
    width: asFiniteNumber(obj.width, type === 'stroke' ? 24 : 240, 12, 20000),
    height: asOptionalFiniteNumber(obj.height, 12, 20000),
    rotation: asFiniteNumber(obj.rotation, 0, -3600, 3600),
    zIndex: Math.floor(asFiniteNumber(obj.zIndex, index + 1, 0, 1e6)),
    color: obj.color !== undefined ? sanitizeNoteColor(obj.color) : undefined,
  };

  if (type === 'text') {
    const item: BoardTextItem = {
      ...base,
      type: 'text',
      content: asString(obj.content),
      align: sanitizeBoardTextAlign(obj.align),
      fontSize: asFiniteNumber(obj.fontSize, 15, 8, 120),
      ...(obj.bold !== undefined ? { bold: Boolean(obj.bold) } : {}),
      ...(obj.italic !== undefined ? { italic: Boolean(obj.italic) } : {}),
    };
    return item;
  }

  if (type === 'image') {
    const image = normalizeNoteImage(obj.image, now);
    if (!image) return null;
    const item: BoardImageItem = {
      ...base,
      type: 'image',
      image,
    };
    return item;
  }

  if (type === 'link') {
    if (!isSafeHttpUrl(obj.url)) return null;
    const label = typeof obj.label === 'string' ? obj.label : undefined;
    const description = typeof obj.description === 'string' ? obj.description : undefined;
    const item: BoardLinkItem = {
      ...base,
      type: 'link',
      url: obj.url.trim(),
      ...(label !== undefined ? { label } : {}),
      ...(description !== undefined ? { description } : {}),
    };
    return item;
  }

  // stroke
  const tool = sanitizeBoardInkTool(obj.tool);
  const points = normalizeStrokePoints(obj.points);
  if (points.length === 0) return null;
  const sourceWidth = asFiniteNumber(obj.sourceWidth, base.width, 12, 20000);
  const sourceHeight = asFiniteNumber(obj.sourceHeight, base.height ?? 16, 12, 20000);
  const strokeItem: BoardStrokeItem = {
    ...base,
    height: base.height ?? sourceHeight,
    type: 'stroke',
    tool,
    strokeColor: sanitizeInkColor(typeof obj.strokeColor === 'string' ? obj.strokeColor : undefined),
    strokeWidth: asFiniteNumber(obj.strokeWidth, tool === 'highlighter' ? 18 : 3, 1, 64),
    opacity: asFiniteNumber(obj.opacity, tool === 'highlighter' ? 0.42 : 1, 0.05, 1),
    sourceWidth,
    sourceHeight,
    points,
  };
  return strokeItem;
}

function normalizeBoard(raw: unknown, now: number): Board | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const createdAt = asFiniteNumber(obj.createdAt, now, 0);
  const updatedAt = asFiniteNumber(obj.updatedAt, createdAt, 0);

  const rawVp =
    obj.viewport && typeof obj.viewport === 'object' && !Array.isArray(obj.viewport)
      ? (obj.viewport as Record<string, unknown>)
      : {};
  const viewport = {
    panX: asFiniteNumber(rawVp.panX, 0, -1e6, 1e6),
    panY: asFiniteNumber(rawVp.panY, 0, -1e6, 1e6),
    zoom: asFiniteNumber(rawVp.zoom, 1, 0.25, 2.5),
  };

  const items = Array.isArray(obj.items)
    ? obj.items
        .map((it, idx) => normalizeBoardItem(it, idx, now))
        .filter((it): it is BoardItem => it !== null)
    : [];

  const gridStyle = sanitizeBoardGridStyle(obj.gridStyle);

  return {
    id: asNonEmptyId(obj.id, 'board'),
    title: asString(obj.title),
    tags: normalizeTagList(obj.tags),
    pinned: Boolean(obj.pinned),
    color: sanitizeNoteColor(obj.color),
    ...(gridStyle !== undefined ? { gridStyle } : {}),
    viewport,
    items,
    createdAt,
    updatedAt,
  };
}

/**
 * Validates and normalizes any decrypted vault JSON into a guaranteed-safe `VaultPayload`.
 */
export function normalizeVaultPayload(raw: unknown, now = Date.now()): VaultPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Decrypted vault payload is not a valid object.');
  }
  const obj = raw as Record<string, unknown>;

  const notes = Array.isArray(obj.notes)
    ? obj.notes.map((n) => normalizeNote(n, now)).filter((n): n is Note => n !== null)
    : [];

  const boards = Array.isArray(obj.boards)
    ? obj.boards.map((b) => normalizeBoard(b, now)).filter((b): b is Board => b !== null)
    : [];

  const tagSet = new Set<string>(normalizeTagList(obj.tags));
  for (const n of notes) {
    for (const t of n.tags) tagSet.add(t);
  }
  for (const b of boards) {
    for (const t of b.tags) tagSet.add(t);
  }

  return {
    notes,
    tags: Array.from(tagSet),
    boards,
  };
}

/**
 * Non-destructive conflict merge of two decrypted vault payloads.
 * Unions notes and boards by `id`, preferring the copy with the higher `updatedAt`.
 */
export function mergeVaultPayloads(local: VaultPayload, remote: VaultPayload): VaultPayload {
  const noteMap = new Map<string, Note>();
  for (const n of remote.notes) {
    noteMap.set(n.id, structuredClone(n));
  }
  for (const n of local.notes) {
    const existing = noteMap.get(n.id);
    if (!existing || n.updatedAt >= existing.updatedAt) {
      noteMap.set(n.id, structuredClone(n));
    }
  }

  const boardMap = new Map<string, Board>();
  for (const b of remote.boards ?? []) {
    boardMap.set(b.id, structuredClone(b));
  }
  for (const b of local.boards ?? []) {
    const existing = boardMap.get(b.id);
    if (!existing || b.updatedAt >= existing.updatedAt) {
      boardMap.set(b.id, structuredClone(b));
    }
  }

  const tags = Array.from(new Set([...(remote.tags || []), ...(local.tags || [])]));
  return {
    notes: Array.from(noteMap.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    boards: Array.from(boardMap.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    tags,
  };
}
