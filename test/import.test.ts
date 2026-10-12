import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetscapeHtml, toNetscapeHtml } from '../src/importers/netscape.ts';
import { parseCsv, parseCsvBookmarks } from '../src/importers/csv.ts';

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000">Dev</H3>
    <DL><p>
        <DT><A HREF="https://github.com/nodejs/node" ADD_DATE="1600000001">Node.js &amp; friends</A>
        <DT><H3>Rust</H3>
        <DL><p>
            <DT><A HREF="https://doc.rust-lang.org/book/" ADD_DATE="1600000002">The Rust Book</A>
            <DD>Official guide
        </DL><p>
        <DT><A HREF="https://example.com/after-nested">Back at Dev level</A>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1600000003">Hacker News</A>
    <DT><A HREF="javascript:void(0)">Not a real bookmark</A>
</DL><p>`;

test('parses bookmarks with correct folder nesting', () => {
  const items = parseNetscapeHtml(CHROME_EXPORT);
  const byUrl = Object.fromEntries(items.map((i) => [i.url, i]));

  assert.equal(items.length, 4, 'javascript: pseudo-URL must be skipped');
  assert.equal(byUrl['https://github.com/nodejs/node'].folderPath, 'Dev');
  assert.equal(byUrl['https://doc.rust-lang.org/book/'].folderPath, 'Dev/Rust');
  assert.equal(byUrl['https://news.ycombinator.com/'].folderPath, '');
});

test('folder depth pops correctly after a nested block closes', () => {
  const items = parseNetscapeHtml(CHROME_EXPORT);
  const back = items.find((i) => i.url === 'https://example.com/after-nested')!;
  assert.equal(back.folderPath, 'Dev', 'should return to Dev, not stay in Dev/Rust');
});

test('decodes HTML entities in titles', () => {
  const items = parseNetscapeHtml(CHROME_EXPORT);
  assert.equal(items.find((i) => i.url.includes('nodejs'))!.title, 'Node.js & friends');
});

test('attaches DD descriptions to the preceding bookmark', () => {
  const items = parseNetscapeHtml(CHROME_EXPORT);
  assert.equal(items.find((i) => i.url.includes('rust-lang'))!.description, 'Official guide');
  assert.equal(items.find((i) => i.url.includes('nodejs'))!.description, '');
});

test('converts ADD_DATE epochs to ISO timestamps', () => {
  const items = parseNetscapeHtml(CHROME_EXPORT);
  assert.equal(items.find((i) => i.url.includes('nodejs'))!.addedAt, new Date(1600000001000).toISOString());
});

test('round-trips through HTML export without losing structure', () => {
  const original = parseNetscapeHtml(CHROME_EXPORT);
  const reparsed = parseNetscapeHtml(toNetscapeHtml(original));

  assert.equal(reparsed.length, original.length);
  for (const o of original) {
    const r = reparsed.find((x) => x.url === o.url);
    assert.ok(r, `${o.url} survived the round trip`);
    assert.equal(r!.folderPath, o.folderPath);
    assert.equal(r!.title, o.title);
  }
});

test('escapes quotes and angle brackets on export', () => {
  const html = toNetscapeHtml([
    { url: 'https://e.com/?a="b"&c=<d>', title: 'Tricky <title> & "quotes"', description: '', folderPath: 'F', addedAt: null, tags: [] },
  ]);
  assert.ok(!html.includes('<title>'), 'raw tags must not leak into output');
  const back = parseNetscapeHtml(html);
  assert.equal(back[0].url, 'https://e.com/?a="b"&c=<d>');
  assert.equal(back[0].title, 'Tricky <title> & "quotes"');
});

test('CSV parser handles quotes, embedded commas and newlines', () => {
  const rows = parseCsv('a,b\n"has, comma","has ""quotes"""\n"multi\nline",x\n');
  assert.deepEqual(rows[1], ['has, comma', 'has "quotes"']);
  assert.deepEqual(rows[2], ['multi\nline', 'x']);
});

test('infers Pocket-style CSV columns', () => {
  const csv = 'title,url,time_added,tags,status\n"My Article","https://e.com/a","1600000000","rust|wasm","unread"\n';
  const items = parseCsvBookmarks(csv);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://e.com/a');
  assert.equal(items[0].title, 'My Article');
  assert.deepEqual(items[0].tags, ['rust', 'wasm']);
  assert.equal(items[0].addedAt, new Date(1600000000000).toISOString());
});

test('rejects a CSV with no URL column rather than importing garbage', () => {
  assert.throws(() => parseCsvBookmarks('name,note\nfoo,bar\n'), /no recognizable URL column/i);
});
