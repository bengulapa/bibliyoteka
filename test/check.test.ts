/**
 * Link-checker integration tests against a local HTTP server.
 *
 * Uses a real server rather than mocks so the politeness rules, the
 * HEAD/GET fallback, robots handling and the "blocked is not dead"
 * guarantee are exercised end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDbAt, startRun } from '../src/db.ts';
import { importBookmarks, queryBookmarks } from '../src/store.ts';
import { runCheck } from '../src/check.ts';
import { PoliteFetcher } from '../src/core/polite.ts';
import type { RawBookmark } from '../src/core/importers/netscape.ts';

interface Hit {
  method: string;
  url: string;
  ua: string;
}

function startTestServer(): Promise<{ server: Server; port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  let rateLimitHits = 0;

  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') });
    const path = (req.url ?? '').split('?')[0];

    if (path === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private/\n');
    }
    if (path === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>fine</html>');
    }
    if (path === '/gone') {
      res.writeHead(404);
      return res.end('nope');
    }
    if (path === '/no-head') {
      if (req.method === 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      res.writeHead(200);
      return res.end('<html>get only</html>');
    }
    if (path === '/blocked') {
      res.writeHead(403, { Server: 'cloudflare' });
      return res.end('denied');
    }
    if (path === '/slow-down') {
      rateLimitHits++;
      if (rateLimitHits > 2) {
        res.writeHead(200);
        return res.end('ok now');
      }
      res.writeHead(429, { 'Retry-After': '1' });
      return res.end('too many');
    }
    if (path === '/private/secret') {
      res.writeHead(200);
      return res.end('should not be fetched');
    }
    if (path === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port, hits });
    });
  });
}

const FAST = { minDelayMs: 0, maxDelayMs: 1, timeoutMs: 5000, maxRetries: 1 };

test('identifies live, dead, blocked and redirected links correctly', async () => {
  const { server, port, hits } = await startTestServer();
  const f = new PoliteFetcher({ ...FAST, respectRobots: false });
  const base = `http://127.0.0.1:${port}`;

  const ok = await f.fetch(`${base}/ok`);
  assert.equal(ok.verdict, 'alive');
  assert.equal(ok.status, 200);

  const gone = await f.fetch(`${base}/gone`);
  assert.equal(gone.verdict, 'dead', '404 is a genuinely dead link');

  const blocked = await f.fetch(`${base}/blocked`);
  assert.equal(blocked.verdict, 'unknown', 'a 403 means blocked, never dead');
  assert.equal(blocked.note, 'cloudflare-challenge');

  const redirected = await f.fetch(`${base}/redirect`);
  assert.equal(redirected.verdict, 'alive');
  assert.ok(redirected.finalUrl?.endsWith('/ok'), 'redirect target recorded');

  assert.ok(hits.every((h) => h.ua.includes('Mozilla/5.0')), 'sends a real browser User-Agent');

  server.close();
});

test('falls back to GET when the server rejects HEAD', async () => {
  const { server, port, hits } = await startTestServer();
  const f = new PoliteFetcher({ ...FAST, respectRobots: false });

  const res = await f.fetch(`http://127.0.0.1:${port}/no-head`);
  assert.equal(res.verdict, 'alive', '405 on HEAD must not read as a dead link');

  const methods = hits.filter((h) => h.url === '/no-head').map((h) => h.method);
  assert.deepEqual(methods, ['HEAD', 'GET'], 'tries HEAD first, then falls back');

  server.close();
});

test('honors Retry-After on 429 instead of hammering', async () => {
  const { server, port } = await startTestServer();
  const f = new PoliteFetcher({ ...FAST, maxRetries: 3, respectRobots: false });

  const started = Date.now();
  const res = await f.fetch(`http://127.0.0.1:${port}/slow-down`);
  const elapsed = Date.now() - started;

  assert.equal(res.verdict, 'alive', 'succeeds once the server stops rate limiting');
  assert.ok(elapsed >= 1000, `backed off before retrying (waited ${elapsed}ms)`);

  server.close();
});

test('respects robots.txt disallow rules', async () => {
  const { server, port, hits } = await startTestServer();
  const f = new PoliteFetcher({ ...FAST, respectRobots: true });

  const res = await f.fetch(`http://127.0.0.1:${port}/private/secret`);
  assert.equal(res.verdict, 'skipped');
  assert.equal(res.note, 'robots-disallow');
  assert.ok(!hits.some((h) => h.url === '/private/secret'), 'disallowed path never requested');

  const allowed = await f.fetch(`http://127.0.0.1:${port}/ok`);
  assert.equal(allowed.verdict, 'alive', 'allowed paths still checked');

  server.close();
});

test('rate limits per domain rather than firing in parallel', async () => {
  const { server, port } = await startTestServer();
  const f = new PoliteFetcher({ minDelayMs: 300, maxDelayMs: 350, timeoutMs: 5000, maxRetries: 0, respectRobots: false });
  const base = `http://127.0.0.1:${port}`;

  const started = Date.now();
  await Promise.all([f.fetch(`${base}/ok`), f.fetch(`${base}/ok`), f.fetch(`${base}/ok`)]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 600, `three same-domain requests were spaced out (took ${elapsed}ms)`);

  server.close();
});

test('a blocked link is never marked dead, and nothing is deleted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-check-'));
  const db = createDbAt(join(dir, 'db.sqlite'));
  const { server, port } = await startTestServer();
  t.after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const mk = (u: string, t: string): RawBookmark => ({
    url: u, title: t, description: '', folderPath: '', addedAt: null, tags: [],
  });

  const runId = startRun(db, 'test');
  importBookmarks(db, [mk(`${base}/ok`, 'Fine'), mk(`${base}/blocked`, 'Blocked'), mk(`${base}/gone`, 'Gone')], {
    source: 'test',
    runId,
  });
  // A loopback host is correctly flagged private on import; treat these as
  // ordinary public bookmarks so the checker itself is what's under test.
  db.exec('UPDATE bookmarks SET private = 0');

  const summary = await runCheck(db, {
    politeness: { ...FAST, respectRobots: false },
    deadAfterFailures: 1,
  });

  assert.equal(summary.checked, 3);
  assert.equal(summary.alive, 1);
  assert.equal(summary.dead, 1);
  assert.equal(summary.unknown, 1);

  const rows = queryBookmarks(db, {});
  assert.equal(rows.length, 3, 'a check run never removes bookmarks');

  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.equal(byTitle['Fine'].check_status, 'alive');
  assert.equal(byTitle['Blocked'].check_status, 'unknown');
  assert.equal(byTitle['Gone'].check_status, 'dead');
  assert.ok(byTitle['Fine'].last_good_at, 'records last-known-good');

  const history = db.prepare('SELECT COUNT(*) AS n FROM checks').get() as any;
  assert.equal(Number(history.n), 3, 'every check is recorded as history');
});

test('a single failure is not enough to call a link dead', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-fail-'));
  const db = createDbAt(join(dir, 'db.sqlite'));
  const { server, port } = await startTestServer();
  t.after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runId = startRun(db, 'test');
  importBookmarks(
    db,
    [{ url: `http://127.0.0.1:${port}/gone`, title: 'Gone', description: '', folderPath: '', addedAt: null, tags: [] }],
    { source: 'test', runId },
  );
  db.exec('UPDATE bookmarks SET private = 0');

  await runCheck(db, { politeness: { ...FAST, respectRobots: false }, deadAfterFailures: 3, recheckAfterDays: 0 });
  assert.equal(queryBookmarks(db, {})[0].check_status, 'unknown', 'first 404 is not yet conclusive');

  await runCheck(db, { politeness: { ...FAST, respectRobots: false }, deadAfterFailures: 3, recheckAfterDays: 0 });
  await runCheck(db, { politeness: { ...FAST, respectRobots: false }, deadAfterFailures: 3, recheckAfterDays: 0 });

  const row = queryBookmarks(db, {})[0];
  assert.equal(row.check_status, 'dead', 'dead only after the failure threshold');
  assert.equal(row.consecutive_failures, 3);
  assert.equal(row.state, 'active', 'still not deleted');
});

test('skips URLs checked recently, making runs incremental', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-inc-'));
  const db = createDbAt(join(dir, 'db.sqlite'));
  const { server, port } = await startTestServer();
  t.after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runId = startRun(db, 'test');
  importBookmarks(
    db,
    [{ url: `http://127.0.0.1:${port}/ok`, title: 'Fine', description: '', folderPath: '', addedAt: null, tags: [] }],
    { source: 'test', runId },
  );
  db.exec('UPDATE bookmarks SET private = 0');

  const first = await runCheck(db, { politeness: { ...FAST, respectRobots: false } });
  assert.equal(first.checked, 1);

  const second = await runCheck(db, { politeness: { ...FAST, respectRobots: false } });
  assert.equal(second.checked, 0, 'already verified within the re-check window');
});

test('private bookmarks are not fetched unless explicitly included', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-priv-'));
  const db = createDbAt(join(dir, 'db.sqlite'));
  const { server, port, hits } = await startTestServer();
  t.after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mk = (u: string, t: string): RawBookmark => ({
    url: u, title: t, description: '', folderPath: '', addedAt: null, tags: [],
  });

  const runId = startRun(db, 'test');
  importBookmarks(
    db,
    [
      mk(`http://127.0.0.1:${port}/ok`, 'Public'),
      mk(`http://127.0.0.1:${port}/ok?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, 'Secret'),
    ],
    { source: 'test', runId },
  );

  const flagged = db.prepare("SELECT private FROM bookmarks WHERE title = 'Secret'").get() as any;
  assert.equal(Number(flagged.private), 1, 'token URL auto-flagged as private');
  db.prepare("UPDATE bookmarks SET private = 0 WHERE title = 'Public'").run();

  const res = await runCheck(db, { politeness: { ...FAST, respectRobots: false } });
  assert.equal(res.checked, 1, 'only the public bookmark was checked');
  assert.ok(!hits.some((h) => h.url.includes('token=')), 'the secret never left the machine');

  const res2 = await runCheck(db, { includePrivate: true, recheckAfterDays: 0, politeness: { ...FAST, respectRobots: false } });
  assert.ok(
    hits.some((h) => h.url.includes('token=')),
    'checked only when explicitly opted in',
  );
  assert.ok(res2.checked >= 1);
});
