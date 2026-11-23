import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoardContextMenuEntries,
  buildNoteContextMenuEntries,
} from '../src/app-context-menus';
import { computeResizedItemRect, normalizeAngleDeg } from '../src/board-geometry';
import { BoardHistory } from '../src/board-history';
import { alignBoardItemsInPlace, summarizeBoardItemsForClipboard } from '../src/board-ops';
import {
  renderBlockedExternalImageHtml,
  renderBoardTextContentHtml,
} from '../src/board-render';
import { createBoardCardHtml, createNoteCardHtml } from '../src/card-render';
import { clampMenuPosition } from '../src/context-menu';
import {
  decryptPayload,
  encryptPayload,
  isValidEncryptedEnvelope,
  PBKDF2_ITERATIONS,
} from '../src/crypto';
import {
  AUTO_INK_TOKEN,
  buildCenterlinePath,
  buildVariableWidthStrokePath,
  lassoSelectsRect,
  lassoSelectsStroke,
  normalizeRawStroke,
  pointInPolygon,
  sanitizeInkColor,
  segmentHitsStroke,
  simplifyStrokePoints,
} from '../src/ink';
import { renderMarkdownDescription, toggleCheckboxLine } from '../src/markdown';
import { extractStandaloneImageUrl, extractStandaloneWebUrl } from '../src/media';
import { parseStoredPreferences, validateNewPassphrase } from '../src/preferences';
import { filterBoards, filterNotes } from '../src/search-filter';
import {
  deleteTagInVault,
  duplicateBoardInList,
  duplicateNoteInList,
  renameTagInVault,
} from '../src/vault-mutations';
import type { Board, BoardStrokeItem, Note, VaultPayload } from '../src/types';
import { compareSemver } from '../src/updates';
import {
  createId,
  escapeHtml,
  getRotatedRectAabb,
  highlightText,
  isExternalHttpUrl,
} from '../src/utils';

describe('crypto', () => {
  it('round-trips a vault payload with AES-256-GCM', async () => {
    const payload: VaultPayload = {
      notes: [
        {
          id: 'n1',
          title: 'Secret',
          description: 'Top secret body',
          tags: ['security'],
          pinned: true,
          color: 'teal',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      tags: ['security'],
      boards: [],
    };
    const envelope = await encryptPayload(payload, 'correct-horse-battery');
    assert.equal(envelope.cipher, 'AES-256-GCM');
    assert.equal(envelope.kdf, 'PBKDF2-SHA256');
    assert.equal(envelope.iterations, PBKDF2_ITERATIONS);
    assert.equal(isValidEncryptedEnvelope(envelope), true);

    const decrypted = await decryptPayload(envelope, 'correct-horse-battery');
    assert.deepEqual(decrypted, payload);
  });

  it('rejects decryption with wrong passphrase', async () => {
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'passphrase-one');
    await assert.rejects(() => decryptPayload(envelope, 'passphrase-two'));
  });

  it('rejects empty passphrase and invalid iteration counts', async () => {
    await assert.rejects(() => encryptPayload({ notes: [], tags: [] }, ''));
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'valid-passphrase');
    await assert.rejects(() =>
      decryptPayload({ ...envelope, iterations: 100 }, 'valid-passphrase')
    );
  });

  it('validates encrypted envelope shape', () => {
    assert.equal(isValidEncryptedEnvelope(null), false);
    assert.equal(isValidEncryptedEnvelope({}), false);
    assert.equal(isValidEncryptedEnvelope({ salt: 'a', iv: 'b', ciphertext: '' }), false);
    assert.equal(isValidEncryptedEnvelope({ salt: 'a', iv: 'b', ciphertext: 'c' }), true);
  });
});

