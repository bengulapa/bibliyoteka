/**
 * Transport-agnostic JSON API.
 *
 * Every GUI operation goes through here. The handler takes a plain request
 * description and returns a plain result, so it can be mounted on a Node HTTP
 * server (web app), called in-process from an extension background worker, or
 * invoked from a desktop shell — without changing any logic.
 */

import type { DB } from './db.ts';
import { startRun, finishRun, getSetting, setSetting } from './db.ts';
import {
  queryBookmarks,
  allTags,
  tagsOf,
  addTag,
  removeTag,
  archiveBookmark,
  restoreBookmark,
  setPrivate,
  pendingDuplicates,
  mergeBookmarks,
  undoRun,
  importBookmarks,
  type BookmarkRow,
} from './store.ts';
import { runCheck, dueForCheck, type CheckOptions } from './check.ts';
import { exportHtml, exportJson } from './export.ts';
import { parseNetscapeHtml } from './core/importers/netscape.ts';
import { parseCsvBookmarks } from './core/importers/csv.ts';
import { redactUrl, assessUrl } from './core/sensitive.ts';
import { normalizeUrl } from './core/normalize.ts';
import { waybackUrl } from './core/polite.ts';
import { autoTags, type KeywordRule } from './core/tagging.ts';
import type { RawBookmark } from './core/importers/netscape.ts';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export interface ApiResponse {
  status: number;
  body: any;
  /** Set for file downloads. */
  download?: { filename: string; contentType: string; text: string };
}

const ok = (body: any = { ok: true }): ApiResponse => ({ status: 200, body });
const bad = (message: string): ApiResponse => ({ status: 400, body: { error: message } });

export function loadRules(db: DB): KeywordRule[] {
  try {
    return JSON.parse(getSetting(db, 'keyword_rules', '[]'));
  } catch {
    return [];
  }
}

export function loadPrivateDomains(db: DB): Set<string> {
  try {
    return new Set<string>(JSON.parse(getSetting(db, 'private_domains', '[]')));
  } catch {
    return new Set();
  }
}

/** Shape a row for the client, redacting anything sensitive. */
function present(db: DB, b: BookmarkRow) {
  return {
    id: b.id,
    url: b.url,
    displayUrl: b.private ? redactUrl(b.url) : b.url,
    title: b.title,
    description: b.description,
    folderPath: b.folder_path,
    source: b.source,
    addedAt: b.added_at,
    private: !!b.private,
    privateReasons: b.private_reasons ? b.private_reasons.split(',').filter(Boolean) : [],
    state: b.state,
    checkStatus: b.check_status,
    lastCheckedAt: b.last_checked_at,
    lastGoodAt: b.last_good_at,
    consecutiveFailures: b.consecutive_failures,
    tags: tagsOf(db, b.id),
    wayback: b.check_status === 'dead' ? waybackUrl(b.url) : null,
  };
}

