import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, nearDuplicateKey, registrableDomain } from '../src/normalize.ts';

test('lowercases scheme and host', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path'), 'https://example.com/Path');
});

test('drops default ports but keeps non-default', () => {
  assert.equal(normalizeUrl('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('http://example.com:80/a'), 'http://example.com/a');
  assert.equal(normalizeUrl('https://example.com:8443/a'), 'https://example.com:8443/a');
});

test('strips tracker params but keeps meaningful ones', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?utm_source=x&utm_medium=y&id=42&fbclid=abc'),
    'https://example.com/p?id=42',
  );
});

test('query param order does not affect identity', () => {
  assert.equal(normalizeUrl('https://e.com/p?b=2&a=1'), normalizeUrl('https://e.com/p?a=1&b=2'));
});

test('strips fragments but preserves SPA hashbang routes', () => {
  assert.equal(normalizeUrl('https://example.com/page#section'), 'https://example.com/page');
  assert.equal(normalizeUrl('https://example.com/app#!/route'), 'https://example.com/app#!/route');
});

test('drops trailing slash including bare root', () => {
  assert.equal(normalizeUrl('https://example.com/path/'), 'https://example.com/path');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
});

test('the classic duplicate pair collapses to one key', () => {
  const a = normalizeUrl('https://Example.com/Article/?utm_source=twitter#top');
  const b = normalizeUrl('http://example.com:80/Article');
  assert.equal(a, 'https://example.com/Article');
  assert.equal(b, 'http://example.com/Article');
  // Scheme is preserved deliberately: http and https are different endpoints.
  assert.notEqual(a, b);
});

test('tolerates scheme-less input', () => {
  assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
});

test('unparseable input survives as its trimmed self', () => {
  assert.equal(normalizeUrl('  not a url  '), 'not a url');
});

test('near-duplicate key ignores the query string', () => {
  assert.equal(nearDuplicateKey('https://e.com/p?a=1'), nearDuplicateKey('https://e.com/p?b=2'));
  assert.notEqual(nearDuplicateKey('https://e.com/p'), nearDuplicateKey('https://e.com/q'));
});

test('registrable domain handles multi-level TLDs', () => {
  assert.equal(registrableDomain('https://news.bbc.co.uk/x'), 'bbc.co.uk');
  assert.equal(registrableDomain('https://a.b.example.com/x'), 'example.com');
  assert.equal(registrableDomain('https://example.com/x'), 'example.com');
});
