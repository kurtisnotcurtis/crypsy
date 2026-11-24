/**
 * Crypsy — Vault Payload Boundary Normalization & Conflict Merging
 *
 * All decrypted vault JSON passes through `normalizeVaultPayload()` before
 * touching application state or DOM rendering. Numbers are coerced and bounded,
 * enums are whitelisted, URLs are canonicalized & protocol-checked, arrays/strings
 * are bounded against DoS payloads, duplicate IDs are deduplicated, and merges
 * respect deletion tombstones and item-level board edits.
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
import { createId, isSafeDataImageUrl, normalizeTag } from '../utils';

export const PAYLOAD_LIMITS = {
  maxNotes: 10_000,
  maxBoards: 500,
  maxTags: 2_000,
  maxTagsPerItem: 100,
  maxTagLength: 100,
  maxImagesPerNote: 50,
  maxBoardItems: 5_000,
  maxStrokePoints: 10_000,
  maxTitleLength: 2_000,
  maxDescriptionLength: 500_000,
  maxBoardTextLength: 100_000,
  maxUrlLength: 8_192,
  maxDataImageLength: 10_000_000,
  maxTombstones: 5_000,
  maxIdLength: 200,
} as const;

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

function asBoundedString(val: unknown, maxLen: number, fallback = ''): string {
  if (typeof val !== 'string') return fallback;
  return val.length > maxLen ? val.slice(0, maxLen) : val;
}

function asUniqueId(val: unknown, prefix: string, seen: Set<string>): string {
  let candidate =
    typeof val === 'string' && val.trim().length > 0
      ? val.trim().slice(0, PAYLOAD_LIMITS.maxIdLength)
      : createId(prefix);
  while (seen.has(candidate)) {
    candidate = createId(prefix);
  }
  seen.add(candidate);
  return candidate;
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

/**
 * Validates and canonicalizes an HTTP(S) URL.
 * Rejects control characters and non-HTTP(S) schemes, and returns `parsed.href`
 * so malformed tricks like `https:\\host\x.png` or scheme tabs cannot bypass
 * downstream Strict Media Privacy gates.
 */
export function normalizeSafeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PAYLOAD_LIMITS.maxUrlLength) return null;
  // Reject ASCII control chars (tabs, newlines, NUL, etc.) anywhere in raw URL
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function isSafeHttpUrl(raw: unknown): raw is string {
  return normalizeSafeHttpUrl(raw) !== null;
}

export function isSafeImageSrc(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.length <= PAYLOAD_LIMITS.maxDataImageLength && isSafeDataImageUrl(trimmed)) {
    return true;
  }
  return normalizeSafeHttpUrl(trimmed) !== null;
}

function normalizeTagList(raw: unknown, maxCount: number = PAYLOAD_LIMITS.maxTagsPerItem): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= maxCount) break;
    if (typeof item !== 'string') continue;
    const clean = normalizeTag(item).slice(0, PAYLOAD_LIMITS.maxTagLength);
    if (clean && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out;
}

function normalizeTombstoneMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.trim().slice(0, PAYLOAD_LIMITS.maxIdLength);
    if (!id) continue;
    const ts = asOptionalFiniteNumber(v, 0);
    if (ts !== undefined) {
      entries.push([id, ts]);
    }
  }
  if (entries.length === 0) return undefined;
  if (entries.length > PAYLOAD_LIMITS.maxTombstones) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = PAYLOAD_LIMITS.maxTombstones;
  }
  return Object.fromEntries(entries);
}

function normalizeNoteImage(raw: unknown, now: number, seenImgIds: Set<string>): NoteImage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.src !== 'string') return null;
  const trimmed = obj.src.trim();
  if (!trimmed) return null;

  let canonicalSrc: string;
  let sourceType: NoteImage['sourceType'];
  if (trimmed.length <= PAYLOAD_LIMITS.maxDataImageLength && isSafeDataImageUrl(trimmed)) {
    canonicalSrc = trimmed;
    sourceType = 'embedded';
  } else {
    const safeUrl = normalizeSafeHttpUrl(trimmed);
    if (!safeUrl) return null;
    canonicalSrc = safeUrl;
    // Always enforce 'external' for any HTTP(S) URL regardless of claimed sourceType
    sourceType = 'external';
  }

  const alt =
    typeof obj.alt === 'string'
      ? asBoundedString(obj.alt, PAYLOAD_LIMITS.maxTitleLength)
      : undefined;
  return {
    id: asUniqueId(obj.id, 'img', seenImgIds),
    src: canonicalSrc,
    ...(alt !== undefined ? { alt } : {}),
    sourceType,
    createdAt: asFiniteNumber(obj.createdAt, now, 0),
  };
}

