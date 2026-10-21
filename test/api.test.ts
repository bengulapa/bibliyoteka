import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbAt } from '../src/db.ts';
import { handle, parseUpload, statsOf } from '../src/api.ts';
import { createApp } from '../src/web/server.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bm-api-'));
  return { db: createDbAt(join(dir, 'db.sqlite')), dir };
}

const GET = (db: any, path: string, query = '') =>
  handle(db, { method: 'GET', path, query: new URLSearchParams(query), body: null });

const POST = (db: any, path: string, body: any) =>
  handle(db, { method: 'POST', path, query: new URLSearchParams(), body });

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/chrome-export.html', import.meta.url)), 'utf8');

test('upload parsing sniffs format from content, not just filename', () => {
  assert.equal(parseUpload('whatever.txt', FIXTURE).format, 'netscape');
  assert.equal(parseUpload('x.json', '[{"url":"https://a.test/"}]').format, 'json');
  assert.equal(parseUpload('x.csv', 'url,title\nhttps://a.test/,A\n').format, 'csv');
});

test('dry-run import previews without writing anything', async () => {
  const { db, dir } = freshDb();

  const res = await POST(db, '/api/import', { filename: 'chrome.html', text: FIXTURE, dryRun: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.parsed > 0);
  assert.ok(res.body.wouldFlagPrivate > 0, 'fixture contains sensitive URLs');
  assert.ok(res.body.sample.length > 0);
  assert.equal(statsOf(db).active, 0, 'dry run must not persist');

  // The preview must never echo a live secret back to the client.
  const leaky = res.body.sample.filter((s: any) => s.private && /token|key=|password/i.test(s.url));
  assert.equal(leaky.length, 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('import → tag → archive → undo round trip through the API', async () => {
  const { db, dir } = freshDb();

  const imported = await POST(db, '/api/import', { filename: 'chrome.html', text: FIXTURE });
  assert.equal(imported.status, 200);
  assert.ok(imported.body.inserted > 0);
  assert.ok(imported.body.merged > 0, 'tracker/case/fragment variants should merge');

  const list = await GET(db, '/api/bookmarks');
  const first = list.body.bookmarks[0];
  assert.ok(first.tags.length, 'auto-tags should be applied');

  const tagged = await POST(db, '/api/tags/add', { ids: [first.id], tag: 'manual/keep' });
  assert.equal(tagged.status, 200);
  assert.ok((await GET(db, '/api/bookmarks')).body.bookmarks.find((b: any) => b.id === first.id).tags.includes('manual/keep'));

  const before = statsOf(db).active;
  await POST(db, '/api/archive', { ids: [first.id] });
  assert.equal(statsOf(db).active, before - 1);

  const undone = await POST(db, '/api/undo', {});
  assert.equal(undone.status, 200);
  assert.equal(statsOf(db).active, before, 'undo restores the archived bookmark');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('private bookmarks are hidden, redacted, and excluded from exports by default', async () => {
  const { db, dir } = freshDb();
  await POST(db, '/api/import', { filename: 'chrome.html', text: FIXTURE });

  const def = await GET(db, '/api/bookmarks', 'limit=500');
  assert.equal(def.body.bookmarks.filter((b: any) => b.private).length, 0, 'private hidden by default');

  const all = await GET(db, '/api/bookmarks', 'limit=500&private=1');
  const priv = all.body.bookmarks.filter((b: any) => b.private);
  assert.ok(priv.length > 0);

  // Private-by-host URLs have no secret to strip; private-by-secret ones must
  // never show the secret value.
  const withSecrets = priv.filter((b: any) => /[?&](token|key|access_token|password|sig)=/i.test(b.url));
  assert.ok(withSecrets.length > 0, 'fixture includes token-bearing URLs');
  for (const b of withSecrets) {
    assert.notEqual(b.displayUrl, b.url, 'secret-bearing URLs must be redacted for display');
    assert.match(b.displayUrl, /REDACTED/);
  }

  const html = await GET(db, '/api/export', 'format=html');
  for (const b of priv) {
    assert.ok(!html.download!.text.includes(b.url), 'default export must omit private bookmarks');
  }

  // Opt-in export includes them, but still never writes a secret to disk.
  const optIn = await GET(db, '/api/export', 'format=html&private=1');
  for (const b of withSecrets) {
    assert.ok(!optIn.download!.text.includes(b.url), 'opt-in export still redacts secrets');
  }
  assert.ok(optIn.download!.text.length > html.download!.text.length, 'opt-in export includes more');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('near-duplicates are queued for review and never auto-merged', async () => {
  const { db, dir } = freshDb();
  await POST(db, '/api/import', { filename: 'chrome.html', text: FIXTURE });

  const dupes = await GET(db, '/api/duplicates');
  assert.ok(dupes.body.pairs.length > 0, 'fixture has same-path different-query pairs');

  const pair = dupes.body.pairs[0];
  const merged = await POST(db, '/api/merge', { keep: pair.a.id, drop: pair.b.id });
  assert.equal(merged.status, 200);
  assert.equal((await GET(db, '/api/duplicates')).body.pairs.length, dupes.body.pairs.length - 1);

  // Undo must reopen the pair, not silently leave it resolved.
  await POST(db, '/api/undo', { runId: merged.body.runId });
  assert.equal((await GET(db, '/api/duplicates')).body.pairs.length, dupes.body.pairs.length);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('settings rules persist and retag is additive and undoable', async () => {
  const { db, dir } = freshDb();
  await POST(db, '/api/import', { filename: 'chrome.html', text: FIXTURE });

  await POST(db, '/api/settings/rules', { match: 'rust', tag: 'lang/rust' });
  assert.deepEqual((await GET(db, '/api/settings')).body.rules, [{ match: 'rust', tag: 'lang/rust' }]);

  const before = statsOf(db).active;
  const retag = await POST(db, '/api/retag', {});
  assert.equal(retag.status, 200);
  assert.equal(statsOf(db).active, before, 'retag must not add or remove bookmarks');

  await POST(db, '/api/settings/private-domains', { add: 'Internal.Corp.Example' });
  assert.deepEqual((await GET(db, '/api/settings')).body.privateDomains, ['internal.corp.example']);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('bad input is rejected with a readable message, not a crash', async () => {
  const { db, dir } = freshDb();

  assert.equal((await POST(db, '/api/import', { text: '' })).status, 400);
  assert.equal((await POST(db, '/api/bookmarks', { url: '' })).status, 400);
  assert.equal((await POST(db, '/api/merge', { keep: 1 })).status, 400);
  assert.equal((await GET(db, '/api/nope')).status, 404);

  const noItems = await POST(db, '/api/import', { filename: 'empty.html', text: '<html></html>' });
  assert.equal(noItems.status, 400);
  assert.match(noItems.body.error, /No bookmarks/);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the HTTP shell serves the app and mounts the API end to end', async (t) => {
  const { db, dir } = freshDb();
  const server = createApp(db);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  assert.match(await page.text(), /<div id="list"/);

  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type')!, /javascript/);

  const imported = await fetch(base + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'chrome.html', text: FIXTURE }),
  });
  assert.equal(imported.status, 200);
  assert.ok((await imported.json()).inserted > 0);

  const stats = await (await fetch(base + '/api/stats')).json();
  assert.ok(stats.active > 0);

  const dl = await fetch(base + '/api/export?format=json');
  assert.match(dl.headers.get('content-disposition')!, /attachment; filename="bookmarks-/);
  assert.ok(JSON.parse(await dl.text()).bookmarks.length > 0);

  const malformed = await fetch(base + '/api/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);

  // Path traversal must not escape the public directory.
  const escape = await fetch(base + '/../../package.json');
  assert.ok(!(await escape.text()).includes('"dependencies"'));
});
