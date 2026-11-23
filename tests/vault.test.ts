import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoardContextMenuEntries,
  buildNoteContextMenuEntries,
} from '../src/app-context-menus';
import { parseStoredPreferences, validateNewPassphrase } from '../src/preferences';
import { filterBoards, filterNotes } from '../src/search-filter';
import type { ActiveFilter, Board, Note } from '../src/types';
import {
  deleteTagInVault,
  duplicateBoardInList,
  duplicateNoteInList,
  renameTagInVault,
} from '../src/vault-mutations';

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
});
