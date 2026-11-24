import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderBlockedExternalImageHtml,
  renderBoardItemHtml,
  renderBoardTextContentHtml,
} from '../src/board/render';
import { createBoardCardHtml, createNoteCardHtml } from '../src/ui/card-render';
import { clampMenuPosition } from '../src/ui/context-menu';
import { renderMarkdownDescription, toggleCheckboxLine } from '../src/markdown';
import { extractStandaloneImageUrl, extractStandaloneWebUrl } from '../src/media';
import type { Board, Note } from '../src/types';
import { compareSemver } from '../src/ui/updates';
import {
  createId,
  escapeHtml,
  getRotatedRectAabb,
  highlightText,
  isExternalHttpUrl,
  isSafeDataImageUrl,
} from '../src/utils';

describe('utils, media & context-menu', () => {
  it('escapes HTML and highlights search matches safely without corrupting entities', () => {
    assert.equal(escapeHtml('<script>"&\'</script>'), '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
    assert.equal(
      highlightText('Hello <world>', 'world'),
      'Hello &lt;<mark class="search-highlight">world</mark>&gt;'
    );
    // Regression: searching "amp" in "Tom & Jerry" must not match inside &amp;
    assert.equal(highlightText('Tom & Jerry', 'amp'), 'Tom &amp; Jerry');
    assert.equal(
      highlightText('Tom & Jerry', '&'),
      'Tom <mark class="search-highlight">&amp;</mark> Jerry'
    );
    assert.equal(
      highlightText('5 < 10 & "quoted" \'ok\'', '<'),
      '5 <mark class="search-highlight">&lt;</mark> 10 &amp; &quot;quoted&quot; &#39;ok&#39;'
    );
  });

  it('prevents attribute injection even if renderBoardItemHtml receives malformed fields', () => {
    const hostileItem = {
      id: 'bad',
      type: 'text',
      x: '0" onload="alert(1)',
      y: 0,
      width: '200" onclick="alert(1)',
      zIndex: 1,
      rotation: 0,
      content: 'hi',
      align: 'left" onmouseover="alert(1)',
      fontSize: '15px"><script>alert(1)</script>',
    } as unknown as Board['items'][number];
    const html = renderBoardItemHtml(hostileItem, '');
    assert.equal(html.includes('onload='), false);
    assert.equal(html.includes('onclick='), false);
    assert.equal(html.includes('onmouseover='), false);
    assert.equal(html.includes('<script>'), false);
  });

  it('computes rotated AABB accurately', () => {
    const aabb = getRotatedRectAabb(0, 0, 100, 50, 90);
    assert.ok(Math.abs(aabb.minX - 25) < 1e-6);
    assert.ok(Math.abs(aabb.maxX - 75) < 1e-6);
    assert.ok(Math.abs(aabb.minY - -25) < 1e-6);
    assert.ok(Math.abs(aabb.maxY - 75) < 1e-6);
  });

  it('renders markdown links and bare URLs in board text safely and in linear time (M8)', () => {
    const html = renderBoardTextContentHtml('See [Docs](https://example.com) and https://foo.bar', '');
    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(html.includes('href="https://foo.bar"'));
    assert.equal(isExternalHttpUrl('https://example.com'), true);
    assert.equal(isExternalHttpUrl('https:\\\\evil.example\\px.png'), true);
    assert.equal(isExternalHttpUrl('ht\ttps://evil.example/px.png'), true);
    assert.equal(isExternalHttpUrl('data:image/webp;base64,abc'), false);
    assert.equal(isSafeDataImageUrl('data:image/webp;base64,AAAA'), true);
    assert.equal(isSafeDataImageUrl('https://evil.example/a.png'), false);

    // M8 ReDoS regression: 80,000 '[' characters must render in linear time (<150ms)
    const t0 = Date.now();
    const evilLine = '['.repeat(80_000);
    const out = renderBoardTextContentHtml(evilLine, '');
    const elapsed = Date.now() - t0;
    assert.equal(out.length, 80_000);
    assert.ok(elapsed < 150, `Expected linear-time render (<150ms), took ${elapsed}ms`);
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

  it('compares semver strings with optional v prefix', () => {
    assert.equal(compareSemver('v1.6.5', '1.6.4'), 1);
    assert.equal(compareSemver('1.6.4', 'v1.6.4'), 0);
    assert.equal(compareSemver('1.6.3', '1.6.4'), -1);
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  });
});

describe('markdown & card rendering', () => {
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

  it('renders note and board cards with safe escaping and privacy placeholders', () => {
    const note: Note = {
      id: 'n1',
      title: '<b>Secret</b>',
      description: '- [ ] Buy oat milk',
      tags: ['home'],
      pinned: true,
      color: 'default',
      images: [
        {
          id: 'img-1',
          src: 'https://cdn.example.com/pic.png',
          alt: 'pic',
          sourceType: 'external',
          createdAt: 100,
        },
      ],
      createdAt: 100,
      updatedAt: 200,
    };
    const noteHtml = createNoteCardHtml(note, 'secret', () => false);
    assert.ok(noteHtml.includes('&lt;b&gt;<mark class="search-highlight">Secret</mark>&lt;/b&gt;'));
    assert.ok(noteHtml.includes('data-allow-external-url="https://cdn.example.com/pic.png"'));

    const emptyBoard: Board = {
      id: 'b1',
      title: 'Empty',
      tags: [],
      pinned: false,
      color: 'default',
      viewport: { panX: 0, panY: 0, zoom: 1 },
      items: [],
      createdAt: 100,
      updatedAt: 200,
    };
    const emptyBoardHtml = createBoardCardHtml(emptyBoard, '', () => true);
    assert.ok(emptyBoardHtml.includes('Empty board canvas'));
    assert.ok(emptyBoardHtml.includes('0 items'));
  });
});
