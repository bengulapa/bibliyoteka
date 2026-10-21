import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDbAt, startRun, finishRun } from '../src/db.ts';
import { importBookmarks, pendingDuplicates, mergeBookmarks, undoRun, queryBookmarks, tagsOf } from '../src/store.ts';
import { exportHtml, exportJson } from '../src/export.ts';
import { assessUrl, redactUrl } from '../src/core/sensitive.ts';
import type { RawBookmark } from '../src/core/importers/netscape.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bm-test-'));
  return { db: createDbAt(join(dir, 'db.sqlite')), dir };
}

function bm(url: string, title = 'T', folder = '', added: string | null = null): RawBookmark {
  return { url, title, description: '', folderPath: folder, addedAt: added, tags: [] };
}

test('exact duplicates after normalization are merged, not duplicated', () => {
  const { db, dir } = freshDb();
  const runId = startRun(db, 'test');

  const res = importBookmarks(
    db,
    [
      bm('https://example.com/article/?utm_source=twitter', 'Short'),
      bm('https://Example.com/article#top', 'A Much Longer Better Title'),
    ],
    { source: 'test', runId },
  );

  assert.equal(res.inserted, 1);
  assert.equal(res.merged, 1);

  const rows = queryBookmarks(db, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'A Much Longer Better Title', 'merge keeps the more informative title');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('merge keeps the earliest added date and unions tags', () => {
  const { db, dir } = freshDb();
  const runId = startRun(db, 'test');

  importBookmarks(db, [bm('https://example.com/x', 'A', 'Newer', '2024-06-01T00:00:00.000Z')], { source: 's1', runId });
  importBookmarks(db, [bm('https://example.com/x', 'A', 'Older', '2020-01-01T00:00:00.000Z')], { source: 's2', runId });

  const row = queryBookmarks(db, {})[0];
  assert.equal(row.added_at, '2020-01-01T00:00:00.000Z', 'earliest date wins');

  const tags = tagsOf(db, row.id);
  assert.ok(tags.includes('src:s1') && tags.includes('src:s2'), 'tags from both imports survive');
  assert.ok(tags.includes('folder:newer') && tags.includes('folder:older'), 'folders union as tags');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('near-duplicates are flagged for review, never auto-merged', () => {
  const { db, dir } = freshDb();
  const runId = startRun(db, 'test');

  importBookmarks(db, [bm('https://shop.com/item?id=1', 'Item one'), bm('https://shop.com/item?id=2', 'Item two')], {
    source: 'test',
    runId,
  });

  assert.equal(queryBookmarks(db, {}).length, 2, 'both rows must survive');
  assert.equal(pendingDuplicates(db).length, 1, 'the pair is queued for human review');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('merging archives rather than deletes, and is reversible', () => {
  const { db, dir } = freshDb();
  const importRun = startRun(db, 'import');
  importBookmarks(db, [bm('https://a.com/p?x=1', 'One'), bm('https://a.com/p?x=2', 'Two')], { source: 't', runId: importRun });

  const [a, b] = queryBookmarks(db, {});
  const mergeRun = startRun(db, 'merge');
  mergeBookmarks(db, a.id, b.id, mergeRun);

  assert.equal(queryBookmarks(db, {}).length, 1, 'dropped row leaves the active list');
  const archived = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(b.id) as any;
  assert.equal(archived.state, 'archived', 'row still exists, just archived');

  undoRun(db, mergeRun);
  assert.equal(queryBookmarks(db, {}).length, 2, 'undo restores it');
  assert.equal(pendingDuplicates(db).length, 1, 'undo re-opens the review pair');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('undoing an import removes exactly what it added', () => {
  const { db, dir } = freshDb();
  const run1 = startRun(db, 'import');
  importBookmarks(db, [bm('https://keep.com/a', 'Keep')], { source: 'first', runId: run1 });
  finishRun(db, run1, '');

  const run2 = startRun(db, 'import');
  importBookmarks(db, [bm('https://undo.com/b', 'Undo me')], { source: 'second', runId: run2 });
  finishRun(db, run2, '');

  assert.equal(queryBookmarks(db, {}).length, 2);
  undoRun(db, run2);

  const left = queryBookmarks(db, {});
  assert.equal(left.length, 1);
  assert.equal(left[0].url, 'https://keep.com/a');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sensitive URLs are detected and excluded from default views and exports', () => {
  const { db, dir } = freshDb();
  const runId = startRun(db, 'test');

  importBookmarks(
    db,
    [
      bm('https://example.com/public', 'Public page'),
      bm('https://app.com/reset?token=abcdef1234567890abcdef1234567890', 'Password reset'),
      bm('http://192.168.1.10:8080/admin', 'Router admin'),
    ],
    { source: 'test', runId },
  );

  assert.equal(queryBookmarks(db, {}).length, 1, 'private rows hidden by default');
  assert.equal(queryBookmarks(db, { includePrivate: true }).length, 3, 'visible when explicitly requested');

  const html = exportHtml(db, {});
  assert.ok(!html.includes('abcdef1234567890'), 'token must never reach an export');
  assert.ok(!html.includes('192.168.1.10'), 'private host must not be exported');
  assert.ok(html.includes('example.com/public'));

  const withPrivate = exportHtml(db, { includePrivate: true });
  assert.ok(!withPrivate.includes('abcdef1234567890'), 'even opt-in HTML export redacts live secrets');
  assert.ok(withPrivate.includes('REDACTED'));

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sensitivity heuristics catch the obvious cases without over-flagging', () => {
  assert.ok(assessUrl('https://e.com/x?api_key=123').sensitive);
  assert.ok(assessUrl('https://user:pw@e.com/x').sensitive);
  assert.ok(assessUrl('http://localhost:3000/app').sensitive);
  assert.ok(assessUrl('https://e.com/x?session=QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ').sensitive);

  assert.ok(!assessUrl('https://example.com/blog/post-1').sensitive);
  assert.ok(!assessUrl('https://example.com/search?q=rust&page=2').sensitive);
});

test('redaction preserves URL shape while destroying the secret', () => {
  const out = redactUrl('https://app.com/cb?code=SECRETVALUE1234567890123456789012&state=xyz');
  assert.ok(out.startsWith('https://app.com/cb?'));
  assert.ok(!out.includes('SECRETVALUE'));
});

test('JSON export is lossless for tags and check state', () => {
  const { db, dir } = freshDb();
  const runId = startRun(db, 'test');
  importBookmarks(db, [bm('https://e.com/a', 'Title', 'Dev/Tools')], { source: 'chrome', runId });

  const parsed = JSON.parse(exportJson(db, {}));
  assert.equal(parsed.format, 'bookmark-manager/v1');
  assert.equal(parsed.bookmarks.length, 1);

  const b = parsed.bookmarks[0];
  assert.equal(b.folderPath, 'Dev/Tools', 'original folder path preserved for round-tripping');
  assert.ok(b.tags.includes('folder:dev/tools'));
  assert.ok(b.tags.includes('site:e.com'));
  assert.ok(b.tags.includes('src:chrome'));
  assert.equal(b.check.status, 'unchecked');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