describe('ink geometry', () => {
  it('sanitizes ink colors against injection', () => {
    assert.equal(sanitizeInkColor(undefined), AUTO_INK_TOKEN);
    assert.equal(sanitizeInkColor(AUTO_INK_TOKEN), AUTO_INK_TOKEN);
    assert.equal(sanitizeInkColor('#4285f4'), '#4285f4');
    assert.equal(sanitizeInkColor('red; background:url(x)'), AUTO_INK_TOKEN);
  });

  it('simplifies collinear points while keeping endpoints', () => {
    const simplified = simplifyStrokePoints(
      [
        [0, 0, 0.5],
        [10, 0, 0.5],
        [20, 0, 0.5],
        [30, 0, 0.5],
      ],
      0.5
    );
    assert.equal(simplified.length, 2);
    assert.deepEqual(simplified[0], [0, 0, 0.5]);
    assert.deepEqual(simplified[1], [30, 0, 0.5]);
  });

  it('normalizes raw strokes and builds non-empty SVG paths', () => {
    const norm = normalizeRawStroke(
      [
        [100, 100, 0.5],
        [140, 120, 0.7],
        [180, 110, 0.6],
      ],
      'pen',
      4
    );
    assert.ok(norm.width > 80);
    assert.ok(norm.height > 20);
    assert.ok(buildCenterlinePath(norm.points).startsWith('M'));
    assert.ok(buildVariableWidthStrokePath(norm.points, 4).endsWith('Z'));
  });

  it('hit-tests strokes with eraser segment and lasso polygon', () => {
    const norm = normalizeRawStroke(
      [
        [10, 10, 0.5],
        [110, 10, 0.5],
      ],
      'pen',
      4
    );
    const stroke: BoardStrokeItem = {
      id: 's1',
      type: 'stroke',
      tool: 'pen',
      strokeColor: '#4285f4',
      strokeWidth: 4,
      opacity: 1,
      x: norm.x,
      y: norm.y,
      width: norm.width,
      height: norm.height,
      sourceWidth: norm.sourceWidth,
      sourceHeight: norm.sourceHeight,
      rotation: 0,
      zIndex: 1,
      points: norm.points,
    };

    assert.equal(segmentHitsStroke(stroke, stroke.width, stroke.height!, 60, 0, 60, 20, 6), true);
    assert.equal(segmentHitsStroke(stroke, stroke.width, stroke.height!, 60, 80, 60, 100, 6), false);

    const box: [number, number][] = [
      [0, 0],
      [120, 0],
      [120, 40],
      [0, 40],
    ];
    assert.equal(pointInPolygon(50, 10, box), true);
    assert.equal(pointInPolygon(200, 10, box), false);
    assert.equal(lassoSelectsStroke(stroke, stroke.width, stroke.height!, box), true);
    assert.equal(lassoSelectsRect(20, 10, 30, 20, 0, box), true);
    assert.equal(lassoSelectsRect(200, 200, 30, 20, 0, box), false);
  });
});