export function statsOf(db: DB) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM bookmarks WHERE state='active') AS active,
         (SELECT COUNT(*) FROM bookmarks WHERE state='archived') AS archived,
         (SELECT COUNT(*) FROM bookmarks WHERE private=1 AND state='active') AS private,
         (SELECT COUNT(*) FROM bookmarks WHERE check_status='alive' AND state='active') AS alive,
         (SELECT COUNT(*) FROM bookmarks WHERE check_status='dead' AND state='active') AS dead,
         (SELECT COUNT(*) FROM bookmarks WHERE check_status='unknown' AND state='active') AS unknown,
         (SELECT COUNT(*) FROM bookmarks WHERE check_status='unchecked' AND state='active') AS unchecked,
         (SELECT COUNT(*) FROM tags) AS tags,
         (SELECT COUNT(*) FROM duplicate_pairs WHERE resolved=0) AS duplicates`,
    )
    .get() as any;
  return {
    active: Number(row.active),
    archived: Number(row.archived),
    private: Number(row.private),
    alive: Number(row.alive),
    dead: Number(row.dead),
    unknown: Number(row.unknown),
    unchecked: Number(row.unchecked),
    tags: Number(row.tags),
    duplicates: Number(row.duplicates),
    dueForCheck: dueForCheck(db, { limit: 100000 }).length,
  };
}

/** Parse an uploaded file by sniffing its content, not just its name. */
export function parseUpload(filename: string, text: string, map: Record<string, string> = {}): {
  items: RawBookmark[];
  format: 'netscape' | 'csv' | 'json';
} {
  if (/^\s*[[{]/.test(text)) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.bookmarks ?? []);
    return {
      format: 'json',
      items: list
        .filter((b: any) => b?.url)
        .map((b: any) => ({
          url: String(b.url),
          title: String(b.title ?? b.url),
          description: String(b.description ?? ''),
          folderPath: String(b.folderPath ?? b.folder_path ?? ''),
          addedAt: b.addedAt ?? b.added_at ?? null,
          tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
        })),
    };
  }
  if (/<DT|<A\s+HREF/i.test(text)) return { format: 'netscape', items: parseNetscapeHtml(text) };
  if (/\.csv$/i.test(filename) || text.includes(',')) return { format: 'csv', items: parseCsvBookmarks(text, map as any) };
  return { format: 'netscape', items: parseNetscapeHtml(text) };
}

export async function handle(db: DB, req: ApiRequest): Promise<ApiResponse> {
  const { method, path, query, body } = req;
  const includePrivate = query.get('private') === '1' || body?.includePrivate === true;

  // ---------------------------------------------------------------- reading

  if (method === 'GET' && path === '/api/stats') return ok(statsOf(db));

  if (method === 'GET' && path === '/api/bookmarks') {
    const limit = Math.min(Number(query.get('limit') ?? 100), 500);
    const offset = Number(query.get('offset') ?? 0);
    const rows = queryBookmarks(db, {
      q: query.get('q') || undefined,
      tag: query.get('tag') || undefined,
      status: query.get('status') || undefined,
      state: query.get('state') || 'active',
      includePrivate,
      sort: (query.get('sort') as any) || 'added',
      limit: limit + 1,
      offset,
    });
    const hasMore = rows.length > limit;
    return ok({ bookmarks: rows.slice(0, limit).map((b) => present(db, b)), hasMore, offset, limit });
  }

  if (method === 'GET' && path === '/api/tags') return ok({ tags: allTags(db, includePrivate) });

  if (method === 'GET' && path === '/api/duplicates') {
    return ok({
      pairs: pendingDuplicates(db).map((p: any) => ({
        id: p.id,
        a: { id: p.a_id, url: p.a_url, title: p.a_title },
        b: { id: p.b_id, url: p.b_url, title: p.b_title },
      })),
    });
  }

  if (method === 'GET' && path === '/api/runs') {
    return ok({
      runs: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 50').all().map((r: any) => ({
        id: r.id,
        kind: r.kind,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        summary: r.summary,
        undone: !!r.undone,
      })),
    });
  }

  if (method === 'GET' && path === '/api/settings') {
    return ok({ rules: loadRules(db), privateDomains: [...loadPrivateDomains(db)] });
  }

  if (method === 'GET' && path === '/api/history') {
    const id = Number(query.get('id'));
    if (!id) return bad('id required');
    return ok({
      checks: db
        .prepare('SELECT checked_at, result, status_code, final_url, note FROM checks WHERE bookmark_id = ? ORDER BY id DESC LIMIT 25')
        .all(id),
    });
  }

  // ---------------------------------------------------------------- exports

  if (method === 'GET' && path === '/api/export') {
    const format = query.get('format') === 'json' ? 'json' : 'html';
    const opts = { includePrivate, includeArchived: query.get('archived') === '1' };
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      status: 200,
      body: null,
      download:
        format === 'json'
          ? { filename: `bookmarks-${stamp}.json`, contentType: 'application/json', text: exportJson(db, opts) }
          : { filename: `bookmarks-${stamp}.html`, contentType: 'text/html', text: exportHtml(db, opts) },
    };
  }

  // --------------------------------------------------------------- mutation

  if (method === 'POST' && path === '/api/import') {
    const { filename = 'upload', text, map, dryRun } = body ?? {};
    if (typeof text !== 'string' || !text.trim()) return bad('No file content received.');

    let parsed;
    try {
      parsed = parseUpload(filename, text, map ?? {});
    } catch (e: any) {
      return bad(`Could not parse ${filename}: ${e.message}`);
    }
    if (!parsed.items.length) return bad(`No bookmarks found in ${filename}.`);

    if (dryRun) {
      return ok({
        dryRun: true,
        format: parsed.format,
        parsed: parsed.items.length,
        wouldFlagPrivate: parsed.items.filter((i) => assessUrl(i.url).sensitive).length,
        sample: parsed.items.slice(0, 8).map((i) => ({
          title: i.title,
          url: redactUrl(i.url),
          folderPath: i.folderPath,
          private: assessUrl(i.url).sensitive,
        })),
      });
    }

    const source = String(body.source || filename.replace(/\.[^.]+$/, '') || 'import');
    const runId = startRun(db, 'import');
    const res = importBookmarks(db, parsed.items, {
      source,
      runId,
      rules: loadRules(db),
      privateDomains: loadPrivateDomains(db),
    });
    finishRun(db, runId, JSON.stringify(res));
    return ok({ ...res, runId, format: parsed.format, source });
  }

  if (method === 'POST' && path === '/api/bookmarks') {
    const url = String(body?.url ?? '').trim();
    if (!url) return bad('A URL is required.');
    if (!normalizeUrl(url).includes('.')) return bad('That does not look like a URL.');

    const runId = startRun(db, 'add');
    const item: RawBookmark = {
      url,
      title: String(body.title ?? '').trim() || url,
      description: String(body.description ?? ''),
      folderPath: '',
      addedAt: new Date().toISOString(),
      tags: Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
    };
    const res = importBookmarks(db, [item], {
      source: 'manual',
      runId,
      rules: loadRules(db),
      privateDomains: loadPrivateDomains(db),
    });
    finishRun(db, runId, JSON.stringify(res));
    return ok({ ...res, runId });
  }

  if (method === 'POST' && path === '/api/tags/add') {
    const ids: number[] = body?.ids ?? [];
    const tag = String(body?.tag ?? '').trim();
    if (!ids.length || !tag) return bad('ids and tag are required.');
    const runId = startRun(db, 'tag');
    for (const id of ids) addTag(db, Number(id), tag, runId);
    finishRun(db, runId, `tagged ${ids.length} with ${tag}`);
    return ok({ runId, count: ids.length });
  }

  if (method === 'POST' && path === '/api/tags/remove') {
    const ids: number[] = body?.ids ?? [];
    const tag = String(body?.tag ?? '').trim();
    if (!ids.length || !tag) return bad('ids and tag are required.');
    for (const id of ids) removeTag(db, Number(id), tag);
    return ok({ count: ids.length });
  }

  if (method === 'POST' && path === '/api/archive') {
    const ids: number[] = body?.ids ?? [];
    if (!ids.length) return bad('ids are required.');
    const runId = startRun(db, 'archive');
    for (const id of ids) archiveBookmark(db, Number(id), runId);
    finishRun(db, runId, `archived ${ids.length}`);
    return ok({ runId, count: ids.length });
  }

  if (method === 'POST' && path === '/api/restore') {
    for (const id of body?.ids ?? []) restoreBookmark(db, Number(id));
    return ok({ count: (body?.ids ?? []).length });
  }

  if (method === 'POST' && path === '/api/private') {
    const ids: number[] = body?.ids ?? [];
    const value = !!body?.value;
    for (const id of ids) setPrivate(db, Number(id), value);
    return ok({ count: ids.length, private: value });
  }

  if (method === 'POST' && path === '/api/merge') {
    const keep = Number(body?.keep);
    const drop = Number(body?.drop);
    if (!keep || !drop) return bad('keep and drop are required.');
    const runId = startRun(db, 'merge');
    mergeBookmarks(db, keep, drop, runId);
    finishRun(db, runId, `merged ${drop} into ${keep}`);
    return ok({ runId });
  }

  if (method === 'POST' && path === '/api/duplicates/keep-both') {
    const pair = Number(body?.pair);
    if (!pair) return bad('pair is required.');
    db.prepare('UPDATE duplicate_pairs SET resolved = 1 WHERE id = ?').run(pair);
    return ok();
  }

  if (method === 'POST' && path === '/api/undo') {
    const id = body?.runId
      ? Number(body.runId)
      : Number((db.prepare('SELECT id FROM runs WHERE undone = 0 ORDER BY id DESC LIMIT 1').get() as any)?.id);
    if (!id) return bad('Nothing to undo.');
    const reversed = undoRun(db, id);
    return ok({ runId: id, reversed });
  }

  if (method === 'POST' && path === '/api/settings/rules') {
    const rules = loadRules(db);
    if (body?.remove !== undefined) {
      rules.splice(Number(body.remove), 1);
    } else {
      const match = String(body?.match ?? '').trim();
      const tag = String(body?.tag ?? '').trim();
      if (!match || !tag) return bad('match and tag are required.');
      rules.push({ match, tag });
    }
    setSetting(db, 'keyword_rules', JSON.stringify(rules));
    return ok({ rules });
  }

  if (method === 'POST' && path === '/api/settings/private-domains') {
    const domains = loadPrivateDomains(db);
    if (body?.remove) domains.delete(String(body.remove).toLowerCase());
    else if (body?.add) domains.add(String(body.add).toLowerCase().trim());
    setSetting(db, 'private_domains', JSON.stringify([...domains]));
    return ok({ privateDomains: [...domains] });
  }

  if (method === 'POST' && path === '/api/retag') {
    // Re-apply deterministic rules to existing bookmarks, reviewable via undo.
    const rules = loadRules(db);
    const runId = startRun(db, 'retag');
    const rows = queryBookmarks(db, { includePrivate: true, limit: 1000000 });
    let added = 0;
    for (const b of rows) {
      const before = new Set(tagsOf(db, b.id));
      const want = autoTags(
        { url: b.url, title: b.title, description: b.description, folderPath: b.folder_path, addedAt: b.added_at, tags: [] },
        b.source,
        rules,
      );
      for (const t of want) {
        if (!before.has(t)) {
          addTag(db, b.id, t, runId);
          added++;
        }
      }
    }
    finishRun(db, runId, `retag added ${added}`);
    return ok({ runId, added });
  }

  return { status: 404, body: { error: `No API route for ${method} ${path}` } };
}

/** Streamed link check, used by the GUI's progress view. */
export async function streamCheck(
  db: DB,
  opts: CheckOptions,
  emit: (event: string, data: any) => void,
): Promise<void> {
  const due = dueForCheck(db, opts).length;
  emit('start', { due });

  const summary = await runCheck(db, {
    ...opts,
    onProgress: (p) => emit('progress', p),
  });

  emit('done', { summary, stats: statsOf(db) });
}
