import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoardContextMenuEntries,
  buildNoteContextMenuEntries,
} from '../src/ui/app-context-menus';
import { parseStoredPreferences, validateNewPassphrase } from '../src/preferences';
import { filterBoards, filterNotes } from '../src/search-filter';
import type { ActiveFilter, Board, Note } from '../src/types';
import {
  deleteTagInVault,
  duplicateBoardInList,
  duplicateNoteInList,
  renameTagInVault,
} from '../src/vault/mutations';
import { mergeVaultPayloads, normalizeVaultPayload } from '../src/vault/payload';

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
    color: 'cobalt',
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
        align: 'left',
        fontSize: 15,
      },
    ],
    createdAt: 100,
    updatedAt: 400,
  },
];

describe('vault search, mutations, preferences & menus', () => {
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

  it('duplicates notes/boards and renames/merges/deletes tags cleanly', () => {
    const vault = {
      notes: structuredClone(sampleNotes),
      boards: structuredClone(sampleBoards),
      tags: ['home', 'errands', 'work'],
      activeFilter: { type: 'tag', tag: 'errands' } as ActiveFilter,
    };

    const noteCopy = duplicateNoteInList(vault.notes, 'n1', 999);
    assert.ok(noteCopy && noteCopy.id !== 'n1' && noteCopy.title === 'Grocery List (Copy)');
    assert.equal(noteCopy.pinned, false);

    const boardCopy = duplicateBoardInList(vault.boards, 'b1', 999);
    assert.ok(boardCopy && boardCopy.id !== 'b1' && boardCopy.items[0]!.id !== 'bi1');

    assert.equal(renameTagInVault(vault, 'errands', '#Home'), true);
    assert.deepEqual(vault.tags, ['home', 'work']);
    assert.deepEqual(vault.notes[0]!.tags, ['home']);
    assert.deepEqual(vault.activeFilter, { type: 'tag', tag: 'home' });

    deleteTagInVault(vault, 'home');
    assert.deepEqual(vault.tags, ['work']);
    assert.deepEqual(vault.activeFilter, { type: 'all', tag: null });
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

  it('normalizes untrusted vault payloads at the decryption boundary', () => {
    const hostile = {
      notes: [
        {
          id: 'n-hostile',
          title: 'Valid Note',
          description: 'Body',
          // Missing tags array (previously crashed renderSidebar!)
          color: 'red" onmouseover="alert(1)',
          pinned: 1,
          images: [
            { id: 'i1', src: 'javascript:alert(1)', sourceType: 'external', createdAt: 10 },
            { id: 'i2', src: 'https://example.com/ok.png', sourceType: 'external', createdAt: 20 },
          ],
        },
      ],
      boards: [
        {
          id: 'b-hostile',
          title: 'Board',
          color: 'invalid',
          gridStyle: 'xss',
          viewport: { panX: 'bad', panY: 10, zoom: 999 },
          items: [
            {
              id: 't1',
              type: 'text',
              x: '10" onload="alert(1)',
              y: 20,
              width: '200;background:url(x)',
              zIndex: 'not-a-num',
              rotation: '45',
              content: 'hello',
              align: 'left" onclick="evil()',
              fontSize: '15px"><img src=x onerror=alert(1)>',
            },
            {
              id: 'l1',
              type: 'link',
              x: 0,
              y: 0,
              width: 200,
              zIndex: 2,
              rotation: 0,
              url: 'javascript:alert(1)',
            },
            {
              id: 's1',
              type: 'stroke',
              tool: 'pen',
              strokeColor: 'red" onload="alert(1)',
              strokeWidth: '4" onerror="alert(1)',
              sourceWidth: 100,
              sourceHeight: 50,
              x: 0,
              y: 0,
              width: 100,
              height: 50,
              zIndex: 3,
              rotation: 0,
              points: [[1, 2, 0.5], ['bad', 3, 0.5]],
            },
          ],
        },
      ],
    };

    const normalized = normalizeVaultPayload(hostile, 5000);
    assert.equal(normalized.notes.length, 1);
    assert.deepEqual(normalized.notes[0]!.tags, []);
    assert.equal(normalized.notes[0]!.color, 'default');
    assert.equal(normalized.notes[0]!.images?.length, 1);
    assert.equal(normalized.notes[0]!.images?.[0]?.src, 'https://example.com/ok.png');

    assert.equal(normalized.boards?.length, 1);
    const board = normalized.boards![0]!;
    assert.equal(board.color, 'default');
    assert.equal(board.gridStyle, undefined);
    assert.equal(board.viewport.panX, 0);
    assert.equal(board.viewport.zoom, 2.5);
    // javascript: link item was dropped
    assert.equal(board.items.length, 2);
    const textItem = board.items[0]!;
    assert.equal(textItem.type, 'text');
    assert.equal(textItem.x, 0);
    assert.equal(textItem.width, 240);
    assert.equal(textItem.align, 'left');
    assert.equal(textItem.fontSize, 15);

    const strokeItem = board.items[1]!;
    assert.equal(strokeItem.type, 'stroke');
    assert.equal(strokeItem.strokeColor, 'auto-ink');
    assert.equal(strokeItem.strokeWidth, 3);
    assert.deepEqual(strokeItem.points, [[1, 2, 0.5]]);
  });

  it('merges conflicting local and remote payloads keeping newer items and unioning additions', () => {
    const local = {
      notes: [
        { ...sampleNotes[0]!, title: 'Local Newer', updatedAt: 500 },
        {
          id: 'n-local-only',
          title: 'Local Added',
          description: '',
          tags: ['local'],
          pinned: false,
          color: 'default' as const,
          createdAt: 400,
          updatedAt: 400,
        },
      ],
      tags: ['home', 'local'],
      boards: [],
    };
    const remote = {
      notes: [
        { ...sampleNotes[0]!, title: 'Remote Older', updatedAt: 200 },
        { ...sampleNotes[1]!, updatedAt: 300 },
      ],
      tags: ['home', 'work'],
      boards: sampleBoards,
    };

    const merged = mergeVaultPayloads(local, remote);
    assert.equal(merged.notes.length, 3);
    assert.equal(merged.notes.find((n) => n.id === 'n1')?.title, 'Local Newer');
    assert.ok(merged.notes.some((n) => n.id === 'n-local-only'));
    assert.ok(merged.notes.some((n) => n.id === 'n2'));
    assert.equal(merged.boards?.length, 1);
    assert.deepEqual(merged.tags.sort(), ['home', 'local', 'work']);
  });
});