describe('utils & media & context-menu', () => {
  it('escapes HTML and highlights search matches safely', () => {
    assert.equal(escapeHtml('<script>"&\'</script>'), '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
    assert.equal(
      highlightText('Hello <world>', 'world'),
      'Hello &lt;<mark class="search-highlight">world</mark>&gt;'
    );
  });

  it('computes rotated AABB accurately', () => {
    const aabb = getRotatedRectAabb(0, 0, 100, 50, 90);
    assert.ok(Math.abs(aabb.minX - 25) < 1e-6);
    assert.ok(Math.abs(aabb.maxX - 75) < 1e-6);
    assert.ok(Math.abs(aabb.minY - -25) < 1e-6);
    assert.ok(Math.abs(aabb.maxY - 75) < 1e-6);
  });

  it('renders markdown links and bare URLs in board text safely', () => {
    const html = renderBoardTextContentHtml('See [Docs](https://example.com) and https://foo.bar', '');
    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(html.includes('href="https://foo.bar"'));
    assert.equal(isExternalHttpUrl('https://example.com'), true);
    assert.equal(isExternalHttpUrl('data:image/webp;base64,abc'), false);
  });

  it('extracts standalone image and web URLs', () => {
    assert.deepEqual(extractStandaloneImageUrl('https://example.com/pic.png?v=1'), {
      url: 'https://example.com/pic.png?v=1',
    });
    assert.equal(extractStandaloneImageUrl('not an image url'), null);
    assert.deepEqual(extractStandaloneWebUrl('[Site](https://example.com/path)'), {
      url: 'https://example.com/path',
      label: 'Site',
    });
    assert.equal(extractStandaloneWebUrl('javascript:alert(1)'), null);
  });

  it('clamps context menu inside viewport bounds', () => {
    const pos = clampMenuPosition(990, 790, 200, 150, 1000, 800, 8);
    assert.equal(pos.left, 790);
    assert.equal(pos.top, 640);
  });

  it('generates prefixed unique IDs and blocked-image placeholders', () => {
    assert.ok(createId('note').startsWith('note-'));
    const blocked = renderBlockedExternalImageHtml('https://cdn.example.com/a.png');
    assert.ok(blocked.includes('cdn.example.com'));
    assert.ok(blocked.includes('data-allow-external-url="https://cdn.example.com/a.png"'));
  });
});

describe('markdown', () => {
  it('toggles task checkboxes at specific line indices', () => {
    const src = '- [ ] Buy milk\n- [x] Walk dog\nPlain line';
    assert.equal(toggleCheckboxLine(src, 0), '- [x] Buy milk\n- [x] Walk dog\nPlain line');
    assert.equal(toggleCheckboxLine(src, 1), '- [ ] Buy milk\n- [ ] Walk dog\nPlain line');
    assert.equal(toggleCheckboxLine(src, 2), null);
    assert.equal(toggleCheckboxLine(src, 99), null);
  });

  it('renders task lists, bullets, ordered lists, and search highlights safely', () => {
    const html = renderMarkdownDescription(
      'note-1',
      '- [ ] First task\n- Bullet item\n2. Second item\nHello <tag>',
      'task',
      (src, alt) => `<img src="${src}" alt="${alt}" />`
    );
    assert.ok(html.includes('md-task-list'));
    assert.ok(html.includes('<mark class="search-highlight">task</mark>'));
    assert.ok(html.includes('<ol class="md-list" start="2">'));
    assert.ok(html.includes('Hello &lt;tag&gt;'));
  });
});

describe('board geometry & semver', () => {
  it('normalizes angles into (-180, 180]', () => {
    assert.equal(normalizeAngleDeg(0), 0);
    assert.equal(normalizeAngleDeg(360), 0);
    assert.equal(normalizeAngleDeg(270), -90);
    assert.equal(normalizeAngleDeg(-180), 180);
  });

  it('computes resized item rect anchoring opposite corner and preserving aspect ratio', () => {
    const res = computeResizedItemRect({
      startMetrics: { x: 100, y: 100, w: 200, h: 100, rotation: 0 },
      handle: 'se',
      dx: 100,
      dy: 10,
      minW: 60,
      minH: 45,
      preserveAspect: true,
      aspectRatio: 2,
    });
    assert.equal(res.x, 100);
    assert.equal(res.y, 100);
    assert.equal(res.width, 300);
    assert.equal(res.height, 150);
    assert.equal(res.changedHeight, true);
  });

  it('compares semver strings with optional v prefix', () => {
    assert.equal(compareSemver('v1.6.5', '1.6.4'), 1);
    assert.equal(compareSemver('1.6.4', 'v1.6.4'), 0);
    assert.equal(compareSemver('1.6.3', '1.6.4'), -1);
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  });
});

describe('search & filter', () => {
  const sampleNotes: Note[] = [
    {
      id: 'n1',
      title: 'Grocery List',
      description: '- [ ] Buy oat milk',
      tags: ['home', 'errands'],
      pinned: true,
      color: 'default',
      createdAt: 100,
      updatedAt: 200,
    },
    {
      id: 'n2',
      title: 'Architecture Notes',
      description: 'AES-GCM encryption details',
      tags: ['work'],
      pinned: false,
      color: 'ocean',
      createdAt: 150,
      updatedAt: 300,
    },
  ];

  const sampleBoards: Board[] = [
    {
      id: 'b1',
      title: 'System Diagram',
      tags: ['work'],
      pinned: true,
      color: 'default',
      viewport: { panX: 0, panY: 0, zoom: 1 },
      items: [
        {
          id: 'bi1',
          type: 'text',
          x: 0,
          y: 0,
          width: 200,
          rotation: 0,
          zIndex: 1,
          color: 'default',
          content: 'Zero-knowledge vault sync',
        },
      ],
      createdAt: 100,
      updatedAt: 400,
    },
  ];

  it('filters notes by view type, tag, and #tag search sorted by updatedAt', () => {
    assert.deepEqual(
      filterNotes(sampleNotes, { type: 'all', tag: null }, '').map((n) => n.id),
      ['n2', 'n1']
    );
    assert.deepEqual(
      filterNotes(sampleNotes, { type: 'pinned', tag: null }, '').map((n) => n.id),
      ['n1']
    );
    assert.deepEqual(
      filterNotes(sampleNotes, { type: 'tag', tag: 'work' }, '').map((n) => n.id),
      ['n2']
    );
    assert.deepEqual(
      filterNotes(sampleNotes, { type: 'all', tag: null }, '#errands').map((n) => n.id),
      ['n1']
    );
    assert.deepEqual(filterNotes(sampleNotes, { type: 'boards', tag: null }, ''), []);
  });

  it('hides boards in default All Notes view unless searching, and matches board items', () => {
    assert.deepEqual(filterBoards(sampleBoards, { type: 'all', tag: null }, ''), []);
    assert.deepEqual(
      filterBoards(sampleBoards, { type: 'all', tag: null }, 'zero-knowledge').map((b) => b.id),
      ['b1']
    );
    assert.deepEqual(
      filterBoards(sampleBoards, { type: 'boards', tag: null }, '').map((b) => b.id),
      ['b1']
    );
    assert.deepEqual(
      filterBoards(sampleBoards, { type: 'tag', tag: 'work' }, '').map((b) => b.id),
      ['b1']
    );
  });

  it('tracks undo/redo history snapshots with bounded depth', () => {
    const history = new BoardHistory(2);
    const s0: BoardStrokeItem[] = [];
    const mk = (id: string): BoardStrokeItem => ({
      id,
      type: 'stroke',
      tool: 'pen',
      strokeColor: '#000',
      strokeWidth: 2,
      opacity: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      sourceWidth: 10,
      sourceHeight: 10,
      rotation: 0,
      zIndex: 1,
      points: [[0, 0, 0.5]],
    });
    const s1 = [mk('a')];
    const s2 = [mk('a'), mk('b')];
    const s3 = [mk('a'), mk('b'), mk('c')];

    history.push(s0);
    history.push(s1);
    history.push(s2); // evicts s0 due to maxHistory=2
    assert.equal(history.canUndo(), true);
    assert.equal(history.canRedo(), false);

    const u1 = history.undo(s3);
    assert.equal(u1?.length, 2);
    assert.equal(history.canRedo(), true);

    const u2 = history.undo(u1!);
    assert.equal(u2?.length, 1);
    assert.equal(history.canUndo(), false);

    const r1 = history.redo(u2!);
    assert.equal(r1?.length, 2);
  });

  it('renders note and board cards with safe escaping and privacy placeholders', () => {
    const noteHtml = createNoteCardHtml(
      {
        ...sampleNotes[0]!,
        title: '<b>Secret</b>',
        images: [
          { id: 'img-1', src: 'https://cdn.example.com/pic.png', alt: 'pic', sourceType: 'external' },
        ],
      },
      'secret',
      () => false
    );
    assert.ok(noteHtml.includes('&lt;b&gt;<mark class="search-highlight">Secret</mark>&lt;/b&gt;'));
    assert.ok(noteHtml.includes('data-allow-external-url="https://cdn.example.com/pic.png"'));

    const emptyBoardHtml = createBoardCardHtml(
      { ...sampleBoards[0]!, items: [] },
      '',
      () => true
    );
    assert.ok(emptyBoardHtml.includes('Empty board canvas'));
    assert.ok(emptyBoardHtml.includes('0 items'));
  });

  it('builds declarative note and board context menu entries', () => {
    const noop = () => {};
    const noteMenu = buildNoteContextMenuEntries(sampleNotes[0]!, {
      onEdit: noop,
      onTogglePin: noop,
      onDuplicate: noop,
      onCopyText: noop,
      onSetColor: noop,
      onDelete: noop,
    });
    const pinEntry = noteMenu.find((e) => e.type === 'action' && e.id === 'pin-note');
    assert.equal(pinEntry?.type === 'action' ? pinEntry.label : '', 'Unpin Note');

    const boardMenuNoRename = buildBoardContextMenuEntries(sampleBoards[0]!, {
      onOpen: noop,
      onTogglePin: noop,
      onDuplicate: noop,
      onSetColor: noop,
      onDelete: noop,
    });
    assert.equal(
      boardMenuNoRename.some((e) => e.type === 'action' && e.id === 'rename-board'),
      false
    );

    const boardMenuWithRename = buildBoardContextMenuEntries(sampleBoards[0]!, {
      onOpen: noop,
      onRename: noop,
      onTogglePin: noop,
      onDuplicate: noop,
      onSetColor: noop,
      onDelete: noop,
    });
    assert.equal(
      boardMenuWithRename.some((e) => e.type === 'action' && e.id === 'rename-board'),
      true
    );
  });

  it('validates stored preferences and passphrases safely', () => {
    const parsed = parseStoredPreferences(
      JSON.stringify({
        viewMode: 'list',
        theme: 'invalid',
        autoLockMinutes: 30,
        lockOnHide: true,
        blockExternalMedia: 'nope',
      })
    );
    assert.deepEqual(parsed, {
      viewMode: 'list',
      autoLockMinutes: 30,
      lockOnHide: true,
    });

    assert.ok(validateNewPassphrase('', '') !== null);
    assert.ok(validateNewPassphrase('short', 'short') !== null);
    assert.ok(validateNewPassphrase('long-enough-1', 'long-enough-2') !== null);
    assert.equal(validateNewPassphrase('correct-horse-battery', 'correct-horse-battery'), null);
  });

  it('aligns board items and summarizes clipboard contents', () => {
    const a = {
      id: 't1',
      type: 'text' as const,
      x: 100,
      y: 20,
      width: 100,
      rotation: 0,
      zIndex: 1,
      color: 'default' as const,
      content: 'Hello',
    };
    const b = {
      id: 't2',
      type: 'text' as const,
      x: 250,
      y: 80,
      width: 100,
      rotation: 0,
      zIndex: 2,
      color: 'default' as const,
      content: 'World',
    };
    alignBoardItemsInPlace(
      [
        { item: a, aabb: { minX: 100, minY: 20, maxX: 200, maxY: 60 } },
        { item: b, aabb: { minX: 250, minY: 80, maxX: 350, maxY: 120 } },
      ],
      'left'
    );
    assert.equal(a.x, 100);
    assert.equal(b.x, 100);
    assert.equal(summarizeBoardItemsForClipboard([a, b]), 'Hello\n\nWorld');
  });

  it('duplicates notes/boards and renames/merges/deletes tags cleanly', () => {
    const vault = {
      notes: structuredClone(sampleNotes),
      boards: structuredClone(sampleBoards),
      tags: ['home', 'errands', 'work'],
      activeFilter: { type: 'tag' as const, tag: 'errands' as string | null },
    };

    const noteCopy = duplicateNoteInList(vault.notes, 'n1', 999);
    assert.ok(noteCopy && noteCopy.id !== 'n1' && noteCopy.title === 'Grocery List (Copy)');
    assert.equal(noteCopy.pinned, false);

    const boardCopy = duplicateBoardInList(vault.boards, 'b1', 999);
    assert.ok(boardCopy && boardCopy.id !== 'b1' && boardCopy.items[0]!.id !== 'bi1');

    // Rename 'errands' -> 'home' (merges without duplicates & updates activeFilter)
    assert.equal(renameTagInVault(vault, 'errands', '#Home'), true);
    assert.deepEqual(vault.tags, ['home', 'work']);
    assert.deepEqual(vault.notes[0]!.tags, ['home']);
    assert.deepEqual(vault.activeFilter, { type: 'tag', tag: 'home' });

    deleteTagInVault(vault, 'home');
    assert.deepEqual(vault.tags, ['work']);
    assert.deepEqual(vault.activeFilter, { type: 'all', tag: null });
  });
});