function normalizeNote(raw: unknown, now: number, seenNoteIds: Set<string>): Note | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const createdAt = asFiniteNumber(obj.createdAt, now, 0);
  const updatedAt = asFiniteNumber(obj.updatedAt, createdAt, 0);
  const seenImgIds = new Set<string>();
  const images = Array.isArray(obj.images)
    ? obj.images
        .slice(0, PAYLOAD_LIMITS.maxImagesPerNote)
        .map((img) => normalizeNoteImage(img, now, seenImgIds))
        .filter((img): img is NoteImage => img !== null)
    : undefined;

  return {
    id: asUniqueId(obj.id, 'note', seenNoteIds),
    title: asBoundedString(obj.title, PAYLOAD_LIMITS.maxTitleLength),
    description: asBoundedString(obj.description, PAYLOAD_LIMITS.maxDescriptionLength),
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
  const limit = Math.min(raw.length, PAYLOAD_LIMITS.maxStrokePoints);
  for (let i = 0; i < limit; i++) {
    const pt = raw[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const x = asFiniteNumber(pt[0], NaN, -1e6, 1e6);
    const y = asFiniteNumber(pt[1], NaN, -1e6, 1e6);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const p = asFiniteNumber(pt[2], 0.5, 0.05, 1);
    out.push([x, y, p]);
  }
  return out;
}

function normalizeBoardItem(
  raw: unknown,
  index: number,
  now: number,
  seenItemIds: Set<string>
): BoardItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type !== 'text' && type !== 'image' && type !== 'link' && type !== 'stroke') {
    return null;
  }

  const base = {
    id: asUniqueId(obj.id, 'bi', seenItemIds),
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
      content: asBoundedString(obj.content, PAYLOAD_LIMITS.maxBoardTextLength),
      align: sanitizeBoardTextAlign(obj.align),
      fontSize: asFiniteNumber(obj.fontSize, 15, 8, 120),
      ...(obj.bold !== undefined ? { bold: Boolean(obj.bold) } : {}),
      ...(obj.italic !== undefined ? { italic: Boolean(obj.italic) } : {}),
    };
    return item;
  }

  if (type === 'image') {
    const image = normalizeNoteImage(obj.image, now, new Set<string>());
    if (!image) return null;
    const item: BoardImageItem = {
      ...base,
      type: 'image',
      image,
    };
    return item;
  }

  if (type === 'link') {
    const canonicalUrl = normalizeSafeHttpUrl(obj.url);
    if (!canonicalUrl) return null;
    const label =
      typeof obj.label === 'string'
        ? asBoundedString(obj.label, PAYLOAD_LIMITS.maxTitleLength)
        : undefined;
    const description =
      typeof obj.description === 'string'
        ? asBoundedString(obj.description, PAYLOAD_LIMITS.maxTitleLength)
        : undefined;
    const item: BoardLinkItem = {
      ...base,
      type: 'link',
      url: canonicalUrl,
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

function normalizeBoard(raw: unknown, now: number, seenBoardIds: Set<string>): Board | null {
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

  const seenItemIds = new Set<string>();
  const items = Array.isArray(obj.items)
    ? obj.items
        .slice(0, PAYLOAD_LIMITS.maxBoardItems)
        .map((it, idx) => normalizeBoardItem(it, idx, now, seenItemIds))
        .filter((it): it is BoardItem => it !== null)
    : [];

  const gridStyle = sanitizeBoardGridStyle(obj.gridStyle);
  const deletedItemIds = normalizeTombstoneMap(obj.deletedItemIds);

  return {
    id: asUniqueId(obj.id, 'board', seenBoardIds),
    title: asBoundedString(obj.title, PAYLOAD_LIMITS.maxTitleLength),
    tags: normalizeTagList(obj.tags),
    pinned: Boolean(obj.pinned),
    color: sanitizeNoteColor(obj.color),
    ...(gridStyle !== undefined ? { gridStyle } : {}),
    viewport,
    items,
    ...(deletedItemIds ? { deletedItemIds } : {}),
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

  const seenNoteIds = new Set<string>();
  const notes = Array.isArray(obj.notes)
    ? obj.notes
        .slice(0, PAYLOAD_LIMITS.maxNotes)
        .map((n) => normalizeNote(n, now, seenNoteIds))
        .filter((n): n is Note => n !== null)
    : [];

  const seenBoardIds = new Set<string>();
  const boards = Array.isArray(obj.boards)
    ? obj.boards
        .slice(0, PAYLOAD_LIMITS.maxBoards)
        .map((b) => normalizeBoard(b, now, seenBoardIds))
        .filter((b): b is Board => b !== null)
    : [];

  const tagSet = new Set<string>(normalizeTagList(obj.tags, PAYLOAD_LIMITS.maxTags));
  for (const n of notes) {
    for (const t of n.tags) {
      if (tagSet.size >= PAYLOAD_LIMITS.maxTags) break;
      tagSet.add(t);
    }
  }
  for (const b of boards) {
    for (const t of b.tags) {
      if (tagSet.size >= PAYLOAD_LIMITS.maxTags) break;
      tagSet.add(t);
    }
  }

  const deletedIds = normalizeTombstoneMap(obj.deletedIds);

  return {
    notes,
    tags: Array.from(tagSet),
    boards,
    ...(deletedIds ? { deletedIds } : {}),
  };
}

function mergeTombstoneMaps(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = {};
  if (b) {
    for (const [id, ts] of Object.entries(b)) {
      merged[id] = ts;
    }
  }
  if (a) {
    for (const [id, ts] of Object.entries(a)) {
      const prev = merged[id];
      if (prev === undefined || ts > prev) {
        merged[id] = ts;
      }
    }
  }
  return merged;
}

function mergeBoardPair(local: Board, remote: Board): Board {
  const localWinsMeta = local.updatedAt >= remote.updatedAt;
  const primary = localWinsMeta ? local : remote;
  const mergedDeletedItemIds = mergeTombstoneMaps(local.deletedItemIds, remote.deletedItemIds);

  const itemMap = new Map<string, { item: BoardItem; boardUpdatedAt: number; fromLocal: boolean }>();
  for (const it of remote.items) {
    itemMap.set(it.id, { item: structuredClone(it), boardUpdatedAt: remote.updatedAt, fromLocal: false });
  }
  for (const it of local.items) {
    const existing = itemMap.get(it.id);
    if (!existing || local.updatedAt >= existing.boardUpdatedAt) {
      itemMap.set(it.id, { item: structuredClone(it), boardUpdatedAt: local.updatedAt, fromLocal: true });
    }
  }

  // Respect item-level deletion tombstones unless the item's board was edited strictly later
  const mergedItems: BoardItem[] = [];
  for (const [id, entry] of itemMap.entries()) {
    const deletedAt = mergedDeletedItemIds[id];
    if (deletedAt !== undefined && deletedAt >= entry.boardUpdatedAt) {
      continue;
    }
    if (deletedAt !== undefined && entry.boardUpdatedAt > deletedAt) {
      delete mergedDeletedItemIds[id];
    }
    mergedItems.push(entry.item);
  }
  mergedItems.sort((a, b) => a.zIndex - b.zIndex);

  const mergedTags = Array.from(new Set([...(remote.tags || []), ...(local.tags || [])]));
  const hasTombstones = Object.keys(mergedDeletedItemIds).length > 0;

  return {
    ...structuredClone(primary),
    tags: mergedTags,
    items: mergedItems,
    ...(hasTombstones ? { deletedItemIds: mergedDeletedItemIds } : { deletedItemIds: undefined }),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/**
 * Conflict merge of two decrypted vault payloads:
 * - Respects deletion tombstones (`deletedIds` & per-board `deletedItemIds`) so deleted items
 *   are not silently resurrected by an older peer.
 * - Unions notes by `id` (preferring higher `updatedAt`, local on tie).
 * - Merges concurrently edited boards at the **item level** so additions from both devices survive.
 */
export function mergeVaultPayloads(local: VaultPayload, remote: VaultPayload): VaultPayload {
  const mergedDeletedIds = mergeTombstoneMaps(local.deletedIds, remote.deletedIds);

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

  const notes: Note[] = [];
  for (const [id, note] of noteMap.entries()) {
    const deletedAt = mergedDeletedIds[id];
    if (deletedAt !== undefined && deletedAt >= note.updatedAt) {
      continue;
    }
    if (deletedAt !== undefined && note.updatedAt > deletedAt) {
      delete mergedDeletedIds[id];
    }
    notes.push(note);
  }

  const boardMap = new Map<string, Board>();
  for (const b of remote.boards ?? []) {
    boardMap.set(b.id, structuredClone(b));
  }
  for (const b of local.boards ?? []) {
    const existing = boardMap.get(b.id);
    if (!existing) {
      boardMap.set(b.id, structuredClone(b));
    } else {
      boardMap.set(b.id, mergeBoardPair(b, existing));
    }
  }

  const boards: Board[] = [];
  for (const [id, board] of boardMap.entries()) {
    const deletedAt = mergedDeletedIds[id];
    if (deletedAt !== undefined && deletedAt >= board.updatedAt) {
      continue;
    }
    if (deletedAt !== undefined && board.updatedAt > deletedAt) {
      delete mergedDeletedIds[id];
    }
    boards.push(board);
  }

  const tags = Array.from(new Set([...(remote.tags || []), ...(local.tags || [])]));

  const hasDeletedIds = Object.keys(mergedDeletedIds).length > 0;
  return {
    notes: notes.sort((a, b) => b.updatedAt - a.updatedAt),
    boards: boards.sort((a, b) => b.updatedAt - a.updatedAt),
    tags,
    ...(hasDeletedIds ? { deletedIds: mergedDeletedIds } : {}),
  };
}
